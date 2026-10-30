BEGIN;

-- Phone push tokens for Neuron's relay notifications (A12, docs/RELAY.md section 5). One row per
-- Expo push token; a token moves to the account that registered it last (a phone that signs in
-- to another account stops notifying the first one). Notifications carry no session content.

CREATE TABLE public.zerox_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name text CHECK (char_length(device_name) <= 128),
  notify_needs_input boolean NOT NULL DEFAULT true,
  notify_finished boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
CREATE INDEX zerox_push_tokens_user_idx ON public.zerox_push_tokens (user_id, updated_at DESC);
ALTER TABLE public.zerox_push_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_push_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_push_tokens TO service_role;

-- Registers (or re-registers) a token for the user with its notification switches. Keeps at most
-- 10 tokens per user, dropping the least recently registered.
CREATE FUNCTION public.zerox_push_register(p_user_id uuid, p_token text, p_platform text, p_device_name text,
  p_needs_input boolean DEFAULT true, p_finished boolean DEFAULT true)
RETURNS TABLE (id uuid, platform text, device_name text, notify_needs_input boolean, notify_finished boolean,
  created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_push_token: p_user_id is required'; END IF;
  IF p_token IS NULL OR p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$' THEN
    RAISE EXCEPTION 'invalid_push_token: not an Expo push token';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'invalid_push_token: p_platform must be ios or android';
  END IF;
  INSERT INTO public.zerox_push_tokens AS t (user_id, token, platform, device_name, notify_needs_input, notify_finished)
    VALUES (p_user_id, p_token, p_platform, left(nullif(btrim(p_device_name), ''), 128),
      coalesce(p_needs_input, true), coalesce(p_finished, true))
    ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
      device_name = EXCLUDED.device_name, notify_needs_input = EXCLUDED.notify_needs_input,
      notify_finished = EXCLUDED.notify_finished, updated_at = now()
    RETURNING t.id INTO v_id;
  DELETE FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.id IN (
    SELECT old.id FROM public.zerox_push_tokens AS old WHERE old.user_id = p_user_id
    ORDER BY old.updated_at DESC, old.id OFFSET 10);
  RETURN QUERY SELECT t.id, t.platform, t.device_name, t.notify_needs_input, t.notify_finished, t.created_at, t.updated_at
    FROM public.zerox_push_tokens AS t WHERE t.id = v_id;
END;
$$;

-- The user's tokens, with the token itself (the gateway sends with it; the API never returns it).
CREATE FUNCTION public.zerox_push_list(p_user_id uuid)
RETURNS TABLE (id uuid, token text, platform text, device_name text, notify_needs_input boolean, notify_finished boolean,
  created_at timestamptz, updated_at timestamptz, last_sent_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT t.id, t.token, t.platform, t.device_name, t.notify_needs_input, t.notify_finished, t.created_at, t.updated_at, t.last_sent_at
  FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id ORDER BY t.updated_at DESC, t.id;
$$;

CREATE FUNCTION public.zerox_push_delete(p_user_id uuid, p_id uuid)
RETURNS TABLE (deleted boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- Records a delivery, and drops tokens the push service reported as no longer registered.
CREATE FUNCTION public.zerox_push_delivered(p_sent uuid[], p_unregistered text[])
RETURNS TABLE (sent integer, removed integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_sent integer;
  v_removed integer;
BEGIN
  UPDATE public.zerox_push_tokens AS t SET last_sent_at = now() WHERE t.id = ANY(coalesce(p_sent, '{}'));
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  DELETE FROM public.zerox_push_tokens AS t WHERE t.token = ANY(coalesce(p_unregistered, '{}'));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN QUERY SELECT v_sent, v_removed;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_push_register(uuid, text, text, text, boolean, boolean),
  public.zerox_push_list(uuid),
  public.zerox_push_delete(uuid, uuid),
  public.zerox_push_delivered(uuid[], text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_push_register(uuid, text, text, text, boolean, boolean),
  public.zerox_push_list(uuid),
  public.zerox_push_delete(uuid, uuid),
  public.zerox_push_delivered(uuid[], text[])
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
