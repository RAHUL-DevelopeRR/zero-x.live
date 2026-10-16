BEGIN;

-- API key, billing, credit and webhook RPCs (docs/PLATFORM_CONTRACT.md section 4).

CREATE FUNCTION public.zerox_api_key_create(p_user_id uuid, p_name text, p_prefix text, p_hash text)
RETURNS TABLE (id uuid, name text, prefix text, created_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_active bigint;
BEGIN
  IF length(v_name) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'invalid_key_name: name must be 1-64 characters'; END IF;
  IF p_prefix IS NULL OR p_prefix !~ '^nzx_[A-Za-z0-9_-]{0,28}$' THEN RAISE EXCEPTION 'invalid_key_prefix'; END IF;
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_key_hash: expected the lowercase hex SHA-256 of the secret';
  END IF;
  -- The account row lock serializes concurrent creations so the limit cannot be raced.
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  SELECT count(*) INTO v_active FROM public.zerox_api_keys AS k
    WHERE k.user_id = p_user_id AND k.revoked_at IS NULL;
  IF v_active >= 10 THEN
    RAISE EXCEPTION 'too_many_keys: an account can have at most 10 active API keys'
      USING HINT = 'Revoke an existing API key before creating a new one.';
  END IF;
  RETURN QUERY INSERT INTO public.zerox_api_keys AS k (user_id, name, prefix, key_hash)
    VALUES (p_user_id, v_name, p_prefix, p_hash)
    RETURNING k.id, k.name, k.prefix, k.created_at;
END;
$$;

CREATE FUNCTION public.zerox_api_key_list(p_user_id uuid)
RETURNS TABLE (id uuid, name text, prefix text, created_at timestamptz, last_used_at timestamptz,
  revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at
  FROM public.zerox_api_keys AS k WHERE k.user_id = p_user_id
  ORDER BY k.created_at DESC, k.id;
$$;

CREATE FUNCTION public.zerox_api_key_revoke(p_user_id uuid, p_key_id uuid)
RETURNS TABLE (revoked boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.zerox_api_keys AS k SET revoked_at = now()
    WHERE k.id = p_key_id AND k.user_id = p_user_id AND k.revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- Returns the owner of an active key; last_used_at is written at most once per minute.
CREATE FUNCTION public.zerox_api_key_verify(p_hash text)
RETURNS TABLE (key_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
  RETURN QUERY UPDATE public.zerox_api_keys AS k SET last_used_at = now()
    WHERE k.key_hash = p_hash AND k.revoked_at IS NULL
      AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
    RETURNING k.id, k.user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT k.id, k.user_id FROM public.zerox_api_keys AS k
      WHERE k.key_hash = p_hash AND k.revoked_at IS NULL;
  END IF;
END;
$$;

-- The paid plan a user's subscriptions entitle them to right now (highest price), or NULL.
-- Revoked subscriptions (duplicates, refunded payments) never entitle.
CREATE FUNCTION public.zerox_subscription_effective_plan(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.plan FROM public.zerox_subscriptions AS s
  JOIN public.zerox_plan_policy AS p ON p.plan = s.plan
  WHERE s.user_id = p_user_id AND s.revoked_at IS NULL
    AND public.zerox_subscription_grants_plan(s.status, s.current_period_end, s.cancel_at_period_end, s.updated_at)
  ORDER BY p.price_usd DESC, s.updated_at DESC
  LIMIT 1;
$$;

-- The plan, plan_source and manual_plan an account should have given its subscriptions:
-- * an operator-granted plan (manual_plan, or the plan itself while it was not set by billing)
--   is kept when it is priced higher than the best entitling subscription;
-- * otherwise that subscription's plan applies and the operator plan is remembered in
--   manual_plan, to be restored when billing ends;
-- * a billing plan with neither an entitling subscription nor an operator plan reverts to free.
-- Accounts with no subscription and no billing-managed plan are returned unchanged.
CREATE FUNCTION public.zerox_billing_plan_target(p_user_id uuid)
RETURNS TABLE (plan text, plan_source text, manual_plan text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_account public.zerox_accounts;
  v_subscription text;
  v_manual text;
  v_subscription_price numeric;
  v_manual_price numeric;
BEGIN
  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_subscription := public.zerox_subscription_effective_plan(p_user_id);
  v_manual := CASE WHEN v_account.plan_source <> 'subscription' AND v_account.plan <> 'free'
    THEN v_account.plan ELSE v_account.manual_plan END;
  SELECT coalesce(max(pp.price_usd), 0) INTO v_subscription_price
    FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_subscription;
  SELECT coalesce(max(pp.price_usd), 0) INTO v_manual_price
    FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_manual;
  IF v_subscription IS NOT NULL AND (v_manual IS NULL OR v_subscription_price >= v_manual_price) THEN
    RETURN QUERY SELECT v_subscription, 'subscription'::text, v_manual;
  ELSIF v_manual IS NOT NULL THEN
    RETURN QUERY SELECT v_manual, 'manual'::text, NULL::text;
  ELSIF v_account.plan_source = 'subscription' THEN
    RETURN QUERY SELECT 'free'::text, 'default'::text, NULL::text;
  ELSE
    RETURN QUERY SELECT v_account.plan, v_account.plan_source, v_account.manual_plan;
  END IF;
END;
$$;

-- Brings one account's plan in line with its subscriptions (see zerox_billing_plan_target).
-- changed is true when the plan changed; downgraded when the new plan is priced lower.
CREATE FUNCTION public.zerox_reconcile_subscription_plan(p_user_id uuid)
RETURNS TABLE (previous_plan text, new_plan text, changed boolean, downgraded boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_account public.zerox_accounts;
  v_target record;
  v_previous_price numeric;
  v_new_price numeric;
BEGIN
  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT t.plan, t.plan_source, t.manual_plan INTO v_target FROM public.zerox_billing_plan_target(p_user_id) AS t;
  IF (v_target.plan, v_target.plan_source, v_target.manual_plan)
      IS NOT DISTINCT FROM (v_account.plan, v_account.plan_source, v_account.manual_plan) THEN
    RETURN QUERY SELECT v_account.plan, v_account.plan, false, false;
    RETURN;
  END IF;
  UPDATE public.zerox_accounts AS a SET plan = v_target.plan, plan_source = v_target.plan_source,
    manual_plan = v_target.manual_plan, updated_at = now()
    WHERE a.clerk_id = p_user_id;
  SELECT coalesce(max(pp.price_usd), 0) INTO v_previous_price
    FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_account.plan;
  SELECT coalesce(max(pp.price_usd), 0) INTO v_new_price
    FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_target.plan;
  RETURN QUERY SELECT v_account.plan, v_target.plan::text, v_account.plan <> v_target.plan,
    v_new_price < v_previous_price;
END;
$$;

-- Upserts a provider subscription (webhook or verify flow) and applies its plan: authenticated
-- or active grants the plan; halted, paused, cancelled, completed and expired keep it until
-- current_period_end, after which the account reverts to its operator plan or free (see
-- zerox_subscription_grants_plan for the exact bounds). Once a subscription has ended
-- (cancelled, completed, expired) its plan is fixed and late or replayed non-ending webhooks
-- are ignored, so out-of-order deliveries cannot resurrect or re-plan it.
-- A subscription that becomes live (authenticated, active, pending) while the same user already
-- has another live, unrevoked one is a duplicate (two checkouts paid in parallel): it is revoked
-- with reason 'duplicate' so it never entitles, and the gateway cancels and refunds it.
CREATE FUNCTION public.zerox_billing_upsert_subscription(p_user_id uuid, p_provider text,
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

-- Every subscription of a user that has not ended, newest first, with the provider plan id and
-- the number of payments recorded for it that did not fail (the checkout and cancel flows).
CREATE FUNCTION public.zerox_billing_subscriptions(p_user_id uuid)
RETURNS TABLE (id uuid, provider text, provider_subscription_id text, plan text, status text,
  current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean,
  revoked_at timestamptz, revoked_reason text, provider_plan_id text, payments bigint,
  created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.id, s.provider, s.provider_subscription_id, s.plan, s.status, s.current_period_start,
    s.current_period_end, s.cancel_at_period_end, s.revoked_at, s.revoked_reason, s.raw ->> 'plan_id',
    (SELECT count(*) FROM public.zerox_payments AS p
      WHERE p.user_id = s.user_id AND p.provider = s.provider AND p.kind = 'subscription'
        AND p.status <> 'failed' AND p.raw ->> 'subscription_id' = s.provider_subscription_id),
    s.created_at, s.updated_at
  FROM public.zerox_subscriptions AS s
  WHERE s.user_id = p_user_id AND s.status NOT IN ('cancelled', 'completed', 'expired')
  ORDER BY s.created_at DESC, s.id
  LIMIT 50;
$$;

-- Records a checkout's new provider subscription as 'created', unless the user already has a
-- live, unrevoked subscription or another unpaid checkout from the last 24 hours. The account row
-- lock makes this atomic across parallel checkouts; the blocking subscription is returned so the
-- gateway can reuse it (same provider plan) or refuse.
CREATE FUNCTION public.zerox_billing_record_checkout(p_user_id uuid, p_provider text,
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

-- Ends a subscription's entitlement for good (reason 'refunded' after a full refund, or
-- 'duplicate'); an existing revocation is kept. Returns the row, or nothing when it is unknown.
CREATE FUNCTION public.zerox_billing_revoke_subscription(p_provider text, p_provider_subscription_id text,
  p_reason text)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_subscription public.zerox_subscriptions;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('duplicate', 'refunded') THEN RAISE EXCEPTION 'invalid_revoke_reason'; END IF;
  SELECT * INTO v_subscription FROM public.zerox_subscriptions AS s
    WHERE s.provider = p_provider AND s.provider_subscription_id = p_provider_subscription_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = v_subscription.user_id FOR UPDATE;
  UPDATE public.zerox_subscriptions AS s SET revoked_at = coalesce(s.revoked_at, now()),
    revoked_reason = coalesce(s.revoked_reason, p_reason), updated_at = now()
    WHERE s.id = v_subscription.id
    RETURNING * INTO v_subscription;
  PERFORM public.zerox_reconcile_subscription_plan(v_subscription.user_id);
  RETURN NEXT v_subscription;
END;
$$;

-- Reconciles every billing-managed account whose plan no longer matches its subscriptions:
-- lapsed grants after missed webhooks, ended billing periods and changed operator plans.
-- downgraded counts moves to a lower-priced plan (or free); reconciled counts every plan change
-- in either direction (an extension to the contract's {downgraded}).
CREATE FUNCTION public.zerox_apply_subscription_expiry()
RETURNS TABLE (downgraded bigint, reconciled bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_result record;
  v_downgraded bigint := 0;
  v_reconciled bigint := 0;
BEGIN
  FOR v_user IN
    SELECT a.clerk_id FROM public.zerox_accounts AS a
    CROSS JOIN LATERAL public.zerox_billing_plan_target(a.clerk_id) AS t
    WHERE a.plan_source = 'subscription'
      AND (t.plan, t.plan_source, t.manual_plan) IS DISTINCT FROM (a.plan, a.plan_source, a.manual_plan)
    ORDER BY a.clerk_id
  LOOP
    SELECT r.changed, r.downgraded INTO v_result FROM public.zerox_reconcile_subscription_plan(v_user) AS r;
    IF v_result.changed THEN v_reconciled := v_reconciled + 1; END IF;
    IF v_result.downgraded THEN v_downgraded := v_downgraded + 1; END IF;
  END LOOP;
  RETURN QUERY SELECT v_downgraded, v_reconciled;
END;
$$;

CREATE FUNCTION public.zerox_subscription_by_provider_id(p_provider text, p_provider_subscription_id text)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.* FROM public.zerox_subscriptions AS s
  WHERE s.provider = p_provider AND s.provider_subscription_id = p_provider_subscription_id;
$$;

-- Records a payment once per (provider, provider payment id). Repeated calls only move the
-- status forward (created < authorized < failed < captured < refunded), fill missing data and
-- merge p_raw into the stored raw object (so its subscription_id is kept).
CREATE FUNCTION public.zerox_billing_record_payment(p_user_id uuid, p_provider text,
  p_provider_payment_id text, p_kind text, p_amount_minor bigint, p_currency text, p_status text,
  p_invoice_url text, p_raw jsonb)
RETURNS SETOF public.zerox_payments
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_payment public.zerox_payments;
  v_ranks constant text[] := ARRAY['created', 'authorized', 'failed', 'captured', 'refunded'];
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_provider_payment_id IS NULL OR length(p_provider_payment_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_payment_id';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('subscription', 'topup') THEN RAISE EXCEPTION 'invalid_payment_kind'; END IF;
  IF p_amount_minor IS NULL OR p_amount_minor < 0 THEN RAISE EXCEPTION 'invalid_payment_amount'; END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'invalid_currency'; END IF;
  IF p_status IS NULL OR NOT (p_status = ANY (v_ranks)) THEN RAISE EXCEPTION 'invalid_payment_status: %', p_status; END IF;
  IF p_invoice_url IS NOT NULL AND (p_invoice_url !~ '^https://' OR length(p_invoice_url) > 2048) THEN
    RAISE EXCEPTION 'invalid_invoice_url: must be an https URL';
  END IF;
  PERFORM 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;

  INSERT INTO public.zerox_payments (user_id, provider, provider_payment_id, kind, amount_minor, currency,
    status, invoice_url, raw)
    VALUES (p_user_id, p_provider, p_provider_payment_id, p_kind, p_amount_minor, p_currency, p_status,
      p_invoice_url, p_raw)
    ON CONFLICT (provider, provider_payment_id) DO NOTHING
    RETURNING * INTO v_payment;
  IF v_payment.id IS NULL THEN
    SELECT * INTO v_payment FROM public.zerox_payments AS p
      WHERE p.provider = p_provider AND p.provider_payment_id = p_provider_payment_id FOR UPDATE;
    IF v_payment.user_id <> p_user_id THEN RAISE EXCEPTION 'payment_owner_mismatch'; END IF;
    UPDATE public.zerox_payments AS p SET
      status = CASE WHEN array_position(v_ranks, p_status) > array_position(v_ranks, p.status)
        THEN p_status ELSE p.status END,
      invoice_url = coalesce(p_invoice_url, p.invoice_url),
      raw = CASE WHEN jsonb_typeof(p.raw) = 'object' AND jsonb_typeof(p_raw) = 'object' THEN p.raw || p_raw
        ELSE coalesce(p_raw, p.raw) END,
      updated_at = now()
      WHERE p.id = v_payment.id
      RETURNING * INTO v_payment;
  END IF;
  RETURN NEXT v_payment;
END;
$$;

-- A recorded payment with its owner, the subscription it paid for (raw subscription_id) and the
-- credits granted for it (the ledger row whose ref is the payment id). Used by refund handling.
CREATE FUNCTION public.zerox_payment_by_provider_id(p_provider text, p_provider_payment_id text)
RETURNS TABLE (id uuid, user_id uuid, kind text, amount_minor bigint, currency text, status text,
  subscription_id text, granted_microusd bigint, granted_reason text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT p.id, p.user_id, p.kind, p.amount_minor, p.currency, p.status, p.raw ->> 'subscription_id',
    coalesce(l.delta_microusd, 0), l.reason
  FROM public.zerox_payments AS p
  LEFT JOIN public.zerox_credit_ledger AS l
    ON l.ref = p.provider_payment_id AND l.user_id = p.user_id AND l.delta_microusd > 0
  WHERE p.provider = p_provider AND p.provider_payment_id = p_provider_payment_id;
$$;

-- Applies a credit delta once per ref (payment id, invoice id, ...). Negative deltas clamp
-- the balance at zero and record the shortfall. Refs starting with 'usage:' are reserved for
-- zerox_settle_v2 (one per reservation), so a grant can never block a settlement.
CREATE FUNCTION public.zerox_credit_grant(p_user_id uuid, p_delta_microusd bigint, p_reason text, p_ref text)
RETURNS TABLE (granted boolean, balance_microusd bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_balance bigint;
  v_new bigint;
  v_ledger_id bigint;
BEGIN
  IF p_delta_microusd IS NULL OR p_delta_microusd = 0 OR abs(p_delta_microusd) > 1000000000000 THEN
    RAISE EXCEPTION 'invalid_credit_delta';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN RAISE EXCEPTION 'invalid_credit_reason'; END IF;
  IF p_ref IS NULL OR length(p_ref) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_credit_ref'; END IF;
  IF lower(p_ref) LIKE 'usage:%' THEN
    RAISE EXCEPTION 'invalid_credit_ref: the usage: prefix is reserved for settlements';
  END IF;
  SELECT a.credit_balance_microusd INTO v_balance FROM public.zerox_accounts AS a
    WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  v_new := greatest(0, v_balance + p_delta_microusd);
  INSERT INTO public.zerox_credit_ledger (user_id, delta_microusd, balance_after_microusd,
    shortfall_microusd, reason, ref)
    VALUES (p_user_id, v_new - v_balance, v_new, (v_new - v_balance) - p_delta_microusd, p_reason, p_ref)
    ON CONFLICT (ref) DO NOTHING
    RETURNING id INTO v_ledger_id;
  IF v_ledger_id IS NULL THEN
    RETURN QUERY SELECT false, v_balance;
    RETURN;
  END IF;
  UPDATE public.zerox_accounts AS a SET credit_balance_microusd = v_new, updated_at = now()
    WHERE a.clerk_id = p_user_id;
  RETURN QUERY SELECT true, v_new;
END;
$$;

-- Claims a provider webhook delivery for processing, once. The claim is a lease: it stays
-- 'processing' until zerox_webhook_complete marks it processed, and a claim whose lease
-- (p_lease_seconds, default 120) expired is claimed again, so an invocation that died mid-way
-- never turns Razorpay's retries into duplicates. in_progress is true while another invocation
-- holds a live lease (answer non-2xx so the provider retries later).
CREATE FUNCTION public.zerox_webhook_claim(p_provider text, p_event_id text, p_event_type text,
  p_payload_sha256 text, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (claimed boolean, in_progress boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
  v_lease interval;
  v_status text;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_event_id'; END IF;
  IF length(p_event_type) > 100 THEN RAISE EXCEPTION 'invalid_event_type'; END IF;
  IF p_payload_sha256 IS NOT NULL AND p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_payload_sha256';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 3600 THEN RAISE EXCEPTION 'invalid_lease'; END IF;
  v_lease := p_lease_seconds * interval '1 second';
  INSERT INTO public.zerox_webhook_events AS w (provider, event_id, event_type, payload_sha256, status, lease_expires_at)
    VALUES (p_provider, p_event_id, coalesce(p_event_type, ''), p_payload_sha256, 'processing', now() + v_lease)
    ON CONFLICT (provider, event_id) DO UPDATE SET lease_expires_at = now() + v_lease, attempts = w.attempts + 1,
      payload_sha256 = coalesce(EXCLUDED.payload_sha256, w.payload_sha256)
      WHERE w.status = 'processing' AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= now());
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows > 0 THEN
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;
  SELECT w.status INTO v_status FROM public.zerox_webhook_events AS w
    WHERE w.provider = p_provider AND w.event_id = p_event_id;
  RETURN QUERY SELECT false, coalesce(v_status, 'processing') = 'processing';
END;
$$;

-- Marks a claimed delivery processed; later deliveries of the same event are duplicates.
CREATE FUNCTION public.zerox_webhook_complete(p_provider text, p_event_id text)
RETURNS TABLE (completed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.zerox_webhook_events AS w SET status = 'processed', processed_at = now(), lease_expires_at = NULL
    WHERE w.provider = p_provider AND w.event_id = p_event_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

-- Extension to the contract: drops a claim when processing failed so the provider's retry of
-- the same delivery can be processed instead of being deduplicated away.
CREATE FUNCTION public.zerox_webhook_release(p_provider text, p_event_id text)
RETURNS TABLE (released boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  DELETE FROM public.zerox_webhook_events AS w WHERE w.provider = p_provider AND w.event_id = p_event_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows > 0;
END;
$$;

CREATE FUNCTION public.zerox_billing_get(p_user_id uuid)
RETURNS TABLE (subscription jsonb, payments jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT
    (SELECT to_jsonb(s) - 'raw' - 'user_id' FROM public.zerox_current_subscription(p_user_id) AS s),
    coalesce((
      SELECT jsonb_agg(to_jsonb(recent) - 'raw' - 'user_id' ORDER BY recent.created_at DESC, recent.id)
      FROM (
        SELECT p.* FROM public.zerox_payments AS p WHERE p.user_id = p_user_id
        ORDER BY p.created_at DESC, p.id LIMIT 50
      ) AS recent
    ), '[]'::jsonb);
$$;

REVOKE ALL ON FUNCTION
  public.zerox_api_key_create(uuid, text, text, text),
  public.zerox_api_key_list(uuid),
  public.zerox_api_key_revoke(uuid, uuid),
  public.zerox_api_key_verify(text),
  public.zerox_subscription_effective_plan(uuid),
  public.zerox_billing_plan_target(uuid),
  public.zerox_reconcile_subscription_plan(uuid),
  public.zerox_billing_upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  public.zerox_billing_subscriptions(uuid),
  public.zerox_billing_record_checkout(uuid, text, text, text, jsonb),
  public.zerox_billing_revoke_subscription(text, text, text),
  public.zerox_apply_subscription_expiry(),
  public.zerox_subscription_by_provider_id(text, text),
  public.zerox_billing_record_payment(uuid, text, text, text, bigint, text, text, text, jsonb),
  public.zerox_payment_by_provider_id(text, text),
  public.zerox_credit_grant(uuid, bigint, text, text),
  public.zerox_webhook_claim(text, text, text, text, integer),
  public.zerox_webhook_complete(text, text),
  public.zerox_webhook_release(text, text),
  public.zerox_billing_get(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_api_key_create(uuid, text, text, text),
  public.zerox_api_key_list(uuid),
  public.zerox_api_key_revoke(uuid, uuid),
  public.zerox_api_key_verify(text),
  public.zerox_subscription_effective_plan(uuid),
  public.zerox_billing_plan_target(uuid),
  public.zerox_reconcile_subscription_plan(uuid),
  public.zerox_billing_upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  public.zerox_billing_subscriptions(uuid),
  public.zerox_billing_record_checkout(uuid, text, text, text, jsonb),
  public.zerox_billing_revoke_subscription(text, text, text),
  public.zerox_apply_subscription_expiry(),
  public.zerox_subscription_by_provider_id(text, text),
  public.zerox_billing_record_payment(uuid, text, text, text, bigint, text, text, text, jsonb),
  public.zerox_payment_by_provider_id(text, text),
  public.zerox_credit_grant(uuid, bigint, text, text),
  public.zerox_webhook_claim(text, text, text, text, integer),
  public.zerox_webhook_complete(text, text),
  public.zerox_webhook_release(text, text),
  public.zerox_billing_get(uuid)
  TO service_role;

COMMIT;
