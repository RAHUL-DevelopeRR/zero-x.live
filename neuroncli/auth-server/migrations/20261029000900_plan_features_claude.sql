BEGIN;

-- Plans with Claude (docs/PLATFORM_CONTRACT.md section 1). Prices, limits and included credits
-- are unchanged. Free keeps the free tier only; Pro, Max and the legacy ultrawork plan have the
-- free and paid tiers, so Claude Sonnet 5.5 and Claude Opus 5.5 (paid pools) are billed from
-- their credits. The feature strings say that every plan has the same Neuron features. The same
-- strings are the static fallbacks in src/plan-policy.js (PLAN_CATALOG), the site's pricing.js
-- and the data-plan-features lists in pricing.html. Safe to re-run.

UPDATE public.zerox_plan_policy SET allowed_tiers = ARRAY['free', 'paid']::text[], updated_at = now()
  WHERE plan IN ('pro', 'max', 'ultrawork') AND NOT ('paid' = ANY (allowed_tiers));
UPDATE public.zerox_plan_policy SET allowed_tiers = ARRAY['free']::text[], updated_at = now()
  WHERE plan = 'free' AND allowed_tiers <> ARRAY['free']::text[];

UPDATE public.zerox_plan_policy AS p SET features = v.features, updated_at = now()
FROM (VALUES
  ('free', '["Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter", "100 requests and 500K tokens per day", "10 requests per minute, 2 at once", "Every Neuron feature, the same on all plans"]'::jsonb),
  ('pro', '["Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits", "$8 of credits included every month", "Free models with higher limits: 2,000 requests and 10M tokens per day", "30 requests per minute, 4 at once", "Every Neuron feature, the same on all plans"]'::jsonb),
  ('max', '["Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits", "$35 of credits included every month", "Free models with higher limits: 10,000 requests and 50M tokens per day", "60 requests per minute, 8 at once", "Every Neuron feature, the same on all plans"]'::jsonb),
  ('ultrawork', '["Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits", "$8 of credits included every month", "Free models with higher limits: 2,000 requests and 10M tokens per day", "30 requests per minute, 4 at once", "Every Neuron feature, the same on all plans"]'::jsonb)
) AS v(plan, features)
WHERE p.plan = v.plan AND p.features IS DISTINCT FROM v.features;

COMMIT;
