BEGIN;

-- Reserve prompt + maximum output under the account row lock before calling a provider.
CREATE FUNCTION public.zerox_reserve_usage(p_user_id uuid, p_tokens bigint)
RETURNS SETOF public.zerox_accounts LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  account public.zerox_accounts;
  token_limit bigint;
  request_limit bigint;
BEGIN
  IF p_tokens < 1 THEN RAISE EXCEPTION 'Reservation must be positive'; END IF;
  SELECT * INTO account FROM public.zerox_accounts WHERE clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF account.last_usage_reset < (now() AT TIME ZONE 'UTC')::date THEN
    account.daily_requests := 0;
    account.daily_tokens_used := 0;
  END IF;
  token_limit := CASE WHEN account.plan IN ('pro','ultrawork') THEN 2000000 ELSE 256000 END;
  request_limit := CASE WHEN account.plan IN ('pro','ultrawork') THEN 20000 ELSE 2000 END;
  IF account.daily_requests >= request_limit OR account.daily_tokens_used + p_tokens > token_limit THEN RETURN; END IF;
  RETURN QUERY UPDATE public.zerox_accounts SET
    daily_requests = account.daily_requests + 1,
    daily_tokens_used = account.daily_tokens_used + p_tokens,
    total_requests = total_requests + 1,
    total_tokens_used = total_tokens_used + p_tokens,
    last_usage_reset = (now() AT TIME ZONE 'UTC')::date,
    updated_at = now(), last_seen_at = now()
  WHERE clerk_id = p_user_id RETURNING *;
END;
$$;

-- Reconcile one successful reservation. Failed/disconnected accounting keeps its reservation
-- when persistence is unavailable, so upstream usage cannot silently escape the quota.
CREATE FUNCTION public.zerox_settle_usage(p_user_id uuid, p_reserved bigint, p_actual bigint, p_day date)
RETURNS SETOF public.zerox_accounts LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_reserved < 1 OR p_actual < 0 THEN RAISE EXCEPTION 'Invalid settlement'; END IF;
  RETURN QUERY UPDATE public.zerox_accounts SET
    daily_tokens_used = CASE WHEN last_usage_reset = p_day
      THEN greatest(0, daily_tokens_used + p_actual - p_reserved) ELSE daily_tokens_used END,
    total_tokens_used = greatest(0, total_tokens_used + p_actual - p_reserved), updated_at = now()
  WHERE clerk_id = p_user_id RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION public.zerox_reserve_usage(uuid,bigint),
  public.zerox_settle_usage(uuid,bigint,bigint,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_reserve_usage(uuid,bigint),
  public.zerox_settle_usage(uuid,bigint,bigint,date) TO service_role;

COMMIT;
