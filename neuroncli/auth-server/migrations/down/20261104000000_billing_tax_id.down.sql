BEGIN;
-- Dropping the column and replacing the two functions of 20261104000000_billing_tax_id.sql takes
-- short locks; give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261104000000_billing_tax_id.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- WARNING: this deletes every saved tax id (GSTIN or VAT number); every other billing detail and
-- every consent record stays. zerox_billing_profile_get and zerox_billing_profile_upsert go back to
-- their 20261103000000_billing_details.sql definitions (no tax_id), with the same grants. Roll the
-- gateway back first or together: a gateway that sends tax_id is refused with
-- "invalid_billing_profile: unknown field" once the old upsert is back. The history row is removed
-- so the runner can apply the migration again. Safe to run twice.

DROP FUNCTION IF EXISTS public.zerox_billing_profile_get(uuid);
DROP FUNCTION IF EXISTS public.zerox_billing_profile_upsert(uuid, jsonb);
-- The CHECK constraint goes with the column.
ALTER TABLE public.zerox_billing_profiles DROP COLUMN IF EXISTS tax_id;

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

REVOKE ALL ON FUNCTION
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_billing_profile_get(uuid),
  public.zerox_billing_profile_upsert(uuid, jsonb)
  TO service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261104000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
