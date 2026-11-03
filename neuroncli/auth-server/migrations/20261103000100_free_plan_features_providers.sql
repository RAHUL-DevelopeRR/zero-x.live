BEGIN;

-- The Free plan's first feature line named Google Gemini and Cloudflare Workers AI, which the
-- gateway has switched off (GEMINI_MODELS and CLOUDFLARE_MODELS are empty in wrangler.toml) while
-- Z.ai's free GLM models are on. This replaces that text inside zerox_plan_policy.features for the
-- Free plan and leaves every other feature line, and every other plan, as it is. It matches the
-- old text instead of the whole list, so it works whatever else an operator has changed, and is
-- a no-op when the old text is not there (a database that never had it, or one already updated).
-- The same line is the static fallback in src/plan-policy.js (PLAN_CATALOG), pricing.js and
-- pricing.html. Safe to re-run. 20261029000900_plan_features_claude.sql is untouched; it still
-- seeds the old line, and this file runs after it in version order.

UPDATE public.zerox_plan_policy
SET features = replace(features::text,
      'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai')::jsonb,
    updated_at = now()
WHERE plan = 'free'
  AND features::text LIKE '%Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter%';

COMMIT;
