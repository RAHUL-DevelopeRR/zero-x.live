BEGIN;

CREATE TABLE public.zerox_accounts (
  clerk_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL DEFAULT '',
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'ultrawork')),
  daily_tokens_used bigint NOT NULL DEFAULT 0 CHECK (daily_tokens_used >= 0),
  daily_requests bigint NOT NULL DEFAULT 0 CHECK (daily_requests >= 0),
  total_tokens_used bigint NOT NULL DEFAULT 0 CHECK (total_tokens_used >= 0),
  total_requests bigint NOT NULL DEFAULT 0 CHECK (total_requests >= 0),
  last_usage_reset date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zerox_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zerox_accounts FROM anon, authenticated;
GRANT ALL ON public.zerox_accounts TO service_role;

CREATE FUNCTION public.zerox_get_account(p_user_id uuid)
RETURNS SETOF public.zerox_accounts LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.zerox_accounts SET daily_requests = 0, daily_tokens_used = 0,
    last_usage_reset = (now() AT TIME ZONE 'UTC')::date
  WHERE clerk_id = p_user_id AND last_usage_reset < (now() AT TIME ZONE 'UTC')::date;
  SELECT * FROM public.zerox_accounts WHERE clerk_id = p_user_id;
$$;

CREATE FUNCTION public.zerox_sync_account(p_user_id uuid, p_profile jsonb, p_plan text DEFAULT 'free')
RETURNS SETOF public.zerox_accounts LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  INSERT INTO public.zerox_accounts (clerk_id, email, first_name, last_name, name, username, image_url, plan)
  VALUES (p_user_id, coalesce(p_profile->>'email',''), coalesce(p_profile->>'firstName',''),
    coalesce(p_profile->>'lastName',''), coalesce(p_profile->>'name',''),
    coalesce(p_profile->>'username',''), coalesce(p_profile->>'imageUrl',''), p_plan)
  ON CONFLICT (clerk_id) DO UPDATE SET email = EXCLUDED.email,
    first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
    name = EXCLUDED.name, username = EXCLUDED.username, image_url = EXCLUDED.image_url,
    updated_at = now(), last_seen_at = now();
  SELECT * FROM public.zerox_get_account(p_user_id);
$$;

CREATE FUNCTION public.zerox_record_usage(p_user_id uuid, p_requests bigint, p_tokens bigint)
RETURNS SETOF public.zerox_accounts LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_requests < 0 OR p_tokens < 0 THEN RAISE EXCEPTION 'Usage increments must be nonnegative'; END IF;
  RETURN QUERY UPDATE public.zerox_accounts SET
    daily_requests = CASE WHEN last_usage_reset < (now() AT TIME ZONE 'UTC')::date
      THEN p_requests ELSE daily_requests + p_requests END,
    daily_tokens_used = CASE WHEN last_usage_reset < (now() AT TIME ZONE 'UTC')::date
      THEN p_tokens ELSE daily_tokens_used + p_tokens END,
    total_requests = total_requests + p_requests, total_tokens_used = total_tokens_used + p_tokens,
    last_usage_reset = (now() AT TIME ZONE 'UTC')::date, updated_at = now(), last_seen_at = now()
    WHERE clerk_id = p_user_id RETURNING *;
END;
$$;
REVOKE ALL ON FUNCTION public.zerox_get_account(uuid), public.zerox_sync_account(uuid,jsonb,text),
  public.zerox_record_usage(uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_get_account(uuid), public.zerox_sync_account(uuid,jsonb,text),
  public.zerox_record_usage(uuid,bigint,bigint) TO service_role;

COMMIT;
