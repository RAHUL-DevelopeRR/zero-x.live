BEGIN;

-- Linked devices (A9) and sliding session expiry (A10), docs/PLATFORM_CONTRACT.md section 10.
-- Each indexed CLI session also records the device it belongs to and when it was last used.
-- Sessions are still stored here only as SHA-256 digests of their tokens.

ALTER TABLE public.zerox_session_index
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN device_name text CHECK (char_length(device_name) <= 128),
  ADD COLUMN device_os text CHECK (char_length(device_os) <= 64),
  ADD COLUMN client_name text CHECK (char_length(client_name) <= 64),
  ADD COLUMN client_version text CHECK (char_length(client_version) <= 64);

-- zerox_session_index_add plus the device: from the approved device-flow grant when
-- p_device_grant_id is set (the device reported it when the code was created), otherwise from
-- p_client {device_name, os, client_name, client_version} sent at sign-in. Display data only.
CREATE FUNCTION public.zerox_session_register(p_user_id uuid, p_token_hash text, p_expires_at timestamptz,
  p_client jsonb DEFAULT NULL, p_device_grant_id uuid DEFAULT NULL)
RETURNS TABLE (token_hash text, user_id uuid, expires_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_device_name text := nullif(btrim(p_client ->> 'device_name'), '');
  v_device_os text := nullif(btrim(p_client ->> 'os'), '');
  v_client_name text := nullif(btrim(p_client ->> 'client_name'), '');
  v_client_version text := nullif(btrim(p_client ->> 'client_version'), '');
BEGIN
  IF p_client IS NOT NULL AND jsonb_typeof(p_client) <> 'object' THEN
    RAISE EXCEPTION 'invalid_session_index: p_client must be an object';
  END IF;
  PERFORM 1 FROM public.zerox_session_index_add(p_user_id, p_token_hash, p_expires_at);
  IF p_device_grant_id IS NOT NULL THEN
    SELECT g.device_name, g.device_os, g.client_name, g.client_version
      INTO v_device_name, v_device_os, v_client_name, v_client_version
      FROM public.zerox_device_grants AS g WHERE g.id = p_device_grant_id AND g.user_id = p_user_id;
  END IF;
  UPDATE public.zerox_session_index AS si SET
      device_name = left(v_device_name, 128), device_os = left(v_device_os, 64),
      client_name = left(v_client_name, 64), client_version = left(v_client_version, 64)
    WHERE si.token_hash = p_token_hash AND si.user_id = p_user_id;
  RETURN QUERY SELECT si.token_hash, si.user_id, si.expires_at, si.created_at
    FROM public.zerox_session_index AS si WHERE si.token_hash = p_token_hash;
END;
$$;

-- The user's unexpired sessions, most recently used first.
CREATE FUNCTION public.zerox_session_list(p_user_id uuid)
RETURNS TABLE (token_hash text, created_at timestamptz, last_used_at timestamptz, expires_at timestamptz,
  device_name text, device_os text, client_name text, client_version text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT si.token_hash, si.created_at, si.last_used_at, si.expires_at,
    si.device_name, si.device_os, si.client_name, si.client_version
  FROM public.zerox_session_index AS si
  WHERE si.user_id = p_user_id AND si.expires_at > now()
  ORDER BY coalesce(si.last_used_at, si.created_at) DESC, si.token_hash;
$$;

-- Marks a session used (at most every 5 minutes) and, with p_expires_at, extends it (never
-- shortens it, and never beyond 400 days after sign-in). `present` is false when the session is
-- not indexed (signed out or revoked): the gateway then must not write the session back.
CREATE FUNCTION public.zerox_session_touch(p_token_hash text, p_expires_at timestamptz DEFAULT NULL)
RETURNS TABLE (present boolean, expires_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_expires timestamptz;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_session_index: p_token_hash must be a lowercase hex SHA-256 digest';
  END IF;
  UPDATE public.zerox_session_index AS si SET
      last_used_at = CASE WHEN si.last_used_at IS NULL OR si.last_used_at < now() - interval '5 minutes'
        THEN now() ELSE si.last_used_at END,
      expires_at = CASE WHEN p_expires_at IS NOT NULL AND p_expires_at > si.expires_at
          AND p_expires_at <= si.created_at + interval '400 days'
        THEN p_expires_at ELSE si.expires_at END
    WHERE si.token_hash = p_token_hash AND si.expires_at > now()
    RETURNING si.expires_at INTO v_expires;
  RETURN QUERY SELECT v_expires IS NOT NULL, v_expires;
END;
$$;

-- Signs out one session of the user (the linked-devices list). Returns whether it existed.
CREATE FUNCTION public.zerox_session_revoke(p_user_id uuid, p_token_hash text)
RETURNS TABLE (revoked boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_session_index AS si WHERE si.user_id = p_user_id AND si.token_hash = p_token_hash;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_session_register(uuid, text, timestamptz, jsonb, uuid),
  public.zerox_session_list(uuid),
  public.zerox_session_touch(text, timestamptz),
  public.zerox_session_revoke(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_session_register(uuid, text, timestamptz, jsonb, uuid),
  public.zerox_session_list(uuid),
  public.zerox_session_touch(text, timestamptz),
  public.zerox_session_revoke(uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
