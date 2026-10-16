BEGIN;

-- Quota, credit and usage RPCs (docs/PLATFORM_CONTRACT.md section 4).
-- Lock order everywhere: reservation row -> account row -> pool minute row -> pool day row.

-- Atomically checks the per-user plan quota, credits and the shared upstream pool budget,
-- then records a reservation. p_pool is {rpm, rpd, tpm, tpd}; a null budget is unlimited.
CREATE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
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
    SELECT count(*), min(r.created_at) INTO v_count, v_oldest FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.created_at > v_now - interval '60 seconds';
    IF v_count >= v_policy.rpm_limit THEN
      v_status := 'user_rpm';
      v_retry := greatest(1, ceil(extract(epoch FROM v_oldest + interval '60 seconds' - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    SELECT count(*), coalesce(sum(r.reserved_cost_microusd) FILTER (WHERE r.tier = 'paid'), 0)
      INTO v_count, v_held FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.status = 'active' AND r.created_at > v_now - interval '10 minutes';
    IF v_count >= v_policy.concurrency_limit THEN
      v_status := 'user_concurrency';
      v_retry := 5;
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
      reserved_cost_microusd, usage_day, pool_minute, pool_day, created_at)
      VALUES (p_user_id, p_request_id, p_model, p_tier, v_account.plan, p_tokens,
        CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END, v_today, v_minute, v_day, v_now)
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
-- usage, refunds the request on p_status = 'refunded', bills paid-tier credits (clamped at 0,
-- shortfall recorded in the ledger) and records the usage event and daily rollup.
CREATE FUNCTION public.zerox_settle_v2(p_reservation_id uuid, p_prompt_tokens bigint,
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
  v_refund integer;
  v_cost bigint := 0;
  v_charged bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok', 'error', 'refunded') THEN
    RAISE EXCEPTION 'invalid_settlement: p_status must be ok, error or refunded';
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
  v_refund := CASE WHEN p_status = 'refunded' THEN 1 ELSE 0 END;
  IF v_reservation.tier = 'paid' AND p_status <> 'refunded' THEN v_cost := coalesce(p_cost_microusd, 0); END IF;

  SELECT least(v_cost, a.credit_balance_microusd) INTO v_charged
    FROM public.zerox_accounts AS a WHERE a.clerk_id = v_reservation.user_id FOR UPDATE;
  UPDATE public.zerox_accounts AS a SET
    daily_tokens_used = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_tokens_used + v_delta) ELSE a.daily_tokens_used END,
    daily_requests = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_requests - v_refund) ELSE a.daily_requests END,
    total_tokens_used = greatest(0, a.total_tokens_used + v_delta),
    total_requests = greatest(0, a.total_requests - v_refund),
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
    requests = greatest(0, pu.requests - v_refund), updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier
      AND pu.bucket = 'minute' AND pu.bucket_start = v_reservation.pool_minute;
  UPDATE public.zerox_pool_usage AS pu SET tokens = greatest(0, pu.tokens + v_delta),
    requests = greatest(0, pu.requests - v_refund), updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier
      AND pu.bucket = 'day' AND pu.bucket_start = v_reservation.pool_day;

  INSERT INTO public.zerox_usage_events (user_id, reservation_id, request_id, model, provider,
    upstream_model, tier, status, prompt_tokens, completion_tokens, cost_microusd, latency_ms,
    error_code, usage_day)
    VALUES (v_reservation.user_id, v_reservation.id, v_reservation.request_id, v_reservation.model,
      left(coalesce(p_provider, ''), 100), left(coalesce(p_upstream_model, ''), 200), v_reservation.tier,
      p_status, v_prompt, v_completion, v_cost, p_latency_ms, left(p_error_code, 100),
      v_reservation.usage_day)
    ON CONFLICT (reservation_id) DO NOTHING;
  INSERT INTO public.zerox_usage_daily AS d (user_id, day, model, requests, errors, prompt_tokens,
    completion_tokens, cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.usage_day, v_reservation.model, 1 - v_refund,
      CASE WHEN p_status = 'ok' THEN 0 ELSE 1 END, v_prompt, v_completion, v_cost)
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

-- Releases reservations that were never settled (crashed or abandoned requests) after
-- 15 minutes. Their reserved tokens stay counted; a late settle still reconciles them.
-- Also performs bounded housekeeping of expired counters, sessions and claims.
CREATE FUNCTION public.zerox_release_stale_reservations()
RETURNS TABLE (released bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_released bigint;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.zerox_reservations AS r
    WHERE r.status = 'active' AND r.created_at < now() - interval '15 minutes'
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

CREATE FUNCTION public.zerox_plan_policies_v2()
RETURNS TABLE (plan text, name text, price_usd numeric, price_usd_cents bigint, price_inr_paise bigint,
  daily_requests bigint, daily_tokens bigint, rpm_limit integer, concurrency_limit integer,
  allowed_tiers text[], monthly_credit_microusd bigint, features jsonb, sort integer, public boolean,
  highlighted boolean, razorpay_plan_id_inr text, razorpay_plan_id_usd text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.plan, p.name, p.price_usd, round(p.price_usd * 100)::bigint, p.price_inr_paise,
    p.daily_requests, p.daily_tokens, p.rpm_limit, p.concurrency_limit, p.allowed_tiers,
    p.monthly_credit_microusd, p.features, p.sort, p.public, p.highlighted,
    p.razorpay_plan_id_inr, p.razorpay_plan_id_usd
  FROM public.zerox_plan_policy AS p
  ORDER BY p.sort, p.plan;
$$;

-- Whether a subscription still entitles its owner to the plan right now.
CREATE FUNCTION public.zerox_subscription_grants_plan(p_status text, p_current_period_end timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p_status IN ('authenticated', 'active', 'pending')
    OR (p_status IN ('halted', 'paused', 'cancelled', 'completed', 'expired')
        AND coalesce(p_current_period_end > now(), false));
$$;

-- The subscription shown to the user: the best entitling one, otherwise the latest.
CREATE FUNCTION public.zerox_current_subscription(p_user_id uuid)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.* FROM public.zerox_subscriptions AS s
  LEFT JOIN public.zerox_plan_policy AS p ON p.plan = s.plan
  WHERE s.user_id = p_user_id
  ORDER BY public.zerox_subscription_grants_plan(s.status, s.current_period_end) DESC,
    CASE WHEN public.zerox_subscription_grants_plan(s.status, s.current_period_end)
      THEN p.price_usd END DESC NULLS LAST,
    s.updated_at DESC, s.created_at DESC
  LIMIT 1;
$$;

CREATE FUNCTION public.zerox_account_overview(p_user_id uuid)
RETURNS TABLE (account jsonb, policy jsonb, credits jsonb, subscription jsonb, usage_today jsonb)
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
        - CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_tokens_used END))
  FROM public.zerox_accounts AS a
  CROSS JOIN clock
  LEFT JOIN LATERAL (
    SELECT p.* FROM public.zerox_plan_policies_v2() AS p
    WHERE p.plan IN (a.plan, 'free') ORDER BY (p.plan = a.plan) DESC LIMIT 1
  ) AS pol ON true
  WHERE a.clerk_id = p_user_id;
$$;

CREATE FUNCTION public.zerox_usage_series(p_user_id uuid, p_from date, p_to date)
RETURNS TABLE (day date, requests bigint, prompt_tokens bigint, completion_tokens bigint, cost_microusd bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid_range: p_from must not be after p_to and the range is at most 367 days';
  END IF;
  RETURN QUERY
    SELECT (p_from + g.n)::date, coalesce(sum(d.requests), 0)::bigint,
      coalesce(sum(d.prompt_tokens), 0)::bigint, coalesce(sum(d.completion_tokens), 0)::bigint,
      coalesce(sum(d.cost_microusd), 0)::bigint
    FROM generate_series(0, p_to - p_from) AS g(n)
    LEFT JOIN public.zerox_usage_daily AS d ON d.user_id = p_user_id AND d.day = p_from + g.n
    GROUP BY g.n ORDER BY g.n;
END;
$$;

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

-- Newest first; pass the last id of a page as p_before for the next page.
CREATE FUNCTION public.zerox_usage_events(p_user_id uuid, p_limit integer DEFAULT 50, p_before bigint DEFAULT NULL)
RETURNS SETOF public.zerox_usage_events
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT e.* FROM public.zerox_usage_events AS e
  WHERE e.user_id = p_user_id AND (p_before IS NULL OR e.id < p_before)
  ORDER BY e.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

REVOKE ALL ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text),
  public.zerox_release_stale_reservations(),
  public.zerox_plan_policies_v2(),
  public.zerox_subscription_grants_plan(text, timestamptz),
  public.zerox_current_subscription(uuid),
  public.zerox_account_overview(uuid),
  public.zerox_usage_series(uuid, date, date),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_usage_events(uuid, integer, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb),
  public.zerox_settle_v2(uuid, bigint, bigint, bigint, text, integer, text, text, text),
  public.zerox_release_stale_reservations(),
  public.zerox_plan_policies_v2(),
  public.zerox_subscription_grants_plan(text, timestamptz),
  public.zerox_current_subscription(uuid),
  public.zerox_account_overview(uuid),
  public.zerox_usage_series(uuid, date, date),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_usage_events(uuid, integer, bigint)
  TO service_role;

COMMIT;
