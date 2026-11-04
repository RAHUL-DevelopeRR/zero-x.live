BEGIN;
-- New tables and functions, plus two metadata-only changes to zerox_reservations (below): nothing
-- existing is locked for long. Give up (and re-run) rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Active model health checks (src/health-probes.js, docs/PLATFORM_CONTRACT.md section 15).
-- The Node gateway runs two instances on the EC2 VM during a deploy (zerox-gateway@0 and @1),
-- and could run on more than one host later, so exactly one process may send test requests:
-- the holder of the `health_probes` lease below. A session advisory lock does not work through
-- PostgREST (every RPC is its own transaction on a pooled connection), so the lease is a row with
-- an expiry that the holder renews on every tick; when the holder stops renewing (a crash, a
-- deploy that stopped it), another instance takes the lease once it has expired.
--
-- zerox_pool_health holds one row per pool (src/catalog.js poolKey: provider:upstream:tier and a
-- vault key id) with the leader's latest verdict. Every instance reads it, so /v1/models and
-- /v1/models/status answer the same on both instances, and a restarted leader keeps its probe
-- counts for the day. Rows carry metadata only: statuses, times, latencies and failure classes,
-- never a prompt, a completion, a key or a provider message.
--
-- zerox_probe_take counts a test request against the pool's shared budget in zerox_pool_usage
-- (the same minute and day buckets zerox_reserve_v2 counts users' requests in), so test requests
-- never let users' requests pass the upstream's limits. It refuses a test request while the pool
-- is busy with users: its one-at-a-time slot is taken, or users already used half of its
-- per-minute requests or tokens. It also reports the pool's settled user outcomes of the last
-- ten minutes, so the leader can count real traffic seen by any instance as an observation: a
-- success, or an upstream failure (a missing model, a 5xx, a timeout or a rejected key) newer than
-- any success.
--
-- A test request on a one-at-a-time pool (Z.ai's free GLM Flash) holds the slot like a user's
-- request: zerox_probe_take inserts a short active reservation without a user (plan 'probe'), which
-- the concurrency count of zerox_reserve_v2 sees, and zerox_probe_release frees it when the test
-- request ends. zerox_reservations.user_id therefore allows null, for probe rows only (the check
-- constraint below). Every per-user query filters by user_id, so probe rows never count for a user.
-- Roll back with migrations/down/20261104000000_health_probes.sql (psql -X -v ON_ERROR_STOP=1 -f).

CREATE TABLE public.zerox_pool_health (
  pool text PRIMARY KEY CHECK (length(pool) BETWEEN 1 AND 300),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  tier text NOT NULL CHECK (tier IN ('free', 'paid')),
  -- The verdict now: base_status overlaid by a timed state (busy until a slot or rate limit frees,
  -- unavailable while delisted, rejected or out of quota). base_status is the last request-level
  -- verdict (a test request or users' traffic), made at verdict_at, which applies again once
  -- available_again_at passes. checked_at is when the state in `status` was observed (null: never);
  -- readers report unknown once it is older than HEALTH_STALE_SECONDS. A model list only confirms
  -- that the model is still offered (listed_at): it never refreshes checked_at, so an old test
  -- verdict goes stale even while the model stays listed.
  status text NOT NULL CHECK (status IN ('available', 'busy', 'degraded', 'unavailable', 'unknown')),
  base_status text NOT NULL DEFAULT 'unknown' CHECK (base_status IN ('available', 'degraded', 'unavailable', 'unknown')),
  available_again_at timestamptz,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_class text CHECK (failure_class IS NULL OR failure_class ~ '^[a-z_]{1,40}$'),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  tool_ok boolean,
  tool_checked_at timestamptz,
  probed_at timestamptz,
  probe_day date,
  probe_count integer NOT NULL DEFAULT 0 CHECK (probe_count >= 0),
  source text NOT NULL CHECK (source IN ('probe', 'list', 'traffic', 'budget')),
  verdict_at timestamptz,
  listed_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Probe slot rows (see above). Both changes are metadata only: no rewrite and no scan (existing
-- rows all have a user, and NOT VALID skips checking them).
ALTER TABLE public.zerox_reservations ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.zerox_reservations ADD CONSTRAINT zerox_reservations_user_or_probe
  CHECK (user_id IS NOT NULL OR (plan = 'probe' AND request_id LIKE 'probe:%')) NOT VALID;

CREATE TABLE public.zerox_health_lease (
  name text PRIMARY KEY CHECK (name = 'health_probes'),
  holder text NOT NULL CHECK (length(holder) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL
);

-- Takes or renews the probe lease for p_holder for p_ttl_seconds (10-600), or releases it when
-- p_ttl_seconds is 0 (a stopping leader, so the next instance need not wait for the expiry).
-- leader is true while p_holder holds it.
CREATE OR REPLACE FUNCTION public.zerox_health_lease(p_holder text, p_ttl_seconds integer)
RETURNS TABLE (leader boolean, holder text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_row public.zerox_health_lease;
BEGIN
  IF p_holder IS NULL OR length(p_holder) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_lease: p_holder must be 1-200 characters';
  END IF;
  IF p_ttl_seconds IS NULL OR (p_ttl_seconds <> 0 AND p_ttl_seconds NOT BETWEEN 10 AND 600) THEN
    RAISE EXCEPTION 'invalid_lease: p_ttl_seconds must be 0 or 10-600';
  END IF;
  IF p_ttl_seconds = 0 THEN
    UPDATE public.zerox_health_lease AS l SET expires_at = v_now
      WHERE l.name = 'health_probes' AND l.holder = p_holder;
    RETURN QUERY SELECT false, l.holder, l.expires_at FROM public.zerox_health_lease AS l WHERE l.name = 'health_probes';
    RETURN;
  END IF;
  INSERT INTO public.zerox_health_lease AS l (name, holder, expires_at)
    VALUES ('health_probes', p_holder, v_now + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
      WHERE l.holder = EXCLUDED.holder OR l.expires_at <= v_now
    RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_row.holder, v_row.expires_at;
    RETURN;
  END IF;
  RETURN QUERY SELECT false, l.holder, l.expires_at FROM public.zerox_health_lease AS l WHERE l.name = 'health_probes';
END;
$$;

-- One test request against a pool's shared budget. p_pool is the {rpm, rpd, tpm, tpd, cpd,
-- concurrency} object zerox_reserve_v2 takes for the pool (src/capacity.js reservationArgs) and
-- p_pool_key its bucket (null: the model's default). status:
--   ok              counted (when p_take) in the minute and day buckets; send the test request.
--                   On a pool with a concurrency limit it also takes a slot for p_lease_seconds
--                   (5-300): slot_id, which zerox_probe_release frees when the request ends
--   pool_full       the pool's one-at-a-time slots are all taken by users' requests
--   pool_exhausted  the request would pass a budget (retry_after_seconds: next minute or 00:00 UTC)
--   pool_busy       users already used half of the minute's requests or tokens: their traffic is
--                   the observation, and the test request waits
-- p_take false only reports (nothing is counted or locked). running counts the pool key's
-- requests in flight (live leases, test requests included); recent_* are the pool key's settled
-- user outcomes of the last ten minutes: ok, and failed (the upstream failed: its error code is
-- model_unavailable, upstream_error, upstream_timeout or upstream_auth, whether the attempt was
-- refunded or not; a rate limit, a client that went away or a rejected request is no failure of
-- the model).
CREATE OR REPLACE FUNCTION public.zerox_probe_take(p_model text, p_tier text, p_pool_key text, p_pool jsonb,
  p_tokens bigint, p_cost_microusd bigint, p_take boolean, p_lease_seconds integer DEFAULT 60)
RETURNS TABLE (status text, retry_after_seconds integer, running bigint, minute_requests bigint, minute_tokens bigint,
  day_requests bigint, recent_ok bigint, recent_failed bigint, last_ok_at timestamptz, last_failed_at timestamptz,
  slot_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'UTC')::date;
  v_resets timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'UTC');
  v_minute timestamptz := date_trunc('minute', v_now, 'UTC');
  v_day timestamptz := (v_today::timestamp AT TIME ZONE 'UTC');
  v_pool_key text := coalesce(p_pool_key, '');
  v_cost bigint := coalesce(p_cost_microusd, 0);
  v_status text := 'ok';
  v_retry integer;
  v_running bigint;
  v_lease timestamptz;
  v_minute_requests bigint := 0;
  v_minute_tokens bigint := 0;
  v_day_requests bigint := 0;
  v_day_tokens bigint := 0;
  v_day_cost bigint := 0;
  v_ok bigint;
  v_failed bigint;
  v_last_ok timestamptz;
  v_last_failed timestamptz;
  v_key text;
  v_invalid boolean;
  v_slot uuid;
  v_rpm bigint;
  v_rpd bigint;
  v_tpm bigint;
  v_tpd bigint;
  v_cpd bigint;
  v_concurrency bigint;
BEGIN
  IF p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_probe: p_model must be 1-200 characters';
  END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('free', 'paid') THEN RAISE EXCEPTION 'invalid_probe: p_tier must be free or paid'; END IF;
  IF p_pool_key IS NOT NULL AND length(p_pool_key) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid_probe: p_pool_key must be 1-300 characters or null';
  END IF;
  IF p_tokens IS NULL OR p_tokens < 1 OR p_tokens > 100000 THEN
    RAISE EXCEPTION 'invalid_probe: p_tokens must be 1-100000';
  END IF;
  IF v_cost < 0 THEN RAISE EXCEPTION 'invalid_probe: p_cost_microusd must be nonnegative'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid_probe: p_lease_seconds must be 5-300';
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

  IF p_take THEN
    -- The same bucket rows, in the same order, as zerox_reserve_v2: a test request and users'
    -- reservations of this pool key serialize on them.
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'minute', v_minute)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at;
    INSERT INTO public.zerox_pool_usage AS pu (model, tier, pool_key, bucket, bucket_start)
      VALUES (p_model, p_tier, v_pool_key, 'day', v_day)
      ON CONFLICT (model, tier, pool_key, bucket, bucket_start) DO UPDATE SET updated_at = pu.updated_at;
    IF v_concurrency IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('zerox_pool_concurrency:' || p_model || '|' || p_tier || '|' || v_pool_key));
    END IF;
  END IF;
  SELECT coalesce(max(pu.requests), 0), coalesce(max(pu.tokens), 0) INTO v_minute_requests, v_minute_tokens
    FROM public.zerox_pool_usage AS pu
    WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key AND pu.bucket = 'minute'
      AND pu.bucket_start = v_minute;
  SELECT coalesce(max(pu.requests), 0), coalesce(max(pu.tokens), 0), coalesce(max(pu.cost_microusd), 0)
    INTO v_day_requests, v_day_tokens, v_day_cost
    FROM public.zerox_pool_usage AS pu
    WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key AND pu.bucket = 'day'
      AND pu.bucket_start = v_day;

  SELECT count(*), min(r.lease_expires_at) INTO v_running, v_lease FROM public.zerox_reservations AS r
    WHERE r.status = 'active' AND r.model = p_model AND r.tier = p_tier AND r.pool_key = v_pool_key
      AND r.lease_expires_at > v_now;
  -- Every settle writes one usage event with the attempt's error code (zerox_settle_v2).
  SELECT count(*) FILTER (WHERE r.outcome = 'ok'),
    count(*) FILTER (WHERE r.outcome <> 'ok' AND e.error_code IN ('model_unavailable', 'upstream_error',
      'upstream_timeout', 'upstream_auth')),
    max(r.settled_at) FILTER (WHERE r.outcome = 'ok'),
    max(r.settled_at) FILTER (WHERE r.outcome <> 'ok' AND e.error_code IN ('model_unavailable', 'upstream_error',
      'upstream_timeout', 'upstream_auth'))
    INTO v_ok, v_failed, v_last_ok, v_last_failed
    FROM public.zerox_reservations AS r
    LEFT JOIN public.zerox_usage_events AS e ON e.reservation_id = r.id
    WHERE r.status = 'settled' AND r.created_at > v_now - interval '10 minutes' AND r.model = p_model
      AND r.tier = p_tier AND r.pool_key = v_pool_key;

  IF v_concurrency IS NOT NULL AND v_running >= v_concurrency THEN
    v_status := 'pool_full';
    v_retry := greatest(1, least(60, ceil(extract(epoch FROM v_lease - v_now))))::integer;
  ELSIF (v_rpd IS NOT NULL AND v_day_requests + 1 > v_rpd) OR (v_tpd IS NOT NULL AND v_day_tokens + p_tokens > v_tpd)
     OR (p_tier = 'paid' AND v_cpd IS NOT NULL AND v_day_cost + greatest(v_cost, 1) > v_cpd) THEN
    v_status := 'pool_exhausted';
    v_retry := greatest(1, ceil(extract(epoch FROM v_resets - v_now)))::integer;
  ELSIF (v_rpm IS NOT NULL AND v_minute_requests + 1 > v_rpm) OR (v_tpm IS NOT NULL AND v_minute_tokens + p_tokens > v_tpm) THEN
    v_status := 'pool_exhausted';
    v_retry := greatest(1, ceil(extract(epoch FROM v_minute + interval '1 minute' - v_now)))::integer;
  ELSIF (v_rpm IS NOT NULL AND v_minute_requests * 2 >= v_rpm) OR (v_tpm IS NOT NULL AND v_minute_tokens * 2 >= v_tpm) THEN
    v_status := 'pool_busy';
    v_retry := greatest(1, ceil(extract(epoch FROM v_minute + interval '1 minute' - v_now)))::integer;
  END IF;

  IF v_status = 'ok' AND p_take THEN
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens, updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'minute' AND pu.bucket_start = v_minute;
    UPDATE public.zerox_pool_usage AS pu SET requests = pu.requests + 1, tokens = pu.tokens + p_tokens,
      cost_microusd = pu.cost_microusd + CASE WHEN p_tier = 'paid' THEN v_cost ELSE 0 END, updated_at = v_now
      WHERE pu.model = p_model AND pu.tier = p_tier AND pu.pool_key = v_pool_key
        AND pu.bucket = 'day' AND pu.bucket_start = v_day;
    v_minute_requests := v_minute_requests + 1;
    v_minute_tokens := v_minute_tokens + p_tokens;
    v_day_requests := v_day_requests + 1;
    IF v_concurrency IS NOT NULL THEN
      -- The test request holds one of the pool's slots, still under the advisory lock above, so a
      -- user's reservation made while it runs sees the slot taken and waits, as for another user.
      INSERT INTO public.zerox_reservations (user_id, request_id, model, tier, plan, reserved_tokens,
        reserved_cost_microusd, usage_day, pool_minute, pool_day, pool_key, created_at, lease_expires_at)
        VALUES (NULL, left('probe:' || p_model, 200), p_model, p_tier, 'probe', p_tokens, 0, v_today, v_minute, v_day,
          v_pool_key, v_now, v_now + make_interval(secs => p_lease_seconds))
        RETURNING id INTO v_slot;
      v_running := v_running + 1;
    END IF;
  END IF;

  RETURN QUERY SELECT v_status, v_retry, v_running, v_minute_requests, v_minute_tokens, v_day_requests,
    v_ok, v_failed, v_last_ok, v_last_failed, v_slot;
END;
$$;

-- Frees the slot a test request took (zerox_probe_take slot_id). True when it was still held.
CREATE OR REPLACE FUNCTION public.zerox_probe_release(p_slot_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.zerox_reservations AS r SET status = 'released', settled_at = now()
    WHERE r.id = p_slot_id AND r.user_id IS NULL AND r.plan = 'probe' AND r.status = 'active';
  RETURN FOUND;
END;
$$;

-- Upserts the leader's rows (a JSON array of zerox_pool_health rows; at most 500). Returns the
-- number written.
CREATE OR REPLACE FUNCTION public.zerox_pool_health_put(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'invalid_health_rows: p_rows must be an array of at most 500 rows';
  END IF;
  INSERT INTO public.zerox_pool_health AS h (pool, model, tier, status, base_status, available_again_at, latency_ms,
    last_success_at, last_failure_at, failure_class, consecutive_failures, tool_ok, tool_checked_at, probed_at,
    probe_day, probe_count, source, verdict_at, listed_at, checked_at, updated_at)
  SELECT x.pool, x.model, x.tier, x.status, coalesce(x.base_status, 'unknown'), x.available_again_at, x.latency_ms,
    x.last_success_at, x.last_failure_at, x.failure_class, coalesce(x.consecutive_failures, 0), x.tool_ok,
    x.tool_checked_at, x.probed_at, x.probe_day, coalesce(x.probe_count, 0), x.source, x.verdict_at, x.listed_at,
    x.checked_at, now()
  FROM jsonb_to_recordset(p_rows) AS x(pool text, model text, tier text, status text, base_status text,
    available_again_at timestamptz, latency_ms integer, last_success_at timestamptz, last_failure_at timestamptz,
    failure_class text, consecutive_failures integer, tool_ok boolean, tool_checked_at timestamptz,
    probed_at timestamptz, probe_day date, probe_count integer, source text, verdict_at timestamptz,
    listed_at timestamptz, checked_at timestamptz)
  ON CONFLICT (pool) DO UPDATE SET model = EXCLUDED.model, tier = EXCLUDED.tier, status = EXCLUDED.status,
    base_status = EXCLUDED.base_status, available_again_at = EXCLUDED.available_again_at,
    latency_ms = EXCLUDED.latency_ms, last_success_at = EXCLUDED.last_success_at,
    last_failure_at = EXCLUDED.last_failure_at, failure_class = EXCLUDED.failure_class,
    consecutive_failures = EXCLUDED.consecutive_failures, tool_ok = EXCLUDED.tool_ok,
    tool_checked_at = EXCLUDED.tool_checked_at, probed_at = EXCLUDED.probed_at, probe_day = EXCLUDED.probe_day,
    probe_count = EXCLUDED.probe_count, source = EXCLUDED.source, verdict_at = EXCLUDED.verdict_at,
    listed_at = EXCLUDED.listed_at, checked_at = EXCLUDED.checked_at, updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  -- Rows the leader has not written for a week belong to pools that left the catalog.
  DELETE FROM public.zerox_pool_health AS h WHERE h.updated_at < now() - interval '7 days';
  RETURN v_count;
END;
$$;

-- Rows the leader wrote within the last p_since_seconds (60-604800). A row can be newer than its
-- verdict (a list check rewrites listed_at); readers judge freshness by checked_at.
CREATE OR REPLACE FUNCTION public.zerox_pool_health_get(p_since_seconds integer)
RETURNS SETOF public.zerox_pool_health
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_since_seconds IS NULL OR p_since_seconds NOT BETWEEN 60 AND 604800 THEN
    RAISE EXCEPTION 'invalid_health_query: p_since_seconds must be 60-604800';
  END IF;
  RETURN QUERY SELECT * FROM public.zerox_pool_health AS h
    WHERE h.updated_at > now() - make_interval(secs => p_since_seconds) ORDER BY h.pool;
END;
$$;

ALTER TABLE public.zerox_pool_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zerox_health_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_pool_health, public.zerox_health_lease FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_pool_health, public.zerox_health_lease TO service_role;

REVOKE ALL ON FUNCTION
  public.zerox_health_lease(text, integer),
  public.zerox_probe_take(text, text, text, jsonb, bigint, bigint, boolean, integer),
  public.zerox_probe_release(uuid),
  public.zerox_pool_health_put(jsonb),
  public.zerox_pool_health_get(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_health_lease(text, integer),
  public.zerox_probe_take(text, text, text, jsonb, bigint, bigint, boolean, integer),
  public.zerox_probe_release(uuid),
  public.zerox_pool_health_put(jsonb),
  public.zerox_pool_health_get(integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
