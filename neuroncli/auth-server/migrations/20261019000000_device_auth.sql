BEGIN;

-- Device authorization grants for `neuron login` (RFC 8628 shape, docs/PLATFORM_CONTRACT.md
-- section 3.8). The CLI shows a short user_code and polls with a device_code; the user approves
-- on https://neuron.zero-x.live/device while signed in to the website, so no localhost callback
-- is needed. device_code is stored only as its SHA-256 hex digest. Single use is enforced here
-- with conditional UPDATE ... RETURNING, which KV cannot do (no compare-and-swap).

CREATE TABLE public.zerox_device_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code text NOT NULL CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 64),
  client_version text CHECK (char_length(client_version) <= 64),
  device_name text CHECK (char_length(device_name) <= 128),
  device_os text CHECK (char_length(device_os) <= 64),
  requester_ip text CHECK (char_length(requester_ip) <= 64),
  requester_country text CHECK (char_length(requester_country) <= 8),
  requester_region text CHECK (char_length(requester_region) <= 128),
  requester_city text CHECK (char_length(requester_city) <= 128),
  requester_network text CHECK (char_length(requester_network) <= 128),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'redeemed')),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  interval_seconds integer NOT NULL DEFAULT 5 CHECK (interval_seconds BETWEEN 1 AND 60),
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  redeemed_at timestamptz,
  CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CHECK (status NOT IN ('approved', 'redeemed') OR user_id IS NOT NULL)
);
-- A user_code identifies one pending grant at a time.
CREATE UNIQUE INDEX zerox_device_grants_pending_code ON public.zerox_device_grants (user_code)
  WHERE status = 'pending';
CREATE INDEX zerox_device_grants_expiry_idx ON public.zerox_device_grants (expires_at);
CREATE INDEX zerox_device_grants_requester_idx ON public.zerox_device_grants (requester_ip, created_at);

-- Creates a pending grant. Raises too_many_pending when the requester already holds
-- p_max_pending unexpired pending grants, and unique_violation on a user_code collision (the
-- gateway then retries with a fresh code).
CREATE FUNCTION public.zerox_device_create(p_device_code_hash text, p_user_code text, p_client jsonb,
  p_requester jsonb, p_ttl_seconds integer, p_interval_seconds integer, p_max_pending integer)
RETURNS TABLE (id uuid, user_code text, expires_at timestamptz, interval_seconds integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_ip text := left(p_requester ->> 'ip', 64);
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 1800 THEN
    RAISE EXCEPTION 'invalid_device_grant: p_ttl_seconds must be 60-1800';
  END IF;
  IF v_ip IS NOT NULL AND p_max_pending IS NOT NULL AND (
    SELECT count(*) FROM public.zerox_device_grants AS g
    WHERE g.requester_ip = v_ip AND g.status = 'pending' AND g.expires_at > now()) >= p_max_pending THEN
    RAISE EXCEPTION 'too_many_pending';
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

-- What the approval page shows for a code: only unexpired pending grants.
CREATE FUNCTION public.zerox_device_lookup(p_user_code text)
RETURNS TABLE (id uuid, client_name text, client_version text, device_name text, device_os text,
  requester_ip text, requester_country text, requester_region text, requester_city text,
  requester_network text, created_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT g.id, g.client_name, g.client_version, g.device_name, g.device_os, g.requester_ip,
    g.requester_country, g.requester_region, g.requester_city, g.requester_network, g.created_at, g.expires_at
  FROM public.zerox_device_grants AS g
  WHERE g.user_code = p_user_code AND g.status = 'pending' AND g.expires_at > now();
$$;

-- Approve or deny a pending grant for a signed-in user. Raises grant_not_pending otherwise.
CREATE FUNCTION public.zerox_device_decide(p_grant_id uuid, p_user_id uuid, p_decision text)
RETURNS TABLE (status text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_decision NOT IN ('approve', 'deny') THEN RAISE EXCEPTION 'invalid_decision'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_device_grant: p_user_id is required'; END IF;
  RETURN QUERY UPDATE public.zerox_device_grants AS g
    SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'denied' END,
      user_id = p_user_id, decided_at = now()
    WHERE g.id = p_grant_id AND g.status = 'pending' AND g.expires_at > now()
    RETURNING g.status;
  IF NOT FOUND THEN RAISE EXCEPTION 'grant_not_pending'; END IF;
END;
$$;

-- One poll from the CLI. Polling faster than interval_seconds returns slow_down and raises the
-- interval by 5 s (at most 60 s). The status is returned as stored; an approved grant is turned
-- into a session by the gateway and then redeemed with zerox_device_redeem.
CREATE FUNCTION public.zerox_device_poll(p_device_code_hash text)
RETURNS TABLE (id uuid, status text, user_id uuid, interval_seconds integer, expired boolean, slow_down boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v public.zerox_device_grants;
  v_slow boolean;
BEGIN
  SELECT * INTO v FROM public.zerox_device_grants AS g WHERE g.device_code_hash = p_device_code_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  v_slow := v.status = 'pending' AND v.last_polled_at IS NOT NULL
    AND v.last_polled_at > now() - make_interval(secs => v.interval_seconds);
  UPDATE public.zerox_device_grants AS g
    SET last_polled_at = now(),
      interval_seconds = CASE WHEN v_slow THEN least(g.interval_seconds + 5, 60) ELSE g.interval_seconds END
    WHERE g.id = v.id
    RETURNING g.interval_seconds INTO v.interval_seconds;
  RETURN QUERY SELECT v.id, v.status, v.user_id, v.interval_seconds, v.expires_at <= now(), v_slow;
END;
$$;

-- Marks an approved grant used. Exactly one caller gets the row back; a second redemption
-- (a replayed device_code, a concurrent poll) gets nothing.
CREATE FUNCTION public.zerox_device_redeem(p_grant_id uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  UPDATE public.zerox_device_grants AS g SET status = 'redeemed', redeemed_at = now()
  WHERE g.id = p_grant_id AND g.status = 'approved' AND g.expires_at > now()
  RETURNING g.user_id;
$$;

-- Maintenance (10-minute cron): drops grants that expired more than a day ago.
CREATE FUNCTION public.zerox_device_purge()
RETURNS integer
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH removed AS (
    DELETE FROM public.zerox_device_grants AS g WHERE g.expires_at < now() - interval '1 day' RETURNING 1)
  SELECT count(*)::integer FROM removed;
$$;

ALTER TABLE public.zerox_device_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_device_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_device_grants TO service_role;

REVOKE ALL ON FUNCTION
  public.zerox_device_create(text, text, jsonb, jsonb, integer, integer, integer),
  public.zerox_device_lookup(text),
  public.zerox_device_decide(uuid, uuid, text),
  public.zerox_device_poll(text),
  public.zerox_device_redeem(uuid),
  public.zerox_device_purge()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_device_create(text, text, jsonb, jsonb, integer, integer, integer),
  public.zerox_device_lookup(text),
  public.zerox_device_decide(uuid, uuid, text),
  public.zerox_device_poll(text),
  public.zerox_device_redeem(uuid),
  public.zerox_device_purge()
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
