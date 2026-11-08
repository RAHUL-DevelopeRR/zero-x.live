BEGIN;
-- Swaps the plan CHECK constraints back and replaces two functions; give up (and re-run) rather
-- than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolls back 20261108000000_athlete_speed_plans.sql by hand: psql -X -v ON_ERROR_STOP=1 -f <this
-- file>. The migration runner (scripts/apply-migrations.mjs) never reads migrations/down/.
-- It refuses (and changes nothing) while any account (plan or manual_plan) or any live, unrevoked
-- subscription is on Athlete or Speed: move those first. Ended subscriptions (cancelled, completed,
-- expired) and revoked ones do not block it, and they are kept: payment history is never rewritten.
-- Then it removes the two zerox_plan_policy rows (with any Razorpay plan ids stored on them),
-- restores the plan CHECK constraints (zerox_subscriptions.plan still accepts athlete and speed, so
-- those ended rows stay valid) and the two billing functions of 20261016000200 (new checkouts and
-- subscription updates take Pro and Max only), and removes the history row so the runner can apply
-- the migration again.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.zerox_accounts AS a
      WHERE a.plan IN ('athlete', 'speed') OR a.manual_plan IN ('athlete', 'speed'))
    OR EXISTS (SELECT 1 FROM public.zerox_subscriptions AS s WHERE s.plan IN ('athlete', 'speed')
      AND s.status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused') AND s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'athlete_speed_in_use: accounts or subscriptions still use the Athlete or Speed plan; nothing was changed';
  END IF;
END;
$$;

DELETE FROM public.zerox_plan_policy WHERE plan IN ('athlete', 'speed');

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
  CHECK (plan IN ('free', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_accounts ADD CONSTRAINT zerox_accounts_plan_check
  CHECK (plan IN ('free', 'pro', 'max', 'ultrawork'));
ALTER TABLE public.zerox_accounts ADD CONSTRAINT zerox_accounts_manual_plan_check
  CHECK (manual_plan IN ('pro', 'max', 'ultrawork'));
-- Ended Athlete and Speed subscriptions survive the rollback, so the subscriptions CHECK keeps both ids.
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
  IF p_plan IS NULL OR p_plan NOT IN ('pro', 'max') THEN RAISE EXCEPTION 'invalid_plan: %', p_plan; END IF;
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
  IF p_plan IS NULL OR p_plan NOT IN ('pro', 'max') THEN RAISE EXCEPTION 'invalid_plan: %', p_plan; END IF;
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

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108000000';

COMMIT;
