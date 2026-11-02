BEGIN;

-- Reverts 20261029000800_paid_billing_caps.sql. Apply only after rolling the Worker back to a
-- build that calls zerox_settle_v2 with 9 arguments. Restores the 20261029000300 versions of
-- zerox_reserve_v2 (no cpd; concurrency leases and rpm per client request stay), zerox_settle_v2
-- (9 arguments, no cache columns) and zerox_admin_overview, the 20261016000100 version of
-- zerox_usage_by_model and the 20261028000000 version of zerox_release_stale_reservations (5
-- minutes after the lease lapsed, every tier), then drops the cost and cache columns. Cache token
-- counts and the pools' daily cost recorded since are lost. Safe to re-run.

DROP FUNCTION IF EXISTS public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text, bigint, bigint);

-- Atomically checks the per-user plan quota, credits and the shared upstream pool budget,
-- then records a reservation. p_pool is {rpm, rpd, tpm, tpd}; a null budget is unlimited.
-- p_pool_key (1-300 characters) selects the pool's own buckets; null is the model's default.
CREATE OR REPLACE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
  p_tokens bigint, p_cost_microusd bigint, p_pool jsonb, p_pool_key text DEFAULT NULL)
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
  v_pool_key text := coalesce(p_pool_key, '');
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
  IF p_pool_key IS NOT NULL AND length(p_pool_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid_reservation: p_pool_key must be 1-300 characters or null';
  END IF;
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
    -- Create-or-lock the pool key's buckets (minute first, then day) so concurrent reservations
    -- across all users serialize on that key's budget; other keys of the model are not locked.
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'minute', v_minute)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
      RETURNING * INTO v_minute_row;
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'day', v_day)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
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
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'minute' AND pu.bucket_start = v_minute;
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'day' AND pu.bucket_start = v_day;
    UPDATE public.zerox_accounts AS a SET daily_requests = a.daily_requests + 1,
      daily_tokens_used = a.daily_tokens_used + p_tokens, total_requests = a.total_requests + 1,
      total_tokens_used = a.total_tokens_used + p_tokens, last_usage_reset = v_today,
      last_seen_at = v_now, updated_at = v_now
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
    INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens,
      reserved_cost_microusd, usage_day, pool_minute, pool_day, pool_key, created_at, lease_expires_at)
      VALUES (p_user_id, p_request_id, p_model, p_tier, v_account.plan, p_tokens,
        CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END, v_today, v_minute, v_day, v_pool_key, v_now,
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

-- Idempotently settles a reservation: reconciles user and pool token counters with actual
-- usage, bills paid-tier credits (clamped at 0, shortfall recorded in the ledger) and records the
-- usage event and daily rollup. The pool counters reconciled are the reservation's own buckets
-- (its model, tier and pool key); the usage event and rollup stay per model. p_status:
-- * ok, error: the request counts against the user and the shared pool.
-- * refunded: the upstream did not count the attempt (429, 5xx, network or auth failures), so the
--   request is returned to the user and to the pool.
-- * failed_upstream: the attempt reached the model (model errors such as tool_use_failed,
--   first-byte or idle timeouts). The pool keeps the request and the processed tokens, as the
--   upstream's own limits do. The user gets the request (and tokens) back while they have
--   refunds left for the day (a tenth of the plan's daily requests, at least 5); after that the
--   attempt counts like an error. The usage event records the effective outcome (refunded/error).
CREATE OR REPLACE FUNCTION public.zerox_settle_v2(p_reservation_id uuid, p_prompt_tokens bigint,
  p_completion_tokens bigint, p_cost_microusd bigint, p_status text, p_latency_ms integer,
  p_provider text, p_upstream_model text, p_error_code text)
RETURNS TABLE (status text, credit_balance_microusd bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_reservation public.zerox_reservations;
  v_balance bigint;
  v_prompt bigint := coalesce(p_prompt_tokens, 0);
  v_completion bigint := coalesce(p_completion_tokens, 0);
  v_delta bigint;
  v_user_delta bigint;
  v_user_prompt bigint;
  v_user_completion bigint;
  v_refund integer;
  v_pool_refund integer;
  v_effective text;
  v_account public.zerox_accounts;
  v_allowance bigint;
  v_refunds_used bigint := 0;
  v_count_refund boolean := false;
  v_cost bigint := 0;
  v_charged bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok', 'error', 'refunded', 'failed_upstream') THEN
    RAISE EXCEPTION 'invalid_settlement: p_status must be ok, error, refunded or failed_upstream';
  END IF;
  IF v_prompt < 0 OR v_completion < 0 OR coalesce(p_cost_microusd, 0) < 0 OR coalesce(p_latency_ms, 0) < 0 THEN
    RAISE EXCEPTION 'invalid_settlement: token, cost and latency values must be nonnegative';
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
  ELSE
    v_user_delta := v_delta;
    v_user_prompt := v_prompt;
    v_user_completion := v_completion;
  END IF;
  IF v_reservation.tier = 'paid' AND v_effective <> 'refunded' THEN v_cost := coalesce(p_cost_microusd, 0); END IF;

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
    requests = greatest(0, pu.requests - v_pool_refund), updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier AND pu.pool_key = v_reservation.pool_key
      AND pu.bucket = 'day' AND pu.bucket_start = v_reservation.pool_day;

  INSERT INTO public.zerox_usage_events (user_id, reservation_id, request_id, model, provider,
    upstream_model, tier, status, prompt_tokens, completion_tokens, cost_microusd, latency_ms,
    error_code, usage_day)
    VALUES (v_reservation.user_id, v_reservation.id, v_reservation.request_id, v_reservation.model,
      left(coalesce(p_provider, ''), 100), left(coalesce(p_upstream_model, ''), 200), v_reservation.tier,
      v_effective, v_user_prompt, v_user_completion, v_cost, p_latency_ms, left(p_error_code, 100),
      v_reservation.usage_day)
    ON CONFLICT (reservation_id) DO NOTHING;
  INSERT INTO public.zerox_usage_daily AS d (user_id, day, model, requests, errors, prompt_tokens,
    completion_tokens, cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.usage_day, v_reservation.model, 1 - v_refund,
      CASE WHEN p_status = 'ok' THEN 0 ELSE 1 END, v_user_prompt, v_user_completion, v_cost)
    ON CONFLICT (user_id, day, model) DO UPDATE SET requests = d.requests + EXCLUDED.requests,
      errors = d.errors + EXCLUDED.errors, prompt_tokens = d.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = d.completion_tokens + EXCLUDED.completion_tokens,
      cost_microusd = d.cost_microusd + EXCLUDED.cost_microusd, updated_at = now();

  UPDATE public.zerox_reservations AS r SET status = 'settled', outcome = p_status,
    prompt_tokens = v_prompt, completion_tokens = v_completion, cost_microusd = v_cost, settled_at = now()
    WHERE r.id = v_reservation.id;
  RETURN QUERY SELECT 'settled'::text, v_balance;
END;
$$;

-- Operator overview. `pools` keeps one row per model and tier, now summed over the pool keys,
-- and adds `keys`: one entry per bucket used today ({pool_key, requests_today, tokens_today,
-- requests_this_minute, tokens_this_minute}; pool_key null for the default bucket).
CREATE OR REPLACE FUNCTION public.zerox_admin_overview()
RETURNS TABLE (overview jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH clock AS (
    SELECT (now() AT TIME ZONE 'UTC')::date AS today,
      ((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC') AS day_start,
      date_trunc('minute', now(), 'UTC') AS minute_start
  ),
  -- Recurring subscriptions whose grant has not lapsed (see zerox_subscription_grants_plan), so
  -- subscriptions left 'active' by a missed webhook drop out of MRR with their plan.
  entitled AS (
    SELECT s.plan, p.price_usd FROM public.zerox_subscriptions AS s
    JOIN public.zerox_plan_policy AS p ON p.plan = s.plan
    WHERE s.status IN ('authenticated', 'active') AND s.revoked_at IS NULL
      AND public.zerox_subscription_grants_plan(s.status, s.current_period_end, s.cancel_at_period_end, s.updated_at)
  ),
  today_usage AS (
    SELECT coalesce(sum(d.requests), 0) AS requests, coalesce(sum(d.errors), 0) AS errors,
      coalesce(sum(d.prompt_tokens + d.completion_tokens), 0) AS tokens,
      coalesce(sum(d.cost_microusd), 0) AS cost_microusd, count(DISTINCT d.user_id) AS users
    FROM public.zerox_usage_daily AS d, clock WHERE d.day = clock.today
  ),
  key_usage AS (
    SELECT d.model, d.tier, d.pool_key, d.requests AS requests_today, d.tokens AS tokens_today,
      coalesce(m.requests, 0) AS requests_this_minute, coalesce(m.tokens, 0) AS tokens_this_minute
    FROM clock
    JOIN public.zerox_pool_usage AS d ON d.bucket = 'day' AND d.bucket_start = clock.day_start
    LEFT JOIN public.zerox_pool_usage AS m ON m.model = d.model AND m.tier = d.tier AND m.pool_key = d.pool_key
      AND m.bucket = 'minute' AND m.bucket_start = clock.minute_start
  ),
  pool_usage AS (
    SELECT k.model, k.tier, sum(k.requests_today) AS requests_today, sum(k.tokens_today) AS tokens_today,
      sum(k.requests_this_minute) AS requests_this_minute, sum(k.tokens_this_minute) AS tokens_this_minute,
      jsonb_agg(jsonb_build_object('pool_key', nullif(k.pool_key, ''), 'requests_today', k.requests_today,
        'tokens_today', k.tokens_today, 'requests_this_minute', k.requests_this_minute,
        'tokens_this_minute', k.tokens_this_minute) ORDER BY k.pool_key) AS keys
    FROM key_usage AS k GROUP BY k.model, k.tier
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'day', clock.today,
    'users', jsonb_build_object(
      'total', (SELECT count(*) FROM public.zerox_accounts),
      'active_today', (SELECT count(*) FROM public.zerox_accounts AS a WHERE a.last_seen_at >= clock.day_start),
      'with_usage_today', today_usage.users,
      'suspended', (SELECT count(*) FROM public.zerox_accounts AS a WHERE a.suspended),
      'by_plan', coalesce((SELECT jsonb_object_agg(counts.plan, counts.n) FROM (
        SELECT a.plan, count(*) AS n FROM public.zerox_accounts AS a GROUP BY a.plan) AS counts), '{}'::jsonb)),
    'revenue', jsonb_build_object(
      'active_subscriptions', (SELECT count(*) FROM entitled),
      'mrr_usd_estimate', (SELECT coalesce(sum(entitled.price_usd), 0) FROM entitled),
      'by_plan', coalesce((SELECT jsonb_object_agg(counts.plan, counts.n) FROM (
        SELECT entitled.plan, count(*) AS n FROM entitled GROUP BY entitled.plan) AS counts), '{}'::jsonb)),
    'credits', jsonb_build_object(
      'outstanding_microusd', (SELECT coalesce(sum(a.credit_balance_microusd), 0) FROM public.zerox_accounts AS a)),
    'usage_today', jsonb_build_object('requests', today_usage.requests, 'errors', today_usage.errors,
      'tokens', today_usage.tokens, 'cost_microusd', today_usage.cost_microusd,
      'cost_usd', round(today_usage.cost_microusd / 1000000.0, 6)),
    'reservations', jsonb_build_object(
      'active', (SELECT count(*) FROM public.zerox_reservations AS r WHERE r.status = 'active')),
    'pools', coalesce((
      SELECT jsonb_agg(jsonb_build_object('model', p.model, 'tier', p.tier,
        'requests_today', p.requests_today, 'tokens_today', p.tokens_today,
        'requests_this_minute', p.requests_this_minute, 'tokens_this_minute', p.tokens_this_minute,
        'keys', p.keys) ORDER BY p.model, p.tier)
      FROM pool_usage AS p), '[]'::jsonb))
  FROM clock, today_usage;
$$;

-- Releases reservations that were never settled (crashed or abandoned requests) 5 minutes after
-- their lease lapsed (rows without a lease: 10 minutes after they were created). Their reserved
-- tokens stay counted; a late settle still reconciles them. Also performs bounded housekeeping of
-- expired counters, sessions and claims.
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


DROP FUNCTION IF EXISTS public.zerox_usage_by_model(uuid, date, date);
CREATE FUNCTION public.zerox_usage_by_model(p_user_id uuid, p_from date, p_to date)
RETURNS TABLE (model text, requests bigint, prompt_tokens bigint, completion_tokens bigint, cost_microusd bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid_range: p_from must not be after p_to and the range is at most 367 days';
  END IF;
  RETURN QUERY
    SELECT d.model, sum(d.requests)::bigint, sum(d.prompt_tokens)::bigint,
      sum(d.completion_tokens)::bigint, sum(d.cost_microusd)::bigint
    FROM public.zerox_usage_daily AS d
    WHERE d.user_id = p_user_id AND d.day BETWEEN p_from AND p_to
    GROUP BY d.model ORDER BY sum(d.requests) DESC, d.model;
END;
$$;


ALTER TABLE public.zerox_pool_usage DROP COLUMN IF EXISTS cost_microusd;
ALTER TABLE public.zerox_reservations DROP COLUMN IF EXISTS cache_read_tokens, DROP COLUMN IF EXISTS cache_write_tokens;
ALTER TABLE public.zerox_usage_events DROP COLUMN IF EXISTS cache_read_tokens, DROP COLUMN IF EXISTS cache_write_tokens;
ALTER TABLE public.zerox_usage_daily DROP COLUMN IF EXISTS cache_read_tokens, DROP COLUMN IF EXISTS cache_write_tokens;

REVOKE ALL ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_release_stale_reservations(),
  public.zerox_admin_overview()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_release_stale_reservations(),
  public.zerox_admin_overview()
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
