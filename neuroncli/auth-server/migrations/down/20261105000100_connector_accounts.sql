BEGIN;
-- Dropping the tables takes short locks; give up (and re-run) rather than queue behind a long
-- transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105000100_connector_accounts.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- Every linked connector account (the sealed vendor tokens), every connector audit row and the
-- rate counters are deleted with the tables; users link their connectors again after the migration is re-applied.
-- Switch hosted connectors off first (HOSTED_CONNECTORS unset): a gateway with them on answers
-- 503 on /api/connectors and /mcp/<id> while the functions are missing. The history row is removed
-- so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_connector_audit_purge(integer);
DROP FUNCTION IF EXISTS public.zerox_connector_audit_add(uuid, text, text, text, text, text, integer, integer, integer, integer, text, text);
DROP FUNCTION IF EXISTS public.zerox_connector_account_revoke(uuid, text);
DROP FUNCTION IF EXISTS public.zerox_connector_rate_take(uuid, integer);
DROP FUNCTION IF EXISTS public.zerox_connector_accounts_list(uuid);
DROP FUNCTION IF EXISTS public.zerox_connector_account_rotate(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.zerox_connector_account_get(uuid, text);
DROP FUNCTION IF EXISTS public.zerox_connector_account_link(uuid, uuid, text, text, text[]);

DROP TABLE IF EXISTS public.zerox_connector_rate;
DROP TABLE IF EXISTS public.zerox_connector_audit;
DROP TABLE IF EXISTS public.zerox_connector_accounts;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105000100';

NOTIFY pgrst, 'reload schema';

COMMIT;
