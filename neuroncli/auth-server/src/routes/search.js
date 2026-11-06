// POST /v1/search (docs/PLATFORM_CONTRACT.md section 17): web search for Neuron with per-plan
// daily quotas. Errors are flat JSON ({"error": code, "message", "request_id", ...}) as the
// search contract defines them: 400 invalid_request, 401 invalid_session (sign in again), 403
// account_suspended, 429 search_quota_exhausted, 503 search_unavailable.
import { missingFunction, rpc } from '../account-store.js';
import { ALL_CREDENTIALS, ApiError, requestId, resolveCaller } from '../auth-context.js';
import { sha256Hex } from '../session-store.js';
import {
  normalizeQuery, parseSearchRequest, RESEARCH_RUN_HEADER, researchRunId, runSearch, searchCache, searchConfigured,
  SearchError, searchLimits,
} from '../search.js';

const MAX_BODY_BYTES = 8192;
const UNAVAILABLE = 'Web search is temporarily unavailable. Please retry shortly.';
const unavailable = () => new SearchError(503, 'search_unavailable', UNAVAILABLE);

function errorJson(c, error) {
  const id = requestId(c);
  const headers = { 'X-Request-Id': id, 'Cache-Control': 'no-store' };
  if (error instanceof SearchError || error instanceof ApiError) {
    const { param, headers: extraHeaders = {}, ...fields } = error.extra || {};
    const body = { error: error.code, message: error.message, ...(param ? { param } : {}), ...fields, request_id: id };
    return c.json(body, error.status, { ...headers, ...extraHeaders });
  }
  console.error('Search request failed', { name: error?.name });
  return c.json({ error: 'search_unavailable', message: UNAVAILABLE, request_id: id }, 503, headers);
}

async function readBody(c) {
  const text = await c.req.text().catch(() => '');
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new SearchError(400, 'invalid_request', 'The request body is too large.', { param: null });
  }
  try { return JSON.parse(text); } catch {
    throw new SearchError(400, 'invalid_request', 'The body must be a JSON object.', { param: null });
  }
}

// Calls a search quota function; a database without migration 20261105200000 (or one that is
// down) makes search unavailable rather than unmetered.
async function quotaRpc(env, name, args) {
  try { return await rpc(env, name, args); }
  catch (error) {
    if (missingFunction(error)) console.error('Search quota functions are missing; apply migration 20261105200000_search_quota.sql');
    else console.error('Search quota database request failed', { code: error?.code ?? null });
    throw unavailable();
  }
}

const quotaView = (limits, row, resetsAt) => ({
  remaining: Math.max(0, limits.daily_searches - Number(row?.searches ?? 0)),
  limit: limits.daily_searches,
  resets_at: resetsAt,
  research: {
    remaining: Math.max(0, limits.daily_research_runs - Number(row?.research_runs ?? 0)),
    limit: limits.daily_research_runs,
  },
});
const isoOrNull = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export async function searchHandler(c, { fetchImpl } = {}) {
  try {
    const caller = await resolveCaller(c, { allow: ALL_CREDENTIALS });
    const request = parseSearchRequest(await readBody(c));
    const runId = researchRunId(request.purpose, c.req.header(RESEARCH_RUN_HEADER));
    if (!searchConfigured(c.env)) {
      throw new SearchError(503, 'search_unavailable', 'Web search is not configured on this gateway.');
    }
    if (caller.suspended) throw new SearchError(403, 'account_suspended', 'This account is suspended. Contact support@zero-x.live.');

    const limits = searchLimits(caller.plan);
    const runHash = runId ? await sha256Hex(runId) : null;
    const reservation = await quotaRpc(c.env, 'zerox_search_reserve', { p_user_id: caller.user_id,
      p_daily_searches: limits.daily_searches, p_daily_research_runs: limits.daily_research_runs, p_run_hash: runHash });
    if (!reservation?.status) throw unavailable();
    const resetsAt = isoOrNull(reservation.resets_at);
    if (reservation.status !== 'ok') {
      const research = reservation.status === 'research_quota_exhausted';
      const retryAfter = resetsAt ? Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000)) : null;
      throw new SearchError(429, 'search_quota_exhausted', research
        ? `Your plan's ${limits.daily_research_runs} research runs for today are used up.`
        : `Your plan's ${limits.daily_searches} web searches for today are used up.`,
      { resets_at: resetsAt, exhausted: research ? 'research_runs' : 'searches', ...(retryAfter ? { headers: { 'Retry-After': String(retryAfter) } } : {}) });
    }

    const settle = async outcome => {
      try {
        return await rpc(c.env, 'zerox_search_settle', { p_user_id: caller.user_id, p_day: String(reservation.day).slice(0, 10),
          p_outcome: outcome, p_run_hash: runHash, p_run_added: reservation.run_added === true });
      } catch (error) {
        console.error('Search settle failed', { outcome, code: error?.code ?? null });
        return null;
      }
    };
    // One cache per user: a shared entry would tell a caller (by `cached: true`, or by how fast the
    // answer comes) that someone else searched the same text in the last 10 minutes.
    const cacheKey = await sha256Hex(`${caller.user_id}\n${request.freshness || ''}\n${normalizeQuery(request.query)}`);
    let answer = searchCache.get(cacheKey);
    const cached = !!answer;
    if (!answer) {
      try { answer = await runSearch(c.env, request, fetchImpl ? { fetchImpl } : {}); }
      catch (error) {
        await settle('failed');
        throw error;
      }
      // An empty answer is often a backend rate-limited for a moment (SearXNG's engines CAPTCHA'd):
      // it is not cached, so the next search asks again.
      if (answer.results.length) searchCache.set(cacheKey, answer);
    }
    await settle(cached ? 'cached' : answer.provider);
    return c.json({
      results: answer.results.slice(0, request.count),
      provider: answer.provider,
      cached,
      quota: quotaView(limits, reservation, resetsAt),
    }, 200, { 'X-Request-Id': requestId(c), 'Cache-Control': 'no-store' });
  } catch (error) {
    return errorJson(c, error);
  }
}

export function registerSearchRoutes(api) {
  api.post('/v1/search', c => searchHandler(c));
}
