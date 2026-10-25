BEGIN;

-- Reverts 20261025000000_catalog_models.sql, by hand, after 20261025000100_catalog_seed.down.sql.
-- Deploy the gateway with CATALOG_SOURCE=code (or revert the code) first: without the RPCs the
-- loader keeps its last snapshot, then serves the code catalog. Dropping the tables discards every
-- catalog row, revision and audit event (export zerox_catalog_events first if they matter).
-- DROP TABLE does not fire the no-delete triggers.

DROP FUNCTION IF EXISTS public.zerox_operator_audit_list(integer, timestamptz);
DROP VIEW IF EXISTS public.zerox_operator_audit;
DROP FUNCTION IF EXISTS public.zerox_catalog_events_list(text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.zerox_catalog_model(text);
DROP FUNCTION IF EXISTS public.zerox_catalog_list();
DROP FUNCTION IF EXISTS public.zerox_catalog_snapshot();
DROP FUNCTION IF EXISTS public.zerox_catalog_revision_json(bigint);
DROP FUNCTION IF EXISTS public.zerox_catalog_revision_spec(bigint);
DROP FUNCTION IF EXISTS public.zerox_catalog_set_status(text, text, text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_reject(text, bigint, text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_approve(text, bigint, bigint, text, text, jsonb);
DROP FUNCTION IF EXISTS public.zerox_catalog_propose(jsonb, text, text, jsonb, text, bigint);
DROP FUNCTION IF EXISTS public.zerox_catalog_insert_revision(text, jsonb, text, text);

DROP TABLE IF EXISTS public.zerox_catalog_events;
ALTER TABLE IF EXISTS public.zerox_catalog_models DROP CONSTRAINT IF EXISTS zerox_catalog_models_active_fk,
  DROP CONSTRAINT IF EXISTS zerox_catalog_models_pending_fk;
DROP TABLE IF EXISTS public.zerox_catalog_revision_pools;
DROP TABLE IF EXISTS public.zerox_catalog_revisions;
DROP TABLE IF EXISTS public.zerox_catalog_models;

DROP FUNCTION IF EXISTS public.zerox_catalog_append_only();
DROP FUNCTION IF EXISTS public.zerox_catalog_pools_guard();
DROP FUNCTION IF EXISTS public.zerox_catalog_revisions_audit();
DROP FUNCTION IF EXISTS public.zerox_catalog_revisions_guard();
DROP FUNCTION IF EXISTS public.zerox_catalog_models_audit();
DROP FUNCTION IF EXISTS public.zerox_catalog_models_guard();
DROP FUNCTION IF EXISTS public.zerox_catalog_context(text, text, text, jsonb, bigint);
DROP FUNCTION IF EXISTS public.zerox_catalog_efforts_ok(text[]);
DROP FUNCTION IF EXISTS public.zerox_catalog_geo_ok(text[]);
DROP FUNCTION IF EXISTS public.zerox_catalog_aliases_ok(text[]);
DROP FUNCTION IF EXISTS public.zerox_catalog_can(text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_type_max_cap_microusd(text);
DROP FUNCTION IF EXISTS public.zerox_catalog_slot_ok(text, text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_upstream_ok(text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_public_id(text, text);
DROP FUNCTION IF EXISTS public.zerox_catalog_provider_types();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261025000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
