BEGIN;

-- Push for the relay's `neuron-relay/1` (docs/RELAY.md section 7): one row per account and phone,
-- keyed by the phone's relay device id, so a computer's `notify` reaches only the phones paired
-- with it. Rows registered by token alone (before device ids) have no device id: no relay push
-- reaches them, and a phone that registers again gets a keyed row. Notifications carry no
-- session content.

ALTER TABLE public.zerox_push_tokens ADD COLUMN device_id text
  CHECK (device_id IS NULL OR device_id ~ '^[A-Za-z0-9_-]{8,64}$');
CREATE UNIQUE INDEX zerox_push_tokens_device_idx ON public.zerox_push_tokens (user_id, device_id) WHERE device_id IS NOT NULL;

-- Registers (or re-registers) a phone: its token and switches replace whatever that phone had. A
-- token registered by another account or phone moves here. Keeps at most 10 per user.
CREATE FUNCTION public.zerox_push_device_register(p_user_id uuid, p_device_id text, p_token text, p_platform text,
  p_needs_me boolean DEFAULT true, p_finished boolean DEFAULT true)
RETURNS TABLE (device_id text, platform text, notify_needs_input boolean, notify_finished boolean,
  created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_push_token: p_user_id is required'; END IF;
  IF p_device_id IS NULL OR p_device_id !~ '^[A-Za-z0-9_-]{8,64}$' THEN
    RAISE EXCEPTION 'invalid_push_token: p_device_id is not a relay device id';
  END IF;
  IF p_token IS NULL OR p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$' THEN
    RAISE EXCEPTION 'invalid_push_token: not an Expo push token';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'invalid_push_token: p_platform must be ios or android';
  END IF;
  DELETE FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.device_id = p_device_id AND t.token <> p_token;
  INSERT INTO public.zerox_push_tokens AS t (user_id, device_id, token, platform, notify_needs_input, notify_finished)
    VALUES (p_user_id, p_device_id, p_token, p_platform, coalesce(p_needs_me, true), coalesce(p_finished, true))
    ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id, platform = EXCLUDED.platform,
      device_name = NULL, notify_needs_input = EXCLUDED.notify_needs_input, notify_finished = EXCLUDED.notify_finished, updated_at = now()
    RETURNING t.id INTO v_id;
  DELETE FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.id IN (
    SELECT old.id FROM public.zerox_push_tokens AS old WHERE old.user_id = p_user_id
    ORDER BY old.updated_at DESC, old.id OFFSET 10);
  RETURN QUERY SELECT t.device_id, t.platform, t.notify_needs_input, t.notify_finished, t.created_at, t.updated_at
    FROM public.zerox_push_tokens AS t WHERE t.id = v_id;
END;
$$;

-- The user's phones, without their tokens (the API lists these).
CREATE FUNCTION public.zerox_push_device_list(p_user_id uuid)
RETURNS TABLE (device_id text, platform text, notify_needs_input boolean, notify_finished boolean,
  created_at timestamptz, updated_at timestamptz, last_sent_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT t.device_id, t.platform, t.notify_needs_input, t.notify_finished, t.created_at, t.updated_at, t.last_sent_at
  FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.device_id IS NOT NULL ORDER BY t.updated_at DESC, t.id;
$$;

-- The tokens of the user's phones among p_device_ids, with their switches (the relay sends with them).
CREATE FUNCTION public.zerox_push_device_targets(p_user_id uuid, p_device_ids text[])
RETURNS TABLE (id uuid, device_id text, token text, platform text, notify_needs_input boolean, notify_finished boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT t.id, t.device_id, t.token, t.platform, t.notify_needs_input, t.notify_finished
  FROM public.zerox_push_tokens AS t
  WHERE t.user_id = p_user_id AND t.device_id = ANY(coalesce(p_device_ids, '{}')) ORDER BY t.updated_at DESC, t.id;
$$;

CREATE FUNCTION public.zerox_push_device_delete(p_user_id uuid, p_device_id text)
RETURNS TABLE (removed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_push_tokens AS t WHERE t.user_id = p_user_id AND t.device_id = p_device_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_push_device_register(uuid, text, text, text, boolean, boolean),
  public.zerox_push_device_list(uuid),
  public.zerox_push_device_targets(uuid, text[]),
  public.zerox_push_device_delete(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_push_device_register(uuid, text, text, text, boolean, boolean),
  public.zerox_push_device_list(uuid),
  public.zerox_push_device_targets(uuid, text[]),
  public.zerox_push_device_delete(uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
