BEGIN;
-- Replacing zerox_reserve_v2 takes a short lock; give up (and re-run) rather than queue behind a
-- long transaction.
SET LOCAL lock_timeout = '5s';

-- Fair share and refunded attempts (go-live follow-up). zerox_reserve_v2 (same arguments and result as
-- 20261107000000) changes two things in the per-user share of a free pool (user_pool_share):
--   1. An attempt that was settled refunded does not count toward the share. A refunded attempt is
--      one the upstream failed (429, 5xx, network or auth failure; the usage event status is
--      'refunded', also a failed_upstream attempt inside the user's refund allowance). Counting it
--      let a free user lose a small pool for the day to failures that were not theirs. Settled ok and
--      error attempts, and unsettled holds, still count; released ones never did.
--   2. A pool with rpd 0 or tpd 0 has no budget at all: it answers pool_exhausted. Before, the share
--      limit of such a pool is 0, so every user read user_pool_share (a per-user refusal that sends
--      the caller on to the next pool but does not mark this one spent).
-- The spend share (cpd) is unchanged: it already gives a refunded attempt's cost back. The pool's own
-- caps are unchanged. No table changes. The deployed gateway needs no change.
--
-- Roll back with migrations/down/20261107000100_pool_share_refunds.sql (psql -X -v
-- ON_ERROR_STOP=1 -f). Every statement can be re-run.

CREATE OR REPLACE FUNCTION public.zerox_reserve_v2(p_user_id uuid, p_request_id text, p_model text, p_tier text,
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
  v_share_cost bigint;
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
    -- released and were not settled refunded (an upstream failure is not the user's use of the pool;
    -- 20261107000100_pool_share_refunds.sql): their settled tokens or what they reserved. A user is
    -- refused once it has USED its share, not when one request would pass it. 'user_pool_share' is
    -- about this user only: the gateway tries the caller's next pool without remembering this one as
    -- spent. A pool with rpd 0 or tpd 0 has no budget to share: it skips this check and reads
    -- pool_exhausted below. A sponsored pool carries a spend cap (cpd) and no rpd or tpd, so it is not
    -- affected by the request and token share; its fairness is the monthly allowance above. The
    -- account row is locked above, so a user's own reservations cannot race each other.
    -- Spend share of a sponsored pool (finding M3, 20261107000000_pool_user_cost_share.sql): the same
    -- fraction of the pool's daily spend cap (cpd). The user's spend today on this pool key is the
    -- cost Zero-X paid for its settled reservations (the usage event's sponsored cost, 0 for a
    -- refunded one) plus the hold of its unsettled ones; a request that would take it past the share
    -- is refused, so no single account spends more than v_share_pct percent of cpd (the check
    -- includes this request's own hold). A user's own reservations are serialized by the account
    -- row lock. cpd 0 stays pool_exhausted below (the cap is spent for everyone).
    IF p_tier = 'free' AND coalesce(v_rpd, 1) > 0 AND coalesce(v_tpd, 1) > 0
       AND (v_rpd IS NOT NULL OR v_tpd IS NOT NULL OR v_cpd > 0) THEN
      SELECT count(*)::bigint,
          coalesce(sum(coalesce(r.prompt_tokens + r.completion_tokens, r.reserved_tokens)), 0)::bigint,
          coalesce(sum(CASE WHEN r.status = 'settled' THEN coalesce(e.sponsored_cost_microusd, 0)
            ELSE r.reserved_cost_microusd END), 0)::bigint
        INTO v_share_requests, v_share_tokens, v_share_cost FROM public.zerox_reservations AS r
        LEFT JOIN public.zerox_usage_events AS e ON e.reservation_id = r.id
        WHERE r.user_id = p_user_id AND r.pool_day = v_day AND r.model = p_model AND r.tier = p_tier
          AND r.pool_key = v_pool_key AND r.status <> 'released'
          AND NOT (r.status = 'settled' AND (coalesce(r.outcome = 'refunded', false) OR coalesce(e.status = 'refunded', false)));
    -- NULL-safe: a settled attempt with no usage event (the LEFT JOIN finds none) or a null outcome
    -- is not refunded, so it counts; a bare NOT (... OR NULL) would drop it from the share.
    END IF;
    IF v_share_requests IS NOT NULL AND
       ((v_rpd IS NOT NULL AND v_share_requests >= ceil(v_rpd * v_share_pct / 100.0)) OR
        (v_tpd IS NOT NULL AND v_share_tokens >= ceil(v_tpd * v_share_pct / 100.0)) OR
        (v_cpd > 0 AND v_share_cost + greatest(v_cost, 1) > ceil(v_cpd * v_share_pct / 100.0))) THEN
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

REVOKE ALL ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_reserve_v2(uuid, text, text, text, bigint, bigint, jsonb, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
