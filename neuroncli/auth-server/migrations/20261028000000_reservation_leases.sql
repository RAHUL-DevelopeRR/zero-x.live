BEGIN;
-- The ALTER, DROP INDEX and CREATE INDEX below lock zerox_reservations until COMMIT. Give up
-- (and re-run) rather than wait behind a long transaction with every reserve and settle queued.
SET LOCAL lock_timeout = '5s';

-- Concurrency leases (E2E finding 2026-10-27). A reservation held its user's concurrency slot
-- until it was settled, or for 10 minutes when nothing settled it. Only the gateway settles, so a
-- request whose Worker isolate Cloudflare killed mid-stream (exceededCpu, error 1102) kept its
-- slot for 10 minutes: no cancel(), no onFinish, and waitUntil died with the isolate. The CLI's
-- immediate retry was killed too, so one kill pair filled both Free slots, and every refusal said
-- "retry in 5 s" while the cron released nothing before 15 minutes.
-- * A slot is a 90 s lease (lease_expires_at) that the gateway renews while the attempt runs
--   (zerox_renew_reservation). The user's next reservation releases its lapsed leases; the cron
--   releases the rest 5 minutes after they lapsed. A released reservation is not refunded: it
--   keeps what it was charged, and a late settle still reconciles it.
-- * user_concurrency reports the real wait, until the first lease lapses (at most 90 s). This
--   changes Retry-After for healthy streams too: renewals keep a running attempt's lease 60-90 s
--   ahead, so while running streams hold every slot the refusal says 60-90 s, where it said 5 s,
--   although a settle can free a slot at any moment. A client that sleeps the whole Retry-After
--   (the Neuron CLI waits up to 90 s) waits that long (docs/PLATFORM_CONTRACT.md section 8.5).
-- * user_rpm counts client requests: failover attempts reserve as <request_id>.<n> and no longer
--   use up the caller's requests per minute.
-- Additive: one nullable column, one replaced index, one new function; zerox_reserve_v2 and
-- zerox_release_stale_reservations keep their signatures and results. Apply it before deploying
-- the gateway that renews leases (a gateway that finds zerox_renew_reservation missing warns and
-- skips renewals). Until that gateway is live, an attempt that streams for more than 90 s loses
-- its slot early; its settle still reconciles it. To roll back, run
-- migrations/down/20261028000000_reservation_leases.sql with psql -f (a gateway that still renews
-- then warns and skips renewals): it restores both functions (CREATE OR REPLACE) and the
-- (user_id, created_at) index, drops zerox_renew_reservation and the column, and removes this
-- migration's history row so the migration runner can apply it again.

ALTER TABLE public.zerox_reservations ADD COLUMN lease_expires_at timestamptz;
-- Rows in flight keep the 10 minute horizon they were reserved under; finished rows need none.
UPDATE public.zerox_reservations SET lease_expires_at = created_at + interval '10 minutes' WHERE status = 'active';
-- zerox_reserve_v2 sets the lease explicitly; the default covers rows inserted by hand.
ALTER TABLE public.zerox_reservations ALTER COLUMN lease_expires_at SET DEFAULT now() + interval '90 seconds';
COMMENT ON COLUMN public.zerox_reservations.lease_expires_at IS
  'While active, the reservation holds a concurrency slot until this time. The gateway renews it (zerox_renew_reservation) while the attempt runs; a lapsed lease is released by the user''s next reservation or by zerox_release_stale_reservations.';

-- In-flight reservations per user (concurrency leases and credit holds).
DROP INDEX public.zerox_reservations_user_active_idx;
CREATE INDEX zerox_reservations_user_active_idx ON public.zerox_reservations (user_id, lease_expires_at) WHERE status = 'active';

-- Atomically checks the per-user plan quota, credits and the shared upstream pool budget,
-- then records a reservation. p_pool is {rpm, rpd, tpm, tpd}; a null budget is unlimited.
CREATE OR REPLACE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
  p_tokens bigint, p_cost_microusd bigint, p_pool jsonb)
RETURNS TABLE (status text, reservation_id uuid, plan text, remaining_requests bigint,
  remaining_tokens bigint, credit_balance_microusd bigint, resets_at timestamptz, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'UTC')::date;
  v_resets timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'UTC');
  v_minute timestamptz := date_trunc('minute', v_now, 'UTC');
  v_day timestamptz := (v_today::timestamp AT TIME ZONE 'UTC');
  v_cost bigint := coalesce(p_cost_microusd, 0);
  v_account public.zerox_accounts;
  v_policy public.zerox_plan_policy;
  v_minute_row public.zerox_pool_usage;
  v_day_row public.zerox_pool_usage;
  v_status text;
  v_retry integer;
  v_id uuid;
  v_count bigint;
  v_oldest timestamptz;
  v_lease timestamptz;
  v_held bigint;
  v_key text;
  v_invalid boolean;
  v_rpm bigint;
  v_rpd bigint;
  v_tpm bigint;
  v_tpd bigint;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_reservation: p_user_id is required'; END IF;
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_reservation: p_request_id must be 1-200 characters';
  END IF;
  IF p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_reservation: p_model must be 1-200 characters';
  END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'paid') THEN
    RAISE EXCEPTION 'invalid_reservation: p_tier must be free or paid';
  END IF;
  IF p_tokens IS NULL OR p_tokens < 1 THEN RAISE EXCEPTION 'invalid_reservation: p_tokens must be positive'; END IF;
  IF v_cost < 0 THEN RAISE EXCEPTION 'invalid_reservation: p_cost_microusd must be nonnegative'; END IF;
  IF p_pool IS NOT NULL AND jsonb_typeof(p_pool) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_pool_budget: p_pool must be an object or null';
  END IF;
  IF jsonb_typeof(p_pool) = 'object' THEN
    FOREACH v_key IN ARRAY ARRAY['rpm', 'rpd', 'tpm', 'tpd'] LOOP
      v_invalid := CASE coalesce(jsonb_typeof(p_pool -> v_key), 'null')
        WHEN 'null' THEN false
        WHEN 'number' THEN (p_pool ->> v_key)::numeric < 0
        ELSE true END;
      IF v_invalid THEN
        RAISE EXCEPTION 'invalid_pool_budget: % must be a nonnegative number or null', v_key;
      END IF;
    END LOOP;
    v_rpm := floor((p_pool ->> 'rpm')::numeric)::bigint;
    v_rpd := floor((p_pool ->> 'rpd')::numeric)::bigint;
    v_tpm := floor((p_pool ->> 'tpm')::numeric)::bigint;
    v_tpd := floor((p_pool ->> 'tpd')::numeric)::bigint;
  END IF;

  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_account'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint,
      NULL::bigint, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  -- Releases the caller's lapsed leases (attempts whose isolate died before settling), keeping
  -- what they were charged. A reservation that is being settled or renewed right now is locked
  -- and skipped: waiting for its row while holding the account row would invert the lock order
  -- (reservation row -> account row), and the settle or renewal decides its fate anyway.
  UPDATE public.zerox_reservations AS r SET status = 'released', settled_at = v_now
    WHERE r.id IN (SELECT l.id FROM public.zerox_reservations AS l
      WHERE l.user_id = p_user_id AND l.status = 'active' AND l.lease_expires_at <= v_now
      FOR UPDATE SKIP LOCKED);
  IF v_account.last_usage_reset < v_today THEN
    UPDATE public.zerox_accounts AS a SET daily_requests = 0, daily_tokens_used = 0, last_usage_reset = v_today
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
  END IF;

  SELECT * INTO v_policy FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_account.plan;
  IF NOT FOUND THEN SELECT * INTO v_policy FROM public.zerox_plan_policy AS pp WHERE pp.plan = 'free'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing quota policy'; END IF;

  IF v_account.suspended THEN
    v_status := 'suspended';
  ELSIF NOT (p_tier = ANY (v_policy.allowed_tiers)) THEN
    v_status := 'upgrade_required';
  ELSIF v_account.daily_requests >= v_policy.daily_requests THEN
    v_status := 'user_daily_requests';
  ELSIF v_account.daily_tokens_used + p_tokens > v_policy.daily_tokens THEN
    v_status := 'user_daily_tokens';
  END IF;

  IF v_status IS NULL THEN
    -- Client requests in the last minute other than this one: failover attempts reserve as
    -- <request_id>.<n>, so an attempt of a request that is already counted always fits. A
    -- request leaves the window with its last attempt.
    SELECT count(*), min(q.last_at) INTO v_count, v_oldest FROM (
      SELECT max(r.created_at) AS last_at FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.created_at > v_now - interval '60 seconds'
        AND split_part(r.request_id, '.', 1) <> split_part(p_request_id, '.', 1)
      GROUP BY split_part(r.request_id, '.', 1)) AS q;
    IF v_count >= v_policy.rpm_limit THEN
      v_status := 'user_rpm';
      v_retry := greatest(1, ceil(extract(epoch FROM v_oldest + interval '60 seconds' - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    -- A concurrency slot is held while its lease runs. Credits stay held by every active paid
    -- reservation until it is settled or released, so a long-running paid request cannot be
    -- spent twice.
    SELECT count(*) FILTER (WHERE r.lease_expires_at > v_now),
      min(r.lease_expires_at) FILTER (WHERE r.lease_expires_at > v_now),
      coalesce(sum(r.reserved_cost_microusd) FILTER (WHERE r.tier = 'paid'), 0)
      INTO v_count, v_lease, v_held FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.status = 'active';
    IF v_count >= v_policy.concurrency_limit THEN
      v_status := 'user_concurrency';
      -- The latest a slot frees: when the first lease lapses (a settle can free one sooner).
      v_retry := greatest(1, least(90, ceil(extract(epoch FROM v_lease - v_now))))::integer;
    ELSIF p_tier = 'paid' AND v_account.credit_balance_microusd - v_held < greatest(v_cost, 1) THEN
      -- Credits held by in-flight paid reservations are not available to new ones.
      v_status := 'insufficient_credits';
    END IF;
  END IF;

  IF v_status IS NULL THEN
    -- Create-or-lock both pool buckets (minute first, then day) so concurrent reservations
    -- across all users serialize on the shared budget.
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, bucket, bucket_start)
      VALUES (p_model, p_tier, 'minute', v_minute)
      ON CONFLICT (model, tier, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
      RETURNING * INTO v_minute_row;
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, bucket, bucket_start)
      VALUES (p_model, p_tier, 'day', v_day)
      ON CONFLICT (model, tier, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
      RETURNING * INTO v_day_row;
    IF (v_rpd IS NOT NULL AND v_day_row.requests + 1 > v_rpd) OR
       (v_tpd IS NOT NULL AND v_day_row.tokens + p_tokens > v_tpd) THEN
      v_status := 'pool_exhausted';
      v_retry := greatest(1, ceil(extract(epoch FROM v_resets - v_now)))::integer;
    ELSIF (v_rpm IS NOT NULL AND v_minute_row.requests + 1 > v_rpm) OR
          (v_tpm IS NOT NULL AND v_minute_row.tokens + p_tokens > v_tpm) THEN
      v_status := 'pool_exhausted';
      v_retry := greatest(1, ceil(extract(epoch FROM v_minute + interval '1 minute' - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.bucket = 'minute' AND pu.bucket_start = v_minute;
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.bucket = 'day' AND pu.bucket_start = v_day;
    UPDATE public.zerox_accounts AS a SET daily_requests = a.daily_requests + 1,
      daily_tokens_used = a.daily_tokens_used + p_tokens, total_requests = a.total_requests + 1,
      total_tokens_used = a.total_tokens_used + p_tokens, last_usage_reset = v_today,
      last_seen_at = v_now, updated_at = v_now
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
    INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens,
      reserved_cost_microusd, usage_day, pool_minute, pool_day, created_at, lease_expires_at)
      VALUES (p_user_id, p_request_id, p_model, p_tier, v_account.plan, p_tokens,
        CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END, v_today, v_minute, v_day, v_now,
        v_now + interval '90 seconds')
      RETURNING id INTO v_id;
    v_status := 'ok';
  END IF;

  RETURN QUERY SELECT v_status, v_id, v_account.plan,
    greatest(0, v_policy.daily_requests - v_account.daily_requests)::bigint,
    greatest(0, v_policy.daily_tokens - v_account.daily_tokens_used)::bigint,
    v_account.credit_balance_microusd, v_resets, v_retry;
END;
$$;

-- Extends the lease of an in-flight reservation to p_lease_seconds from now; never shortens it.
-- The gateway calls it every 30 s while the attempt runs. False when the reservation was settled
-- or released, or does not exist.
CREATE FUNCTION public.zerox_renew_reservation(p_reservation_id uuid, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid_lease: p_lease_seconds must be 1-3600';
  END IF;
  UPDATE public.zerox_reservations AS r
    SET lease_expires_at = greatest(r.lease_expires_at, now() + make_interval(secs => p_lease_seconds))
    WHERE r.id = p_reservation_id AND r.status = 'active';
  RETURN FOUND;
END;
$$;

-- Releases reservations that were never settled (crashed or abandoned requests) 5 minutes after
-- their lease lapsed (rows without a lease: 10 minutes after they were created), unless their
-- user's next reservation released them first. Their reserved tokens stay counted; a late settle
-- still reconciles them. Also performs bounded housekeeping of expired counters, sessions and
-- claims.
CREATE OR REPLACE FUNCTION public.zerox_release_stale_reservations()
RETURNS TABLE (released bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_released bigint;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.zerox_reservations AS r
    WHERE r.status = 'active'
      AND coalesce(r.lease_expires_at, r.created_at + interval '10 minutes') < now() - interval '5 minutes'
    ORDER BY r.created_at LIMIT 10000 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.zerox_reservations AS r SET status = 'released', settled_at = now()
    FROM stale WHERE r.id = stale.id;
  GET DIAGNOSTICS v_released = ROW_COUNT;

  DELETE FROM public.zerox_reservations AS r WHERE r.id IN (
    SELECT old.id FROM public.zerox_reservations AS old
    WHERE old.status <> 'active' AND old.created_at < now() - interval '30 days' LIMIT 10000);
  DELETE FROM public.zerox_pool_usage AS pu
    WHERE pu.bucket = 'minute' AND pu.bucket_start < now() - interval '1 day';
  DELETE FROM public.zerox_pool_usage AS pu
    WHERE pu.bucket = 'day' AND pu.bucket_start < now() - interval '90 days';
  DELETE FROM public.zerox_session_index AS si WHERE si.expires_at < now();
  DELETE FROM public.zerox_webhook_events AS w WHERE w.received_at < now() - interval '90 days';

  RETURN QUERY SELECT v_released;
END;
$$;

REVOKE ALL ON FUNCTION public.zerox_renew_reservation(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_renew_reservation(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
