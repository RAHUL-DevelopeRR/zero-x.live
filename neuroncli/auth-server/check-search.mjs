// POST /v1/search and the search and colony limits of /api/account (docs/PLATFORM_CONTRACT.md
// section 14) on a real database: every migration on a fresh in-memory PGlite, the gateway on the
// local dev identity, a mock SearXNG server and a mock Brave Search API (the gateway's calls to
// api.search.brave.com are redirected to it). No real backend or key is used.
// Run: node check-search.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import app from './src/index.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { devToken, devUserId } from './src/auth-context.js';
import { sha256Hex } from './src/session-store.js';
import {
  BRAVE_SEARCH_URL, CACHE_TTL_MS, colonyLimits, normalizeQuery, parseSearchRequest, runSearch, SearchCache, searchCache,
  searchBackends, searchLimits, searchResult, searxngBase,
} from './src/search.js';

const base = 'http://127.0.0.1:8787';
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const nextMidnight = () => new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString();

// ── Mock backends ──
function mockServer(name) {
  const state = { calls: [], reply: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    state.calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), headers: req.headers });
    const { status = 200, body = {}, raw = null, delayMs = 0 } = (typeof state.reply === 'function' ? state.reply(url) : state.reply) || {};
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(raw ?? JSON.stringify(body));
    }, delayMs);
  });
  return { name, server, state };
}
const searx = mockServer('searxng');
const brave = mockServer('brave');
for (const mock of [searx, brave]) {
  mock.server.listen(0, '127.0.0.1');
  await once(mock.server, 'listening');
  mock.url = `http://127.0.0.1:${mock.server.address().port}`;
}
// A port with nothing listening (a SearXNG that is down).
const closed = createServer();
closed.listen(0, '127.0.0.1');
await once(closed, 'listening');
const deadUrl = `http://127.0.0.1:${closed.address().port}`;
closed.close();

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(BRAVE_SEARCH_URL)) return originalFetch(brave.url + url.slice('https://api.search.brave.com'.length), init);
  return originalFetch(input, init);
};

const searxResults = (prefix, n = 12) => ({ results: [
  { title: `<b>${prefix}</b> &amp; friends`, url: `https://example.org/${prefix}/0`, content: 'First <em>hit</em>&#39;s text',
    publishedDate: '2026-10-30T08:00:00' },
  { title: 'duplicate', url: `https://example.org/${prefix}/0`, content: 'same url again' },
  { title: 'not http', url: 'javascript:alert(1)', content: 'dropped' },
  ...Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}`, url: `https://example.org/${prefix}/${i + 1}`, content: `snippet ${i + 1}` })),
] });
const braveResults = prefix => ({ web: { results: Array.from({ length: 10 }, (_, i) => ({ title: `${prefix} brave ${i}`,
  url: `https://brave.example/${prefix}/${i}`, description: `<strong>brave</strong> ${i}`, page_age: '2026-11-01T00:00:00' })) } });

// ── Gateway on PGlite ──
const pgEnv = { DATABASE_DRIVER: 'pglite', DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
const handle = await getPgliteHandle(pgEnv);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;
const BRAVE_KEY = 'BSA-test-key-0123456789';
const both = { ...pgEnv, SEARXNG_URL: `${searx.url}/`, BRAVE_API_KEY: BRAVE_KEY };

const call = async (env, path, { method = 'GET', token, body, raw, headers = {} } = {}) => {
  const response = await app.request(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
};
const search = (env, token, body, headers) => call(env, '/v1/search', { method: 'POST', token, body, headers });
const signIn = async email => {
  const minted = await call(pgEnv, '/auth/cli/session', { method: 'POST', token: devToken(email), body: { machine_fingerprint: 'fp' } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  return { ses: minted.body.session_token, userId: await devUserId(email) };
};
const usage = async userId => (await sql(`SELECT searches, research_runs, cache_hits, searxng_calls, brave_calls
  FROM public.zerox_search_usage WHERE user_id = $1`, [userId]))[0] ?? null;

try {
  // ── Units ──
  assert.deepEqual(parseSearchRequest({ query: '  rust   async\n traits ' }), { query: 'rust async traits', count: 8, purpose: 'search', freshness: null });
  for (const [body, param] of [[{ query: '' }, 'query'], [{ query: '   ' }, 'query'], [{ query: 'x'.repeat(401) }, 'query'],
    [{ query: 7 }, 'query'], [{ query: 'q', count: 0 }, 'count'], [{ query: 'q', count: 11 }, 'count'], [{ query: 'q', count: '5' }, 'count'],
    [{ query: 'q', count: 2.5 }, 'count'], [{ query: 'q', purpose: 'news' }, 'purpose'], [{ query: 'q', freshness: 'hour' }, 'freshness']]) {
    assert.throws(() => parseSearchRequest(body), error => error.status === 400 && error.extra.param === param, JSON.stringify(body));
  }
  assert.equal(parseSearchRequest({ query: '\u{1F980}'.repeat(400) }).query.length, 800, '400 characters, not UTF-16 units');
  assert.equal(normalizeQuery('Rust  ASYNC traits'), normalizeQuery('rust async Traits'));
  assert.deepEqual(searchResult({ title: '<b>A</b> &amp; B &#x27;c&#39;', url: 'https://a.example/x', snippet: '<p>s</p>', published: 'bad' }),
    { title: "A & B 'c'", url: 'https://a.example/x', snippet: 's' });
  assert.equal(searchResult({ title: 't', url: 'https://user:pw@a.example/' }), null, 'URLs with credentials are dropped');
  assert.equal(searxngBase({ SEARXNG_URL: 'https://u:p@search.example' }), null);
  assert.equal(searxngBase({ SEARXNG_URL: 'ftp://search.example' }), null);
  assert.equal(searxngBase({ SEARXNG_URL: 'https://search.example/searx/' }), 'https://search.example/searx');
  assert.deepEqual(searchBackends({}), []);
  assert.deepEqual(searchBackends({ BRAVE_API_KEY: BRAVE_KEY }), ['brave']);
  assert.deepEqual(searchBackends(both), ['searxng', 'brave']);
  assert.deepEqual([searchLimits('free'), searchLimits('pro'), searchLimits('max'), searchLimits('ultrawork'), searchLimits('gold')],
    [{ daily_searches: 40, daily_research_runs: 3 }, { daily_searches: 400, daily_research_runs: 30 },
      { daily_searches: 2000, daily_research_runs: 150 }, { daily_searches: 400, daily_research_runs: 30 }, { daily_searches: 40, daily_research_runs: 3 }]);
  assert.deepEqual([colonyLimits('free'), colonyLimits('pro'), colonyLimits('max')],
    [{ max_workers: 1, max_tokens_per_run: 300000 }, { max_workers: 4, max_tokens_per_run: 2000000 }, { max_workers: 8, max_tokens_per_run: 6000000 }]);
  const cache = new SearchCache({ limit: 2 });
  cache.set('a', 1, 0); cache.set('b', 2, 1000); cache.set('c', 3, 2000);
  assert.deepEqual([cache.get('a', 2000), cache.get('b', 2000), cache.get('c', 2000)], [undefined, 2, 3], 'the oldest entry is evicted');
  assert.equal(cache.get('b', 1000 + CACHE_TTL_MS), undefined, 'entries expire after 10 minutes');
  assert.equal(cache.size, 1, 'expired entries are swept, not kept');
  ok('units: request validation, result cleaning, backend config, plan budgets, cache expiry and eviction');

  // ── Signed out ──
  for (const token of [undefined, 'ses_' + 'x'.repeat(32), 'nzx_' + 'y'.repeat(43), 'Basic abc']) {
    const answer = await search(both, token, { query: 'hello' });
    assert.equal(answer.status, 401, String(token));
    assert.equal(answer.body.error, 'invalid_session');
    assert.match(answer.body.message, /sign in again/);
  }
  ok('signed out or unknown credential: 401 invalid_session (sign in again)');

  const alice = await signIn('search-alice@example.test');
  // ── Not configured: 503, nothing counted ──
  let answer = await search(pgEnv, alice.ses, { query: 'hello' });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, 'search_unavailable');
  assert.equal(await usage(alice.userId), null, 'no quota is taken');
  answer = await search({ ...pgEnv, SEARXNG_URL: 'not a url', BRAVE_API_KEY: 'short' }, alice.ses, { query: 'hello' });
  assert.equal(answer.status, 503, 'invalid values configure nothing');
  ok('no backend configured: 503 search_unavailable before any quota is taken');

  // ── Bad requests ──
  answer = await call(both, '/v1/search', { method: 'POST', token: alice.ses, raw: '{not json' });
  assert.deepEqual([answer.status, answer.body.error], [400, 'invalid_request']);
  answer = await search(both, alice.ses, { query: 'q', count: 20 });
  assert.deepEqual([answer.status, answer.body.error, answer.body.param], [400, 'invalid_request', 'count']);
  answer = await search(both, alice.ses, { query: 'q', purpose: 'research' });
  assert.deepEqual([answer.status, answer.body.param], [400, 'x-neuron-research-run'], 'a research search names its run');
  answer = await call(both, '/v1/search', { method: 'POST', token: alice.ses, raw: JSON.stringify({ query: 'q', pad: 'x'.repeat(9000) }) });
  assert.equal(answer.status, 400, 'bodies over 8 KB are refused');
  assert.equal(await usage(alice.userId), null);
  ok('invalid bodies: 400 invalid_request with the param, nothing counted');

  // ── SearXNG answers ──
  searx.state.reply = { body: searxResults('rust') };
  answer = await search(both, alice.ses, { query: '  Rust async   traits ', count: 5, freshness: 'week' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(answer.body).sort(), ['cached', 'provider', 'quota', 'results']);
  assert.equal(answer.body.provider, 'searxng');
  assert.equal(answer.body.cached, false);
  assert.equal(answer.body.results.length, 5);
  assert.deepEqual(answer.body.results[0], { title: 'rust & friends', url: 'https://example.org/rust/0', snippet: "First hit's text",
    published: '2026-10-30T08:00:00.000Z' });
  assert.deepEqual(answer.body.results[1], { title: 'rust 1', url: 'https://example.org/rust/1', snippet: 'snippet 1' }, 'duplicates and non-http URLs are dropped');
  assert.deepEqual(answer.body.quota, { remaining: 39, limit: 40, resets_at: nextMidnight(), research: { remaining: 3, limit: 3 } });
  assert.equal(searx.state.calls.length, 1);
  assert.equal(searx.state.calls[0].path, '/search');
  assert.deepEqual(searx.state.calls[0].params, { q: 'Rust async traits', format: 'json', categories: 'general', safesearch: '1',
    pageno: '1', time_range: 'week' });
  assert.equal(brave.state.calls.length, 0, 'Brave is not called while SearXNG answers');
  ok('SearXNG first: contract shape, cleaned and de-duplicated results, count, freshness passed as time_range, quota 39/40');

  // ── Cache hit ──
  answer = await search(both, alice.ses, { query: 'rust ASYNC traits', count: 10, freshness: 'week' });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.cached, answer.body.provider, answer.body.results.length], [true, 'searxng', 10]);
  assert.equal(searx.state.calls.length, 1, 'answered from the cache');
  assert.equal(answer.body.quota.remaining, 38, 'a cached answer still counts as a search');
  answer = await search(both, alice.ses, { query: 'rust async traits', freshness: 'month' });
  assert.equal(answer.body.cached, false, 'freshness is part of the cache key');
  assert.equal(searx.state.calls.length, 2);
  assert.deepEqual(await usage(alice.userId), { searches: 3, research_runs: 0, cache_hits: 1, searxng_calls: 2, brave_calls: 0 });
  ok('cache: the same normalized query and freshness is served from memory within 10 minutes (cached: true)');

  // ── The cache is per user: no cross-tenant "someone searched this" signal ──
  const carol = await signIn('search-carol@example.test');
  answer = await search(both, carol.ses, { query: 'Rust async traits', freshness: 'week' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.cached, false, "another user's query is never reported as cached");
  assert.equal(searx.state.calls.length, 3, 'and is asked of the backend again');
  answer = await search(both, carol.ses, { query: 'rust async traits', freshness: 'week' });
  assert.equal(answer.body.cached, true, "the caller's own repeat is cached");
  assert.equal(searx.state.calls.length, 3);
  assert.deepEqual(await usage(carol.userId), { searches: 2, research_runs: 0, cache_hits: 1, searxng_calls: 1, brave_calls: 0 });
  ok("cache is per user: user B searching user A's query gets cached: false and a backend call; B's own repeat is cached");

  // ── Brave fallback ──
  searx.state.reply = { status: 500, body: { error: 'engines down' } };
  brave.state.reply = { body: braveResults('fb') };
  answer = await search(both, alice.ses, { query: 'fallback one', freshness: 'day', count: 3 });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.provider, answer.body.cached, answer.body.results.length], ['brave', false, 3]);
  assert.deepEqual(answer.body.results[0], { title: 'fb brave 0', url: 'https://brave.example/fb/0', snippet: 'brave 0', published: '2026-11-01T00:00:00.000Z' });
  const braveCall = brave.state.calls.at(-1);
  assert.equal(braveCall.path, '/res/v1/web/search');
  assert.deepEqual(braveCall.params, { q: 'fallback one', count: '10', safesearch: 'moderate', freshness: 'pd' });
  assert.equal(braveCall.headers['x-subscription-token'], BRAVE_KEY);
  searx.state.reply = { body: { results: [], unresponsive_engines: [['google', 'CAPTCHA']] } };
  answer = await search(both, alice.ses, { query: 'fallback two' });
  assert.equal(answer.body.provider, 'brave', 'an empty SearXNG answer falls back to Brave');
  answer = await search({ ...both, SEARXNG_URL: deadUrl }, alice.ses, { query: 'fallback three' });
  assert.equal(answer.body.provider, 'brave', 'an unreachable SearXNG falls back to Brave');
  searx.state.reply = { raw: '<html>not json</html>' };
  answer = await search(both, alice.ses, { query: 'fallback four' });
  assert.equal(answer.body.provider, 'brave', 'a non-JSON SearXNG answer (format=json disabled) falls back to Brave');
  answer = await search({ ...pgEnv, BRAVE_API_KEY: BRAVE_KEY }, alice.ses, { query: 'brave only' });
  assert.equal(answer.body.provider, 'brave', 'Brave alone');
  brave.state.reply = { body: { web: { results: [] } } };
  searx.state.reply = { body: { results: [] } };
  answer = await search(both, alice.ses, { query: 'nothing anywhere' });
  assert.deepEqual([answer.status, answer.body.provider, answer.body.results], [200, 'searxng', []], 'an empty answer from every backend is a 200');
  const callsAfterEmpty = searx.state.calls.length;
  searx.state.reply = { body: searxResults('later') };
  answer = await search(both, alice.ses, { query: 'nothing anywhere' });
  assert.deepEqual([answer.status, answer.body.cached, answer.body.provider], [200, false, 'searxng'], 'an empty answer is not cached');
  assert.equal(searx.state.calls.length, callsAfterEmpty + 1, 'the next search asks SearXNG again');
  assert.ok(answer.body.results.length > 0);
  ok('Brave fallback on SearXNG errors, empty answers, non-JSON and unreachable hosts; Brave alone; freshness pd and the key header; empty answers not cached');

  // ── Every backend fails: 503 and the search is given back ──
  const before = await usage(alice.userId);
  searx.state.reply = { status: 502 };
  brave.state.reply = { status: 429, body: { type: 'ErrorResponse' } };
  answer = await search(both, alice.ses, { query: 'all down' });
  assert.deepEqual([answer.status, answer.body.error], [503, 'search_unavailable']);
  assert.deepEqual(await usage(alice.userId), before, 'the failed search is not counted');
  ok('every backend failing: 503 search_unavailable, quota given back');

  // ── Quota exhaustion (Free: 40 a day) ──
  searx.state.reply = { body: searxResults('quota') };
  await sql('UPDATE public.zerox_search_usage SET searches = 39 WHERE user_id = $1', [alice.userId]);
  answer = await search(both, alice.ses, { query: 'last one' });
  assert.deepEqual([answer.status, answer.body.quota.remaining], [200, 0]);
  answer = await search(both, alice.ses, { query: 'one too many' });
  assert.equal(answer.status, 429);
  assert.equal(answer.body.error, 'search_quota_exhausted');
  assert.equal(answer.body.resets_at, nextMidnight());
  assert.equal(answer.body.exhausted, 'searches');
  assert.equal(answer.body.quota, undefined, 'quota is only ever the 200 object');
  assert.ok(Number(answer.headers.get('retry-after')) > 0);
  answer = await search(both, alice.ses, { query: 'last one' });
  assert.equal(answer.status, 429, 'a cached query is refused too once the quota is used up');
  assert.equal((await usage(alice.userId)).searches, 40);
  ok('Free quota: the 40th search answers remaining 0, the 41st 429 search_quota_exhausted with resets_at and Retry-After');

  // ── Research runs (Free: 3 distinct run ids a day) ──
  const bob = await signIn('search-bob@example.test');
  const research = (run, query = `research ${run}`) => search(both, bob.ses, { query, purpose: 'research' }, { 'x-neuron-research-run': run });
  for (const [run, query] of [['run-aaaa-1', 'a1'], ['run-aaaa-1', 'a2'], ['run-bbbb-2', 'b1'], ['run-cccc-3', 'c1']]) {
    answer = await research(run, query);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  }
  assert.deepEqual(answer.body.quota, { remaining: 36, limit: 40, resets_at: nextMidnight(), research: { remaining: 0, limit: 3 } });
  answer = await research('run-dddd-4');
  assert.deepEqual([answer.status, answer.body.error, answer.body.exhausted], [429, 'search_quota_exhausted', 'research_runs']);
  answer = await research('run-aaaa-1', 'a3');
  assert.equal(answer.status, 200, 'a run opened today keeps working');
  answer = await search(both, bob.ses, { query: 'plain search' }, { 'x-neuron-research-run': 'run-eeee-5' });
  assert.equal(answer.status, 200, 'the header is ignored on a plain search');
  assert.deepEqual(await usage(bob.userId), { searches: 6, research_runs: 3, cache_hits: 0, searxng_calls: 6, brave_calls: 0 });
  const runs = await sql('SELECT run_hash FROM public.zerox_search_research_runs WHERE user_id = $1 ORDER BY run_hash', [bob.userId]);
  assert.deepEqual(runs.map(row => row.run_hash), (await Promise.all(['run-aaaa-1', 'run-bbbb-2', 'run-cccc-3'].map(sha256Hex))).sort(),
    'run ids are stored as sha256 only');
  // A failed search gives back the run it opened.
  await sql('DELETE FROM public.zerox_search_research_runs WHERE user_id = $1 AND run_hash = $2', [bob.userId, await sha256Hex('run-cccc-3')]);
  await sql('UPDATE public.zerox_search_usage SET research_runs = 2 WHERE user_id = $1', [bob.userId]);
  searx.state.reply = { status: 500 };
  brave.state.reply = { status: 500 };
  answer = await research('run-ffff-6', 'fails');
  assert.equal(answer.status, 503);
  assert.equal((await usage(bob.userId)).research_runs, 2, 'the run is given back');
  searx.state.reply = { body: searxResults('again') };
  answer = await research('run-ffff-6', 'works');
  assert.equal(answer.status, 200, 'so the same run can start again');
  ok('research runs: distinct run ids counted (3 on Free), the 4th refused with exhausted research_runs, open runs keep working, hashed ids, failures give the run back');

  // ── Plans: Pro and Max limits, /api/account limits.search and limits.colony ──
  let account = await call(pgEnv, '/api/account', { token: bob.ses });
  assert.deepEqual([account.body.limits.search, account.body.limits.colony],
    [{ daily_searches: 40, daily_research_runs: 3 }, { max_workers: 1, max_tokens_per_run: 300000 }]);
  await sql("UPDATE public.zerox_accounts SET plan = 'pro' WHERE clerk_id = $1", [bob.userId]);
  answer = await research('run-dddd-4');
  assert.equal(answer.status, 200, 'Pro has 30 research runs');
  assert.deepEqual(answer.body.quota, { remaining: 400 - 8, limit: 400, resets_at: nextMidnight(), research: { remaining: 26, limit: 30 } });
  account = await call(pgEnv, '/api/account', { token: bob.ses });
  assert.deepEqual([account.body.limits.search, account.body.limits.colony],
    [{ daily_searches: 400, daily_research_runs: 30 }, { max_workers: 4, max_tokens_per_run: 2000000 }]);
  await sql("UPDATE public.zerox_accounts SET plan = 'max' WHERE clerk_id = $1", [bob.userId]);
  answer = await search(both, bob.ses, { query: 'max plan' });
  assert.deepEqual([answer.body.quota.limit, answer.body.quota.research.limit], [2000, 150]);
  account = await call(pgEnv, '/api/account', { token: bob.ses });
  assert.deepEqual([account.body.limits.search, account.body.limits.colony],
    [{ daily_searches: 2000, daily_research_runs: 150 }, { max_workers: 8, max_tokens_per_run: 6000000 }]);
  ok('plans: Pro 400/30 and Max 2000/150 applied; /api/account limits.search and limits.colony per plan');

  // ── API keys and suspended accounts ──
  const minted = await call(pgEnv, '/api/keys', { method: 'POST', token: devToken('search-bob@example.test'), body: { name: 'search' } });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const apiKey = minted.body.secret;
  assert.ok(/^nzx_/.test(apiKey), 'an nzx_ key');
  answer = await search(both, apiKey, { query: 'with a key' });
  assert.equal(answer.status, 200, 'nzx_ keys may search');
  await sql('UPDATE public.zerox_accounts SET suspended = true WHERE clerk_id = $1', [bob.userId]);
  answer = await search(both, bob.ses, { query: 'suspended' });
  assert.deepEqual([answer.status, answer.body.error], [403, 'account_suspended']);
  await sql('UPDATE public.zerox_accounts SET suspended = false WHERE clerk_id = $1', [bob.userId]);
  ok('nzx_ API keys search; suspended accounts get 403 account_suspended');

  // ── Metadata only ──
  const stored = JSON.stringify(await sql(`SELECT (SELECT json_agg(u) FROM public.zerox_search_usage AS u) AS usage,
    (SELECT json_agg(r) FROM public.zerox_search_research_runs AS r) AS runs`));
  for (const text of ['rust', 'Rust async traits', 'fallback', 'plain search', 'nothing anywhere', 'run-aaaa-1', 'example.org']) {
    assert.ok(!stored.toLowerCase().includes(text.toLowerCase()), `no "${text}" in the database`);
  }
  const columns = (await sql(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name LIKE 'zerox_search%' ORDER BY 1, 2`)).map(row => `${row.table_name}.${row.column_name}`);
  assert.deepEqual(columns, ['zerox_search_research_runs.created_at', 'zerox_search_research_runs.day', 'zerox_search_research_runs.run_hash',
    'zerox_search_research_runs.user_id', 'zerox_search_usage.brave_calls', 'zerox_search_usage.cache_hits', 'zerox_search_usage.day',
    'zerox_search_usage.research_runs', 'zerox_search_usage.searches', 'zerox_search_usage.searxng_calls', 'zerox_search_usage.updated_at',
    'zerox_search_usage.user_id']);
  // Old rows are pruned by the user's next search.
  await sql("INSERT INTO public.zerox_search_research_runs (user_id, day, run_hash) VALUES ($1, current_date - 1, $2)", [alice.userId, 'a'.repeat(64)]);
  await sql("INSERT INTO public.zerox_search_usage (user_id, day, searches) VALUES ($1, current_date - 93, 5)", [alice.userId]);
  await sql("UPDATE public.zerox_search_usage SET searches = 0 WHERE user_id = $1 AND day = (now() AT TIME ZONE 'UTC')::date", [alice.userId]);
  answer = await search(both, alice.ses, { query: 'prune' });
  assert.equal(answer.status, 200);
  assert.deepEqual((await sql('SELECT count(*)::int AS n FROM public.zerox_search_research_runs WHERE user_id = $1', [alice.userId]))[0].n, 0);
  assert.deepEqual((await sql('SELECT count(*)::int AS n FROM public.zerox_search_usage WHERE user_id = $1', [alice.userId]))[0].n, 1);
  // Database privileges: service_role only.
  const privileges = await sql(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
      p.prosecdef FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'zerox_search%' ORDER BY 1`);
  assert.deepEqual(privileges, [{ proname: 'zerox_search_reserve', anon: false, auth: false, service: true, prosecdef: false },
    { proname: 'zerox_search_settle', anon: false, auth: false, service: true, prosecdef: false }]);
  ok('metadata only: no query, result or run id in the database; old rows pruned; service_role-only functions');

  // ── Down script, missing migration, re-apply ──
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  await handle.db.exec(await read('./migrations/down/20261105200000_search_quota.down.sql'));
  handle.functions.clear();
  assert.deepEqual(await sql("SELECT to_regclass('public.zerox_search_usage') AS a, to_regclass('public.zerox_search_research_runs') AS b"), [{ a: null, b: null }]);
  assert.equal((await sql("SELECT count(*)::int AS n FROM supabase_migrations.schema_migrations WHERE version = '20261105200000'"))[0].n, 0);
  searchCache.clear();
  answer = await search(both, alice.ses, { query: 'no migration' });
  assert.deepEqual([answer.status, answer.body.error], [503, 'search_unavailable'], 'no quota functions: unavailable, never unmetered');
  account = await call(pgEnv, '/api/account', { token: alice.ses });
  assert.equal(account.status, 200, '/api/account does not need the migration');
  await handle.db.exec(await read('./migrations/20261105200000_search_quota.sql'));
  handle.functions.clear();
  answer = await search(both, alice.ses, { query: 'migration back' });
  assert.equal(answer.status, 200);
  ok('down script drops the tables, functions and history row; without them 503; the migration applies again');

  // ── runSearch directly: no backend answered ──
  await assert.rejects(runSearch({ SEARXNG_URL: deadUrl }, { query: 'x', freshness: null }), error => error.status === 503);
  ok('runSearch: 503 SearchError when no backend answers');
} finally {
  globalThis.fetch = originalFetch;
  searx.server.close();
  brave.server.close();
  await closeAllPglite();
}
console.log(`\n${passed.length} search checks passed`);
