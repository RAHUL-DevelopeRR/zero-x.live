BEGIN;
-- Creating a table and a function takes no lock on existing rows; give up (and re-run) rather than
-- queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Pool refusals: a queryable record of every shared-budget refusal.
--
-- On 2026-11-13 a Neuron turn on GPT-OSS 120B (Groq free pool, 8,000 tokens per minute) was refused
-- by zerox_reserve_v2 with pool_exhausted for 44 s. The refusal left no row anywhere: the minute
-- bucket already existed and is not written on a refusal, and the gateway only logged a warning.
-- The gateway now records each pool_exhausted and user_pool_share refusal here (after it has
-- answered, never on the request path's critical section) through zerox_note_pool_refusal, which
-- also snapshots the pool's minute and day buckets at that moment, so the next investigation sees
-- when, which pool, why, how many tokens the request needed and how much of the budget was used.
--
-- Additive only: one table, one function. No existing table, function or row changes; a gateway
-- without this migration skips the record (PGRST202) and keeps working, and this migration is safe
-- before or after any gateway. Rows older than 14 days are removed by the function as it inserts.
-- Roll back with migrations/down/20261114000000_pool_refusals.sql (psql -X -v ON_ERROR_STOP=1 -f).
-- Every statement can be re-run.

CREATE TABLE IF NOT EXISTS public.zerox_pool_refusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  model text NOT NULL,
  tier text NOT NULL,
  pool_key text NOT NULL DEFAULT '',
  status text NOT NULL,
  reason text NOT NULL,
  budget text,
  needed_tokens bigint,
  retry_after_seconds integer,
  limits jsonb,
  minute_requests bigint,
  minute_tokens bigint,
  day_requests bigint,
  day_tokens bigint
);
COMMENT ON TABLE public.zerox_pool_refusals IS
  'Shared pool budget refusals (zerox_reserve_v2 pool_exhausted and user_pool_share) with the pool buckets at that moment; kept 14 days.';
COMMENT ON COLUMN public.zerox_pool_refusals.reason IS
  'minute_budget | daily_budget | concurrency | spend_cap | user_pool_share';
COMMENT ON COLUMN public.zerox_pool_refusals.needed_tokens IS
  'The refused reservation''s p_tokens (prompt estimate plus the output hold).';
COMMENT ON COLUMN public.zerox_pool_refusals.limits IS 'The reservation''s p_pool (rpm, rpd, tpm, tpd, cpd, concurrency).';
CREATE INDEX IF NOT EXISTS zerox_pool_refusals_created_idx ON public.zerox_pool_refusals (created_at);
CREATE INDEX IF NOT EXISTS zerox_pool_refusals_model_idx ON public.zerox_pool_refusals (model, created_at);

ALTER TABLE public.zerox_pool_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_pool_refusals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zerox_pool_refusals TO service_role;

-- Records one refusal. The buckets are read as they stand now (no lock): the minute bucket of the
-- current minute and the day bucket of the current UTC day of the pool key (zerox_reserve_v2 keys
-- them the same way). Returns the new row's id.
CREATE OR REPLACE FUNCTION public.zerox_note_pool_refusal(p_model text, p_tier text, p_pool_key text, p_status text,
  p_reason text, p_budget text DEFAULT NULL, p_needed_tokens bigint DEFAULT NULL, p_retry_after_seconds integer DEFAULT NULL,
  p_limits jsonb DEFAULT NULL, p_request_id text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_now timestamptz := now();
  v_minute timestamptz := date_trunc('minute', v_now, 'UTC');
  v_day timestamptz := ((v_now AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC');
  v_pool_key text := coalesce(p_pool_key, '');
  v_minute_row public.zerox_pool_usage;
  v_day_row public.zerox_pool_usage;
  v_id uuid;
BEGIN
  IF p_model IS NULL OR p_tier IS NULL OR p_status IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_refusal: model, tier, status and reason are required';
  END IF;
  SELECT * INTO v_minute_row FROM public.zerox_pool_usage AS pu
    WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key AND pu.bucket = 'minute' AND pu.bucket_start = v_minute;
  SELECT * INTO v_day_row FROM public.zerox_pool_usage AS pu
    WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key AND pu.bucket = 'day' AND pu.bucket_start = v_day;
  INSERT INTO public.zerox_pool_refusals (created_at, request_id, model, tier, pool_key, status, reason, budget,
    needed_tokens, retry_after_seconds, limits, minute_requests, minute_tokens, day_requests, day_tokens)
    VALUES (v_now, left(p_request_id, 100), left(p_model, 200), left(p_tier, 20), left(v_pool_key, 200), left(p_status, 40),
      left(p_reason, 40), left(p_budget, 100), p_needed_tokens, p_retry_after_seconds,
      CASE WHEN jsonb_typeof(p_limits) = 'object' THEN p_limits END,
      coalesce(v_minute_row.requests, 0), coalesce(v_minute_row.tokens, 0),
      coalesce(v_day_row.requests, 0), coalesce(v_day_row.tokens, 0))
    RETURNING id INTO v_id;
  DELETE FROM public.zerox_pool_refusals AS r WHERE r.created_at < v_now - interval '14 days';
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zerox_note_pool_refusal(text, text, text, text, text, text, bigint, integer, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_note_pool_refusal(text, text, text, text, text, text, bigint, integer, jsonb, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
