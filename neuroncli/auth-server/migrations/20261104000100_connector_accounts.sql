BEGIN;
-- New tables only, but the grants and the auth.users foreign key take short locks; give up (and
-- re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Hosted connectors (docs/PLATFORM_CONTRACT.md section 14.4, src/routes/connectors.js,
-- src/mcp-proxy.js). A user links a SaaS account (GitHub, Linear, ...) once on the dashboard; the
-- gateway keeps the vendor's OAuth tokens and proxies https://zero-x.live/mcp/<connector> to the
-- vendor's official remote MCP server. Nothing here is used unless HOSTED_CONNECTORS=true.
--
-- zerox_connector_accounts: one row per link. enc_refresh_token is an envelope (JSON text): the
-- vendor token bundle {refresh_token, access_token, expires_at} sealed with AES-256-GCM under a
-- random per-row data key, and that data key sealed under the gateway secret
-- CONNECTOR_TOKENS_KEK, both with the row id, user and connector as additional data
-- (src/connector-vault.js), so a value copied to another row does not open. Plaintext tokens are
-- never stored, returned to clients or logged. A link is revoked, never updated in place: linking
-- again revokes the previous row, so at most one row per (user, connector) is active.
--
-- zerox_connector_audit: metadata of every call through the proxy (method, tool name, catalog
-- tier, decision, status, duration, byte counts, sha256 of the tool arguments, error class). No
-- argument or result text. Purged after 30 days by the scheduled maintenance while hosted
-- connectors are on.
--
-- Roll back with migrations/down/20261104000100_connector_accounts.sql (psql -X -v
-- ON_ERROR_STOP=1 -f), which drops both tables and every stored link.

CREATE TABLE IF NOT EXISTS public.zerox_connector_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector text NOT NULL CHECK (connector ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  enc_refresh_token text NOT NULL CHECK (char_length(enc_refresh_token) BETWEEN 64 AND 16384),
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS zerox_connector_accounts_active_idx
  ON public.zerox_connector_accounts (user_id, connector) WHERE revoked_at IS NULL;
COMMENT ON COLUMN public.zerox_connector_accounts.enc_refresh_token IS
  'Envelope-encrypted vendor token bundle (src/connector-vault.js); never returned by any API.';

CREATE TABLE IF NOT EXISTS public.zerox_connector_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector text NOT NULL CHECK (connector ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  method text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 64),
  tool text CHECK (char_length(tool) <= 128),
  -- read, write, external or destructive (the catalog tier); blocked tools never reach the vendor.
  tier text CHECK (tier IN ('read', 'write', 'external', 'destructive', 'blocked')),
  decision text NOT NULL CHECK (decision IN ('allowed', 'needs_confirmation', 'blocked', 'too_large', 'upstream_error',
    'needs_connect', 'not_in_plan', 'rate_limited')),
  status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  bytes_in integer NOT NULL DEFAULT 0 CHECK (bytes_in >= 0),
  bytes_out integer NOT NULL DEFAULT 0 CHECK (bytes_out >= 0),
  args_sha256 text CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  error_class text CHECK (char_length(error_class) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zerox_connector_audit_user_idx ON public.zerox_connector_audit (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS zerox_connector_audit_created_idx ON public.zerox_connector_audit (created_at);

-- Links a connector: revokes the user's active link for it (if any) and stores the new one. The
-- id is chosen by the gateway before sealing (it is part of the additional data).
CREATE OR REPLACE FUNCTION public.zerox_connector_account_link(p_id uuid, p_user_id uuid, p_connector text,
  p_enc text, p_scopes text[] DEFAULT '{}')
RETURNS TABLE (id uuid, connector text, scopes text[], created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR p_connector IS NULL OR p_enc IS NULL THEN
    RAISE EXCEPTION 'invalid_connector_account: id, user, connector and token are required';
  END IF;
  -- Serializes links per user and connector so the active-row index holds under concurrency.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zerox_connector_accounts:' || p_user_id::text || ':' || p_connector));
  UPDATE public.zerox_connector_accounts AS a SET revoked_at = now(), updated_at = now()
    WHERE a.user_id = p_user_id AND a.connector = p_connector AND a.revoked_at IS NULL;
  RETURN QUERY INSERT INTO public.zerox_connector_accounts AS a (id, user_id, connector, enc_refresh_token, scopes)
    VALUES (p_id, p_user_id, p_connector, p_enc, coalesce(p_scopes, '{}'))
    RETURNING a.id, a.connector, a.scopes, a.created_at;
END;
$$;

-- The active link with its sealed tokens, for the proxy only (never sent to a client).
CREATE OR REPLACE FUNCTION public.zerox_connector_account_get(p_user_id uuid, p_connector text)
RETURNS TABLE (id uuid, connector text, enc_refresh_token text, scopes text[], created_at timestamptz,
  updated_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT a.id, a.connector, a.enc_refresh_token, a.scopes, a.created_at, a.updated_at
  FROM public.zerox_connector_accounts AS a
  WHERE a.user_id = p_user_id AND a.connector = p_connector AND a.revoked_at IS NULL;
$$;

-- Stores refreshed tokens on the active link (a link revoked meanwhile stays revoked).
CREATE OR REPLACE FUNCTION public.zerox_connector_account_rotate(p_id uuid, p_user_id uuid, p_enc text)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.zerox_connector_accounts AS a SET enc_refresh_token = p_enc, updated_at = now()
    WHERE a.id = p_id AND a.user_id = p_user_id AND a.revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- The user's active links, metadata only (never the sealed tokens).
CREATE OR REPLACE FUNCTION public.zerox_connector_accounts_list(p_user_id uuid)
RETURNS TABLE (connector text, scopes text[], created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT a.connector, a.scopes, a.created_at, a.updated_at
  FROM public.zerox_connector_accounts AS a
  WHERE a.user_id = p_user_id AND a.revoked_at IS NULL
  ORDER BY a.connector;
$$;

-- Revokes the user's active link for a connector. revoked = false when there was none.
CREATE OR REPLACE FUNCTION public.zerox_connector_account_revoke(p_user_id uuid, p_connector text)
RETURNS TABLE (revoked boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.zerox_connector_accounts AS a SET revoked_at = now(), updated_at = now()
    WHERE a.user_id = p_user_id AND a.connector = p_connector AND a.revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- One audit row (metadata only).
CREATE OR REPLACE FUNCTION public.zerox_connector_audit_add(p_user_id uuid, p_connector text, p_method text,
  p_tool text, p_tier text, p_decision text, p_status integer, p_duration_ms integer, p_bytes_in integer,
  p_bytes_out integer, p_args_sha256 text, p_error_class text)
RETURNS TABLE (id bigint)
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  INSERT INTO public.zerox_connector_audit AS t (user_id, connector, method, tool, tier, decision, status,
    duration_ms, bytes_in, bytes_out, args_sha256, error_class)
  VALUES (p_user_id, p_connector, left(p_method, 64), left(p_tool, 128), p_tier, p_decision, p_status,
    greatest(coalesce(p_duration_ms, 0), 0), greatest(coalesce(p_bytes_in, 0), 0), greatest(coalesce(p_bytes_out, 0), 0),
    p_args_sha256, left(p_error_class, 64))
  RETURNING t.id;
$$;

-- Deletes audit rows older than p_days (at least 1).
CREATE OR REPLACE FUNCTION public.zerox_connector_audit_purge(p_days integer DEFAULT 30)
RETURNS TABLE (purged bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_connector_audit AS t
    WHERE t.created_at < now() - pg_catalog.make_interval(days => greatest(coalesce(p_days, 30), 1));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows;
END;
$$;

ALTER TABLE public.zerox_connector_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_connector_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_connector_accounts, public.zerox_connector_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_connector_accounts, public.zerox_connector_audit TO service_role;

REVOKE ALL ON FUNCTION
  public.zerox_connector_account_link(uuid, uuid, text, text, text[]),
  public.zerox_connector_account_get(uuid, text),
  public.zerox_connector_account_rotate(uuid, uuid, text),
  public.zerox_connector_accounts_list(uuid),
  public.zerox_connector_account_revoke(uuid, text),
  public.zerox_connector_audit_add(uuid, text, text, text, text, text, integer, integer, integer, integer, text, text),
  public.zerox_connector_audit_purge(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_connector_account_link(uuid, uuid, text, text, text[]),
  public.zerox_connector_account_get(uuid, text),
  public.zerox_connector_account_rotate(uuid, uuid, text),
  public.zerox_connector_accounts_list(uuid),
  public.zerox_connector_account_revoke(uuid, text),
  public.zerox_connector_audit_add(uuid, text, text, text, text, text, integer, integer, integer, integer, text, text),
  public.zerox_connector_audit_purge(integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
