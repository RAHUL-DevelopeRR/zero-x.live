BEGIN;
-- A few statements and one constraint swap on small tables; give up (and re-run) rather than queue
-- behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105000100_haiku_catalog.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/. Run it before
-- 20261029000700_catalog_seed.down.sql. Safe order: CATALOG_SOURCE=code (or the previous gateway)
-- first, which hides the row at once.
--
-- * The model row anthropic/claude-haiku-5-5 is disabled, not deleted (catalog rows are never
--   deleted, contract section 13.1); the audit log records it. Its revision and pool stay as history.
-- * zerox_catalog_slot_ok loses the free tier of anthropic.paid again, so the next snapshot drops
--   the pool as key_slot_not_allowed even if the row were enabled. zerox_catalog_slot_sponsors is dropped.
-- * The table check that keeps a free pool unpriced and uncapped comes back as it was, added NOT
--   VALID: it applies to new rows only, since the sponsored pool's own row (history) breaks it.
-- The history row is removed so the runner can apply the migration again; applying it again enables
-- the row.

SELECT public.zerox_catalog_set_status(m.id, 'disabled', 'migration',
  'Claude Haiku 5.5 disabled by the rollback of 20261105000100_haiku_catalog.sql')
FROM public.zerox_catalog_models AS m
WHERE m.id = 'anthropic/claude-haiku-5-5' AND m.status IN ('draft', 'active');

CREATE OR REPLACE FUNCTION public.zerox_catalog_slot_ok(p_type text, p_tier text, p_slot text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce((p_type, p_tier, p_slot) IN (
    ('gemini', 'free', 'gemini.free'), ('gemini', 'paid', 'gemini.paid'),
    ('groq', 'free', 'groq.free'), ('groq', 'paid', 'groq.paid'),
    ('nvidia', 'free', 'nvidia.free'),
    ('openrouter', 'free', 'openrouter.free'),
    ('omniroute', 'free', 'omniroute.free'),
    ('cloudflare', 'free', 'cloudflare.binding'), ('cloudflare', 'paid', 'cloudflare.binding'),
    ('anthropic', 'paid', 'anthropic.paid'),
    ('zai', 'free', 'zai.free')
  ), false);
$$;

ALTER TABLE public.zerox_catalog_revision_pools DROP CONSTRAINT IF EXISTS zerox_catalog_revision_pools_free_terms;
ALTER TABLE public.zerox_catalog_revision_pools ADD CHECK (tier = 'paid' OR (input_microusd_per_mtok IS NULL AND output_microusd_per_mtok IS NULL
  AND cache_read_microusd_per_mtok IS NULL AND cache_write_microusd_per_mtok IS NULL
  AND cache_write_1h_microusd_per_mtok IS NULL AND long_context_threshold IS NULL AND daily_spend_cap_microusd IS NULL)) NOT VALID;

DROP FUNCTION IF EXISTS public.zerox_catalog_slot_sponsors(text);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105000100';

NOTIFY pgrst, 'reload schema';

COMMIT;
