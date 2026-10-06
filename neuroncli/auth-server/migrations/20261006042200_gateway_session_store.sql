BEGIN;

CREATE TABLE public.gateway_session_store (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  value text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX gateway_session_store_expiry_idx ON public.gateway_session_store (expires_at);
ALTER TABLE public.gateway_session_store ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gateway_session_store FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gateway_session_store TO service_role;

CREATE FUNCTION public.zerox_session_get(p_key text)
RETURNS TABLE (value text) LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid session key'; END IF;
  RETURN QUERY SELECT stored.value FROM public.gateway_session_store AS stored
    WHERE stored.key = p_key AND stored.expires_at > now();
END;
$$;

CREATE FUNCTION public.zerox_session_put(p_key text, p_value text, p_ttl integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid session key'; END IF;
  IF p_ttl IS NULL OR p_ttl < 1 OR p_ttl > 604800 THEN RAISE EXCEPTION 'Invalid session TTL'; END IF;
  IF p_value IS NULL THEN RAISE EXCEPTION 'Missing session value'; END IF;
  DELETE FROM public.gateway_session_store WHERE expires_at <= now();
  INSERT INTO public.gateway_session_store (key, value, expires_at)
  VALUES (p_key, p_value, now() + p_ttl * interval '1 second')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
END;
$$;

CREATE FUNCTION public.zerox_session_delete(p_key text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid session key'; END IF;
  DELETE FROM public.gateway_session_store WHERE key = p_key;
END;
$$;
REVOKE ALL ON FUNCTION public.zerox_session_get(text), public.zerox_session_put(text,text,integer),
  public.zerox_session_delete(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_session_get(text), public.zerox_session_put(text,text,integer),
  public.zerox_session_delete(text) TO service_role;

COMMIT;
