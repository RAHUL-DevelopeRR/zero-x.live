BEGIN;

-- Reverts 20261029000900_plan_features_claude.sql: restores the plan feature strings seeded by
-- 20261016000000_business_schema.sql. allowed_tiers stay as they are: the seed already gave Pro,
-- Max and ultrawork the paid tier and Free the free tier only, so the up migration changes them
-- only where an operator had removed paid from a paid plan. Safe to re-run.

UPDATE public.zerox_plan_policy AS p SET features = v.features, updated_at = now()
FROM (VALUES
  ('free', '["100 requests per day", "500K tokens per day", "Free-tier models (Groq, Gemini Flash, Workers AI)", "10 requests per minute, 2 concurrent", "Usage dashboard"]'::jsonb),
  ('pro', '["2,000 requests per day", "10M tokens per day", "$8 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "30 requests per minute, 4 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb),
  ('max', '["10,000 requests per day", "50M tokens per day", "$35 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "60 requests per minute, 8 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb),
  ('ultrawork', '["2,000 requests per day", "10M tokens per day", "$8 of monthly credits for paid models", "Paid upstream capacity when free pools are busy", "30 requests per minute, 4 concurrent", "API keys for headless and CI runs", "Usage dashboard"]'::jsonb)
) AS v(plan, features)
WHERE p.plan = v.plan AND p.features IS DISTINCT FROM v.features;

COMMIT;
