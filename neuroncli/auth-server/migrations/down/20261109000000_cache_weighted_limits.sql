BEGIN;
-- Replacing zerox_settle_v2 and dropping a column of zerox_reservations take short locks; give up
-- (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261109000000_cache_weighted_limits.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- zerox_settle_v2 (11 arguments), zerox_window_usage and zerox_account_overview come back as
-- 20261106000600 and 20261102000000 left them, so the user's limits count raw tokens again;
-- zerox_reservations.counted_tokens is dropped; the Free row goes back to 1,000,000 tokens per
-- 5 hours (only while it is at 3,000,000) with its feature line. Deploy the gateway that does not
-- send p_counted_tokens first: until then its settlements with cache reads fail. The history row
-- is removed so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text, bigint, bigint, bigint);
CREATE OR REPLACE FUNCTION public.zerox_settle_v2(p_reservation_id uuid, p_prompt_tokens bigint,
  p_completion_tokens bigint, p_cost_microusd bigint, p_status text, p_latency_ms integer,
  p_provider text, p_upstream_model text, p_error_code text,
  p_cache_read_tokens bigint DEFAULT 0, p_cache_write_tokens bigint DEFAULT 0)
RETURNS TABLE (status text, credit_balance_microusd bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_reservation public.zerox_reservations;
  v_balance bigint;
  v_prompt bigint := coalesce(p_prompt_tokens, 0);
  v_completion bigint := coalesce(p_completion_tokens, 0);
  v_cache_read bigint := coalesce(p_cache_read_tokens, 0);
  v_cache_write bigint := coalesce(p_cache_write_tokens, 0);
  v_delta bigint;
  v_user_delta bigint;
  v_user_prompt bigint;
  v_user_completion bigint;
  v_user_cache_read bigint;
  v_user_cache_write bigint;
  v_refund integer;
  v_pool_refund integer;
  v_effective text;
  v_account public.zerox_accounts;
  v_allowance bigint;
  v_refunds_used bigint := 0;
  v_count_refund boolean := false;
  v_cost bigint := 0;
  v_pool_cost bigint := 0;
  v_charged bigint;
  v_sponsored bigint := 0;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok', 'error', 'refunded', 'failed_upstream') THEN
    RAISE EXCEPTION 'invalid_settlement: p_status must be ok, error, refunded or failed_upstream';
  END IF;
  IF v_prompt < 0 OR v_completion < 0 OR coalesce(p_cost_microusd, 0) < 0 OR coalesce(p_latency_ms, 0) < 0 THEN
    RAISE EXCEPTION 'invalid_settlement: token, cost and latency values must be nonnegative';
  END IF;
  IF v_cache_read < 0 OR v_cache_write < 0 OR v_cache_read + v_cache_write > v_prompt THEN
    RAISE EXCEPTION 'invalid_settlement: cache token counts must be nonnegative and sum to at most p_prompt_tokens';
  END IF;

  SELECT * INTO v_reservation FROM public.zerox_reservations AS r WHERE r.id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_reservation.status = 'settled' THEN
    RETURN QUERY SELECT 'already_settled'::text, a.credit_balance_microusd
      FROM public.zerox_accounts AS a WHERE a.clerk_id = v_reservation.user_id;
    RETURN;
  END IF;

  v_delta := v_prompt + v_completion - v_reservation.reserved_tokens;
  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = v_reservation.user_id FOR UPDATE;
  v_effective := p_status;
  IF p_status = 'failed_upstream' THEN
    SELECT greatest(5, pp.daily_requests / 10) INTO v_allowance FROM public.zerox_plan_policy AS pp
      WHERE pp.plan IN (v_reservation.plan, 'free') ORDER BY (pp.plan = v_reservation.plan) DESC LIMIT 1;
    IF v_account.upstream_refund_day = v_reservation.usage_day THEN v_refunds_used := v_account.upstream_refunds; END IF;
    v_effective := CASE WHEN v_refunds_used < coalesce(v_allowance, 5) THEN 'refunded' ELSE 'error' END;
  END IF;
  v_refund := CASE WHEN v_effective = 'refunded' THEN 1 ELSE 0 END;
  v_pool_refund := CASE WHEN p_status = 'refunded' THEN 1 ELSE 0 END;
  -- The allowance counter belongs to the latest UTC day: a late settle of an earlier day's
  -- reservation (across midnight) is not counted, and never resets the current day's count.
  v_count_refund := p_status = 'failed_upstream' AND v_refund = 1
    AND (v_account.upstream_refund_day IS NULL OR v_account.upstream_refund_day <= v_reservation.usage_day);
  -- A refunded failed_upstream attempt costs the user nothing; the pool still counts it.
  IF p_status = 'failed_upstream' AND v_refund = 1 THEN
    v_user_delta := -v_reservation.reserved_tokens;
    v_user_prompt := 0;
    v_user_completion := 0;
    v_user_cache_read := 0;
    v_user_cache_write := 0;
  ELSE
    v_user_delta := v_delta;
    v_user_prompt := v_prompt;
    v_user_completion := v_completion;
    v_user_cache_read := v_cache_read;
    v_user_cache_write := v_cache_write;
  END IF;
  IF v_reservation.tier = 'paid' AND v_effective <> 'refunded' THEN v_cost := coalesce(p_cost_microusd, 0); END IF;
  -- The pool's day bucket moves from the hold to the settled cost whatever the tier: a sponsored free
  -- pool carries a price too (the hold was added to the bucket by zerox_reserve_v2).
  IF p_status <> 'refunded' THEN v_pool_cost := coalesce(p_cost_microusd, 0); END IF;
  -- What Zero-X paid for a free-tier request on a priced (sponsored) pool; the user is charged
  -- nothing (v_cost stays paid-only). A failed_upstream attempt refunded to the user still cost it.
  IF v_reservation.tier = 'free' AND p_status <> 'refunded' THEN v_sponsored := coalesce(p_cost_microusd, 0); END IF;

  v_charged := least(v_cost, v_account.credit_balance_microusd);
  UPDATE public.zerox_accounts AS a SET
    daily_tokens_used = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_tokens_used + v_user_delta) ELSE a.daily_tokens_used END,
    daily_requests = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_requests - v_refund) ELSE a.daily_requests END,
    total_tokens_used = greatest(0, a.total_tokens_used + v_user_delta),
    total_requests = greatest(0, a.total_requests - v_refund),
    upstream_refunds = CASE WHEN v_count_refund THEN v_refunds_used + 1 ELSE a.upstream_refunds END,
    upstream_refund_day = CASE WHEN v_count_refund THEN v_reservation.usage_day ELSE a.upstream_refund_day END,
    credit_balance_microusd = a.credit_balance_microusd - v_charged,
    updated_at = now()
    WHERE a.clerk_id = v_reservation.user_id
    RETURNING a.credit_balance_microusd INTO v_balance;

  IF v_cost > 0 THEN
    INSERT INTO public.zerox_credit_ledger (user_id, delta_microusd, balance_after_microusd,
      shortfall_microusd, reason, ref)
      VALUES (v_reservation.user_id, -v_charged, v_balance, v_cost - v_charged, 'usage',
        'usage:' || v_reservation.id::text);
  END IF;

  UPDATE public.zerox_pool_usage AS pu SET tokens = greatest(0, pu.tokens + v_delta),
    requests = greatest(0, pu.requests - v_pool_refund), updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier AND pu.pool_key = v_reservation.pool_key
      AND pu.bucket = 'minute' AND pu.bucket_start = v_reservation.pool_minute;
  UPDATE public.zerox_pool_usage AS pu SET tokens = greatest(0, pu.tokens + v_delta),
    requests = greatest(0, pu.requests - v_pool_refund),
    cost_microusd = greatest(0, pu.cost_microusd + v_pool_cost - v_reservation.reserved_cost_microusd),
    updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier AND pu.pool_key = v_reservation.pool_key
      AND pu.bucket = 'day' AND pu.bucket_start = v_reservation.pool_day;

  INSERT INTO public.zerox_usage_events (user_id, reservation_id, request_id, model, provider,
    upstream_model, tier, status, prompt_tokens, completion_tokens, cost_microusd, latency_ms,
    error_code, usage_day, cache_read_tokens, cache_write_tokens, sponsored_cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.id, v_reservation.request_id, v_reservation.model,
      left(coalesce(p_provider, ''), 100), left(coalesce(p_upstream_model, ''), 200), v_reservation.tier,
      v_effective, v_user_prompt, v_user_completion, v_cost, p_latency_ms, left(p_error_code, 100),
      v_reservation.usage_day, v_user_cache_read, v_user_cache_write, v_sponsored)
    ON CONFLICT (reservation_id) DO NOTHING;
  INSERT INTO public.zerox_usage_daily AS d (user_id, day, model, requests, errors, prompt_tokens,
    completion_tokens, cost_microusd, cache_read_tokens, cache_write_tokens, sponsored_cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.usage_day, v_reservation.model, 1 - v_refund,
      CASE WHEN p_status = 'ok' THEN 0 ELSE 1 END, v_user_prompt, v_user_completion, v_cost,
      v_user_cache_read, v_user_cache_write, v_sponsored)
    ON CONFLICT (user_id, day, model) DO UPDATE SET requests = d.requests + EXCLUDED.requests,
      errors = d.errors + EXCLUDED.errors, prompt_tokens = d.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = d.completion_tokens + EXCLUDED.completion_tokens,
      cost_microusd = d.cost_microusd + EXCLUDED.cost_microusd,
      cache_read_tokens = d.cache_read_tokens + EXCLUDED.cache_read_tokens,
      cache_write_tokens = d.cache_write_tokens + EXCLUDED.cache_write_tokens,
      sponsored_cost_microusd = d.sponsored_cost_microusd + EXCLUDED.sponsored_cost_microusd, updated_at = now();

  -- The monthly family allowance row (zerox_reserve_v2 p_cap) ends at exactly the tokens the usage
  -- event records: the hold is replaced by the settled tokens, a refund returns it and the request.
  -- Lock order as in zerox_reserve_v2: reservation, account, month row.
  IF v_reservation.cap_family IS NOT NULL THEN
    UPDATE public.zerox_family_month_usage AS u SET tokens = greatest(0, u.tokens + v_user_delta),
      requests = greatest(0, u.requests - v_refund), sponsored_cost_microusd = u.sponsored_cost_microusd + v_sponsored,
      updated_at = now()
      WHERE u.user_id = v_reservation.user_id AND u.family = v_reservation.cap_family AND u.month = v_reservation.cap_month;
  END IF;

  UPDATE public.zerox_reservations AS r SET status = 'settled', outcome = p_status,
    prompt_tokens = v_prompt, completion_tokens = v_completion, cost_microusd = v_cost,
    cache_read_tokens = v_cache_read, cache_write_tokens = v_cache_write, settled_at = now()
    WHERE r.id = v_reservation.id;
  RETURN QUERY SELECT 'settled'::text, v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.zerox_window_usage(p_user_id uuid, p_window_seconds integer, p_now timestamptz DEFAULT now())
RETURNS TABLE (created_at timestamptz, tokens bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.created_at, CASE WHEN r.status = 'settled'
      THEN coalesce(e.prompt_tokens + e.completion_tokens, r.prompt_tokens + r.completion_tokens, r.reserved_tokens)
      ELSE r.reserved_tokens END
  FROM public.zerox_reservations AS r
  LEFT JOIN public.zerox_usage_events AS e ON e.reservation_id = r.id
  WHERE r.user_id = p_user_id AND r.created_at > p_now - make_interval(secs => p_window_seconds);
$$;

CREATE OR REPLACE FUNCTION public.zerox_account_overview(p_user_id uuid, p_caps jsonb DEFAULT NULL)
RETURNS TABLE (account jsonb, policy jsonb, credits jsonb, subscription jsonb, usage_today jsonb, usage_window jsonb,
  usage_month jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH clock AS (
    SELECT (now() AT TIME ZONE 'UTC')::date AS today,
      (((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS resets_at
  )
  SELECT
    jsonb_build_object('id', a.clerk_id, 'email', a.email, 'name', a.name,
      'first_name', a.first_name, 'last_name', a.last_name, 'username', a.username,
      'image_url', a.image_url, 'plan', a.plan, 'plan_source', a.plan_source,
      'suspended', a.suspended, 'country', a.country, 'created_at', a.created_at,
      'last_seen_at', a.last_seen_at),
    to_jsonb(pol),
    jsonb_build_object('balance_microusd', a.credit_balance_microusd,
      'monthly_grant_microusd', coalesce(pol.monthly_credit_microusd, 0)),
    (SELECT to_jsonb(s) - 'raw' FROM public.zerox_current_subscription(a.clerk_id) AS s),
    jsonb_build_object('day', clock.today, 'resets_at', clock.resets_at,
      'requests', CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_requests END,
      'tokens', CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_tokens_used END,
      'remaining_requests', greatest(0, pol.daily_requests
        - CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_requests END),
      'remaining_tokens', greatest(0, pol.daily_tokens
        - CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_tokens_used END)),
    CASE WHEN pol.window_tokens IS NOT NULL AND pol.window_seconds IS NOT NULL THEN
      jsonb_build_object('window_seconds', pol.window_seconds, 'limit_tokens', pol.window_tokens,
        'tokens', win.used, 'remaining_tokens', greatest(0, pol.window_tokens - win.used),
        'resets_at', win.oldest + make_interval(secs => pol.window_seconds)) END,
    coalesce((SELECT jsonb_agg(jsonb_build_object('family', m.family, 'tokens', m.tokens, 'requests', m.requests,
        'limit_tokens', cap.limit_tokens, 'remaining_tokens', CASE WHEN cap.limit_tokens IS NOT NULL
          THEN greatest(0, cap.limit_tokens - m.tokens) END,
        'resets_at', (m.month + interval '1 month') AT TIME ZONE 'UTC') ORDER BY m.family)
      FROM public.zerox_family_month_usage AS m
      LEFT JOIN LATERAL (SELECT (c.value ->> 'month_tokens')::bigint AS limit_tokens
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_caps) = 'array' THEN p_caps ELSE '[]'::jsonb END) AS c(value)
        WHERE c.value ->> 'family' = m.family LIMIT 1) AS cap ON true
      WHERE m.user_id = a.clerk_id AND m.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date), '[]'::jsonb)
  FROM public.zerox_accounts AS a
  CROSS JOIN clock
  LEFT JOIN LATERAL (
    SELECT p.* FROM public.zerox_plan_policies_v2() AS p
    WHERE p.plan IN (a.plan, 'free') ORDER BY (p.plan = a.plan) DESC LIMIT 1
  ) AS pol ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(w.tokens), 0)::bigint AS used, min(w.created_at) AS oldest
    FROM public.zerox_window_usage(a.clerk_id, pol.window_seconds) AS w
    WHERE pol.window_seconds IS NOT NULL
  ) AS win ON true
  WHERE a.clerk_id = p_user_id;
$$;

ALTER TABLE public.zerox_reservations DROP COLUMN IF EXISTS counted_tokens;

UPDATE public.zerox_plan_policy AS p SET window_tokens = 1000000, updated_at = now()
  WHERE p.plan = 'free' AND p.window_tokens = 3000000 AND p.window_seconds = 18000;
UPDATE public.zerox_plan_policy AS p SET
  features = coalesce((SELECT jsonb_agg(CASE WHEN f.value = '100 requests per day and 3M tokens every 5 hours'
      THEN '100 requests per day and 1M tokens every 5 hours' ELSE f.value END ORDER BY f.ordinality)
    FROM jsonb_array_elements_text(p.features) WITH ORDINALITY AS f(value, ordinality)), '[]'::jsonb),
  updated_at = now()
  WHERE p.plan = 'free' AND p.features ? '100 requests per day and 3M tokens every 5 hours';

REVOKE ALL ON FUNCTION
  public.zerox_window_usage(uuid, integer, timestamptz),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text, bigint, bigint),
  public.zerox_account_overview(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_window_usage(uuid, integer, timestamptz),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text, bigint, bigint),
  public.zerox_account_overview(uuid, jsonb)
  TO service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261109000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
