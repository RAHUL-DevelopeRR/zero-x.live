BEGIN;
-- Replacing zerox_reserve_v2 and the usage functions takes short locks; give up (and re-run)
-- rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Sponsored pools and the monthly family allowance (docs/PLATFORM_CONTRACT.md section 19).
-- A sponsored pool is a free-tier pool on a key slot the operator pays for (Claude Haiku 5.5 on
-- anthropic.paid). Users pay nothing; the pool carries the upstream price so Zero-X's own cost is
-- recorded and capped, and each user may use a family's tokens up to a monthly allowance.
--
-- * zerox_family_month_usage: tokens, requests and sponsored cost per user, model family and
--   calendar month (UTC). RLS on, no policies, service_role only, like every table here.
-- * zerox_reservations.cap_family / cap_month remember which month row a reservation was held in;
--   zerox_usage_events and zerox_usage_daily gain sponsored_cost_microusd (what Zero-X paid).
-- * zerox_reserve_v2 takes a ninth argument p_cap {"family": ..., "month_tokens": ...} (default
--   null: the 8-argument call of the deployed gateway still resolves and behaves as before). The
--   monthly check runs after the plan's daily and window checks and before rpm, concurrency,
--   credits and the pool budgets, atomically (the account row is held, the month row is locked).
--   A refusal is status user_family_month_tokens with resets_at the first of next month 00:00 UTC.
--   The pool's spend cap p_pool.cpd now applies to any tier, and the day bucket holds the
--   worst-case cost whatever the tier (credit holds still count paid reservations only). The result
--   gains cap_family, cap_tokens, cap_used_tokens and cap_resets_at (null without p_cap).
-- * zerox_settle_v2 (same arguments): the pool's day bucket moves from the hold to the settled cost
--   for any tier; the user is still charged only on the paid tier; the sponsored cost is recorded on
--   the event, the daily rollup and the month row; the month row is corrected to the settled tokens
--   (a refund gives them back). A reservation released unsettled keeps its hold, as the daily and
--   window counters do; a late settle still corrects it.
-- * zerox_usage_by_model gains sponsored_cost_microusd; zerox_account_overview takes p_caps (an array
--   of {"family", "month_tokens"}, default null) and gains usage_month; the stale-reservation
--   housekeeping also deletes month rows older than 13 months.
--
-- Deploy the gateway first: it sends p_cap only for sponsored pools and fails closed against a
-- database without this migration (the pool reads not_configured). The old gateway works against
-- the new functions. Roll back with migrations/down/20261106000600_sponsored_pools.sql (psql -X -v
-- ON_ERROR_STOP=1 -f), before down/20261106000000_pool_fair_share.sql. zerox_reserve_v2 here carries the
-- per-user fair share of free pools (user_pool_share, 20261106000000_pool_fair_share.sql) as well as
-- the monthly allowance; apply this migration after that one. Every statement can be
-- re-run.

CREATE TABLE IF NOT EXISTS public.zerox_family_month_usage (
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  family text NOT NULL CHECK (length(family) BETWEEN 1 AND 200),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  sponsored_cost_microusd bigint NOT NULL DEFAULT 0 CHECK (sponsored_cost_microusd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, family, month)
);
COMMENT ON TABLE public.zerox_family_month_usage IS
  'Per user, model family and UTC calendar month: tokens settled or held by reservations (the monthly allowance of a sponsored family, zerox_reserve_v2 p_cap), requests and the cost Zero-X paid (billed micro-USD).';
CREATE INDEX IF NOT EXISTS zerox_family_month_usage_month_idx ON public.zerox_family_month_usage (month);
ALTER TABLE public.zerox_family_month_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_family_month_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_family_month_usage TO service_role;

ALTER TABLE public.zerox_reservations
  ADD COLUMN IF NOT EXISTS cap_family text CHECK (cap_family IS NULL OR length(cap_family) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS cap_month date;
ALTER TABLE public.zerox_usage_events
  ADD COLUMN IF NOT EXISTS sponsored_cost_microusd bigint NOT NULL DEFAULT 0 CHECK (sponsored_cost_microusd >= 0);
ALTER TABLE public.zerox_usage_daily
  ADD COLUMN IF NOT EXISTS sponsored_cost_microusd bigint NOT NULL DEFAULT 0 CHECK (sponsored_cost_microusd >= 0);

-- The result gains columns and the function an argument, so it is dropped and created again.
DROP FUNCTION IF EXISTS public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text);
DROP FUNCTION IF EXISTS public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text, jsonb);

-- Atomically checks the per-user plan quota, the monthly family allowance (p_cap), credits and the
-- shared upstream pool budget, then records a reservation. p_pool is {rpm, rpd, tpm, tpd, cpd,
-- concurrency}; a null budget is unlimited. cpd is the pool's billed micro-USD per UTC day: a
-- reservation needs room for its whole p_cost_microusd (at least 1) in the day bucket, whatever the
-- tier. concurrency is the most reservations of the pool key running at once. p_pool_key (1-300
-- characters) selects the pool's own buckets; null is the model's default. A plan with a token
-- window is checked against the tokens of the last window_seconds instead of the day's. p_cap is
-- {"family": text, "month_tokens": number} or null: the user's tokens of that family this UTC
-- month (cap_used_tokens, with this reservation when made) plus this one must fit in month_tokens,
-- else status user_family_month_tokens with resets_at = cap_resets_at (first of next month, null
-- when the request alone is larger than the allowance).
CREATE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
  p_tokens bigint, p_cost_microusd bigint, p_pool jsonb, p_pool_key text DEFAULT NULL, p_cap jsonb DEFAULT NULL)
RETURNS TABLE (status text, reservation_id uuid, plan text, remaining_requests bigint,
  remaining_tokens bigint, credit_balance_microusd bigint, resets_at timestamptz, retry_after_seconds integer,
  window_tokens bigint, window_seconds integer, window_used_tokens bigint, window_resets_at timestamptz,
  cap_family text, cap_tokens bigint, cap_used_tokens bigint, cap_resets_at timestamptz)
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
  v_cap_family text;
  v_cap_tokens bigint;
  v_cap_used bigint;
  v_cap_resets timestamptz;
  v_cap_row public.zerox_family_month_usage;
  v_month date;
  v_share_pct constant integer := 25;
  v_share_requests bigint;
  v_share_tokens bigint;
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

  IF p_cap IS NOT NULL AND jsonb_typeof(p_cap) <> 'null' THEN
    IF jsonb_typeof(p_cap) <> 'object' THEN RAISE EXCEPTION 'invalid_cap: p_cap must be an object or null'; END IF;
    IF jsonb_typeof(p_cap -> 'family') IS DISTINCT FROM 'string' OR length(p_cap ->> 'family') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'invalid_cap: family must be 1-200 characters';
    END IF;
    IF jsonb_typeof(p_cap -> 'month_tokens') IS DISTINCT FROM 'number' OR (p_cap ->> 'month_tokens')::numeric < 1 THEN
      RAISE EXCEPTION 'invalid_cap: month_tokens must be a positive number';
    END IF;
    v_cap_family := p_cap ->> 'family';
    v_cap_tokens := floor((p_cap ->> 'month_tokens')::numeric)::bigint;
    v_month := date_trunc('month', v_now AT TIME ZONE 'UTC')::date;
    v_cap_resets := (v_month + interval '1 month') AT TIME ZONE 'UTC';
  END IF;

  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_account'::text, NULL::uuid, NULL::text, NULL::bigint, NULL::bigint,
      NULL::bigint, NULL::timestamptz, NULL::integer, NULL::bigint, NULL::integer, NULL::bigint, NULL::timestamptz,
      NULL::text, NULL::bigint, NULL::bigint, NULL::timestamptz;
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
    IF p_tokens > v_policy.window_tokens THEN
      -- Larger than the whole window: it never fits, so there is no time to retry at (resets_at
      -- and retry_after_seconds are null); window_resets_at is the window as it stands.
      v_status := 'user_window_tokens';
      v_window_resets := coalesce(v_window_oldest, v_now) + make_interval(secs => v_policy.window_seconds);
    ELSIF v_window_used + p_tokens > v_policy.window_tokens THEN
      v_status := 'user_window_tokens';
      -- The first moment enough of the window has expired for this request: the made-at time of
      -- the earliest reservation whose expiry (with all older ones) frees enough tokens, plus the
      -- window. Such a reservation always exists, since this request alone fits in the window.
      SELECT min(q.created_at) INTO v_window_resets FROM (
        SELECT w.created_at, sum(w.tokens) OVER (ORDER BY w.created_at ROWS UNBOUNDED PRECEDING) AS freed
        FROM public.zerox_window_usage(p_user_id, v_policy.window_seconds, v_now) AS w) AS q
        WHERE v_window_used - q.freed + p_tokens <= v_policy.window_tokens;
      v_window_resets := coalesce(v_window_resets, v_now) + make_interval(secs => v_policy.window_seconds);
      v_retry := greatest(1, ceil(extract(epoch FROM v_window_resets - v_now)))::integer;
    END IF;
  END IF;

  IF v_status IS NULL AND v_cap_family IS NOT NULL THEN
    -- The family's monthly token allowance (sponsored pools): the user's tokens this calendar month
    -- (settled usage plus what running and released reservations hold) plus this reservation must
    -- fit. The row is created or locked here (the account row is already held, so a user's own
    -- reservations serialize before this point); a refusal writes nothing but updated_at.
    INSERT INTO public.zerox_family_month_usage AS u (user_id, family, month)
      VALUES (p_user_id, v_cap_family, v_month)
      ON CONFLICT (user_id, family, month) DO UPDATE SET updated_at = u.updated_at
      RETURNING * INTO v_cap_row;
    v_cap_used := v_cap_row.tokens;
    IF v_cap_used + p_tokens > v_cap_tokens THEN
      v_status := 'user_family_month_tokens';
      -- Larger than the whole allowance: it never fits, so there is no time to retry at.
      IF p_tokens <= v_cap_tokens THEN
        v_retry := greatest(1, ceil(extract(epoch FROM v_cap_resets - v_now)))::integer;
      END IF;
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
    -- Fair share of a free pool (security audit 2026-11-05, F6; 20261106000000_pool_fair_share.sql):
    -- one user may take at most v_share_pct percent of a free pool's daily request budget (rpd) and
    -- of its daily token budget (tpd), so a few accounts cannot use up a small shared pool before
    -- everyone else. The count is this user's reservations on this pool key today that were not
    -- released, their settled tokens or what they reserved. A user is refused once it has USED its
    -- share, not when one request would pass it. 'user_pool_share' is about this user only: the
    -- gateway tries the caller's next pool without remembering this one as spent. A sponsored pool
    -- carries a spend cap (cpd) and no rpd or tpd, so it is not affected; its fairness is the
    -- monthly allowance above. The account row is locked above, so a user's own reservations cannot
    -- race each other.
    IF p_tier = 'free' AND (v_rpd IS NOT NULL OR v_tpd IS NOT NULL) THEN
      SELECT count(*)::bigint,
          coalesce(sum(coalesce(r.prompt_tokens + r.completion_tokens, r.reserved_tokens)), 0)::bigint
        INTO v_share_requests, v_share_tokens FROM public.zerox_reservations AS r
        WHERE r.user_id = p_user_id AND r.pool_day = v_day AND r.model = p_model AND r.tier = p_tier
          AND r.pool_key = v_pool_key AND r.status <> 'released';
    END IF;
    IF v_share_requests IS NOT NULL AND
       ((v_rpd IS NOT NULL AND v_share_requests >= ceil(v_rpd * v_share_pct / 100.0)) OR
        (v_tpd IS NOT NULL AND v_share_tokens >= ceil(v_tpd * v_share_pct / 100.0))) THEN
      v_status := 'user_pool_share';
      v_retry := greatest(1, ceil(extract(epoch FROM v_resets - v_now)))::integer;
    ELSIF (v_rpd IS NOT NULL AND v_day_row.requests + 1 > v_rpd) OR
       (v_tpd IS NOT NULL AND v_day_row.tokens + p_tokens > v_tpd) OR
       (v_cpd IS NOT NULL AND v_day_row.cost_microusd + greatest(v_cost, 1) > v_cpd) THEN
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
      cost_microusd = pu.cost_microusd + v_cost,
      updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'day' AND pu.bucket_start = v_day;
    UPDATE public.zerox_accounts AS a SET daily_requests = a.daily_requests + 1,
      daily_tokens_used = a.daily_tokens_used + p_tokens, total_requests = a.total_requests + 1,
      total_tokens_used = a.total_tokens_used + p_tokens, last_usage_reset = v_today,
      last_seen_at = v_now, updated_at = v_now
      WHERE a.clerk_id = p_user_id RETURNING * INTO v_account;
    INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens,
      reserved_cost_microusd, usage_day, pool_minute, pool_day, pool_key, created_at, lease_expires_at,
      cap_family, cap_month)
      VALUES (p_user_id, p_request_id, p_model, p_tier, v_account.plan, p_tokens,
        v_cost, v_today, v_minute, v_day, v_pool_key, v_now,
        v_now + interval '90 seconds', v_cap_family, CASE WHEN v_cap_family IS NOT NULL THEN v_month END)
      RETURNING id INTO v_id;
    IF v_cap_family IS NOT NULL THEN
      UPDATE public.zerox_family_month_usage AS u SET tokens = u.tokens + p_tokens, requests = u.requests + 1,
        updated_at = v_now
        WHERE u.user_id = p_user_id AND u.family = v_cap_family AND u.month = v_month;
      v_cap_used := v_cap_used + p_tokens;
    END IF;
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
    CASE WHEN v_status = 'user_family_month_tokens' THEN CASE WHEN p_tokens <= v_cap_tokens THEN v_cap_resets END
      WHEN v_status <> 'user_window_tokens' THEN v_resets
      WHEN p_tokens <= v_policy.window_tokens THEN v_window_resets END,
    v_retry,
    CASE WHEN v_window THEN v_policy.window_tokens END,
    CASE WHEN v_window THEN v_policy.window_seconds END,
    v_window_used, v_window_resets,
    v_cap_family, v_cap_tokens, v_cap_used, v_cap_resets;
END;
$$;

CREATE OR REPLACE FUNCTION public.zerox_settle_v2(p_reservation_id uuid, p_prompt_tokens bigint,
  p_completion_tokens bigint, p_cost_microusd bigint, p_status text, p_latency_ms integer,
  p_provider text, p_upstream_model text, p_error_code text,
  p_cache_read_tokens bigint DEFAULT 0, p_cache_write_tokens bigint DEFAULT 0)
RETURNS TABLE (status text, credit_balance_microusd bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_reservation public.zerox_reservations;
  v_balance bigint;
  v_prompt bigint := coalesce(p_prompt_tokens, 0);
  v_completion bigint := coalesce(p_completion_tokens, 0);
  v_cache_read bigint := coalesce(p_cache_read_tokens, 0);
  v_cache_write bigint := coalesce(p_cache_write_tokens, 0);
  v_delta bigint;
  v_user_delta bigint;
  v_user_prompt bigint;
  v_user_completion bigint;
  v_user_cache_read bigint;
  v_user_cache_write bigint;
  v_refund integer;
  v_pool_refund integer;
  v_effective text;
  v_account public.zerox_accounts;
  v_allowance bigint;
  v_refunds_used bigint := 0;
  v_count_refund boolean := false;
  v_cost bigint := 0;
  v_pool_cost bigint := 0;
  v_charged bigint;
  v_sponsored bigint := 0;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('ok', 'error', 'refunded', 'failed_upstream') THEN
    RAISE EXCEPTION 'invalid_settlement: p_status must be ok, error, refunded or failed_upstream';
  END IF;
  IF v_prompt < 0 OR v_completion < 0 OR coalesce(p_cost_microusd, 0) < 0 OR coalesce(p_latency_ms, 0) < 0 THEN
    RAISE EXCEPTION 'invalid_settlement: token, cost and latency values must be nonnegative';
  END IF;
  IF v_cache_read < 0 OR v_cache_write < 0 OR v_cache_read + v_cache_write > v_prompt THEN
    RAISE EXCEPTION 'invalid_settlement: cache token counts must be nonnegative and sum to at most p_prompt_tokens';
  END IF;

  SELECT * INTO v_reservation FROM public.zerox_reservations AS r WHERE r.id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_reservation.status = 'settled' THEN
    RETURN QUERY SELECT 'already_settled'::text, a.credit_balance_microusd
      FROM public.zerox_accounts AS a WHERE a.clerk_id = v_reservation.user_id;
    RETURN;
  END IF;

  v_delta := v_prompt + v_completion - v_reservation.reserved_tokens;
  SELECT * INTO v_account FROM public.zerox_accounts AS a WHERE a.clerk_id = v_reservation.user_id FOR UPDATE;
  v_effective := p_status;
  IF p_status = 'failed_upstream' THEN
    SELECT greatest(5, pp.daily_requests / 10) INTO v_allowance FROM public.zerox_plan_policy AS pp
      WHERE pp.plan IN (v_reservation.plan, 'free') ORDER BY (pp.plan = v_reservation.plan) DESC LIMIT 1;
    IF v_account.upstream_refund_day = v_reservation.usage_day THEN v_refunds_used := v_account.upstream_refunds; END IF;
    v_effective := CASE WHEN v_refunds_used < coalesce(v_allowance, 5) THEN 'refunded' ELSE 'error' END;
  END IF;
  v_refund := CASE WHEN v_effective = 'refunded' THEN 1 ELSE 0 END;
  v_pool_refund := CASE WHEN p_status = 'refunded' THEN 1 ELSE 0 END;
  -- The allowance counter belongs to the latest UTC day: a late settle of an earlier day's
  -- reservation (across midnight) is not counted, and never resets the current day's count.
  v_count_refund := p_status = 'failed_upstream' AND v_refund = 1
    AND (v_account.upstream_refund_day IS NULL OR v_account.upstream_refund_day <= v_reservation.usage_day);
  -- A refunded failed_upstream attempt costs the user nothing; the pool still counts it.
  IF p_status = 'failed_upstream' AND v_refund = 1 THEN
    v_user_delta := -v_reservation.reserved_tokens;
    v_user_prompt := 0;
    v_user_completion := 0;
    v_user_cache_read := 0;
    v_user_cache_write := 0;
  ELSE
    v_user_delta := v_delta;
    v_user_prompt := v_prompt;
    v_user_completion := v_completion;
    v_user_cache_read := v_cache_read;
    v_user_cache_write := v_cache_write;
  END IF;
  IF v_reservation.tier = 'paid' AND v_effective <> 'refunded' THEN v_cost := coalesce(p_cost_microusd, 0); END IF;
  -- The pool's day bucket moves from the hold to the settled cost whatever the tier: a sponsored free
  -- pool carries a price too (the hold was added to the bucket by zerox_reserve_v2).
  IF p_status <> 'refunded' THEN v_pool_cost := coalesce(p_cost_microusd, 0); END IF;
  -- What Zero-X paid for a free-tier request on a priced (sponsored) pool; the user is charged
  -- nothing (v_cost stays paid-only). A failed_upstream attempt refunded to the user still cost it.
  IF v_reservation.tier = 'free' AND p_status <> 'refunded' THEN v_sponsored := coalesce(p_cost_microusd, 0); END IF;

  v_charged := least(v_cost, v_account.credit_balance_microusd);
  UPDATE public.zerox_accounts AS a SET
    daily_tokens_used = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_tokens_used + v_user_delta) ELSE a.daily_tokens_used END,
    daily_requests = CASE WHEN a.last_usage_reset = v_reservation.usage_day
      THEN greatest(0, a.daily_requests - v_refund) ELSE a.daily_requests END,
    total_tokens_used = greatest(0, a.total_tokens_used + v_user_delta),
    total_requests = greatest(0, a.total_requests - v_refund),
    upstream_refunds = CASE WHEN v_count_refund THEN v_refunds_used + 1 ELSE a.upstream_refunds END,
    upstream_refund_day = CASE WHEN v_count_refund THEN v_reservation.usage_day ELSE a.upstream_refund_day END,
    credit_balance_microusd = a.credit_balance_microusd - v_charged,
    updated_at = now()
    WHERE a.clerk_id = v_reservation.user_id
    RETURNING a.credit_balance_microusd INTO v_balance;

  IF v_cost > 0 THEN
    INSERT INTO public.zerox_credit_ledger (user_id, delta_microusd, balance_after_microusd,
      shortfall_microusd, reason, ref)
      VALUES (v_reservation.user_id, -v_charged, v_balance, v_cost - v_charged, 'usage',
        'usage:' || v_reservation.id::text);
  END IF;

  UPDATE public.zerox_pool_usage AS pu SET tokens = greatest(0, pu.tokens + v_delta),
    requests = greatest(0, pu.requests - v_pool_refund), updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier AND pu.pool_key = v_reservation.pool_key
      AND pu.bucket = 'minute' AND pu.bucket_start = v_reservation.pool_minute;
  UPDATE public.zerox_pool_usage AS pu SET tokens = greatest(0, pu.tokens + v_delta),
    requests = greatest(0, pu.requests - v_pool_refund),
    cost_microusd = greatest(0, pu.cost_microusd + v_pool_cost - v_reservation.reserved_cost_microusd),
    updated_at = now()
    WHERE pu.model = v_reservation.model AND pu.tier = v_reservation.tier AND pu.pool_key = v_reservation.pool_key
      AND pu.bucket = 'day' AND pu.bucket_start = v_reservation.pool_day;

  INSERT INTO public.zerox_usage_events (user_id, reservation_id, request_id, model, provider,
    upstream_model, tier, status, prompt_tokens, completion_tokens, cost_microusd, latency_ms,
    error_code, usage_day, cache_read_tokens, cache_write_tokens, sponsored_cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.id, v_reservation.request_id, v_reservation.model,
      left(coalesce(p_provider, ''), 100), left(coalesce(p_upstream_model, ''), 200), v_reservation.tier,
      v_effective, v_user_prompt, v_user_completion, v_cost, p_latency_ms, left(p_error_code, 100),
      v_reservation.usage_day, v_user_cache_read, v_user_cache_write, v_sponsored)
    ON CONFLICT (reservation_id) DO NOTHING;
  INSERT INTO public.zerox_usage_daily AS d (user_id, day, model, requests, errors, prompt_tokens,
    completion_tokens, cost_microusd, cache_read_tokens, cache_write_tokens, sponsored_cost_microusd)
    VALUES (v_reservation.user_id, v_reservation.usage_day, v_reservation.model, 1 - v_refund,
      CASE WHEN p_status = 'ok' THEN 0 ELSE 1 END, v_user_prompt, v_user_completion, v_cost,
      v_user_cache_read, v_user_cache_write, v_sponsored)
    ON CONFLICT (user_id, day, model) DO UPDATE SET requests = d.requests + EXCLUDED.requests,
      errors = d.errors + EXCLUDED.errors, prompt_tokens = d.prompt_tokens + EXCLUDED.prompt_tokens,
      completion_tokens = d.completion_tokens + EXCLUDED.completion_tokens,
      cost_microusd = d.cost_microusd + EXCLUDED.cost_microusd,
      cache_read_tokens = d.cache_read_tokens + EXCLUDED.cache_read_tokens,
      cache_write_tokens = d.cache_write_tokens + EXCLUDED.cache_write_tokens,
      sponsored_cost_microusd = d.sponsored_cost_microusd + EXCLUDED.sponsored_cost_microusd, updated_at = now();

  -- The monthly family allowance row (zerox_reserve_v2 p_cap) ends at exactly the tokens the usage
  -- event records: the hold is replaced by the settled tokens, a refund returns it and the request.
  -- Lock order as in zerox_reserve_v2: reservation, account, month row.
  IF v_reservation.cap_family IS NOT NULL THEN
    UPDATE public.zerox_family_month_usage AS u SET tokens = greatest(0, u.tokens + v_user_delta),
      requests = greatest(0, u.requests - v_refund), sponsored_cost_microusd = u.sponsored_cost_microusd + v_sponsored,
      updated_at = now()
      WHERE u.user_id = v_reservation.user_id AND u.family = v_reservation.cap_family AND u.month = v_reservation.cap_month;
  END IF;

  UPDATE public.zerox_reservations AS r SET status = 'settled', outcome = p_status,
    prompt_tokens = v_prompt, completion_tokens = v_completion, cost_microusd = v_cost,
    cache_read_tokens = v_cache_read, cache_write_tokens = v_cache_write, settled_at = now()
    WHERE r.id = v_reservation.id;
  RETURN QUERY SELECT 'settled'::text, v_balance;
END;
$$;

DROP FUNCTION IF EXISTS public.zerox_usage_by_model(uuid, date, date);
CREATE FUNCTION public.zerox_usage_by_model(p_user_id uuid, p_from date, p_to date)
RETURNS TABLE (model text, requests bigint, prompt_tokens bigint, cache_read_tokens bigint,
  cache_write_tokens bigint, completion_tokens bigint, cost_microusd bigint, sponsored_cost_microusd bigint)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid_range: p_from must not be after p_to and the range is at most 367 days';
  END IF;
  RETURN QUERY
    SELECT d.model, sum(d.requests)::bigint, sum(d.prompt_tokens)::bigint,
      sum(d.cache_read_tokens)::bigint, sum(d.cache_write_tokens)::bigint,
      sum(d.completion_tokens)::bigint, sum(d.cost_microusd)::bigint, sum(d.sponsored_cost_microusd)::bigint
    FROM public.zerox_usage_daily AS d
    WHERE d.user_id = p_user_id AND d.day BETWEEN p_from AND p_to
    GROUP BY d.model ORDER BY sum(d.requests) DESC, d.model;
END;
$$;

DROP FUNCTION IF EXISTS public.zerox_account_overview(uuid);
DROP FUNCTION IF EXISTS public.zerox_account_overview(uuid, jsonb);
CREATE FUNCTION public.zerox_account_overview(p_user_id uuid, p_caps jsonb DEFAULT NULL)
RETURNS TABLE (account jsonb, policy jsonb, credits jsonb, subscription jsonb, usage_today jsonb, usage_window jsonb,
  usage_month jsonb)
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
        'resets_at', win.oldest + make_interval(secs => pol.window_seconds)) END,
    coalesce((SELECT jsonb_agg(jsonb_build_object('family', m.family, 'tokens', m.tokens, 'requests', m.requests,
        'limit_tokens', cap.limit_tokens, 'remaining_tokens', CASE WHEN cap.limit_tokens IS NOT NULL
          THEN greatest(0, cap.limit_tokens - m.tokens) END,
        'resets_at', (m.month + interval '1 month') AT TIME ZONE 'UTC') ORDER BY m.family)
      FROM public.zerox_family_month_usage AS m
      LEFT JOIN LATERAL (SELECT (c.value ->> 'month_tokens')::bigint AS limit_tokens
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_caps) = 'array' THEN p_caps ELSE '[]'::jsonb END) AS c(value)
        WHERE c.value ->> 'family' = m.family LIMIT 1) AS cap ON true
      WHERE m.user_id = a.clerk_id AND m.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date), '[]'::jsonb)
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

CREATE OR REPLACE FUNCTION public.zerox_release_stale_reservations()
RETURNS TABLE (released bigint)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_released bigint;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.zerox_reservations AS r
    WHERE r.status = 'active'
      AND coalesce(r.lease_expires_at, r.created_at + interval '10 minutes') < now() - interval '5 minutes'
      AND (r.tier <> 'paid' OR r.created_at < now() - interval '60 minutes')
    ORDER BY r.created_at LIMIT 10000 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.zerox_reservations AS r SET status = 'released', settled_at = now()
    FROM stale WHERE r.id = stale.id;
  GET DIAGNOSTICS v_released = ROW_COUNT;

  DELETE FROM public.zerox_reservations AS r WHERE r.id IN (
    SELECT old.id FROM public.zerox_reservations AS old
    WHERE old.status <> 'active' AND old.created_at < now() - interval '30 days' LIMIT 10000);
  DELETE FROM public.zerox_pool_usage AS pu
    WHERE pu.bucket = 'minute' AND pu.bucket_start < now() - interval '1 day';
  DELETE FROM public.zerox_pool_usage AS pu
    WHERE pu.bucket = 'day' AND pu.bucket_start < now() - interval '90 days';
  DELETE FROM public.zerox_family_month_usage AS u WHERE (u.user_id, u.family, u.month) IN (
    SELECT old.user_id, old.family, old.month FROM public.zerox_family_month_usage AS old
    WHERE old.month < (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '13 months')::date LIMIT 10000);
  DELETE FROM public.zerox_session_index AS si WHERE si.expires_at < now();
  DELETE FROM public.zerox_webhook_events AS w WHERE w.received_at < now() - interval '90 days';

  RETURN QUERY SELECT v_released;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text, jsonb),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_account_overview(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text, jsonb),
  public.zerox_usage_by_model(uuid, date, date),
  public.zerox_account_overview(uuid, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
