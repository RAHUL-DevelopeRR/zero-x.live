BEGIN;
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261104000000_health_probes.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/. Turn the
-- probes off first (HEALTH_PROBES=off on the gateway, or roll the gateway back): a gateway that
-- finds these functions missing logs it once and reports every model without a recent
-- observation as unknown. The probe counts already added to zerox_pool_usage stay (they were
-- real upstream requests). The history row is removed so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_pool_health_get(integer);
DROP FUNCTION IF EXISTS public.zerox_pool_health_put(jsonb);
DROP FUNCTION IF EXISTS public.zerox_probe_release(uuid);
DROP FUNCTION IF EXISTS public.zerox_probe_take(text, text, text, jsonb, bigint, bigint, boolean, integer);
DROP FUNCTION IF EXISTS public.zerox_health_lease(text, integer);
DROP TABLE IF EXISTS public.zerox_health_lease;
DROP TABLE IF EXISTS public.zerox_pool_health;
-- Probe slot rows have no user: remove them before user_id is required again (this scans
-- zerox_reservations once).
DELETE FROM public.zerox_reservations AS r WHERE r.user_id IS NULL;
ALTER TABLE public.zerox_reservations DROP CONSTRAINT IF EXISTS zerox_reservations_user_or_probe;
ALTER TABLE public.zerox_reservations ALTER COLUMN user_id SET NOT NULL;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261104000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
