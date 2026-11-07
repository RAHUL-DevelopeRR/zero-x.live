BEGIN;
-- One UPDATE of the plan rows; give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Claude Haiku 5.5 is included on every plan at no charge, up to 10M tokens a month per account
-- (docs/PLATFORM_CONTRACT.md section 19). The plans' feature lines say so: the line becomes the
-- second line of Free (after "Free models chosen for coding, with tool use") and the first line of
-- Pro, Max and ultrawork. The same line is in src/plan-policy.js (PLAN_CATALOG), the site's
-- pricing.js fallback and the data-plan-features lists in pricing.html. Guarded like
-- 20261104300000: a plan whose features already contain the line is not touched, every other line
-- and every other plan stays as it is. Safe to re-run; no gateway restart needed. Roll back with
-- migrations/down/20261106000800_plan_features_haiku.sql.

UPDATE public.zerox_plan_policy AS p SET
  features = coalesce((SELECT jsonb_agg(q.value ORDER BY q.ord) FROM (
      SELECT f.value, f.ordinality * 2 AS ord FROM jsonb_array_elements(p.features) WITH ORDINALITY AS f(value, ordinality)
      UNION ALL
      SELECT to_jsonb('Claude Haiku 5.5 included: 10M tokens a month at no charge'::text),
        CASE WHEN p.plan = 'free' THEN 3 ELSE 0 END) AS q), '[]'::jsonb),
  updated_at = now()
  WHERE p.plan IN ('free', 'pro', 'max', 'ultrawork')
    AND NOT (p.features ? 'Claude Haiku 5.5 included: 10M tokens a month at no charge');

COMMIT;
