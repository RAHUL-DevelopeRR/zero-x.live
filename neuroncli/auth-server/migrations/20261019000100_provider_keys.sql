BEGIN;

-- Provider key vault (docs/PLATFORM_CONTRACT.md section 8.4). The operator adds free-tier
-- provider API keys on https://dashboard.zero-x.live/admin/keys instead of Worker secrets; each
-- active key becomes its own free pool in the gateway. Keys are stored only as AES-256-GCM
-- ciphertext under the Worker secret PROVIDER_KEYS_KEK, with the row id and provider as
-- additional data (src/provider-keys.js), so a ciphertext copied to another row does not open.
-- The id is chosen by the gateway before encrypting, which is why it has no default. Keys are
-- disabled, never deleted, so the list keeps a record of what was rotated out.

CREATE TABLE public.zerox_provider_keys (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('groq', 'gemini', 'nvidia', 'openrouter')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 64),
  ciphertext text NOT NULL CHECK (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$' AND char_length(ciphertext) BETWEEN 24 AND 2048),
  iv text NOT NULL CHECK (iv ~ '^[A-Za-z0-9+/]{16}$'),
  last4 text NOT NULL CHECK (char_length(last4) = 4),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  last_used_at timestamptz,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE INDEX zerox_provider_keys_active_idx ON public.zerox_provider_keys (provider, created_at)
  WHERE status = 'active';

-- Stores one sealed key. Raises too_many_keys when the provider already has 20 active keys
-- (each key adds a pool per model and a model-list check per minute).
CREATE FUNCTION public.zerox_provider_key_add(p_id uuid, p_provider text, p_label text, p_ciphertext text,
  p_iv text, p_last4 text)
RETURNS TABLE (id uuid, provider text, label text, last4 text, status text, created_at timestamptz,
  disabled_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'invalid_provider_key: p_id is required'; END IF;
  IF p_provider IS NULL THEN RAISE EXCEPTION 'invalid_provider_key: p_provider is required'; END IF;
  -- Serializes adds per provider so the cap holds under concurrent requests.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zerox_provider_keys:' || p_provider));
  IF (SELECT count(*) FROM public.zerox_provider_keys AS k
      WHERE k.provider = p_provider AND k.status = 'active') >= 20 THEN
    RAISE EXCEPTION 'too_many_keys';
  END IF;
  RETURN QUERY INSERT INTO public.zerox_provider_keys AS k (id, provider, label, ciphertext, iv, last4)
    VALUES (p_id, p_provider, p_label, p_ciphertext, p_iv, p_last4)
    RETURNING k.id, k.provider, k.label, k.last4, k.status, k.created_at, k.disabled_at, k.last_used_at;
END;
$$;

-- Metadata for the admin page: never the ciphertext or IV.
CREATE FUNCTION public.zerox_provider_keys_list()
RETURNS TABLE (id uuid, provider text, label text, last4 text, status text, created_at timestamptz,
  disabled_at timestamptz, last_used_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT k.id, k.provider, k.label, k.last4, k.status, k.created_at, k.disabled_at, k.last_used_at
  FROM public.zerox_provider_keys AS k
  ORDER BY k.status = 'active' DESC, k.provider, k.created_at, k.id;
$$;

-- What the gateway decrypts into pools (every isolate, at most once a minute).
CREATE FUNCTION public.zerox_provider_keys_active()
RETURNS TABLE (id uuid, provider text, label text, last4 text, ciphertext text, iv text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT k.id, k.provider, k.label, k.last4, k.ciphertext, k.iv, k.created_at
  FROM public.zerox_provider_keys AS k
  WHERE k.status = 'active'
  ORDER BY k.provider, k.created_at, k.id;
$$;

-- Disables a key (idempotent). No row means there is no such key.
CREATE FUNCTION public.zerox_provider_key_disable(p_id uuid)
RETURNS TABLE (id uuid, provider text, label text, last4 text, status text, created_at timestamptz,
  disabled_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY UPDATE public.zerox_provider_keys AS k SET status = 'disabled', disabled_at = now()
    WHERE k.id = p_id AND k.status = 'active'
    RETURNING k.id, k.provider, k.label, k.last4, k.status, k.created_at, k.disabled_at, k.last_used_at;
  IF NOT FOUND THEN
    RETURN QUERY SELECT k.id, k.provider, k.label, k.last4, k.status, k.created_at, k.disabled_at, k.last_used_at
      FROM public.zerox_provider_keys AS k WHERE k.id = p_id;
  END IF;
END;
$$;

-- Records that a key served a request. The gateway calls it at most once per key every
-- 10 minutes per isolate; writes closer than a minute apart are skipped here too.
CREATE FUNCTION public.zerox_provider_key_touch(p_id uuid)
RETURNS TABLE (touched boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.zerox_provider_keys AS k SET last_used_at = now()
    WHERE k.id = p_id AND k.status = 'active'
      AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

ALTER TABLE public.zerox_provider_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_provider_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_provider_keys TO service_role;

REVOKE ALL ON FUNCTION
  public.zerox_provider_key_add(uuid, text, text, text, text, text),
  public.zerox_provider_keys_list(),
  public.zerox_provider_keys_active(),
  public.zerox_provider_key_disable(uuid),
  public.zerox_provider_key_touch(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_provider_key_add(uuid, text, text, text, text, text),
  public.zerox_provider_keys_list(),
  public.zerox_provider_keys_active(),
  public.zerox_provider_key_disable(uuid),
  public.zerox_provider_key_touch(uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
