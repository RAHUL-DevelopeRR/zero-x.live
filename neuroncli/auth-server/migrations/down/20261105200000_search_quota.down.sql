BEGIN;
-- Dropping the search tables takes short locks; give up (and re-run) rather than queue behind a
-- long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105200000_search_quota.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/. Drops the
-- search quota functions and tables (the daily search counters are lost; they hold no query
-- text). A gateway that serves POST /v1/search then answers 503 search_unavailable until the
-- migration is applied again. The history row is removed so the runner can apply it again.

DROP FUNCTION IF EXISTS public.zerox_search_settle(uuid, date, text, text, boolean);
DROP FUNCTION IF EXISTS public.zerox_search_reserve(uuid, integer, integer, text);
DROP TABLE IF EXISTS public.zerox_search_research_runs;
DROP TABLE IF EXISTS public.zerox_search_usage;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105200000';

NOTIFY pgrst, 'reload schema';

COMMIT;
