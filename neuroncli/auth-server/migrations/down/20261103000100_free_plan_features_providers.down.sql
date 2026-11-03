BEGIN;

-- Reverts 20261103000100_free_plan_features_providers.sql: puts the earlier Free plan provider
-- line back (the text seeded by 20261029000900_plan_features_claude.sql). Safe to re-run. Run it
-- by hand (psql -X -v ON_ERROR_STOP=1 -f <this file>); the migration runner never reads
-- migrations/down/. The DELETE below removes the runner's history row so the migration can be
-- applied again.

UPDATE public.zerox_plan_policy
SET features = replace(features::text,
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai',
      'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter')::jsonb,
    updated_at = now()
WHERE plan = 'free'
  AND features::text LIKE '%Free models from Groq, NVIDIA, OpenRouter and Z.ai%';

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261103000100';

COMMIT;
