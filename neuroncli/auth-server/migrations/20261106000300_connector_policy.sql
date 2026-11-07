BEGIN;
-- Adding a column to zerox_plan_policy and recreating zerox_plan_policies_v2 take short locks;
-- give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Connector (MCP server) policy per plan (docs/PLATFORM_CONTRACT.md section 14.1). GET
-- /api/account returns it as policy.connectors; the Neuron CLI applies it after its managed
-- settings and before user and project settings. There are no organisations yet, so the plan is
-- the only gateway policy scope.
--
-- connector_policy is a JSON object (NULL = no gateway policy for the plan, the block is left out):
--   allowed         catalog ids, or "catalog:*" for every entry of the connector catalog
--   denied          catalog ids the CLI must not start (deny wins over allowed and required)
--   required        catalog ids the CLI starts with managed scope and the user cannot disable
--   hosted          catalog ids the plan may use through https://zero-x.live/mcp/<id>
--   allow_unvetted  whether servers that are not in the catalog may run
--   catalog_version the connector catalog version these ids were written against
-- The gateway validates every value again (src/connector-policy.js) and reports hosted ids only
-- while hosted connectors are switched on (HOSTED_CONNECTORS=true), so seeding them here exposes
-- nothing by itself.
--
-- Seed: Free gets local connectors only (hosted []); Pro, Max and the legacy ultrawork plan get
-- the hosted SaaS connectors. A plan whose policy an operator already set keeps it, so the file
-- is safe to re-run. zerox_plan_policies_v2 gains the column, so it is dropped and created again
-- (same arguments, same grants); zerox_account_overview returns to_jsonb of that row and picks the
-- column up unchanged. Roll back with migrations/down/20261106000300_connector_policy.sql
-- (psql -X -v ON_ERROR_STOP=1 -f). The gateway works against a database without this migration:
-- no policy.connectors block is returned.

ALTER TABLE public.zerox_plan_policy ADD COLUMN IF NOT EXISTS connector_policy jsonb;
ALTER TABLE public.zerox_plan_policy DROP CONSTRAINT IF EXISTS zerox_plan_policy_connector_policy_check;
ALTER TABLE public.zerox_plan_policy ADD CONSTRAINT zerox_plan_policy_connector_policy_check
  CHECK (connector_policy IS NULL OR jsonb_typeof(connector_policy) = 'object');
COMMENT ON COLUMN public.zerox_plan_policy.connector_policy IS
  'Connector (MCP) policy of the plan: {allowed, denied, required, hosted, allow_unvetted, catalog_version}; NULL = no gateway policy. Served as GET /api/account policy.connectors.';

UPDATE public.zerox_plan_policy AS p SET connector_policy = v.policy, updated_at = now()
FROM (VALUES
  ('free', '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": [], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb),
  ('pro', '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": ["atlassian", "github", "linear", "notion", "slack"], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb),
  ('max', '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": ["atlassian", "github", "linear", "notion", "slack"], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb),
  ('ultrawork', '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": ["atlassian", "github", "linear", "notion", "slack"], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb)
) AS v(plan, policy)
WHERE p.plan = v.plan AND p.connector_policy IS NULL;

-- The rows gain connector_policy (null when the plan has none).
DROP FUNCTION IF EXISTS public.zerox_plan_policies_v2();
CREATE FUNCTION public.zerox_plan_policies_v2()
RETURNS TABLE (plan text, name text, price_usd numeric, price_usd_cents bigint, price_inr_paise bigint,
  daily_requests bigint, daily_tokens bigint, rpm_limit integer, concurrency_limit integer,
  allowed_tiers text[], monthly_credit_microusd bigint, features jsonb, sort integer, public boolean,
  highlighted boolean, razorpay_plan_id_inr text, razorpay_plan_id_usd text, window_tokens bigint,
  window_seconds integer, connector_policy jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.plan, p.name, p.price_usd, round(p.price_usd * 100)::bigint, p.price_inr_paise,
    p.daily_requests, p.daily_tokens, p.rpm_limit, p.concurrency_limit, p.allowed_tiers,
    p.monthly_credit_microusd, p.features, p.sort, p.public, p.highlighted,
    p.razorpay_plan_id_inr, p.razorpay_plan_id_usd, p.window_tokens, p.window_seconds, p.connector_policy
  FROM public.zerox_plan_policy AS p
  ORDER BY p.sort, p.plan;
$$;

REVOKE ALL ON FUNCTION public.zerox_plan_policies_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zerox_plan_policies_v2() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
