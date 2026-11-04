BEGIN;
-- New tables and functions only; nothing existing is locked for long. Give up (and re-run)
-- rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';

-- Web search quotas (docs/PLATFORM_CONTRACT.md section 14, POST /v1/search). Each plan has a
-- daily number of searches and of research runs per UTC day (Free 40/3, Pro 400/30, Max
-- 2000/150; the numbers live in src/search.js and are passed in, like p_pool for
-- zerox_reserve_v2). A research run is a search with purpose "research" carrying the run id header
-- x-neuron-research-run; the distinct run ids of a day are counted, so the searches of one run
-- spend one research run between them (and one search each).
--
-- Metadata only: zerox_search_usage holds per-user daily counters (searches, research runs, cache
-- hits, upstream calls by backend) and zerox_search_research_runs the sha256 of today's run ids
-- (the gateway hashes them; a run id is never stored). No query text or result reaches the
-- database: the gateway's result cache is in memory and expires after 10 minutes. A user's run
-- hashes from earlier days and counter rows older than 92 days are deleted by their next search.
--
-- zerox_search_reserve takes one search (and, for a new run id, one research run) before the
-- gateway calls a backend, holding the counter row FOR UPDATE, so concurrent searches of one user
-- cannot both take the last one. zerox_search_settle records how it was answered, or gives the
-- search (and the run it opened) back when no backend answered. Roll back with
-- migrations/down/20261104200000_search_quota.down.sql (psql -X -v ON_ERROR_STOP=1 -f).

CREATE TABLE public.zerox_search_usage (
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  day date NOT NULL,
  searches integer NOT NULL DEFAULT 0 CHECK (searches >= 0),
  research_runs integer NOT NULL DEFAULT 0 CHECK (research_runs >= 0),
  cache_hits integer NOT NULL DEFAULT 0 CHECK (cache_hits >= 0),
  searxng_calls integer NOT NULL DEFAULT 0 CHECK (searxng_calls >= 0),
  brave_calls integer NOT NULL DEFAULT 0 CHECK (brave_calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
COMMENT ON TABLE public.zerox_search_usage IS
  'Per-user daily web search counters (POST /v1/search). Metadata only: no query text or results.';
ALTER TABLE public.zerox_search_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_search_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_search_usage TO service_role;

CREATE TABLE public.zerox_search_research_runs (
  user_id uuid NOT NULL REFERENCES public.zerox_accounts(clerk_id) ON DELETE CASCADE,
  day date NOT NULL,
  run_hash text NOT NULL CHECK (run_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, run_hash)
);
COMMENT ON TABLE public.zerox_search_research_runs IS
  'sha256 of the research run ids (x-neuron-research-run) a user opened today; counts distinct runs.';
ALTER TABLE public.zerox_search_research_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zerox_search_research_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zerox_search_research_runs TO service_role;

-- Takes one search for the user today, and one research run when p_run_hash is a run not seen
-- today. status: ok, search_quota_exhausted (no search left today) or research_quota_exhausted
-- (no research run left; a run already open today keeps working). Nothing is taken unless the
-- status is ok. run_added tells zerox_search_settle whether a failed search must give the run back.
CREATE FUNCTION public.zerox_search_reserve(p_user_id uuid, p_daily_searches integer, p_daily_research_runs integer,
  p_run_hash text DEFAULT NULL)
RETURNS TABLE (status text, day date, searches integer, research_runs integer, run_added boolean, resets_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_resets timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'UTC');
  v_row public.zerox_search_usage;
  v_added boolean := false;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid_search_reservation: p_user_id is required'; END IF;
  IF p_daily_searches IS NULL OR p_daily_searches < 0 OR p_daily_research_runs IS NULL OR p_daily_research_runs < 0 THEN
    RAISE EXCEPTION 'invalid_search_reservation: limits must be zero or more';
  END IF;
  IF p_run_hash IS NOT NULL AND p_run_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_search_reservation: p_run_hash must be a sha256 hex digest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.zerox_accounts AS a WHERE a.clerk_id = p_user_id) THEN
    RAISE EXCEPTION 'account_not_found';
  END IF;
  INSERT INTO public.zerox_search_usage AS u (user_id, day) VALUES (p_user_id, v_today) ON CONFLICT DO NOTHING;
  SELECT u.* INTO v_row FROM public.zerox_search_usage AS u WHERE u.user_id = p_user_id AND u.day = v_today FOR UPDATE;
  DELETE FROM public.zerox_search_research_runs AS r WHERE r.user_id = p_user_id AND r.day < v_today;
  DELETE FROM public.zerox_search_usage AS u WHERE u.user_id = p_user_id AND u.day < v_today - 92;

  IF v_row.searches >= p_daily_searches THEN
    RETURN QUERY SELECT 'search_quota_exhausted'::text, v_today, v_row.searches, v_row.research_runs, false, v_resets;
    RETURN;
  END IF;
  IF p_run_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.zerox_search_research_runs AS r
      WHERE r.user_id = p_user_id AND r.day = v_today AND r.run_hash = p_run_hash) THEN
    IF v_row.research_runs >= p_daily_research_runs THEN
      RETURN QUERY SELECT 'research_quota_exhausted'::text, v_today, v_row.searches, v_row.research_runs, false, v_resets;
      RETURN;
    END IF;
    INSERT INTO public.zerox_search_research_runs AS r (user_id, day, run_hash) VALUES (p_user_id, v_today, p_run_hash);
    v_added := true;
  END IF;
  UPDATE public.zerox_search_usage AS u SET searches = u.searches + 1,
      research_runs = u.research_runs + CASE WHEN v_added THEN 1 ELSE 0 END, updated_at = now()
    WHERE u.user_id = p_user_id AND u.day = v_today
    RETURNING u.* INTO v_row;
  RETURN QUERY SELECT 'ok'::text, v_today, v_row.searches, v_row.research_runs, v_added, v_resets;
END;
$$;

-- Records how a reserved search was answered: p_outcome searxng or brave (a backend call),
-- cached (the gateway's cache), or failed (no backend answered: the search is given back, and
-- the research run too when this search opened it, p_run_added). p_day is the reservation's day.
CREATE FUNCTION public.zerox_search_settle(p_user_id uuid, p_day date, p_outcome text, p_run_hash text DEFAULT NULL,
  p_run_added boolean DEFAULT false)
RETURNS TABLE (searches integer, research_runs integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_removed integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_day IS NULL THEN RAISE EXCEPTION 'invalid_search_settle: p_user_id and p_day are required'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('searxng', 'brave', 'cached', 'failed') THEN
    RAISE EXCEPTION 'invalid_search_settle: p_outcome must be searxng, brave, cached or failed';
  END IF;
  IF p_outcome = 'failed' AND coalesce(p_run_added, false) AND p_run_hash IS NOT NULL THEN
    DELETE FROM public.zerox_search_research_runs AS r
      WHERE r.user_id = p_user_id AND r.day = p_day AND r.run_hash = p_run_hash;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
  END IF;
  RETURN QUERY UPDATE public.zerox_search_usage AS u SET
      searches = CASE WHEN p_outcome = 'failed' THEN greatest(u.searches - 1, 0) ELSE u.searches END,
      research_runs = greatest(u.research_runs - v_removed, 0),
      cache_hits = u.cache_hits + CASE WHEN p_outcome = 'cached' THEN 1 ELSE 0 END,
      searxng_calls = u.searxng_calls + CASE WHEN p_outcome = 'searxng' THEN 1 ELSE 0 END,
      brave_calls = u.brave_calls + CASE WHEN p_outcome = 'brave' THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE u.user_id = p_user_id AND u.day = p_day
    RETURNING u.searches, u.research_runs;
END;
$$;

REVOKE ALL ON FUNCTION
  public.zerox_search_reserve(uuid, integer, integer, text),
  public.zerox_search_settle(uuid, date, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.zerox_search_reserve(uuid, integer, integer, text),
  public.zerox_search_settle(uuid, date, text, text, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
