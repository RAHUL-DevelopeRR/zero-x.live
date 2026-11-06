BEGIN;
-- One UPDATE of the four plan rows; give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- The Free plan's first feature line on the pricing page named the services behind the free
-- models, including Google Gemini and Cloudflare Workers AI, which the gateway has switched off
-- (GEMINI_MODELS and CLOUDFLARE_MODELS are empty in wrangler.toml). The site names models by their
-- makers only, so the line now describes the models instead: "Free models chosen for coding, with
-- tool use". Guarded: only a line this file knows is replaced, inside the Free plan's features, and
-- every other line and every other plan is left as it is. Known lines: the seed's
-- (20261016000000_business_schema.sql), 20261029000900_plan_features_claude.sql's, and
-- 20261103000100_free_plan_features_providers.sql's (feat/billing-details-and-legal), so it works
-- whichever of those ran last. A row already updated or edited by an operator is not touched.
-- The same line is the static fallback in src/plan-policy.js (PLAN_CATALOG), the site's pricing.js
-- and the data-plan-features list in pricing.html. Safe to re-run. Roll back with
-- migrations/down/20261104300000_free_plan_features_lineup.sql.

UPDATE public.zerox_plan_policy AS p SET
  features = coalesce((SELECT jsonb_agg(CASE WHEN f.value IN (
        'Free-tier models (Groq, Gemini Flash, Workers AI)',
        'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
        'Free models from Groq, NVIDIA, OpenRouter and Z.ai')
      THEN 'Free models chosen for coding, with tool use' ELSE f.value END ORDER BY f.ordinality)
    FROM jsonb_array_elements_text(p.features) WITH ORDINALITY AS f(value, ordinality)), '[]'::jsonb),
  updated_at = now()
  WHERE p.plan = 'free'
    AND p.features ?| ARRAY['Free-tier models (Groq, Gemini Flash, Workers AI)',
      'Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
      'Free models from Groq, NVIDIA, OpenRouter and Z.ai'];

COMMIT;
