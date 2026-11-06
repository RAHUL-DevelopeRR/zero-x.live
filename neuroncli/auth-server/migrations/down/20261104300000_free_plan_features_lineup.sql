BEGIN;
-- One UPDATE of the Free plan row; give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261104300000_free_plan_features_lineup.sql by hand: psql -X -v ON_ERROR_STOP=1 -f
-- <this file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- The Free plan's "Free models chosen for coding, with tool use" line goes back to the line the
-- migrations before it left: 20261103000100_free_plan_features_providers.sql's when that migration
-- is in the history (feat/billing-details-and-legal), otherwise
-- 20261029000900_plan_features_claude.sql's. Nothing else changes. The history row is removed so
-- the runner can apply the migration again.

UPDATE public.zerox_plan_policy AS p SET
  features = coalesce((SELECT jsonb_agg(CASE WHEN f.value = 'Free models chosen for coding, with tool use'
      THEN CASE WHEN EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations AS h WHERE h.version = '20261103000100')
        THEN 'Free models from Groq, NVIDIA, OpenRouter and Z.ai'
        ELSE 'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter' END
      ELSE f.value END ORDER BY f.ordinality)
    FROM jsonb_array_elements_text(p.features) WITH ORDINALITY AS f(value, ordinality)), '[]'::jsonb),
  updated_at = now()
  WHERE p.plan = 'free' AND p.features ? 'Free models chosen for coding, with tool use';

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261104300000';

COMMIT;
