// Active model health checks (src/health-probes.js) against a real Postgres (PGlite, every
// migration applied) and mock providers: quota math, delisted models, busy slots, recovery,
// quota-aware scheduling, the single leader, real traffic as an observation, stale rows reading
// unknown, the passive merge and the kill switch. Offline; the clock of the prober is controlled.
//   node check-health-probes.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountDatabaseError, rpc } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { CATALOG, POOL_LIMITS, poolKey } from './src/catalog.js';
import {
  CHAT_MAX_TOKENS, HealthProber, MAX_PROBE_SHARE, PROBE_SCHEDULES, TOOL_MAX_TOKENS, databaseProbeStore, healthStaleMs,
  probeHealthRows, probePlan, probeRoutingRows, probeSettings, probeView, setActiveProber, startHealthProbes,
} from './src/health-probes.js';
import { withHealth } from './src/health-share.js';
import { FailureKind, ProviderHealthTracker } from './src/provider-health.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quiet = { info() {}, warn() {}, log() {} };

// Minute buckets roll over on the wall clock: keep each budget section clear of a boundary.
async function clockHeadroom(seconds = 15) {
  const now = new Date();
  const intoMinute = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  if (intoMinute > 60 - seconds) await sleep((60 - intoMinute + 0.5) * 1000);
  const toMidnight = 86400 - (Date.now() / 1000) % 86400;
  if (toMidnight < 90) await sleep((toMidnight + 1) * 1000);
}

/* ───────────── 1. Quota math (no database) ───────────── */

const entry = id => CATALOG.find(item => item.id === id);
{
  const groq = probePlan(entry('groq/openai/gpt-oss-120b'), entry('groq/openai/gpt-oss-120b').pools[0]);
  assert.deepEqual([groq.chatMs / 60000, groq.toolMs / 60000, groq.dailyCap], [60, 360, 28], 'Groq free: hourly chat, tools every 6 h');
  assert.ok(groq.dailyCap <= POOL_LIMITS.groq_free.rpd * MAX_PROBE_SHARE);
  const nvidia = probePlan(entry('nvidia/openai/gpt-oss-20b'), entry('nvidia/openai/gpt-oss-20b').pools[0]);
  assert.deepEqual([nvidia.chatMs / 60000, nvidia.toolMs / 60000, nvidia.dailyCap], [15, 180, 104]);
  assert.ok(nvidia.dailyCap * 3 <= POOL_LIMITS.nvidia_trial.rpd * 0.035, 'three NVIDIA models stay near 3 % of the trial account');
  const north = entry('cohere/north-mini-code:free');
  const openrouter = probePlan(north, north.pools[0]);
  assert.equal(openrouter.providerDailyCap, 4, 'OpenRouter: at most 4 test requests a day for the whole account');
  assert.ok(openrouter.providerDailyCap / POOL_LIMITS.openrouter_free.rpd <= 0.08);
  assert.ok(openrouter.chatMs >= 8 * 3600_000, 'OpenRouter: chat at most every 8 h');
  const gemini = probePlan(entry('gemini/gemini-2.5-flash'), entry('gemini/gemini-2.5-flash').pools[0]);
  assert.deepEqual([gemini.dailyCap, gemini.toolMs], [1, 0], 'Gemini free (20 a day): one chat a day, its list does the rest');
  const workers = entry('@cf/openai/gpt-oss-120b');
  const cf = probePlan(workers, workers.pools[0]);
  assert.ok(cf.dailyCap <= Math.floor(workers.pools[0].limits.rpd * MAX_PROBE_SHARE), 'Workers AI stretched under 5 %');
  // Every free pool with a published daily budget stays within the share (OpenRouter: its account cap).
  for (const item of CATALOG) {
    for (const pool of item.pools) {
      const plan = probePlan(item, pool);
      if (pool.limits?.rpd && plan.providerDailyCap == null) {
        assert.ok(plan.dailyCap <= Math.max(1, Math.floor(pool.limits.rpd * MAX_PROBE_SHARE)), `${item.id} ${pool.tier} within ${MAX_PROBE_SHARE}`);
      }
      assert.ok(plan.chatMs >= 15 * 60000, `${item.id}: no chat more often than every 15 min`);
    }
  }
  const zai = entry('zai/glm-4.7-flash');
  assert.equal(probePlan(zai, zai.pools[0]).chatMs, 15 * 60000);
  const sonnet = CATALOG.find(item => item.provider === 'anthropic');
  assert.deepEqual([probePlan(sonnet, sonnet.pools[0]).chatMs / 60000, PROBE_SCHEDULES.paid.tool_minutes], [30, 360]);
  assert.ok(CHAT_MAX_TOKENS <= 3 && TOOL_MAX_TOKENS <= 200, 'tiny requests');
  ok('quota math: every schedule within its pool\'s free daily budget');
}

{
  assert.equal(probeSettings({}).enabled, true, 'on by default');
  for (const value of ['off', 'OFF', 'false', '0']) assert.equal(probeSettings({ HEALTH_PROBES: value }).enabled, false);
  assert.equal(probeSettings({}).tickMs, 15000);
  assert.equal(healthStaleMs({}), 1_200_000);
  assert.equal(healthStaleMs({ HEALTH_STALE_SECONDS: '5' }), 120_000, 'clamped to at least 2 minutes');
  assert.equal(startHealthProbes({ HEALTH_PROBES: 'off', DATABASE_DRIVER: 'pglite' }), null, 'kill switch');
  assert.equal(startHealthProbes({}), null, 'no database: no probes');
  assert.equal(probeHealthRows(), null);
  ok('settings: HEALTH_PROBES=off kill switch, safe defaults');
}

/* ───────────── 2. Stale rows and the passive merge (no database) ───────────── */

{
  const now = Date.parse('2026-11-04T12:48:00Z');
  const stale = healthStaleMs({});
  const row = { pool: 'p', status: 'available', base_status: 'available', checked_at: now - 60_000, until: null };
  assert.equal(probeView(row, now, stale).status, 'available');
  assert.equal(probeView(row, now + stale, stale).status, 'unknown', 'no confirmation within the stale window: unknown');
  const busy = { ...row, status: 'busy', until: now + 30_000 };
  assert.deepEqual([probeView(busy, now, stale).status, probeView(busy, now, stale).until], ['busy', now + 30_000]);
  assert.equal(probeView(busy, now + 31_000, stale).status, 'available', 'a busy slot that freed reads the last verdict');
  const delisted = { ...row, status: 'unavailable', base_status: 'unavailable', until: null, failure_class: 'delisted' };
  assert.equal(probeView(delisted, now, stale).status, 'blurred');
  assert.equal(probeView(delisted, now, stale).until, row.checked_at + stale, 'routing skips it only until the verdict goes stale');

  const payload = () => ({ data: [{ id: 'a', available: true }, { id: 'b', available: true }, { id: 'c', available: true }] });
  const keys = { a: ['pa'], b: ['pb'], c: ['pc'] };
  const probeRows = new Map([
    ['pa', { pool: 'pa', status: 'available', base_status: 'available', checked_at: now - 30_000, latency_ms: 420, last_success_at: now - 30_000 }],
    ['pb', { pool: 'pb', status: 'available', base_status: 'available', checked_at: now - stale - 1000 }],
  ]);
  const env = { HEALTH_STALE_SECONDS: String(stale / 1000) };
  const out = await withHealth(env, payload(), model => keys[model.id], { probeRows, now, readRows: async () => new Map() });
  const by = Object.fromEntries(out.data.map(model => [model.id, model]));
  assert.deepEqual([by.a.status, by.a.latency_ms, by.a.checked_at], ['available', 420, new Date(now - 30_000).toISOString()]);
  assert.equal(by.b.status, 'unknown', 'stale probe row: unknown, never available');
  assert.equal(by.c.status, 'unknown', 'no observation at all: unknown, never available');

  // A real failure newer than the probe flips the model at once; a newer probe success brightens it.
  const tracker = new ProviderHealthTracker();
  const realNow = Date.now();
  const fresh = new Map([['pa', { pool: 'pa', status: 'available', base_status: 'available', checked_at: realNow - 60_000 }]]);
  tracker.recordFailure('pa', { kind: FailureKind.MODEL_UNAVAILABLE });
  let merged = await withHealth(env, { data: [{ id: 'a', available: true }] }, () => ['pa'],
    { tracker, probeRows: fresh, now: realNow + 10, readRows: async () => new Map() });
  assert.deepEqual([merged.data[0].status, merged.data[0].last_failure_class], ['unavailable', 'model_unavailable'],
    'a real 404 after the probe: unavailable at once');
  fresh.set('pa', { ...fresh.get('pa'), checked_at: realNow + 5 });
  merged = await withHealth(env, { data: [{ id: 'a', available: true }] }, () => ['pa'],
    { tracker, probeRows: fresh, now: realNow + 10, readRows: async () => new Map() });
  assert.equal(merged.data[0].status, 'available', 'a newer passing test request brightens it again');
  ok('stale rows read unknown; the freshest of real traffic and test requests wins');
}

/* ───────────── 3. Against Postgres and mock providers ───────────── */

const env = {
  DATABASE_DRIVER: 'pglite',
  GROQ_API_KEY: 'gsk_probe_test', NVIDIA_API_KEY: 'nvapi-probe-test', NVIDIA_HOSTED: 'true',
  OPENROUTER_API_KEY: 'sk-or-probe-test', OPENROUTER_HOSTED: 'true',
  OPENROUTER_MODELS: 'cohere/north-mini-code:free,minimax/minimax-m3.1-flash:free',
  GLM_API_KEY: 'glm-probe-test', GEMINI_MODELS: '', CLOUDFLARE_MODELS: '',
};
const SECRETS = [env.GROQ_API_KEY, env.NVIDIA_API_KEY, env.OPENROUTER_API_KEY, env.GLM_API_KEY];
const handle = await getPgliteHandle(env);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const calls = [];
const behaviour = {}; // upstream model id -> (body) => Response
const completion = body => (body.tools
  ? json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function',
    function: { name: 'record_result', arguments: '{"status":"ok","value":42}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 } })
  : json({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }));
const lists = {
  'https://api.groq.com/openai/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }] }),
  'https://integrate.api.nvidia.com/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-20b' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b' }, { id: 'stepfun-ai/step-5-preview' }] }),
  // 2026-11-04: OpenRouter no longer lists MiniMax M3.1 Flash.
  'https://openrouter.ai/api/v1/models': () => json({ data: [{ id: 'cohere/north-mini-code:free' }] }),
  'https://openrouter.ai/api/v1/key': () => json({ data: { label: 'probe', is_free_tier: true } }),
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input?.url ?? input);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, model: body?.model ?? null, tools: Boolean(body?.tools), max_tokens: body?.max_tokens ?? null,
    headers: options.headers || {} });
  const list = Object.keys(lists).find(prefix => url.startsWith(prefix));
  if (list) return lists[list](url);
  if (url.endsWith('/chat/completions')) return (behaviour[body.model] || completion)(body);
  return json({ error: { message: 'not found' } }, 404);
};
const chats = () => calls.filter(call => call.url.endsWith('/chat/completions'));

const base = Date.now();
let offset = 0;
const clock = () => base + offset;
const store = databaseProbeStore(env);
const prober = new HealthProber(env, { store, holder: 'instance-a', now: clock, log: quiet });
const other = new HealthProber(env, { store, holder: 'instance-b', now: clock, log: quiet });
const key = id => {
  const item = CATALOG.find(candidate => candidate.id === id);
  return poolKey(item, item.pools.find(pool => pool.tier === 'free'));
};
const GROQ_120B = key('groq/openai/gpt-oss-120b');
const GROQ_20B = key('groq/openai/gpt-oss-20b');
const QWEN = key('groq/qwen/qwen3.8-27b');
const NVIDIA_20B = key('nvidia/openai/gpt-oss-20b');
const NORTH = key('cohere/north-mini-code:free');
const MINIMAX = key('minimax/minimax-m3.1-flash:free');
const GLM_47 = key('zai/glm-4.7-flash');
const today = () => new Date(clock()).toISOString().slice(0, 10);
const dayBucket = async model => (await sql(`SELECT requests FROM public.zerox_pool_usage WHERE model = $1 AND tier = 'free'
  AND bucket = 'day' ORDER BY bucket_start DESC LIMIT 1`, [model]))[0]?.requests ?? 0;
const makeDue = (...pools) => { for (const pool of pools) prober.rows.get(pool).probed_at = null; };
const tickA = async () => { offset += 15_000; return prober.tick(); };

let userCounter = 0;
async function newUser() {
  userCounter += 1;
  const email = `probe${userCounter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Probe ${userCounter}` } });
  return id;
}

try {
  await clockHeadroom(40);
  // ── Single leader: the first instance to ask holds the lease; the other only reads ──
  let summary = await prober.tick();
  assert.equal(summary.leader, true, 'instance a leads');
  const followerCalls = calls.length;
  summary = await other.tick();
  assert.equal(summary.leader, false, 'instance b follows');
  assert.equal(calls.length, followerCalls, 'a follower sends no list check and no test request');
  ok('single leader: one instance holds the Postgres lease, the other sends nothing');

  // ── Delisted model: unavailable from the free list, never asked ──
  assert.ok(calls.some(call => call.url === 'https://openrouter.ai/api/v1/models'), 'the free OpenRouter list was read');
  assert.equal(prober.rows.get(MINIMAX).status, 'unavailable');
  assert.equal(prober.rows.get(MINIMAX).failure_class, 'delisted');
  for (let i = 0; i < 8; i++) await tickA();
  assert.ok(!chats().some(call => call.model === 'minimax/minimax-m3.1-flash:free'), 'no request is spent on a delisted model');
  assert.ok(chats().every(call => call.max_tokens <= TOOL_MAX_TOKENS));
  assert.ok(chats().filter(call => !call.tools).every(call => call.max_tokens === CHAT_MAX_TOKENS), 'chat probes ask for 3 tokens');
  // The follower reads the leader's verdicts.
  await other.tick();
  assert.equal(other.cache.get(MINIMAX).status, 'unavailable');
  setActiveProber(other);
  const routing = probeRoutingRows(clock());
  assert.equal(routing.get(MINIMAX).status, 'blurred', 'routing skips the delisted model');
  // From here on the leader's own cache answers the app (the process that probes reads its rows).
  setActiveProber(prober);
  ok('delisted model -> unavailable (OpenRouter list), no request spent, shared with the follower and routing');

  // ── Every configured pool got a verdict; probes counted against the shared pool budgets ──
  for (const pool of [GROQ_120B, GROQ_20B, QWEN, NVIDIA_20B, NORTH, GLM_47]) {
    assert.equal(prober.rows.get(pool).status, 'available', `${pool} answered its test request`);
    assert.ok(prober.rows.get(pool).probe_count >= 1 && prober.rows.get(pool).probe_count <= 2, 'a chat, then at most one tool call');
  }
  assert.equal(await dayBucket('groq/openai/gpt-oss-120b'), prober.rows.get(GROQ_120B).probe_count,
    'every Groq test request is in the pool\'s day bucket');
  assert.equal(await dayBucket('cohere/north-mini-code:free'), prober.rows.get(NORTH).probe_count);
  for (const model of new Set(chats().map(call => call.model))) {
    assert.equal(chats().find(call => call.model === model).tools, false, `${model}: a chat first, the tool call only after it passed`);
  }
  // The status endpoint (through the app, per route) reports the verdicts with checked_at.
  const { default: app } = await import('./src/index.js');
  const statusRows = async () => {
    const response = await app.request('https://zero-x.live/v1/models/status?routes=1', {}, env);
    assert.equal(response.status, 200);
    const body = await response.json();
    return { body, by: Object.fromEntries(body.data.map(row => [row.id, row])) };
  };
  let status = await statusRows();
  assert.equal(status.body.stale_after_seconds, 1200);
  assert.equal(status.by['minimax/minimax-m3.1-flash:free'].status, 'unavailable');
  assert.equal(status.by['minimax/minimax-m3.1-flash:free'].last_failure_class, 'delisted');
  assert.equal(status.by['groq/openai/gpt-oss-120b'].status, 'available');
  assert.ok(Number.isFinite(status.by['groq/openai/gpt-oss-120b'].latency_ms));
  assert.ok(status.by['groq/openai/gpt-oss-120b'].checked_at, 'an honest per-model checked_at');
  const families = await (await app.request('https://zero-x.live/v1/models', {}, env)).json();
  assert.ok(!JSON.stringify(families.data.map(({ id, status: s, checked_at: c }) => ({ id, s, c }))).includes('openrouter'),
    'the family view names no provider');
  ok('every pool probed once and counted in zerox_pool_usage; /v1/models/status reports verdicts and checked_at');

  // ── Busy slot: a user's request holds GLM's only slot ──
  await clockHeadroom(20);
  const user = await newUser();
  const held = await rpc(env, 'zerox_reserve_v2', { p_user_id: user, p_request_id: `req_${randomUUID()}`,
    p_model: 'zai/glm-4.7-flash', p_tier: 'free', p_tokens: 100, p_cost_microusd: 0,
    p_pool: { rpm: null, rpd: null, tpm: null, tpd: null, concurrency: 1 } });
  assert.equal(held.status, 'ok');
  const glmCalls = chats().filter(call => call.model === 'glm-4.7-flash').length;
  makeDue(GLM_47);
  await tickA();
  assert.equal(prober.rows.get(GLM_47).status, 'busy', 'the slot is taken: busy');
  assert.ok(prober.rows.get(GLM_47).until > clock(), 'with available_again_at');
  assert.equal(chats().filter(call => call.model === 'glm-4.7-flash').length, glmCalls, 'no test request while a user holds the slot');
  status = await statusRows();
  assert.equal(status.by['zai/glm-4.7-flash'].status, 'busy');
  assert.ok(Date.parse(status.by['zai/glm-4.7-flash'].available_again_at) > Date.now());
  await sql(`UPDATE public.zerox_reservations SET status = 'settled', outcome = 'ok', settled_at = now() WHERE id = $1`, [held.reservation_id]);
  await tickA();
  assert.equal(prober.rows.get(GLM_47).status, 'available', 'the slot freed: the last verdict applies again');
  ok('busy slot -> busy with available_again_at, without spending a request; back once it frees');

  // ── Recovery: two failures make a model unavailable, a passing request brings it back ──
  behaviour['openai/gpt-oss-120b'] = () => json({ error: { message: 'upstream down', type: 'server_error' } }, 503);
  makeDue(GROQ_120B);
  await tickA();
  assert.deepEqual([prober.rows.get(GROQ_120B).status, prober.rows.get(GROQ_120B).failure_class], ['degraded', 'server'],
    'one 503: degraded (intermittent)');
  assert.equal(prober.due({ entry: entry('groq/openai/gpt-oss-120b'), pool: entry('groq/openai/gpt-oss-120b').pools[0],
    key: GROQ_120B, plan: probePlan(entry('groq/openai/gpt-oss-120b'), entry('groq/openai/gpt-oss-120b').pools[0]) }, clock() + 15 * 60000),
  'chat', 'a failing pool is asked again sooner (a quarter of its hour)');
  makeDue(GROQ_120B);
  await tickA();
  assert.equal(prober.rows.get(GROQ_120B).status, 'unavailable', 'two in a row: unavailable');
  status = await statusRows();
  assert.equal(status.by['groq/openai/gpt-oss-120b'].status, 'unavailable');
  delete behaviour['openai/gpt-oss-120b'];
  makeDue(GROQ_120B);
  await tickA();
  assert.equal(prober.rows.get(GROQ_120B).status, 'available', 'recovered');
  assert.equal(prober.rows.get(GROQ_120B).consecutive_failures, 0);
  // A 429 from the upstream: busy with the provider's delay.
  behaviour['openai/gpt-oss-20b'] = () => json({ error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } },
    429, { 'retry-after': '42' });
  makeDue(GROQ_20B);
  await tickA();
  assert.equal(prober.rows.get(GROQ_20B).status, 'busy');
  assert.ok(Math.abs(prober.rows.get(GROQ_20B).until - (clock() + 42_000)) < 2_000, 'until the upstream\'s Retry-After');
  delete behaviour['openai/gpt-oss-20b'];
  // A 404 from the upstream: unavailable (model_unavailable).
  behaviour['nvidia/nemotron-3-ultra-550b-a55b'] = () => json({ error: { message: 'Not found', code: 'model_not_found' } }, 404);
  const nemotron = key('nvidia/nvidia/nemotron-3-ultra-550b-a55b');
  makeDue(nemotron);
  await tickA();
  assert.deepEqual([prober.rows.get(nemotron).status, prober.rows.get(nemotron).failure_class], ['unavailable', 'model_unavailable']);
  delete behaviour['nvidia/nemotron-3-ultra-550b-a55b'];
  ok('recovery: 503 -> degraded -> unavailable -> available; 429 -> busy until Retry-After; 404 -> unavailable');

  // ── Quota-aware scheduling ──
  await clockHeadroom(20);
  // (a) The pool's daily test-request cap.
  const groq120b = () => chats().filter(call => call.model === 'openai/gpt-oss-120b' && call.url.startsWith('https://api.groq.com')).length;
  const before = groq120b();
  const groqPlan = probePlan(entry('groq/openai/gpt-oss-120b'), entry('groq/openai/gpt-oss-120b').pools[0]);
  Object.assign(prober.rows.get(GROQ_120B), { probe_day: today(), probe_count: groqPlan.dailyCap, probed_at: null });
  await tickA();
  assert.equal(groq120b(), before, 'no test request past the daily cap of the pool');
  // (b) OpenRouter's account-wide cap (4 a day for every :free model together).
  Object.assign(prober.rows.get(NORTH), { probe_day: today(), probe_count: 4, probed_at: null });
  const northBefore = chats().filter(call => call.model === 'cohere/north-mini-code:free').length;
  await tickA();
  assert.equal(chats().filter(call => call.model === 'cohere/north-mini-code:free').length, northBefore, 'OpenRouter cap holds');
  // (c) Users are busy on the pool: half of the minute's requests already used.
  await sql(`UPDATE public.zerox_pool_usage SET requests = 15 WHERE model = 'groq/qwen/qwen3.8-27b' AND tier = 'free'
    AND bucket = 'minute' AND bucket_start = date_trunc('minute', now(), 'UTC')`);
  await sql(`INSERT INTO public.zerox_pool_usage (model, tier, pool_key, bucket, bucket_start, requests)
    VALUES ('groq/qwen/qwen3.8-27b', 'free', '', 'minute', date_trunc('minute', now(), 'UTC'), 15) ON CONFLICT DO NOTHING`);
  const qwenBefore = chats().filter(call => call.model === 'qwen/qwen3.8-27b').length;
  const qwenStatus = prober.rows.get(QWEN).status;
  makeDue(QWEN);
  await tickA();
  assert.equal(chats().filter(call => call.model === 'qwen/qwen3.8-27b').length, qwenBefore, 'skipped while users are busy on the pool');
  assert.equal(prober.rows.get(QWEN).status, qwenStatus, 'and their activity alone changes no verdict');
  // (d) The pool's daily budget is spent by users: unavailable until 00:00 UTC, no request sent.
  await sql(`UPDATE public.zerox_pool_usage SET requests = 1000 WHERE model = 'groq/qwen/qwen3.8-27b' AND tier = 'free' AND bucket = 'day'`);
  makeDue(QWEN);
  await tickA();
  assert.deepEqual([prober.rows.get(QWEN).status, prober.rows.get(QWEN).failure_class], ['unavailable', 'quota']);
  // The database's retry (to 00:00 UTC) is added to the prober's clock, which runs `offset` ahead.
  const midnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
  assert.ok(Math.abs(prober.rows.get(QWEN).until - offset - midnight) < 120_000, 'until 00:00 UTC');
  assert.equal(chats().filter(call => call.model === 'qwen/qwen3.8-27b').length, qwenBefore);
  // (e) Users' traffic from any instance is the observation: a settled success, no request sent.
  const trafficUser = await newUser();
  const served = await rpc(env, 'zerox_reserve_v2', { p_user_id: trafficUser, p_request_id: `req_${randomUUID()}`,
    p_model: 'nvidia/openai/gpt-oss-20b', p_tier: 'free', p_tokens: 100, p_cost_microusd: 0, p_pool: POOL_LIMITS.nvidia_trial });
  await sql(`UPDATE public.zerox_reservations SET status = 'settled', outcome = 'ok', settled_at = now() WHERE id = $1`, [served.reservation_id]);
  const nvidiaBefore = chats().filter(call => call.url.startsWith('https://integrate.api.nvidia.com') && call.model === 'openai/gpt-oss-20b').length;
  makeDue(NVIDIA_20B);
  await tickA();
  assert.equal(prober.rows.get(NVIDIA_20B).source, 'traffic', 'a recent user success counts');
  assert.equal(chats().filter(call => call.url.startsWith('https://integrate.api.nvidia.com') && call.model === 'openai/gpt-oss-20b').length,
    nvidiaBefore, 'and no test request is spent');
  ok('quota-aware: daily caps, OpenRouter account cap, busy pools skipped, spent budgets reported, real traffic reused');

  // ── Tool calls, less often ──
  offset += 6 * 3600_000;
  for (let i = 0; i < 12; i++) await tickA();
  const toolCalls = chats().filter(call => call.tools);
  assert.ok(toolCalls.length >= 1, 'a tool-call test request after its interval');
  assert.ok(toolCalls.every(call => call.max_tokens === TOOL_MAX_TOKENS));
  const toolPool = [...prober.rows.values()].find(row => row.tool_ok === true);
  assert.ok(toolPool, 'a passing tool call is recorded');
  behaviour['openai/gpt-oss-20b'] = body => (body.tools ? json({ choices: [{ message: { role: 'assistant', content: 'I cannot.' },
    finish_reason: 'stop' }] }) : completion(body));
  Object.assign(prober.rows.get(GROQ_20B), { status: 'available', base_status: 'available', until: null, tool_checked_at: 0,
    probed_at: clock(), probe_count: 0 });
  await tickA();
  assert.deepEqual([prober.rows.get(GROQ_20B).status, prober.rows.get(GROQ_20B).failure_class, prober.rows.get(GROQ_20B).tool_ok],
    ['degraded', 'tool_call', false], 'answers but no longer calls tools: degraded');
  delete behaviour['openai/gpt-oss-20b'];
  ok('tool-call probes: less often, 160 tokens, a missing tool call is degraded');

  // ── Leader hand-over ──
  await prober.stop();
  summary = await other.tick();
  assert.equal(summary.leader, true, 'the stopped leader handed the lease over');
  assert.equal((await prober.store.lease('instance-a', 90)), false, 'and a returning instance a follows');
  await other.stop();
  ok('leader hand-over: stop() releases the lease, the next instance leads at its next tick');

  // ── Metadata-only: no key in any request body or log line ──
  const logged = [];
  const recorder = { info: (...args) => logged.push(args), warn: (...args) => logged.push(args), log: (...args) => logged.push(args) };
  const third = new HealthProber(env, { store, holder: 'instance-c', now: clock, log: recorder });
  behaviour['openai/gpt-oss-120b'] = () => json({ error: { message: `bad key ${env.GROQ_API_KEY}`, type: 'invalid_request_error' } }, 500);
  await third.tick();
  third.rows.get(GROQ_120B).probed_at = null;
  third.rows.get(GROQ_120B).probe_count = 0;
  offset += 15_000;
  await third.tick();
  const text = JSON.stringify(logged);
  assert.ok(logged.some(args => args[0] === 'Health probe'), 'test requests are logged');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'no key in the logs');
  assert.ok(!text.includes('bad key'), 'no provider message in the logs');
  const stored = JSON.stringify(await sql('SELECT * FROM public.zerox_pool_health'));
  for (const secret of SECRETS) assert.ok(!stored.includes(secret), 'no key in the rows');
  await third.stop();
  delete behaviour['openai/gpt-oss-120b'];
  ok('metadata-only logs and rows');

  // ── A test request the upstream refuses as a request (400) records no verdict ──
  const STEP = key('nvidia/stepfun-ai/step-5-preview');
  await sql('DELETE FROM public.zerox_pool_health WHERE pool = $1', [STEP]);
  behaviour['stepfun-ai/step-5-preview'] = () => json({ error: { message: 'max_tokens too small', type: 'invalid_request_error' } }, 400);
  const fourth = new HealthProber(env, { store, holder: 'instance-d', now: clock, log: quiet });
  offset += 15_000;
  for (let i = 0; i < 8 && !fourth.rows.get(STEP)?.probed_at; i++) {
    offset += 15_000;
    assert.equal((await fourth.tick()).leader, true);
  }
  assert.ok(fourth.rows.get(STEP).probed_at, 'the test request was sent');
  assert.equal(fourth.rows.get(STEP).status, 'unknown', 'a refused test request is no verdict');
  assert.equal(probeView(fourth.cache.get(STEP), clock()).status, 'unknown', 'stored (the list saw it) without a verdict');
  await fourth.stop();
  delete behaviour['stepfun-ai/step-5-preview'];
  ok('a test request refused as a request: no verdict, the other rows are still written');

  // ── A database without the migration: the prober logs once and stays idle ──
  const missing = { lease: async () => { throw new AccountDatabaseError('Could not find the function', { code: 'PGRST202' }); },
    rows: async () => [], put: async () => {}, take: async () => ({}) };
  const warned = [];
  const orphan = new HealthProber(env, { store: missing, holder: 'x', log: { info() {}, warn: (...a) => warned.push(a) } });
  assert.equal((await orphan.tick()).leader, false);
  assert.equal(orphan.disabled, 'migration_missing');
  await orphan.tick();
  assert.equal(warned.length, 1, 'logged once');
  ok('missing migration: probes off, logged once');
} finally {
  setActiveProber(null);
  globalThis.fetch = realFetch;
  await closeAllPglite();
}

console.log(`\n${passed.length} health probe checks passed`);
