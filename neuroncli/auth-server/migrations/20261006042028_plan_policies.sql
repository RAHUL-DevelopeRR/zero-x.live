BEGIN;

CREATE TABLE public.zerox_plan_policy (
  plan text PRIMARY KEY CHECK (plan IN ('free', 'pro', 'ultrawork')),
  name text NOT NULL CHECK (length(name) > 0),
  daily_tokens bigint NOT NULL CHECK (daily_tokens > 0),
  daily_requests bigint NOT NULL CHECK (daily_requests > 0),
  price_usd numeric(10,2) NOT NULL CHECK (price_usd >= 0)
);
ALTER TABLE public.zerox_plan_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_plan_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zerox_plan_policy TO service_role;

INSERT INTO public.zerox_plan_policy (plan, name, daily_tokens, daily_requests, price_usd)
VALUES ('free', 'Free', 256000, 2000, 0),
  ('pro', 'Pro', 2000000, 20000, 10),
  ('ultrawork', 'Pro (Legacy Ultrawork)', 2000000, 20000, 10);

CREATE FUNCTION public.zerox_plan_policies()
RETURNS TABLE (policies jsonb) LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(jsonb_object_agg(plan, jsonb_build_object(
    'name', name, 'daily_tokens', daily_tokens,
    'daily_requests', daily_requests, 'price_usd', price_usd)), '{}'::jsonb)
  FROM public.zerox_plan_policy;
$$;
REVOKE ALL ON FUNCTION public.zerox_plan_policies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_plan_policies() TO service_role;

CREATE OR REPLACE FUNCTION public.zerox_reserve_usage(p_user_id uuid, p_tokens bigint)
RETURNS SETOF public.zerox_accounts LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  account public.zerox_accounts;
  policy public.zerox_plan_policy;
BEGIN
  IF p_tokens < 1 THEN RAISE EXCEPTION 'Reservation must be positive'; END IF;
  SELECT * INTO account FROM public.zerox_accounts WHERE clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO policy FROM public.zerox_plan_policy WHERE plan = account.plan;
  IF NOT FOUND THEN
    SELECT * INTO policy FROM public.zerox_plan_policy WHERE plan = 'free';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing quota policy'; END IF;
  IF account.last_usage_reset < (now() AT TIME ZONE 'UTC')::date THEN
    account.daily_requests := 0;
    account.daily_tokens_used := 0;
  END IF;
  IF account.daily_requests >= policy.daily_requests OR
    p_tokens > policy.daily_tokens - account.daily_tokens_used THEN RETURN; END IF;
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
REVOKE ALL ON FUNCTION public.zerox_reserve_usage(uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_reserve_usage(uuid,bigint) TO service_role;

COMMIT;
