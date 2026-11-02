BEGIN;
-- Adding columns to zerox_plan_policy and replacing zerox_reserve_v2 take short locks; give up
-- (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Rolling token window per plan (docs/PLATFORM_CONTRACT.md section 1). A plan with window_tokens
-- and window_seconds set allows at most window_tokens tokens in any window_seconds, counted per
-- user over a rolling window instead of the UTC day: Free gets 1,000,000 tokens every 5 hours
-- (18,000 s). For such a plan the daily token cap (daily_tokens) no longer refuses a request;
-- the daily request cap, the per-minute and concurrency limits and paid credits stay as they
-- were. Plans without a window (Pro, Max, ultrawork) behave exactly as before.
--
-- What a window counts: every reservation the user made in the last window_seconds (by
-- created_at): a settled one with the tokens it was charged (its usage event: prompt plus
-- completion, 0 for a refund), an active one (still running) or a released one (its lease lapsed
-- unsettled) with the tokens it reserved, which is what the daily counter charges them too.
-- zerox_window_usage reads them through zerox_reservations_user_created_idx (user_id,
-- created_at DESC) and the unique index on zerox_usage_events.reservation_id, so the cost is the
-- user's own requests in the window (at most a few hundred on Free). zerox_reserve_v2 holds the
-- account row FOR UPDATE while it counts, so two reservations of one user cannot both take the
-- last tokens of a window.
--
-- A refused reservation answers status user_window_tokens with resets_at (and window_resets_at)
-- set to when enough of the window has expired for this request to fit, and
-- retry_after_seconds until then. Deploy the gateway that knows user_window_tokens before
-- applying this migration: an older gateway answers an unknown status with 503.
--
-- Free's daily_tokens becomes 5,000,000, the most five back-to-back windows can spend in one UTC
-- day, so clients that still show "tokens today / daily_tokens" (Neuron CLI alpha.2) show a true
-- ceiling. Free's feature strings say "1M tokens every 5 hours".
--
-- zerox_reserve_v2, zerox_plan_policies_v2 and zerox_account_overview gain result columns, so
-- they are dropped and created again (same arguments, same grants). Roll back with
-- migrations/down/20261102000000_free_token_window.sql (psql -X -v ON_ERROR_STOP=1 -f).

ALTER TABLE public.zerox_plan_policy
  ADD COLUMN IF NOT EXISTS window_tokens bigint CHECK (window_tokens > 0),
  ADD COLUMN IF NOT EXISTS window_seconds integer CHECK (window_seconds BETWEEN 60 AND 604800);
ALTER TABLE public.zerox_plan_policy DROP CONSTRAINT IF EXISTS zerox_plan_policy_window_check;
ALTER TABLE public.zerox_plan_policy ADD CONSTRAINT zerox_plan_policy_window_check
  CHECK ((window_tokens IS NULL) = (window_seconds IS NULL));
COMMENT ON COLUMN public.zerox_plan_policy.window_tokens IS
  'Tokens a user may use in any rolling window of window_seconds; NULL = no window (daily_tokens applies). With a window, daily_tokens does not refuse requests.';
COMMENT ON COLUMN public.zerox_plan_policy.window_seconds IS
  'Length of the rolling token window in seconds (60 s to 7 days); set together with window_tokens.';

UPDATE public.zerox_plan_policy AS p SET window_tokens = 1000000, window_seconds = 18000, daily_tokens = 5000000,
  features = coalesce((SELECT jsonb_agg(CASE f.value
      WHEN '500K tokens per day' THEN '1M tokens every 5 hours'
      WHEN '100 requests and 500K tokens per day' THEN '100 requests per day and 1M tokens every 5 hours'
      ELSE f.value END ORDER BY f.ordinality)
    FROM jsonb_array_elements_text(p.features) WITH ORDINALITY AS f(value, ordinality)), '[]'::jsonb),
  updated_at = now()
  WHERE p.plan = 'free';

-- The tokens each of a user's reservations in the last p_window_seconds counts against a
-- rolling window (see above), with when it was made.
DROP FUNCTION IF EXISTS public.zerox_window_usage(uuid, integer, timestamptz);
CREATE FUNCTION public.zerox_window_usage(p_user_id uuid, p_window_seconds integer, p_now timestamptz DEFAULT now())
RETURNS TABLE (created_at timestamptz, tokens bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT r.created_at, CASE WHEN r.status = 'settled'
      THEN coalesce(e.prompt_tokens + e.completion_tokens, r.prompt_tokens + r.completion_tokens, r.reserved_tokens)
      ELSE r.reserved_tokens END
  FROM public.zerox_reservations AS r
  LEFT JOIN public.zerox_usage_events AS e ON e.reservation_id = r.id
  WHERE r.user_id = p_user_id AND r.created_at > p_now - make_interval(secs => p_window_seconds)
    AND r.created_at <= p_now;
$$;

-- The result gains window_tokens, window_seconds, window_used_tokens and window_resets_at, so the
-- function is replaced rather than altered (same 8 arguments, so PostgREST still finds one).
DROP FUNCTION IF EXISTS public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text);

-- Atomically checks the per-user plan quota, credits and the shared upstream pool budget,
-- then records a reservation. p_pool is {rpm, rpd, tpm, tpd, cpd, concurrency}; a null budget is
-- unlimited. cpd (paid tier only) is the pool's billed micro-USD per UTC day: a paid reservation
-- needs room for its whole p_cost_microusd (at least 1) in the day bucket. concurrency is the most
-- reservations of the pool key running at once. p_pool_key (1-300 characters) selects the pool's
-- own buckets; null is the model's default. A plan with a token window (window_tokens and
-- window_seconds) is checked against the tokens of the last window_seconds instead of the day's:
-- window_used_tokens is that count (with this reservation when it is made), window_resets_at when
-- the oldest counted tokens leave the window (refused: when enough have left for this request),
-- and remaining_tokens the window's remaining tokens. The window columns are null for plans
-- without a window.
CREATE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
  p_tokens bigint, p_cost_microusd bigint, p_pool jsonb, p_pool_key text DEFAULT NULL)
RETURNS TABLE (status text, reservation_id uuid, plan text, remaining_requests bigint,
  remaining_tokens bigint, credit_balance_microusd bigint, resets_at timestamptz, retry_after_seconds integer,
  window_tokens bigint, window_seconds integer, window_used_tokens bigint, window_resets_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'UTC')::date;
  v_resets timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'UTC');
  v_minute timestamptz := date_trunc('minute', v_now, 'UTC');
  v_day timestamptz := (v_today::timestamp AT TIME ZONE 'UTC');
  v_cost bigint := coalesce(p_cost_microusd, 0);
  v_pool_key text := coalesce(p_pool_key, '');
  v_account public.zerox_accounts;
  v_policy public.zerox_plan_policy;
  v_minute_row public.zerox_pool_usage;
  v_day_row public.zerox_pool_usage;
  v_status text;
  v_retry integer;
  v_id uuid;
  v_count bigint;
  v_oldest timestamptz;
  v_lease timestamptz;
  v_held bigint;
  v_key text;
  v_invalid boolean;
  v_rpm bigint;
  v_rpd bigint;
  v_tpm bigint;
  v_tpd bigint;
  v_cpd bigint;
  v_concurrency bigint;
  v_window boolean;
  v_window_used bigint;
  v_window_oldest timestamptz;
  v_window_resets timestamptz;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_reservation: p_user_id is required'; END IF;
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_reservation: p_request_id must be 1-200 characters';
  END IF;
  IF p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_reservation: p_model must be 1-200 characters';
  END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'paid') THEN
    RAISE EXCEPTION 'invalid_reservation: p_tier must be free or paid';
  END IF;
  IF p_tokens IS NULL OR p_tokens < 1 THEN RAISE EXCEPTION 'invalid_reservation: p_tokens must be positive'; END IF;
  IF v_cost < 0 THEN RAISE EXCEPTION 'invalid_reservation: p_cost_microusd must be nonnegative'; END IF;
  IF p_pool_key IS NOT NULL AND length(p_pool_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid_reservation: p_pool_key must be 1-300 characters or null';
  END IF;
  IF p_pool IS NOT NULL AND jsonb_typeof(p_pool) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_pool_budget: p_pool must be an object or null';
  END IF;
  IF jsonb_typeof(p_pool) = 'object' THEN
    FOREACH v_key IN ARRAY ARRAY['rpm', 'rpd', 'tpm', 'tpd', 'cpd', 'concurrency'] LOOP
      v_invalid := CASE coalesce(jsonb_typeof(p_pool -> v_key), 'null')
        WHEN 'null' THEN false
        WHEN 'number' THEN (p_pool ->> v_key)::numeric < 0
        ELSE true END;
      IF v_invalid THEN
        RAISE EXCEPTION 'invalid_pool_budget: % must be a nonnegative number or null', v_key;
      END IF;
    END LOOP;
    v_rpm := floor((p_pool ->> 'rpm')::numeric)::bigint;
    v_rpd := floor((p_pool ->> 'rpd')::numeric)::bigint;
    v_tpm := floor((p_pool ->> 'tpm')::numeric)::bigint;
    v_tpd := floor((p_pool ->> 'tpd')::numeric)::bigint;
    v_cpd := floor((p_pool ->> 'cpd')::numeric)::bigint;
    v_concurrency := floor((p_pool ->> 'concurrency')::numeric)::bigint;
  END IF;

  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_account'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint,
      NULL::bigint, NULL::timestamptz, NULL::integer, NULL::bigint, NULL::integer, NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;
  -- Releases the caller's lapsed free leases (attempts whose isolate died before settling),
  -- keeping what they were charged. A lapsed paid reservation stays active: its slot is free (the
  -- concurrency count below needs a running lease), but its credits stay held until it is settled
  -- or zerox_release_stale_reservations releases it, at least 60 minutes after it was made. A
  -- reservation that is being settled or renewed right now is locked and skipped: waiting for its
  -- row while holding the account row would invert the lock order (reservation row -> account
  -- row), and the settle or renewal decides its fate anyway.
  UPDATE public.zerox_reservations AS r SET status = 'released', settled_at = v_now
    WHERE r.id IN (SELECT l.id FROM public.zerox_reservations AS l
      WHERE l.user_id = p_user_id AND l.status = 'active' AND l.lease_expires_at <= v_now AND l.tier <> 'paid'
      FOR UPDATE SKIP LOCKED);
  IF v_account.last_usage_reset < v_today THEN
    UPDATE public.zerox_accounts AS a SET daily_requests = 0, daily_tokens_used = 0, last_usage_reset = v_today
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
  END IF;

  SELECT * INTO v_policy FROM public.zerox_plan_policy AS pp WHERE pp.plan = v_account.plan;
  IF NOT FOUND THEN SELECT * INTO v_policy FROM public.zerox_plan_policy AS pp WHERE pp.plan = 'free'; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing quota policy'; END IF;
  v_window := v_policy.window_tokens IS NOT NULL AND v_policy.window_seconds IS NOT NULL;

  IF v_account.suspended THEN
    v_status := 'suspended';
  ELSIF NOT (p_tier = ANY (v_policy.allowed_tiers)) THEN
    v_status := 'upgrade_required';
  ELSIF v_account.daily_requests >= v_policy.daily_requests THEN
    v_status := 'user_daily_requests';
  ELSIF NOT v_window AND v_account.daily_tokens_used + p_tokens > v_policy.daily_tokens THEN
    v_status := 'user_daily_tokens';
  END IF;

  IF v_status IS NULL AND v_window THEN
    -- The rolling token window replaces the daily token cap: the tokens of the last
    -- window_seconds (settled usage plus what running and lapsed reservations hold) plus this
    -- reservation must fit in window_tokens.
    SELECT coalesce(sum(w.tokens), 0)::bigint, min(w.created_at) INTO v_window_used, v_window_oldest
      FROM public.zerox_window_usage(p_user_id, v_policy.window_seconds, v_now) AS w;
    IF v_window_used + p_tokens > v_policy.window_tokens THEN
      v_status := 'user_window_tokens';
      -- The first moment enough of the window has expired for this request: the made-at time of
      -- the earliest reservation whose expiry (with all older ones) frees enough tokens, plus the
      -- window. A request larger than the whole window never fits; it is told the time the last
      -- counted tokens expire.
      SELECT min(q.created_at) INTO v_window_resets FROM (
        SELECT w.created_at, sum(w.tokens) OVER (ORDER BY w.created_at ROWS UNBOUNDED PRECEDING) AS freed
        FROM public.zerox_window_usage(p_user_id, v_policy.window_seconds, v_now) AS w) AS q
        WHERE v_window_used - q.freed + p_tokens <= v_policy.window_tokens;
      IF v_window_resets IS NULL THEN
        SELECT max(w.created_at) INTO v_window_resets
          FROM public.zerox_window_usage(p_user_id, v_policy.window_seconds, v_now) AS w;
      END IF;
      v_window_resets := coalesce(v_window_resets, v_now) + make_interval(secs => v_policy.window_seconds);
      v_retry := greatest(1, ceil(extract(epoch FROM v_window_resets - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    -- Client requests in the last minute other than this one: failover attempts reserve as
    -- <request_id>.<n>, so an attempt of a request that is already counted always fits. A
    -- request leaves the window with its last attempt.
    SELECT count(*), min(q.last_at) INTO v_count, v_oldest FROM (
      SELECT max(r.created_at) AS last_at FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.created_at > v_now - interval '60 seconds'
        AND split_part(r.request_id, '.', 1) <> split_part(p_request_id, '.', 1)
      GROUP BY split_part(r.request_id, '.', 1)) AS q;
    IF v_count >= v_policy.rpm_limit THEN
      v_status := 'user_rpm';
      v_retry := greatest(1, ceil(extract(epoch FROM v_oldest + interval '60 seconds' - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    -- A concurrency slot is held while its lease runs. Credits stay held by every active paid
    -- reservation until it is settled or released (not before 60 minutes, also after its lease
    -- lapsed), so a long-running paid request cannot be spent twice.
    SELECT count(*) FILTER (WHERE r.lease_expires_at > v_now),
      min(r.lease_expires_at) FILTER (WHERE r.lease_expires_at > v_now),
      coalesce(sum(r.reserved_cost_microusd) FILTER (WHERE r.tier = 'paid'), 0)
      INTO v_count, v_lease, v_held FROM public.zerox_reservations AS r
      WHERE r.user_id = p_user_id AND r.status = 'active';
    IF v_count >= v_policy.concurrency_limit THEN
      v_status := 'user_concurrency';
      -- The latest a slot frees: when the first lease lapses (a settle can free one sooner).
      v_retry := greatest(1, least(90, ceil(extract(epoch FROM v_lease - v_now))))::integer;
    ELSIF p_tier = 'paid' AND v_account.credit_balance_microusd - v_held < greatest(v_cost, 1) THEN
      -- Credits held by in-flight paid reservations are not available to new ones.
      v_status := 'insufficient_credits';
    END IF;
  END IF;

  IF v_status IS NULL THEN
    -- Create-or-lock the pool key's buckets (minute first, then day) so concurrent reservations
    -- across all users serialize on that key's budget; other keys of the model are not locked.
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'minute', v_minute)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
      RETURNING * INTO v_minute_row;
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'day', v_day)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at
      RETURNING * INTO v_day_row;
    IF (v_rpd IS NOT NULL AND v_day_row.requests + 1 > v_rpd) OR
       (v_tpd IS NOT NULL AND v_day_row.tokens + p_tokens > v_tpd) OR
       (p_tier = 'paid' AND v_cpd IS NOT NULL AND v_day_row.cost_microusd + greatest(v_cost, 1) > v_cpd) THEN
      v_status := 'pool_exhausted';
      v_retry := greatest(1, ceil(extract(epoch FROM v_resets - v_now)))::integer;
    ELSIF (v_rpm IS NOT NULL AND v_minute_row.requests + 1 > v_rpm) OR
          (v_tpm IS NOT NULL AND v_minute_row.tokens + p_tokens > v_tpm) THEN
      v_status := 'pool_exhausted';
      v_retry := greatest(1, ceil(extract(epoch FROM v_minute + interval '1 minute' - v_now)))::integer;
    ELSIF v_concurrency IS NOT NULL THEN
      -- One count per pool key at a time, until this transaction ends: the bucket locks above do
      -- not suffice, since two reservations that start on either side of 00:00 UTC lock different
      -- minute and day rows. Taken last, after the bucket rows, and held by nobody who then waits
      -- for a bucket row, so it adds no lock cycle. A hash collision only serializes two keys.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('zerox_pool_concurrency:' || p_model || '|' || p_tier || '|' || v_pool_key));
      -- Requests running on this pool key now, every user's: their leases run (a lapsed lease is a
      -- request whose isolate died). A fresh snapshot, so it sees a slot taken by a reservation
      -- that held the lock before this one.
      SELECT count(*), min(r.lease_expires_at) INTO v_count, v_lease FROM public.zerox_reservations AS r
        WHERE r.status = 'active' AND r.model = p_model AND r.tier = p_tier AND r.pool_key = v_pool_key
          AND r.lease_expires_at > v_now;
      IF v_count >= v_concurrency THEN
        v_status := 'pool_exhausted';
        -- Until the first lease lapses at the latest (a settle frees the slot sooner), within the
        -- per-minute window that callers read pool_exhausted retries by (src/pool-budget.js).
        v_retry := greatest(1, least(60, ceil(extract(epoch FROM v_lease - v_now))))::integer;
      END IF;
    END IF;
  END IF;

  IF v_status IS NULL THEN
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'minute' AND pu.bucket_start = v_minute;
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      cost_microusd = pu.cost_microusd + CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'day' AND pu.bucket_start = v_day;
    UPDATE public.zerox_accounts AS a SET daily_requests = a.daily_requests + 1,
      daily_tokens_used = a.daily_tokens_used + p_tokens, total_requests = a.total_requests + 1,
      total_tokens_used = a.total_tokens_used + p_tokens, last_usage_reset = v_today,
      last_seen_at = v_now, updated_at = v_now
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
    INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens,
      reserved_cost_microusd, usage_day, pool_minute, pool_day, pool_key, created_at, lease_expires_at)
      VALUES (p_user_id, p_request_id, p_model, p_tier, v_account.plan, p_tokens,
        CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END, v_today, v_minute, v_day, v_pool_key, v_now,
        v_now + interval '90 seconds')
      RETURNING id INTO v_id;
    v_status := 'ok';
    IF v_window THEN
      v_window_used := v_window_used + p_tokens;
      v_window_resets := coalesce(v_window_oldest, v_now) + make_interval(secs => v_policy.window_seconds);
    END IF;
  ELSIF v_window AND v_window_used IS NOT NULL AND v_window_resets IS NULL THEN
    -- Refused by a later check: the window as it stands.
    v_window_resets := coalesce(v_window_oldest, v_now) + make_interval(secs => v_policy.window_seconds);
  END IF;

  RETURN QUERY SELECT v_status, v_id, v_account.plan,
    greatest(0, v_policy.daily_requests - v_account.daily_requests)::bigint,
    CASE WHEN v_window AND v_window_used IS NOT NULL
      THEN greatest(0, v_policy.window_tokens - v_window_used)
      ELSE greatest(0, v_policy.daily_tokens - v_account.daily_tokens_used) END::bigint,
    v_account.credit_balance_microusd,
    CASE WHEN v_status = 'user_window_tokens' THEN v_window_resets ELSE v_resets END,
    v_retry,
    CASE WHEN v_window THEN v_policy.window_tokens END,
    CASE WHEN v_window THEN v_policy.window_seconds END,
    v_window_used, v_window_resets;
END;
$$;

-- The rows gain window_tokens and window_seconds (null without a window).
DROP FUNCTION IF EXISTS public.zerox_plan_policies_v2();
CREATE FUNCTION public.zerox_plan_policies_v2()
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

-- Gains usage_window: for a plan with a token window, the tokens counted in the current window
-- (tokens), its limit (limit_tokens), what is left (remaining_tokens), its length
-- (window_seconds) and when the oldest counted tokens leave it (resets_at, null when the window
-- is empty); null for plans without a window. usage_today is unchanged.
DROP FUNCTION IF EXISTS public.zerox_account_overview(uuid);
CREATE FUNCTION public.zerox_account_overview(p_user_id uuid)
RETURNS TABLE (account jsonb, policy jsonb, credits jsonb, subscription jsonb, usage_today jsonb, usage_window jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH clock AS (
    SELECT (now() AT TIME ZONE 'UTC')::date AS today,
      (((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS resets_at
  )
  SELECT
    jsonb_build_object('id', a.clerk_id, 'email', a.email, 'name', a.name,
      'first_name', a.first_name, 'last_name', a.last_name, 'username', a.username,
      'image_url', a.image_url, 'plan', a.plan, 'plan_source', a.plan_source,
      'suspended', a.suspended, 'country', a.country, 'created_at', a.created_at,
      'last_seen_at', a.last_seen_at),
    to_jsonb(pol),
    jsonb_build_object('balance_microusd', a.credit_balance_microusd,
      'monthly_grant_microusd', coalesce(pol.monthly_credit_microusd, 0)),
    (SELECT to_jsonb(s) - 'raw' FROM public.zerox_current_subscription(a.clerk_id) AS s),
    jsonb_build_object('day', clock.today, 'resets_at', clock.resets_at,
      'requests', CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_requests END,
      'tokens', CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_tokens_used END,
      'remaining_requests', greatest(0, pol.daily_requests
        - CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_requests END),
      'remaining_tokens', greatest(0, pol.daily_tokens
        - CASE WHEN a.last_usage_reset < clock.today THEN 0 ELSE a.daily_tokens_used END)),
    CASE WHEN pol.window_tokens IS NOT NULL AND pol.window_seconds IS NOT NULL THEN
      jsonb_build_object('window_seconds', pol.window_seconds, 'limit_tokens', pol.window_tokens,
        'tokens', win.used, 'remaining_tokens', greatest(0, pol.window_tokens - win.used),
        'resets_at', win.oldest + make_interval(secs => pol.window_seconds)) END
  FROM public.zerox_accounts AS a
  CROSS JOIN clock
  LEFT JOIN LATERAL (
    SELECT p.* FROM public.zerox_plan_policies_v2() AS p
    WHERE p.plan IN (a.plan, 'free') ORDER BY (p.plan = a.plan) DESC LIMIT 1
  ) AS pol ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(w.tokens), 0)::bigint AS used, min(w.created_at) AS oldest
    FROM public.zerox_window_usage(a.clerk_id, pol.window_seconds) AS w
    WHERE pol.window_seconds IS NOT NULL
  ) AS win ON true
  WHERE a.clerk_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_window_usage(uuid, integer, timestamptz),
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text),
  public.zerox_plan_policies_v2(),
  public.zerox_account_overview(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_window_usage(uuid, integer, timestamptz),
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text),
  public.zerox_plan_policies_v2(),
  public.zerox_account_overview(uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
