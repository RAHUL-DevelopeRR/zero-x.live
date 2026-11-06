BEGIN;
-- One UPDATE of the plan rows; give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105000200_plan_features_haiku.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/. Removes
-- exactly the Claude Haiku 5.5 line from every plan; nothing else changes. The history row is
-- removed so the runner can apply the migration again.

UPDATE public.zerox_plan_policy AS p SET
  features = coalesce((SELECT jsonb_agg(f.value ORDER BY f.ordinality)
    FROM jsonb_array_elements(p.features) WITH ORDINALITY AS f(value, ordinality)
    WHERE f.value <> to_jsonb('Claude Haiku 5.5 included: 10M tokens a month at no charge'::text)), '[]'::jsonb),
  updated_at = now()
  WHERE p.features ? 'Claude Haiku 5.5 included: 10M tokens a month at no charge';

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105000200';

COMMIT;
