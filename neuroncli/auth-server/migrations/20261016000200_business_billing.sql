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
CREATE FUNCTION public.zerox_subscription_effective_plan(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.plan FROM public.zerox_subscriptions AS s
  JOIN public.zerox_plan_policy AS p ON p.plan = s.plan
  WHERE s.user_id = p_user_id AND public.zerox_subscription_grants_plan(s.status, s.current_period_end)
  ORDER BY p.price_usd DESC, s.updated_at DESC
  LIMIT 1;
$$;

-- Brings one account's plan in line with its subscriptions. Only accounts whose plan came
-- from billing are downgraded; returns true when the plan changed.
CREATE FUNCTION public.zerox_reconcile_subscription_plan(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_account public.zerox_accounts;
  v_plan text;
BEGIN
  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_plan := public.zerox_subscription_effective_plan(p_user_id);
  IF v_plan IS NOT NULL THEN
    IF v_account.plan = v_plan AND v_account.plan_source = 'subscription' THEN RETURN false; END IF;
    UPDATE public.zerox_accounts AS a SET plan = v_plan, plan_source = 'subscription', updated_at = now()
      WHERE a.clerk_id = p_user_id;
    RETURN v_account.plan <> v_plan;
  END IF;
  IF v_account.plan_source = 'subscription' THEN
    UPDATE public.zerox_accounts AS a SET plan = 'free', plan_source = 'default', updated_at = now()
      WHERE a.clerk_id = p_user_id;
    RETURN v_account.plan <> 'free';
  END IF;
  RETURN false;
END;
$$;

-- Upserts a provider subscription (webhook or verify flow) and applies its plan: authenticated
-- or active grants the plan; halted, paused, cancelled, completed and expired keep it until
-- current_period_end, after which the account reverts to free. Terminal statuses are sticky so
-- out-of-order webhooks cannot resurrect a cancelled subscription.
CREATE FUNCTION public.zerox_billing_upsert_subscription(p_user_id uuid, p_provider text,
  p_provider_subscription_id text, p_plan text, p_status text, p_current_period_start timestamptz,
  p_current_period_end timestamptz, p_cancel_at_period_end boolean, p_raw jsonb)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_subscription public.zerox_subscriptions;
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
    UPDATE public.zerox_subscriptions AS s SET plan = p_plan,
      status = CASE WHEN s.status IN ('cancelled', 'completed', 'expired')
        AND p_status NOT IN ('cancelled', 'completed', 'expired') THEN s.status ELSE p_status END,
      current_period_start = coalesce(p_current_period_start, s.current_period_start),
      current_period_end = coalesce(p_current_period_end, s.current_period_end),
      cancel_at_period_end = coalesce(p_cancel_at_period_end, s.cancel_at_period_end),
      raw = coalesce(p_raw, s.raw), updated_at = now()
      WHERE s.id = v_subscription.id
      RETURNING * INTO v_subscription;
  END IF;

  PERFORM public.zerox_reconcile_subscription_plan(p_user_id);
  RETURN NEXT v_subscription;
END;
$$;

-- Downgrades accounts whose subscriptions no longer entitle them to their paid plan.
CREATE FUNCTION public.zerox_apply_subscription_expiry()
RETURNS TABLE (downgraded bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_count bigint := 0;
BEGIN
  FOR v_user IN
    SELECT a.clerk_id FROM public.zerox_accounts AS a
    WHERE a.plan_source = 'subscription' AND a.plan <> 'free'
      AND a.plan IS DISTINCT FROM public.zerox_subscription_effective_plan(a.clerk_id)
    ORDER BY a.clerk_id
  LOOP
    IF public.zerox_reconcile_subscription_plan(v_user) THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN QUERY SELECT v_count;
END;
$$;

CREATE FUNCTION public.zerox_subscription_by_provider_id(p_provider text, p_provider_subscription_id text)
RETURNS SETOF public.zerox_subscriptions
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT s.* FROM public.zerox_subscriptions AS s
  WHERE s.provider = p_provider AND s.provider_subscription_id = p_provider_subscription_id;
$$;

-- Records a payment once per (provider, provider payment id). Repeated calls only move the
-- status forward (created < authorized < failed < captured < refunded) and fill missing data.
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
      invoice_url = coalesce(p_invoice_url, p.invoice_url), raw = coalesce(p_raw, p.raw), updated_at = now()
      WHERE p.id = v_payment.id
      RETURNING * INTO v_payment;
  END IF;
  RETURN NEXT v_payment;
END;
$$;

-- Applies a credit delta once per ref (payment id, invoice id, ...). Negative deltas clamp
-- the balance at zero and record the shortfall.
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

-- Insert-if-absent claim used to process each provider webhook delivery exactly once.
CREATE FUNCTION public.zerox_webhook_claim(p_provider text, p_event_id text, p_event_type text,
  p_payload_sha256 text)
RETURNS TABLE (claimed boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_rows bigint;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_]{1,31}$' THEN RAISE EXCEPTION 'invalid_provider'; END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_event_id'; END IF;
  IF length(p_event_type) > 100 THEN RAISE EXCEPTION 'invalid_event_type'; END IF;
  IF p_payload_sha256 IS NOT NULL AND p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_payload_sha256';
  END IF;
  INSERT INTO public.zerox_webhook_events (provider, event_id, event_type, payload_sha256)
    VALUES (p_provider, p_event_id, coalesce(p_event_type, ''), p_payload_sha256)
    ON CONFLICT (provider, event_id) DO NOTHING;
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
  public.zerox_reconcile_subscription_plan(uuid),
  public.zerox_billing_upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  public.zerox_apply_subscription_expiry(),
  public.zerox_subscription_by_provider_id(text, text),
  public.zerox_billing_record_payment(uuid, text, text, text, bigint, text, text, text, jsonb),
  public.zerox_credit_grant(uuid, bigint, text, text),
  public.zerox_webhook_claim(text, text, text, text),
  public.zerox_webhook_release(text, text),
  public.zerox_billing_get(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_api_key_create(uuid, text, text, text),
  public.zerox_api_key_list(uuid),
  public.zerox_api_key_revoke(uuid, uuid),
  public.zerox_api_key_verify(text),
  public.zerox_subscription_effective_plan(uuid),
  public.zerox_reconcile_subscription_plan(uuid),
  public.zerox_billing_upsert_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, jsonb),
  public.zerox_apply_subscription_expiry(),
  public.zerox_subscription_by_provider_id(text, text),
  public.zerox_billing_record_payment(uuid, text, text, text, bigint, text, text, text, jsonb),
  public.zerox_credit_grant(uuid, bigint, text, text),
  public.zerox_webhook_claim(text, text, text, text),
  public.zerox_webhook_release(text, text),
  public.zerox_billing_get(uuid)
  TO service_role;

COMMIT;
