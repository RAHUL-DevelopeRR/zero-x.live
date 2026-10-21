BEGIN;

-- zerox_device_create refuses a requester that already holds p_max_pending unexpired pending
-- grants. The refusal now says when the oldest of them expires (the first slot to free up), so
-- /auth/device/code can send that wait as Retry-After instead of the full code lifetime:
-- too_many_pending carries DETAIL 'retry_after_seconds=<n>'. Signature and result unchanged.
CREATE OR REPLACE FUNCTION public.zerox_device_create(p_device_code_hash text, p_user_code text, p_client jsonb,
  p_requester jsonb, p_ttl_seconds integer, p_interval_seconds integer, p_max_pending integer)
RETURNS TABLE (id uuid, user_code text, expires_at timestamptz, interval_seconds integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_ip text := left(p_requester ->> 'ip', 64);
  v_pending bigint;
  v_oldest timestamptz;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 1800 THEN
    RAISE EXCEPTION 'invalid_device_grant: p_ttl_seconds must be 60-1800';
  END IF;
  IF v_ip IS NOT NULL AND p_max_pending IS NOT NULL THEN
    SELECT count(*), min(g.expires_at) INTO v_pending, v_oldest FROM public.zerox_device_grants AS g
      WHERE g.requester_ip = v_ip AND g.status = 'pending' AND g.expires_at > now();
    IF v_pending >= p_max_pending THEN
      RAISE EXCEPTION 'too_many_pending' USING DETAIL = 'retry_after_seconds=' ||
        greatest(1, ceil(extract(epoch FROM v_oldest - now())))::integer;
    END IF;
  END IF;
  RETURN QUERY INSERT INTO public.zerox_device_grants AS g (device_code_hash, user_code, client_name, client_version,
      device_name, device_os, requester_ip, requester_country, requester_region, requester_city, requester_network,
      interval_seconds, expires_at)
    VALUES (p_device_code_hash, p_user_code, left(coalesce(p_client ->> 'name', 'neuron-cli'), 64),
      left(p_client ->> 'version', 64), left(p_client ->> 'device_name', 128), left(p_client ->> 'os', 64),
      v_ip, left(p_requester ->> 'country', 8), left(p_requester ->> 'region', 128),
      left(p_requester ->> 'city', 128), left(p_requester ->> 'network', 128),
      coalesce(p_interval_seconds, 5), now() + make_interval(secs => p_ttl_seconds))
    RETURNING g.id, g.user_code, g.expires_at, g.interval_seconds;
END;
$$;

REVOKE ALL ON FUNCTION public.zerox_device_create(text, text, jsonb, jsonb, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_device_create(text, text, jsonb, jsonb, integer, integer, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
