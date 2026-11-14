BEGIN;
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261114000000_pool_refusals.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- Drops zerox_note_pool_refusal and the zerox_pool_refusals table with the refusals it recorded.
-- Any gateway keeps working afterwards: it skips the record when the function is missing. The
-- history row is removed so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_note_pool_refusal(text, text, text, text, text, text, bigint, integer, jsonb, text);
DROP TABLE IF EXISTS public.zerox_pool_refusals;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
