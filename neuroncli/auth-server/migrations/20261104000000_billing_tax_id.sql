BEGIN;
-- Adding the column takes a short exclusive lock on zerox_billing_profiles (and a scan of its rows
-- for the CHECK); give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- An optional tax id on the billing details a buyer gives before Razorpay opens (owner decision of
-- 2026-11-04; docs/PLATFORM_CONTRACT.md section 14.6). 20261103000000_billing_details.sql left it out
-- because Zero-X is not registered for GST; that is still true: the number is kept with the buyer's
-- billing record for their own records only. Zero-X charges no GST and issues no GST invoice, and
-- the number is never sent to Razorpay.
--
-- zerox_billing_profiles.tax_id: NULL when not given. For country 'IN' a GSTIN (15 characters: a
-- 2 digit state code, a 10 character PAN, an entity character, 'Z', a check character); for every
-- other country a VAT or tax id of 2 to 20 upper-case letters, digits or hyphens that starts and
-- ends with a letter or digit. The gateway normalises and validates first (src/billing/profile.js:
-- spaces removed, upper case, the GSTIN check character and that the state code matches the
-- buyer's state); this CHECK is the last line, not the friendly one, and does not repeat the check
-- character or the state match.
--
-- zerox_billing_profile_get and zerox_billing_profile_upsert are replaced (their result gains
-- tax_id, so they are dropped and created again) with the same SECURITY INVOKER, pinned search_path
-- and service_role-only grants. The upsert is still a PUT: an absent or empty tax_id is cleared.
-- Existing rows get NULL; nothing else changes.
--
-- Roll back with migrations/down/20261104000000_billing_tax_id.down.sql (psql -X -v ON_ERROR_STOP=1 -f);
-- that deletes every saved tax id and puts the two functions of 20261103000000 back.

ALTER TABLE public.zerox_billing_profiles ADD COLUMN tax_id text;
ALTER TABLE public.zerox_billing_profiles ADD CONSTRAINT zerox_billing_profiles_tax_id_check CHECK (
  tax_id IS NULL OR (
    length(tax_id) BETWEEN 2 AND 20
    AND tax_id ~ '^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$'
    AND (country <> 'IN' OR tax_id ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  )
);

DROP FUNCTION public.zerox_billing_profile_get(uuid);
DROP FUNCTION public.zerox_billing_profile_upsert(uuid, jsonb);

CREATE FUNCTION public.zerox_billing_profile_get(p_user_id uuid)
RETURNS TABLE (customer_type text, full_name text, business_name text, country text, state text, city text,
  postal_code text, address_line1 text, address_line2 text, phone_e164 text, tax_id text, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.customer_type, p.full_name, p.business_name, p.country, p.state, p.city, p.postal_code, p.address_line1,
    p.address_line2, p.phone_e164, p.tax_id, p.created_at, p.updated_at
  FROM public.zerox_billing_profiles AS p WHERE p.user_id = p_user_id;
$$;

CREATE FUNCTION public.zerox_billing_profile_upsert(p_user_id uuid, p_profile jsonb)
RETURNS TABLE (customer_type text, full_name text, business_name text, country text, state text, city text,
  postal_code text, address_line1 text, address_line2 text, phone_e164 text, tax_id text, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'invalid_billing_profile: expected a JSON object';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_profile) AS k
      WHERE k NOT IN ('customer_type', 'full_name', 'business_name', 'country', 'state', 'city', 'postal_code',
        'address_line1', 'address_line2', 'phone_e164', 'tax_id')) THEN
    RAISE EXCEPTION 'invalid_billing_profile: unknown field';
  END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  RETURN QUERY INSERT INTO public.zerox_billing_profiles AS p (user_id, customer_type, full_name, business_name, country,
      state, city, postal_code, address_line1, address_line2, phone_e164, tax_id)
    VALUES (p_user_id, coalesce(nullif(p_profile->>'customer_type', ''), 'individual'), p_profile->>'full_name',
      nullif(p_profile->>'business_name', ''), p_profile->>'country', nullif(p_profile->>'state', ''), p_profile->>'city',
      nullif(p_profile->>'postal_code', ''), nullif(p_profile->>'address_line1', ''), nullif(p_profile->>'address_line2', ''),
      nullif(p_profile->>'phone_e164', ''), nullif(p_profile->>'tax_id', ''))
    ON CONFLICT (user_id) DO UPDATE SET
      customer_type = EXCLUDED.customer_type, full_name = EXCLUDED.full_name, business_name = EXCLUDED.business_name,
      country = EXCLUDED.country, state = EXCLUDED.state, city = EXCLUDED.city, postal_code = EXCLUDED.postal_code,
      address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2, phone_e164 = EXCLUDED.phone_e164,
      tax_id = EXCLUDED.tax_id, updated_at = now()
    RETURNING p.customer_type, p.full_name, p.business_name, p.country, p.state, p.city, p.postal_code, p.address_line1,
      p.address_line2, p.phone_e164, p.tax_id, p.created_at, p.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
