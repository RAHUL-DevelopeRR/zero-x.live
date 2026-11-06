BEGIN;
-- Recreating zerox_plan_policies_v2 and dropping the column take short locks; give up (and
-- re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261105000000_connector_policy.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- zerox_plan_policies_v2 comes back as 20261102000000_free_token_window.sql left it (dropped and
-- created again, since its result loses a column; the grants are restored), and
-- zerox_plan_policy.connector_policy is dropped with every plan's connector policy in it. A
-- gateway that knows the column keeps working: /api/account then leaves policy.connectors out
-- (no gateway policy). Run it before down/20261102000000_free_token_window.sql if both are
-- rolled back. The history row is removed so the runner can apply the migration again.

DROP FUNCTION IF EXISTS public.zerox_plan_policies_v2();
CREATE OR REPLACE FUNCTION public.zerox_plan_policies_v2()
RETURNS TABLE (plan text, name text, price_usd numeric, price_usd_cents bigint, price_inr_paise bigint,
  daily_requests bigint, daily_tokens bigint, rpm_limit integer, concurrency_limit integer,
  allowed_tiers text[], monthly_credit_microusd bigint, features jsonb, sort integer, public boolean,
  highlighted boolean, razorpay_plan_id_inr text, razorpay_plan_id_usd text, window_tokens bigint,
  window_seconds integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.plan, p.name, p.price_usd, round(p.price_usd * 100)::bigint, p.price_inr_paise,
    p.daily_requests, p.daily_tokens, p.rpm_limit, p.concurrency_limit, p.allowed_tiers,
    p.monthly_credit_microusd, p.features, p.sort, p.public, p.highlighted,
    p.razorpay_plan_id_inr, p.razorpay_plan_id_usd, p.window_tokens, p.window_seconds
  FROM public.zerox_plan_policy AS p
  ORDER BY p.sort, p.plan;
$$;

REVOKE ALL ON FUNCTION public.zerox_plan_policies_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_plan_policies_v2() TO service_role;

ALTER TABLE public.zerox_plan_policy DROP CONSTRAINT IF EXISTS zerox_plan_policy_connector_policy_check;
ALTER TABLE public.zerox_plan_policy DROP COLUMN IF EXISTS connector_policy;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105000000';

NOTIFY pgrst, 'reload schema';

COMMIT;
