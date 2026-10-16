BEGIN;

-- CLI session index and admin overview RPCs (docs/PLATFORM_CONTRACT.md section 4).
-- Session ids are never stored here, only their SHA-256 hex digests.

CREATE FUNCTION public.zerox_session_index_add(p_user_id uuid, p_token_hash text, p_expires_at timestamptz)
RETURNS TABLE (token_hash text, user_id uuid, expires_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_session_index: p_user_id is required'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_session_index: p_token_hash must be a lowercase hex SHA-256 digest';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '400 days' THEN
    RAISE EXCEPTION 'invalid_session_index: p_expires_at must be in the future (at most 400 days)';
  END IF;
  DELETE FROM public.zerox_session_index AS si WHERE si.user_id = p_user_id AND si.expires_at <= now();
  RETURN QUERY INSERT INTO public.zerox_session_index AS si (token_hash, user_id, expires_at)
    VALUES (p_token_hash, p_user_id, p_expires_at)
    ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at
      WHERE si.user_id = EXCLUDED.user_id
    RETURNING si.token_hash, si.user_id, si.expires_at, si.created_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_owner_mismatch'; END IF;
END;
$$;

CREATE FUNCTION public.zerox_session_index_list(p_user_id uuid)
RETURNS TABLE (token_hash text, expires_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT si.token_hash, si.expires_at, si.created_at FROM public.zerox_session_index AS si
  WHERE si.user_id = p_user_id AND si.expires_at > now()
  ORDER BY si.created_at DESC, si.token_hash;
$$;

-- Removes every indexed session of the user and returns their hashes so the caller can
-- delete the matching entries from the session store (KV or gateway_session_store).
CREATE FUNCTION public.zerox_session_index_revoke_all(p_user_id uuid)
RETURNS TABLE (token_hash text)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  DELETE FROM public.zerox_session_index AS si WHERE si.user_id = p_user_id RETURNING si.token_hash;
$$;

-- Extension to the contract: drops one entry when a single session signs out.
CREATE FUNCTION public.zerox_session_index_remove(p_token_hash text)
RETURNS TABLE (removed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_session_index AS si WHERE si.token_hash = p_token_hash;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- Operator dashboard snapshot. Pool limits and health come from the gateway catalog; the
-- database contributes today's per-pool counters.
CREATE FUNCTION public.zerox_admin_overview()
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
    WHERE s.status IN ('authenticated', 'active')
      AND public.zerox_subscription_grants_plan(s.status, s.current_period_end, s.cancel_at_period_end, s.updated_at)
  ),
  today_usage AS (
    SELECT coalesce(sum(d.requests), 0) AS requests, coalesce(sum(d.errors), 0) AS errors,
      coalesce(sum(d.prompt_tokens + d.completion_tokens), 0) AS tokens,
      coalesce(sum(d.cost_microusd), 0) AS cost_microusd, count(DISTINCT d.user_id) AS users
    FROM public.zerox_usage_daily AS d, clock WHERE d.day = clock.today
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
      SELECT jsonb_agg(jsonb_build_object('model', d.model, 'tier', d.tier,
        'requests_today', d.requests, 'tokens_today', d.tokens,
        'requests_this_minute', coalesce(m.requests, 0), 'tokens_this_minute', coalesce(m.tokens, 0))
        ORDER BY d.model, d.tier)
      FROM public.zerox_pool_usage AS d
      LEFT JOIN public.zerox_pool_usage AS m ON m.model = d.model AND m.tier = d.tier
        AND m.bucket = 'minute' AND m.bucket_start = clock.minute_start
      WHERE d.bucket = 'day' AND d.bucket_start = clock.day_start), '[]'::jsonb))
  FROM clock, today_usage;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_session_index_add(uuid, text, timestamptz),
  public.zerox_session_index_list(uuid),
  public.zerox_session_index_revoke_all(uuid),
  public.zerox_session_index_remove(text),
  public.zerox_admin_overview()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_session_index_add(uuid, text, timestamptz),
  public.zerox_session_index_list(uuid),
  public.zerox_session_index_revoke_all(uuid),
  public.zerox_session_index_remove(text),
  public.zerox_admin_overview()
  TO service_role;

-- Ask PostgREST to pick up the new functions immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
