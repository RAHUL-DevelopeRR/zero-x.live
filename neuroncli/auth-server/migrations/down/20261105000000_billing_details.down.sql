BEGIN;
-- Dropping the tables and functions of 20261105000000_billing_details.sql takes short locks; give
-- up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105000000_billing_details.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- WARNING: this deletes every saved billing profile and every consent record. Nothing else in the
-- schema refers to them. Roll the gateway back first or together: a gateway that knows the
-- billing details step answers 503 on checkout and top-up once the functions are gone. The
-- history row is removed so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_billing_consents_latest(uuid);
DROP FUNCTION IF EXISTS public.zerox_billing_record_consents(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.zerox_billing_profile_upsert(uuid, jsonb);
DROP FUNCTION IF EXISTS public.zerox_billing_profile_get(uuid);
-- Its triggers go with the table; the sequence goes with the bigserial column.
DROP TABLE IF EXISTS public.zerox_billing_consents;
DROP TABLE IF EXISTS public.zerox_billing_profiles;
DROP FUNCTION IF EXISTS public.zerox_billing_consents_guard();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
