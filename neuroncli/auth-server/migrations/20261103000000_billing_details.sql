BEGIN;
-- The two foreign keys take a short lock on zerox_accounts; give up (and re-run) rather than
-- queue behind a long transaction. Nothing else existing is changed.
SET LOCAL lock_timeout = '5s';

-- Billing details a buyer gives Zero-X before Razorpay opens (docs/PLATFORM_CONTRACT.md section
-- 3.5, GET/PUT /api/billing/profile, and the details step in billing-details.js), and a record of
-- the documents each buyer agreed to at checkout.
--
-- Only plain contact and address details live here. Card, UPI and bank details are typed into
-- Razorpay's own window and never reach Zero-X. There is no tax id (GSTIN) column: Zero-X is not
-- registered for GST.
--
-- zerox_billing_profiles: one row per account (name, country, state, city, postal code, optional
-- address lines, phone and business name). customer_type 'business' needs a business name and
-- an address line. The gateway validates everything first (src/billing/profile.js); these CHECKs
-- are the last line, not the friendly one. The row goes with the account (ON DELETE CASCADE), like
-- the account's other personal data. NOTE: zerox_payments and zerox_subscriptions also cascade, so
-- deleting an account deletes its payment records too; keeping them for the period tax law
-- requires needs a schema change that is not part of this migration.
--
-- zerox_billing_consents: append-only. Each row says that a buyer agreed to one version of one
-- document (terms, privacy, refund or auto_renewal, the renewal notice shown beside the Subscribe
-- button) while buying a subscription or a top-up. Versions are the dates in
-- src/billing/legal-versions.js. A trigger refuses every UPDATE, every TRUNCATE and every DELETE
-- except the one the database itself runs when an account is deleted (foreign key action).
--
-- RPCs (SECURITY INVOKER, service_role only, like every other zerox_* function):
--   zerox_billing_profile_get(user)          the profile row, none when the buyer has not saved one
--   zerox_billing_profile_upsert(user, json) saves the whole profile (a PUT: absent optional keys are cleared)
--   zerox_billing_record_consents(user, context, {document: version}) appends one row per document
--   zerox_billing_consents_latest(user)      the newest version of each document the buyer agreed to
-- Roll back with migrations/down/20261103000000_billing_details.down.sql (psql -X -v ON_ERROR_STOP=1 -f);
-- that deletes every saved profile and consent record.

CREATE TABLE public.zerox_billing_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  customer_type text NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual', 'business')),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  business_name text CHECK (business_name IS NULL OR length(btrim(business_name)) BETWEEN 1 AND 120),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  state text CHECK (state IS NULL OR length(btrim(state)) BETWEEN 1 AND 80),
  city text NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 80),
  postal_code text CHECK (postal_code IS NULL OR length(btrim(postal_code)) BETWEEN 1 AND 12),
  address_line1 text CHECK (address_line1 IS NULL OR length(btrim(address_line1)) BETWEEN 1 AND 120),
  address_line2 text CHECK (address_line2 IS NULL OR length(btrim(address_line2)) BETWEEN 1 AND 120),
  phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (country <> 'IN' OR state IS NOT NULL),
  CHECK (customer_type <> 'business' OR (business_name IS NOT NULL AND address_line1 IS NOT NULL)),
  CHECK (address_line2 IS NULL OR address_line1 IS NOT NULL)
);

CREATE TABLE public.zerox_billing_consents (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  document text NOT NULL CHECK (document IN ('terms', 'privacy', 'refund', 'auto_renewal')),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  context text NOT NULL CHECK (context IN ('subscription', 'topup')),
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zerox_billing_consents_user_idx
  ON public.zerox_billing_consents (user_id, document, accepted_at DESC, id DESC);

-- Append-only. The foreign key action that deletes a buyer's rows with their account runs inside
-- the database's own trigger (depth 2 here); a direct DELETE, any UPDATE and TRUNCATE do not.
CREATE FUNCTION public.zerox_billing_consents_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'consents_append_only: consent records are never changed or deleted';
END;
$$;
CREATE TRIGGER zerox_billing_consents_guard BEFORE UPDATE OR DELETE ON public.zerox_billing_consents
  FOR EACH ROW EXECUTE FUNCTION public.zerox_billing_consents_guard();
CREATE TRIGGER zerox_billing_consents_no_truncate BEFORE TRUNCATE ON public.zerox_billing_consents
  FOR EACH STATEMENT EXECUTE FUNCTION public.zerox_billing_consents_guard();

CREATE FUNCTION public.zerox_billing_profile_get(p_user_id uuid)
RETURNS TABLE (customer_type text, full_name text, business_name text, country text, state text, city text,
  postal_code text, address_line1 text, address_line2 text, phone_e164 text, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.customer_type, p.full_name, p.business_name, p.country, p.state, p.city, p.postal_code, p.address_line1,
    p.address_line2, p.phone_e164, p.created_at, p.updated_at
  FROM public.zerox_billing_profiles AS p WHERE p.user_id = p_user_id;
$$;

CREATE FUNCTION public.zerox_billing_profile_upsert(p_user_id uuid, p_profile jsonb)
RETURNS TABLE (customer_type text, full_name text, business_name text, country text, state text, city text,
  postal_code text, address_line1 text, address_line2 text, phone_e164 text, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'invalid_billing_profile: expected a JSON object';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_profile) AS k
      WHERE k NOT IN ('customer_type', 'full_name', 'business_name', 'country', 'state', 'city', 'postal_code',
        'address_line1', 'address_line2', 'phone_e164')) THEN
    RAISE EXCEPTION 'invalid_billing_profile: unknown field';
  END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  RETURN QUERY INSERT INTO public.zerox_billing_profiles AS p (user_id, customer_type, full_name, business_name, country,
      state, city, postal_code, address_line1, address_line2, phone_e164)
    VALUES (p_user_id, coalesce(nullif(p_profile->>'customer_type', ''), 'individual'), p_profile->>'full_name',
      nullif(p_profile->>'business_name', ''), p_profile->>'country', nullif(p_profile->>'state', ''), p_profile->>'city',
      nullif(p_profile->>'postal_code', ''), nullif(p_profile->>'address_line1', ''), nullif(p_profile->>'address_line2', ''),
      nullif(p_profile->>'phone_e164', ''))
    ON CONFLICT (user_id) DO UPDATE SET
      customer_type = EXCLUDED.customer_type, full_name = EXCLUDED.full_name, business_name = EXCLUDED.business_name,
      country = EXCLUDED.country, state = EXCLUDED.state, city = EXCLUDED.city, postal_code = EXCLUDED.postal_code,
      address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2, phone_e164 = EXCLUDED.phone_e164,
      updated_at = now()
    RETURNING p.customer_type, p.full_name, p.business_name, p.country, p.state, p.city, p.postal_code, p.address_line1,
      p.address_line2, p.phone_e164, p.created_at, p.updated_at;
END;
$$;

CREATE FUNCTION public.zerox_billing_record_consents(p_user_id uuid, p_context text, p_consents jsonb)
RETURNS TABLE (recorded integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows integer;
BEGIN
  IF p_context IS NULL OR p_context NOT IN ('subscription', 'topup') THEN
    RAISE EXCEPTION 'invalid_consent: context must be subscription or topup';
  END IF;
  IF p_consents IS NULL OR jsonb_typeof(p_consents) <> 'object' THEN
    RAISE EXCEPTION 'invalid_consent: expected an object of document versions';
  END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  INSERT INTO public.zerox_billing_consents (user_id, document, version, context)
    SELECT p_user_id, e.key, e.value, p_context FROM jsonb_each_text(p_consents) AS e ORDER BY e.key;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows;
END;
$$;

CREATE FUNCTION public.zerox_billing_consents_latest(p_user_id uuid)
RETURNS TABLE (document text, version text, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT DISTINCT ON (c.document) c.document, c.version, c.accepted_at
  FROM public.zerox_billing_consents AS c WHERE c.user_id = p_user_id
  ORDER BY c.document, c.accepted_at DESC, c.id DESC;
$$;

ALTER TABLE public.zerox_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_billing_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_billing_profiles, public.zerox_billing_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_billing_profiles, public.zerox_billing_consents TO service_role;
REVOKE ALL ON SEQUENCE public.zerox_billing_consents_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.zerox_billing_consents_id_seq TO service_role;

REVOKE ALL ON FUNCTION
  public.zerox_billing_consents_guard(),
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb),
  public.zerox_billing_record_consents(uuid, text, jsonb),
  public.zerox_billing_consents_latest(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_billing_consents_guard(),
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb),
  public.zerox_billing_record_consents(uuid, text, jsonb),
  public.zerox_billing_consents_latest(uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
