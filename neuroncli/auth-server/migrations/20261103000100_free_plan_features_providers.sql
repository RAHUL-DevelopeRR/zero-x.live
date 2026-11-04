BEGIN;

-- The Free plan's first feature line named upstream providers. Zero-X does not name the providers
-- behind its free models on the pricing page (the privacy policy lists who receives requests),
-- and two of the providers it named, Google Gemini and Cloudflare Workers AI, are switched off
-- (GEMINI_MODELS and CLOUDFLARE_MODELS are empty in wrangler.toml). This replaces that line inside
-- zerox_plan_policy.features for the Free plan with "Free models with usage limits" and leaves
-- every other feature line, and every other plan, as it is. Three old texts are replaced:
--   * "Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter", seeded
--     by 20261029000900_plan_features_claude.sql;
--   * "Free-tier models (Groq, Gemini Flash, Workers AI)", the October seed of
--     20261016000000_business_schema.sql, still shown on a database where 20261029000900 was
--     never applied (production showed it on 2026-11-04);
--   * "Free models from Groq, NVIDIA, OpenRouter and Z.ai", an earlier draft of this file that
--     local and test databases may have applied.
-- It matches the old text instead of the whole list, so it works whatever else an operator has
-- changed, and is a no-op when no old text is there (a database that never had them, or one
-- already updated). The new line is the static fallback in src/plan-policy.js (PLAN_CATALOG),
-- pricing.js and pricing.html. Safe to re-run. 20261029000900_plan_features_claude.sql is
-- untouched; it still seeds the old line, and this file runs after it in version order.

UPDATE public.zerox_plan_policy
SET features = replace(replace(replace(features::text,
      'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
      'Free models with usage limits'),
      'Free-tier models (Groq, Gemini Flash, Workers AI)',
      'Free models with usage limits'),
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai',
      'Free models with usage limits')::jsonb,
    updated_at = now()
WHERE plan = 'free'
  AND (features::text LIKE '%Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter%'
    OR features::text LIKE '%Free-tier models (Groq, Gemini Flash, Workers AI)%'
    OR features::text LIKE '%Free models from Groq, NVIDIA, OpenRouter and Z.ai%');

COMMIT;
