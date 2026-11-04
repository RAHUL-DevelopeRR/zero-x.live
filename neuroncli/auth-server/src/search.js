// Web search for Neuron (POST /v1/search, docs/PLATFORM_CONTRACT.md section 14): plan budgets,
// request validation, the 10-minute result cache and the two backends. A self-hosted SearXNG
// (SEARXNG_URL) answers first; the Brave Search API (BRAVE_API_KEY) is the fallback. With neither
// configured the route answers 503 search_unavailable. Query text never leaves this module except
// to the backend: it is not logged, not stored in the database, and the cache forgets it after
// CACHE_TTL_MS.
import { normalizePlanId } from './plan-policy.js';

// ── Plan budgets (also in /api/account limits.search and limits.colony) ──
// Searches and research runs per UTC day. A research run is the distinct x-neuron-research-run id
// of searches with purpose "research".
export const SEARCH_LIMITS = Object.freeze({
  free: Object.freeze({ daily_searches: 40, daily_research_runs: 3 }),
  pro: Object.freeze({ daily_searches: 400, daily_research_runs: 30 }),
  max: Object.freeze({ daily_searches: 2000, daily_research_runs: 150 }),
});
// Colony (multi-agent mode) budgets, enforced by the CLI: parallel workers and tokens per run.
export const COLONY_LIMITS = Object.freeze({
  free: Object.freeze({ max_workers: 1, max_tokens_per_run: 300000 }),
  pro: Object.freeze({ max_workers: 4, max_tokens_per_run: 2000000 }),
  max: Object.freeze({ max_workers: 8, max_tokens_per_run: 6000000 }),
});
export const searchLimits = plan => ({ ...(SEARCH_LIMITS[normalizePlanId(plan)] || SEARCH_LIMITS.free) });
export const colonyLimits = plan => ({ ...(COLONY_LIMITS[normalizePlanId(plan)] || COLONY_LIMITS.free) });

// ── Request ──
export const MAX_QUERY_CHARS = 400;
export const MAX_COUNT = 10;
export const DEFAULT_COUNT = 8;
export const PURPOSES = Object.freeze(['search', 'research']);
export const FRESHNESS = Object.freeze(['day', 'week', 'month', 'year']);
export const RESEARCH_RUN_HEADER = 'x-neuron-research-run';
const RUN_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export class SearchError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const invalid = (message, param) => new SearchError(400, 'invalid_request', message, { param });

// Validates a parsed JSON body: {query, count?, purpose?, freshness?}. Returns the clean request
// (query trimmed with its whitespace collapsed) or throws a 400 SearchError.
export function parseSearchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The body must be a JSON object.', null);
  if (typeof body.query !== 'string') throw invalid('`query` must be a string of 1-400 characters.', 'query');
  const query = body.query.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const length = Array.from(query).length;
  if (length < 1 || length > MAX_QUERY_CHARS) throw invalid('`query` must be a string of 1-400 characters.', 'query');
  let count = DEFAULT_COUNT;
  if (body.count !== undefined && body.count !== null) {
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_COUNT) {
      throw invalid('`count` must be an integer between 1 and 10.', 'count');
    }
    count = body.count;
  }
  const purpose = body.purpose === undefined || body.purpose === null ? 'search' : body.purpose;
  if (!PURPOSES.includes(purpose)) throw invalid('`purpose` must be "search" or "research".', 'purpose');
  const freshness = body.freshness === undefined || body.freshness === null ? null : body.freshness;
  if (freshness !== null && !FRESHNESS.includes(freshness)) {
    throw invalid('`freshness` must be "day", "week", "month" or "year".', 'freshness');
  }
  return { query, count, purpose, freshness };
}

// The research run id of a research search, or a 400 SearchError when it is missing or malformed.
export function researchRunId(purpose, header) {
  if (purpose !== 'research') return null;
  const value = typeof header === 'string' ? header.trim() : '';
  if (!RUN_ID.test(value)) {
    throw invalid(`A research search needs the ${RESEARCH_RUN_HEADER} header: 8-128 letters, digits, ".", "_", ":" or "-".`,
      RESEARCH_RUN_HEADER);
  }
  return value;
}

// The cache key's text: NFKC, lower case, one space between words.
export const normalizeQuery = query => query.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

// ── Cache: in memory, per process or isolate, 10 minutes, at most CACHE_LIMIT entries. The route
// keys it by user, freshness and query, and stores non-empty answers only. ──
export const CACHE_TTL_MS = 600000;
export const CACHE_LIMIT = 1000;
export class SearchCache {
  constructor({ ttlMs = CACHE_TTL_MS, limit = CACHE_LIMIT } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.entries = new Map();
  }
  // Drops expired entries. Every entry lives ttlMs, so insertion order is expiry order.
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expires > now) break;
      this.entries.delete(key);
    }
  }
  get(key, now = Date.now()) {
    this.sweep(now);
    return this.entries.get(key)?.value;
  }
  set(key, value, now = Date.now()) {
    this.sweep(now);
    this.entries.delete(key);
    while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, { value, expires: now + this.ttlMs });
  }
  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}
export const searchCache = new SearchCache();

// ── Backends ──
export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
export const BACKEND_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2000000;
const BRAVE_FRESHNESS = Object.freeze({ day: 'pd', week: 'pw', month: 'pm', year: 'py' });

// SEARXNG_URL is the instance's base URL (http or https, no credentials); /search is appended.
export function searxngBase(env) {
  const raw = String(env?.SEARXNG_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}
const braveKey = env => {
  const key = String(env?.BRAVE_API_KEY || '').trim();
  return /^[\x21-\x7e]{8,256}$/.test(key) ? key : null;
};
// Which backends this gateway may call, in order.
export function searchBackends(env) {
  return [searxngBase(env) ? 'searxng' : null, braveKey(env) ? 'brave' : null].filter(Boolean);
}
export const searchConfigured = env => searchBackends(env).length > 0;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, name) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : lower.startsWith('#') ? Number(lower.slice(1)) : NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join('').trimEnd() + '…' : text;
}
function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function cleanDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Backends often send a date-time without a zone (Brave's page_age); read it as UTC, not as the
  // gateway host's local time.
  const text = value.trim();
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

// One result in the contract's shape: {title, url, snippet, published?}; null when unusable.
export function searchResult({ title, url, snippet, published }) {
  const href = cleanUrl(url);
  if (!href) return null;
  const result = { title: cleanText(title, 300) || href, url: href, snippet: cleanText(snippet, 600) };
  const date = cleanDate(published);
  if (date) result.published = date;
  return result;
}
const uniqueResults = items => {
  const seen = new Set();
  return items.map(searchResult).filter(item => item && !seen.has(item.url) && seen.add(item.url)).slice(0, MAX_COUNT);
};

async function readJson(response) {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  return JSON.parse(text);
}

async function searxngSearch(env, { query, freshness }, fetchImpl) {
  const url = new URL(`${searxngBase(env)}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');
  url.searchParams.set('safesearch', '1');
  url.searchParams.set('pageno', '1');
  if (freshness) url.searchParams.set('time_range', freshness);
  const response = await fetchImpl(url.href, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await readJson(response);
  if (!Array.isArray(data?.results)) throw new Error('no results array');
  return uniqueResults(data.results.map(item => ({ title: item?.title, url: item?.url, snippet: item?.content,
    published: item?.publishedDate ?? item?.pubdate })));
}

async function braveSearch(env, { query, freshness }, fetchImpl) {
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(MAX_COUNT));
  url.searchParams.set('safesearch', 'moderate');
  if (freshness) url.searchParams.set('freshness', BRAVE_FRESHNESS[freshness]);
  const response = await fetchImpl(url.href, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey(env) },
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await readJson(response);
  const items = data?.web?.results;
  if (items !== undefined && !Array.isArray(items)) throw new Error('no results array');
  return uniqueResults((items || []).map(item => ({ title: item?.title, url: item?.url, snippet: item?.description,
    published: item?.page_age })));
}

const BACKENDS = { searxng: searxngSearch, brave: braveSearch };

// Asks the configured backends in order for up to MAX_COUNT results. An error or an empty answer
// moves on to the next backend; an empty answer is returned when no backend has more. Returns
// {results, provider}; throws a 503 SearchError when no backend answered.
export async function runSearch(env, request, { fetchImpl = globalThis.fetch } = {}) {
  let empty = null;
  for (const name of searchBackends(env)) {
    try {
      const results = await BACKENDS[name](env, request, fetchImpl);
      if (results.length) return { results, provider: name };
      empty ||= { results, provider: name };
    } catch (error) {
      // Never the query (a JSON parse error quotes the body, which may echo it): only which
      // backend failed and how.
      const reason = error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'SyntaxError' ? 'invalid_json'
        : /^HTTP \d{3}$|^response too large$|^no results array$/.test(error?.message) ? error.message : 'network_error';
      console.warn('Search backend failed', { backend: name, reason });
    }
  }
  if (empty) return empty;
  throw new SearchError(503, 'search_unavailable', 'Web search is temporarily unavailable. Please retry shortly.');
}
