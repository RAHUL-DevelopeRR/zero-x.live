BEGIN;
-- Swaps the plan CHECK constraints and replaces two functions: short locks on zerox_accounts,
-- zerox_plan_policy and zerox_subscriptions. Give up (and re-run) rather than queue behind a long
-- transaction.
SET LOCAL lock_timeout = '5s';

-- Two paid plans below Pro, approved by the owner on 2026-11-08 (docs/PLATFORM_CONTRACT.md section 1):
--   athlete  "Athlete"  $1 / Rs 89 a month    300 requests and 6M tokens a day, 15 rpm, 2 at once,
--                                             $0.75 of credits a month (750000 micro-USD)
--   speed    "Speed"    $5 / Rs 449 a month   1,000 requests and 8M tokens a day, 20 rpm, 3 at once,
--                                             $4 of credits a month (4000000 micro-USD)
-- Both have the free and paid tiers like Pro and Max, sort between Free (10) and Pro (20), are
-- public and not highlighted (Pro stays highlighted), and get the same connector policy as Pro.
-- Their feature lines are the ones in src/plan-policy.js (PLAN_CATALOG), the site's pricing.js
-- fallback and pricing.html.
--
-- 1. The plan CHECK constraints accept the two ids: zerox_accounts.plan and .manual_plan,
--    zerox_plan_policy.plan and zerox_subscriptions.plan. Each single-column CHECK on those
--    columns is dropped whatever its name and added again by name, like 20261016000000.
-- 2. zerox_billing_upsert_subscription and zerox_billing_record_checkout accept them (same
--    signatures and bodies as 20261016000200 apart from the plan list; grants are kept).
-- 3. The two zerox_plan_policy rows are upserted. A row that already exists keeps its Razorpay
--    plan ids (stored later by scripts/razorpay-bootstrap.mjs) and its connector policy when an
--    operator set one; every other column is set to the approved values.
--
-- No other plan, account or subscription changes. Plans are ranked by price_usd (upgrades,
-- downgrades and zerox_billing_plan_target), so the new plans rank below Pro with no other
-- change. The gateway works without this migration: it leaves Athlete and Speed out of /api/plans
-- and checkout answers plan_unavailable for them (src/plan-policy.js ROW_REQUIRED_PLAN_IDS). Until
-- their Razorpay plan ids are stored, checkout for them answers billing_plan_missing. Safe to
-- re-run; no gateway restart needed (the plan catalogue is cached for 60 s). Roll back with
-- migrations/down/20261108000000_athlete_speed_plans.sql.

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT rel.relname, con.conname
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS nsp ON nsp.oid = rel.relnamespace
    JOIN pg_catalog.pg_attribute AS att ON att.attrelid = rel.oid
    WHERE nsp.nspname = 'public' AND con.contype = 'c' AND con.conkey = ARRAY[att.attnum]
      AND ((rel.relname IN ('zerox_accounts', 'zerox_plan_policy', 'zerox_subscriptions') AND att.attname = 'plan')
        OR (rel.relname = 'zerox_accounts' AND att.attname = 'manual_plan'))
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', constraint_row.relname, constraint_row.conname);
  END LOOP;
END;
$$;
ALTER TABLE public.zerox_plan_policy ADD CONSTRAINT zerox_plan_policy_plan_check
  CHECK (plan IN ('free', 'athlete', 'speed', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_accounts ADD CONSTRAINT zerox_accounts_plan_check
  CHECK (plan IN ('free', 'athlete', 'speed', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_accounts ADD CONSTRAINT zerox_accounts_manual_plan_check
  CHECK (manual_plan IN ('athlete', 'speed', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_subscriptions ADD CONSTRAINT zerox_subscriptions_plan_check
  CHECK (plan IN ('athlete', 'speed', 'pro', 'max'));

CREATE OR REPLACE FUNCTION public.zerox_billing_upsert_subscription(p_user_id uuid, p_provider text,
  p_provider_subscription_id text, p_plan text, p_status text, p_current_period_start timestamptz,
  p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_raw jsonb)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_subscription public.zerox_subscriptions;
  v_previous text;
  v_ended constant text[] := ARRAY['cancelled', 'completed', 'expired'];
  v_live constant text[] := ARRAY['authenticated', 'active', 'pending', 'halted', 'paused'];
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_provider_subscription_id IS NULL OR length(p_provider_subscription_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_subscription_id';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('athlete', 'speed', 'pro', 'max') THEN RAISE EXCEPTION 'invalid_plan: %', p_plan; END IF;
  IF p_status IS NULL OR p_status NOT IN ('created', 'authenticated', 'active', 'pending', 'halted',
      'paused', 'cancelled', 'completed', 'expired') THEN
    RAISE EXCEPTION 'invalid_subscription_status: %', p_status;
  END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;

  INSERT INTO public.zerox_subscriptions (user_id, provider, provider_subscription_id, plan, status,
    current_period_start, current_period_end, cancel_at_period_end, raw)
    VALUES (p_user_id, p_provider, p_provider_subscription_id, p_plan, p_status, p_current_period_start,
      p_current_period_end, coalesce(p_cancel_at_period_end, false), p_raw)
    ON CONFLICT (provider, provider_subscription_id) DO NOTHING
    RETURNING * INTO v_subscription;
  IF v_subscription.id IS NULL THEN
    SELECT * INTO v_subscription FROM public.zerox_subscriptions AS s
      WHERE s.provider = p_provider AND s.provider_subscription_id = p_provider_subscription_id FOR UPDATE;
    IF v_subscription.user_id <> p_user_id THEN RAISE EXCEPTION 'subscription_owner_mismatch'; END IF;
    v_previous := v_subscription.status;
    -- An ended subscription accepts only further ending updates, and never changes plan.
    IF NOT (v_subscription.status = ANY (v_ended)) OR p_status = ANY (v_ended) THEN
      UPDATE public.zerox_subscriptions AS s SET
        plan = CASE WHEN s.status = ANY (v_ended) THEN s.plan ELSE p_plan END,
        status = p_status,
        current_period_start = coalesce(p_current_period_start, s.current_period_start),
        current_period_end = coalesce(p_current_period_end, s.current_period_end),
        cancel_at_period_end = coalesce(p_cancel_at_period_end, s.cancel_at_period_end),
        raw = coalesce(p_raw, s.raw), updated_at = now()
        WHERE s.id = v_subscription.id
        RETURNING * INTO v_subscription;
    END IF;
  END IF;

  -- The account row lock above serializes this check across concurrent upserts.
  IF v_subscription.revoked_at IS NULL
      AND v_subscription.status IN ('authenticated', 'active', 'pending')
      AND (v_previous IS NULL OR NOT (v_previous = ANY (v_live)))
      AND EXISTS (SELECT 1 FROM public.zerox_subscriptions AS o
        WHERE o.user_id = p_user_id AND o.id <> v_subscription.id AND o.revoked_at IS NULL
          AND o.status = ANY (v_live)) THEN
    UPDATE public.zerox_subscriptions AS s SET revoked_at = now(), revoked_reason = 'duplicate', updated_at = now()
      WHERE s.id = v_subscription.id
      RETURNING * INTO v_subscription;
  END IF;

  PERFORM public.zerox_reconcile_subscription_plan(p_user_id);
  RETURN NEXT v_subscription;
END;
$$;

CREATE OR REPLACE FUNCTION public.zerox_billing_record_checkout(p_user_id uuid, p_provider text,
  p_provider_subscription_id text, p_plan text, p_raw jsonb)
RETURNS TABLE (recorded boolean, blocking_subscription_id text, blocking_status text, blocking_plan_id text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_other public.zerox_subscriptions;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_provider_subscription_id IS NULL OR length(p_provider_subscription_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_subscription_id';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('athlete', 'speed', 'pro', 'max') THEN RAISE EXCEPTION 'invalid_plan: %', p_plan; END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  SELECT * INTO v_other FROM public.zerox_subscriptions AS s
    WHERE s.user_id = p_user_id AND s.provider_subscription_id <> p_provider_subscription_id
      AND s.revoked_at IS NULL
      AND (s.status IN ('authenticated', 'active', 'pending', 'halted', 'paused')
        OR (s.status = 'created' AND s.created_at > now() - interval '24 hours'))
    ORDER BY (s.status = 'created'), s.created_at
    LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_other.provider_subscription_id, v_other.status, v_other.raw ->> 'plan_id';
    RETURN;
  END IF;
  INSERT INTO public.zerox_subscriptions (user_id, provider, provider_subscription_id, plan, status, raw)
    VALUES (p_user_id, p_provider, p_provider_subscription_id, p_plan, 'created', p_raw)
    ON CONFLICT (provider, provider_subscription_id) DO NOTHING;
  RETURN QUERY SELECT true, p_provider_subscription_id, 'created'::text, p_raw ->> 'plan_id';
END;
$$;

INSERT INTO public.zerox_plan_policy AS policy (plan, name, price_usd, price_inr_paise, daily_requests,
  daily_tokens, rpm_limit, concurrency_limit, allowed_tiers, monthly_credit_microusd, features, sort, public,
  highlighted, window_tokens, window_seconds, connector_policy)
VALUES
  ('athlete', 'Athlete', 1, 8900, 300, 6000000, 15, 2, ARRAY['free', 'paid'], 750000,
    '["Claude Haiku 5.5 included: 10M tokens a month at no charge", "Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits", "$0.75 of credits included every month", "Free models with higher limits: 300 requests and 6M tokens per day", "15 requests per minute, 2 at once", "Every Neuron feature, the same on all plans"]'::jsonb,
    12, true, false, NULL, NULL,
    '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": ["atlassian", "github", "linear", "notion", "slack"], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb),
  ('speed', 'Speed', 5, 44900, 1000, 8000000, 20, 3, ARRAY['free', 'paid'], 4000000,
    '["Claude Haiku 5.5 included: 10M tokens a month at no charge", "Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits", "$4 of credits included every month", "Free models with higher limits: 1,000 requests and 8M tokens per day", "20 requests per minute, 3 at once", "Every Neuron feature, the same on all plans"]'::jsonb,
    15, true, false, NULL, NULL,
    '{"allowed": ["catalog:*"], "denied": [], "required": [], "hosted": ["atlassian", "github", "linear", "notion", "slack"], "allow_unvetted": true, "catalog_version": "2026-11-03"}'::jsonb)
ON CONFLICT (plan) DO UPDATE SET name = EXCLUDED.name, price_usd = EXCLUDED.price_usd,
  price_inr_paise = EXCLUDED.price_inr_paise, daily_requests = EXCLUDED.daily_requests,
  daily_tokens = EXCLUDED.daily_tokens, rpm_limit = EXCLUDED.rpm_limit,
  concurrency_limit = EXCLUDED.concurrency_limit, allowed_tiers = EXCLUDED.allowed_tiers,
  monthly_credit_microusd = EXCLUDED.monthly_credit_microusd, features = EXCLUDED.features,
  sort = EXCLUDED.sort, public = EXCLUDED.public, highlighted = EXCLUDED.highlighted,
  window_tokens = EXCLUDED.window_tokens, window_seconds = EXCLUDED.window_seconds,
  connector_policy = coalesce(policy.connector_policy, EXCLUDED.connector_policy),
  razorpay_plan_id_inr = policy.razorpay_plan_id_inr, razorpay_plan_id_usd = policy.razorpay_plan_id_usd,
  updated_at = now();

COMMIT;
