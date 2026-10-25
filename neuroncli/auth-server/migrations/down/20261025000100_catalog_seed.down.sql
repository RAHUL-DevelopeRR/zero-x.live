BEGIN;

-- Reverts 20261025000100_catalog_seed.sql, by hand, before 20261025000000_catalog_models.down.sql.
-- Safe order: deploy the gateway with CATALOG_SOURCE=code (or revert the code) first; running code
-- that loses the rows serves its last snapshot, then the code catalog, so there is no outage.
--
-- Removes the seeded and imported model rows (operator-proposed rows stay) and the anthropic.paid
-- offer with its events. Skip the offer part when another applied migration (the Claude adapter's)
-- also creates that offer and should keep it. The catalog tables refuse deletes through triggers,
-- so this script switches them off for its own statements and back on.

ALTER TABLE public.zerox_catalog_models DISABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_revisions DISABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_revision_pools DISABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_events DISABLE TRIGGER USER;

CREATE TEMP TABLE zerox_catalog_unseed ON COMMIT DROP AS
  SELECT m.id FROM public.zerox_catalog_models AS m
  WHERE m.source = 'seed' OR (m.source = 'discovery' AND EXISTS (SELECT 1 FROM public.zerox_catalog_events AS e
    WHERE e.model_id = m.id AND e.action = 'import' AND e.actor = 'migration'));

UPDATE public.zerox_catalog_models AS m SET status = 'disabled', active_revision_id = NULL, pending_revision_id = NULL
WHERE m.id IN (SELECT u.id FROM pg_temp.zerox_catalog_unseed AS u);
DELETE FROM public.zerox_catalog_events AS e WHERE e.model_id IN (SELECT u.id FROM pg_temp.zerox_catalog_unseed AS u);
DELETE FROM public.zerox_catalog_revision_pools AS p USING public.zerox_catalog_revisions AS r
WHERE p.revision_id = r.id AND r.model_id IN (SELECT u.id FROM pg_temp.zerox_catalog_unseed AS u);
DELETE FROM public.zerox_catalog_revisions AS r WHERE r.model_id IN (SELECT u.id FROM pg_temp.zerox_catalog_unseed AS u);
DELETE FROM public.zerox_catalog_models AS m WHERE m.id IN (SELECT u.id FROM pg_temp.zerox_catalog_unseed AS u);

ALTER TABLE public.zerox_catalog_models ENABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_revisions ENABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_revision_pools ENABLE TRIGGER USER;
ALTER TABLE public.zerox_catalog_events ENABLE TRIGGER USER;

-- zerox_offer_events rows go with the offer (ON DELETE CASCADE).
DELETE FROM public.zerox_offers AS o WHERE o.id = 'anthropic.paid';

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261025000100';

NOTIFY pgrst, 'reload schema';

COMMIT;
