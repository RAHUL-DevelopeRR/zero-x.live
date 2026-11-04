BEGIN;

-- The Free plan's provider line named Google Gemini and Cloudflare Workers AI, which the gateway
-- has switched off (GEMINI_MODELS and CLOUDFLARE_MODELS are empty in wrangler.toml) while Z.ai's
-- free GLM models are on. This replaces that line inside zerox_plan_policy.features for the Free
-- plan with "Free models from Groq, NVIDIA, OpenRouter and Z.ai" and leaves every other feature
-- line, and every other plan, as it is. Two old texts are replaced:
--   * "Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter", seeded
--     by 20261029000900_plan_features_claude.sql;
--   * "Free-tier models (Groq, Gemini Flash, Workers AI)", the October seed of
--     20261016000000_business_schema.sql, still shown on a database where 20261029000900 was
--     never applied (production showed it on 2026-11-04).
-- It matches the old text instead of the whole list, so it works whatever else an operator has
-- changed, and is a no-op when neither old text is there (a database that never had them, or one
-- already updated). The new line is the static fallback in src/plan-policy.js (PLAN_CATALOG),
-- pricing.js and pricing.html. Safe to re-run. 20261029000900_plan_features_claude.sql is
-- untouched; it still seeds the old line, and this file runs after it in version order.

UPDATE public.zerox_plan_policy
SET features = replace(replace(features::text,
      'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai'),
      'Free-tier models (Groq, Gemini Flash, Workers AI)',
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai')::jsonb,
    updated_at = now()
WHERE plan = 'free'
  AND (features::text LIKE '%Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter%'
    OR features::text LIKE '%Free-tier models (Groq, Gemini Flash, Workers AI)%');

COMMIT;
