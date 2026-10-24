// HealthHub Durable Object (src/health-hub.js) and its isolate client (src/health-hub-client.js),
// offline: fake Durable Object storage, fake upstreams, controlled clock.
//   node check-health-hub.mjs
import assert from 'node:assert/strict';
import { ALARM_INTERVAL_MS, HealthHub, PROBE_DAILY_CAPS } from './src/health-hub.js';
import { hubHealthRows, publishHealth, resetHubClientCache } from './src/health-hub-client.js';
import { resetSharedHealthCache, withHealth } from './src/health-share.js';
import { FailureKind, HealthState } from './src/provider-health.js';

const drain = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeState(saved = new Map()) {
  let alarm = null;
  return {
    saved,
    get alarm() { return alarm; },
    blockConcurrencyWhile: fn => fn(),
    storage: {
      get: async key => saved.get(key),
      put: async (key, value) => { saved.set(key, structuredClone(value)); },
      getAlarm: async () => alarm,
      setAlarm: async at => { alarm = at; },
    },
  };
}

// HEALTH_CANARIES=false: these checks count every upstream request of the list, status-page and
// half-open probe paths; the OIOP canaries are covered by check-oiop.mjs.
const ENV = {
  HEALTH_CANARIES: 'false',
  GROQ_API_KEY: 'groq-test', GEMINI_API_KEY: 'gemini-test', NVIDIA_API_KEY: 'nvidia-test', NVIDIA_HOSTED: 'true',
  OPENROUTER_API_KEY: 'or-test', OPENROUTER_HOSTED: 'true',
  OPENROUTER_MODELS: 'cohere/north-mini-code:free,minimax/minimax-m3.1-flash:free',
  AI: { run: async () => ({ response: 'OK' }) },
};
const GROQ_120B = 'groq:openai/gpt-oss-120b:free';
const GROQ_QWEN = 'groq:qwen/qwen3.8-27b:free';
const GEMINI_25 = 'gemini:gemini-2.5-flash:free';
const NVIDIA_20B = 'nvidia:openai/gpt-oss-20b:free';

// Upstream fakes, switchable per test. Every call is recorded.
const calls = [];
let upstream = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = String(input?.url ?? input);
  calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
  for (const [prefix, handler] of Object.entries(upstream)) if (url.startsWith(prefix)) return handler(url, options);
  return new Response('{}', { status: 404 });
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lists = {
  'https://api.groq.com/openai/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] }),
  'https://generativelanguage.googleapis.com/v1beta/models': () => json({}, 401),
  'https://integrate.api.nvidia.com/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-20b' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b' }, { id: 'stepfun-ai/step-5-preview' }] }),
  'https://openrouter.ai/api/v1/models': () => json({ data: [{ id: 'cohere/north-mini-code:free' }, { id: 'minimax/minimax-m3.1-flash:free' }] }),
  'https://groqstatus.com/api/v2/summary.json': () => json({ components: [{ name: 'openai/gpt-oss-20b', status: 'major_outage' },
    { name: 'openai/gpt-oss-120b', status: 'operational' }] }),
  'https://www.cloudflarestatus.com/api/v2/summary.json': () => json({ components: [{ name: 'Workers AI', status: 'degraded_performance' }] }),
};

// The tracker reads Date.now(), so the test clock drives Date.now itself.
const realNow = Date.now;
try {
  const base = realNow();
  let offset = 0;
  const clock = () => base + offset;
  Date.now = clock;

  // 1. Reports from isolates become one global state; the alarm arms itself.
  const state = fakeState();
  const hub = new HealthHub(state, ENV, { now: clock });
  await hub.ready;
  assert.equal(state.alarm, base + ALARM_INTERVAL_MS, 'the first instance arms the 30 s alarm');
  const report = outcomes => hub.fetch(new Request('https://hub/report', { method: 'POST', body: JSON.stringify({ outcomes }) }));
  assert.equal((await report([{ key: GROQ_120B, success: false, kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 20 },
    { key: GEMINI_25, success: false, kind: FailureKind.MODEL_UNAVAILABLE }])).status, 200);
  let snap = await (await hub.fetch(new Request('https://hub/snapshot'))).json();
  assert.equal(snap.pools[GROQ_120B].status, 'busy');
  assert.equal(snap.pools[GEMINI_25].status, 'blurred');
  assert.ok(snap.pools[GEMINI_25].until > base);
  await report([{ key: GROQ_120B, success: true }]);
  snap = await (await hub.fetch(new Request('https://hub/snapshot'))).json();
  assert.equal(snap.pools[GROQ_120B].status, 'available', 'a real success brightens the model again');
  assert.equal((await hub.fetch(new Request('https://hub/report', { method: 'POST', body: '{"outcomes":"x"}' }))).status, 400);
  assert.ok(state.saved.get('hub').records[GEMINI_25], 'state is persisted');
  console.log('ok - reports: busy (short 429), blurred (model gone), real success brightens, bad body 400, persisted');

  // 2. Alarm: free checks. Lists (one per key), key checks and status pages, four per alarm, staggered.
  upstream = lists;
  calls.length = 0;
  offset = 31_000;
  await hub.alarm();
  assert.equal(state.alarm, base + offset + ALARM_INTERVAL_MS, 'the alarm re-arms itself');
  const checked = calls.map(call => call.url);
  assert.equal(checked.filter(url => !url.includes('chat/completions')).length, 4, 'four checks per alarm');
  for (let i = 0; i < 3; i++) { offset += 31_000; await hub.alarm(); }
  snap = hub.snapshot();
  assert.equal(snap.pools[GROQ_QWEN].status, 'blurred', 'missing from the Groq list -> greyed out');
  assert.equal(snap.pools[GEMINI_25].status, 'blurred', '401 on the Gemini list -> greyed out (key cannot serve)');
  assert.equal(hub.tracker.records.get('gemini:gemini-3.6-flash:free').status, HealthState.AUTH_FAILED);
  assert.equal(snap.pools['groq:openai/gpt-oss-20b:free'].status, 'blurred', 'status page major outage -> greyed out');
  assert.equal(snap.pools['cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast:free'].status, 'degraded');
  const groqList = calls.find(call => call.url === 'https://api.groq.com/openai/v1/models');
  assert.equal(groqList.headers.Authorization, 'Bearer groq-test');
  const geminiList = calls.find(call => call.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models'));
  assert.equal(geminiList.headers['x-goog-api-key'], 'gemini-test', 'the Gemini key travels in a header, not the URL');
  assert.ok(!calls.some(call => call.url.includes('key=')), 'no key in any URL');
  console.log('ok - alarm checks: missing model and 401 grey out, status-page outage greys out, degraded shows, keys only in headers');

  // The status page recovers: the pool it put down comes back.
  upstream = { ...lists, 'https://groqstatus.com/api/v2/summary.json': () => json({ components: [
    { name: 'openai/gpt-oss-20b', status: 'operational' }] }) };
  for (let i = 0; i < 4; i++) { offset += 31_000; await hub.alarm(); }
  assert.equal(hub.snapshot().pools['groq:openai/gpt-oss-20b:free'].status, 'available', 'status page operational -> bright again');
  console.log('ok - recovery: the status page clearing an outage brightens the model');

  // 3. Test requests: only half-open, idle, capped pools; never NVIDIA or OpenRouter.
  upstream = {
    ...lists,
    'https://groqstatus.com/api/v2/summary.json': () => json({ components: [] }),
    'https://api.groq.com/openai/v1/chat/completions': () => json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
  };
  await report([{ key: GROQ_120B, success: false, kind: FailureKind.SERVER },
    { key: GROQ_120B, success: false, kind: FailureKind.SERVER }, { key: GROQ_120B, success: false, kind: FailureKind.SERVER },
    { key: NVIDIA_20B, success: false, kind: FailureKind.SERVER }, { key: NVIDIA_20B, success: false, kind: FailureKind.SERVER },
    { key: NVIDIA_20B, success: false, kind: FailureKind.SERVER }]);
  assert.equal(hub.snapshot().pools[GROQ_120B].status, 'blurred', 'three 5xx -> down');
  calls.length = 0;
  offset += 31_000;
  await hub.alarm();
  assert.ok(!calls.some(call => call.url.endsWith('/chat/completions')), 'no test request while real traffic was recent');
  offset += 150_000;
  await hub.alarm();
  const probes = calls.filter(call => call.url.endsWith('/chat/completions'));
  assert.equal(probes.length, 1, 'one test request: Groq (NVIDIA is never tested)');
  assert.equal(probes[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  const probeBody = JSON.parse(probes[0].body);
  assert.equal(probeBody.model, 'openai/gpt-oss-120b');
  assert.ok(probeBody.max_tokens <= 8);
  assert.equal(hub.snapshot().pools[GROQ_120B].status, 'available', 'a passing test request brightens the model');
  assert.equal(hub.tracker.records.get(NVIDIA_20B).status, HealthState.DOWN,
    'NVIDIA was not tested: its record stays as real traffic left it (half-open after the cooldown)');
  assert.equal(PROBE_DAILY_CAPS.nvidia, 0);
  assert.equal(PROBE_DAILY_CAPS.openrouter, 0);

  // A 200 without choices is not health; the daily cap holds.
  upstream['https://api.groq.com/openai/v1/chat/completions'] = () => json({ ok: true });
  hub.probes = { day: new Date(base + offset).toISOString().slice(0, 10), counts: { [GROQ_120B]: PROBE_DAILY_CAPS.groq - 1 } };
  await report([{ key: GROQ_120B, success: false, kind: FailureKind.SERVER }, { key: GROQ_120B, success: false, kind: FailureKind.SERVER },
    { key: GROQ_120B, success: false, kind: FailureKind.SERVER }]);
  const groq120bProbes = () => calls.filter(call => call.url === 'https://api.groq.com/openai/v1/chat/completions'
    && JSON.parse(call.body).model === 'openai/gpt-oss-120b').length;
  offset += 200_000;
  calls.length = 0;
  await hub.alarm();
  assert.equal(groq120bProbes(), 1);
  assert.notEqual(hub.snapshot().pools[GROQ_120B].status, 'available', 'a 200 with no choices does not count as healthy');
  offset += 200_000;
  calls.length = 0;
  await hub.alarm();
  assert.equal(groq120bProbes(), 0, 'the daily cap of 24 holds');
  console.log('ok - test requests: half-open + idle only, Groq yes / NVIDIA never, 200 without choices fails, daily cap holds');

  // 4. A restarted object resumes from storage.
  const reborn = new HealthHub(state, ENV, { now: clock });
  await reborn.ready;
  assert.equal(reborn.snapshot().pools[GROQ_QWEN].status, 'blurred');
  console.log('ok - restart: state reloads from Durable Object storage');

  // 5. Isolate client: outcomes reach the hub with a one-way caller tag; successes are sampled.
  resetHubClientCache();
  const received = [];
  const namespace = {
    idFromName: name => ({ name }),
    get: (id, options) => {
      assert.equal(id.name, 'global');
      assert.equal(options.locationHint, 'apac');
      return { fetch: async (url, init = {}) => {
        if (String(url).endsWith('/report')) { received.push(JSON.parse(init.body)); return json({ ok: true }); }
        return json({ generated_at: Date.now(), pools: { [GROQ_QWEN]: { status: 'blurred', until: Date.now() + 60_000, at: Date.now() },
          'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast:free': { status: 'degraded', until: 0, at: Date.now() } } });
      } };
    },
  };
  const env = { ...ENV, HEALTH_HUB: namespace, ALLOW_UNKNOWN_COUNTRY: 'true' };
  const c = {};
  await publishHealth(c, env, GROQ_120B, null, { success: false, kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 9,
    caller: 'ses_secret_token_prefix' });
  assert.equal(received.length, 1);
  const sent = received[0].outcomes[0];
  assert.equal(sent.key, GROQ_120B);
  assert.equal(sent.kind, FailureKind.RATE_LIMITED);
  assert.match(sent.caller, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(received).includes('ses_secret'), 'no token fragment reaches the hub');
  await publishHealth(c, env, GROQ_120B, null, { success: true });
  await publishHealth(c, env, GROQ_120B, null, { success: true });
  assert.equal(received.length, 2, 'the first success after a failure is sent; the next within 30 s is not');

  const rows = await hubHealthRows(env, [GROQ_QWEN, GROQ_120B]);
  assert.equal(rows.get(GROQ_QWEN).status, 'blurred');
  assert.equal(rows.get(GROQ_120B), null);
  assert.equal(await hubHealthRows({ ...ENV }, [GROQ_QWEN]), null, 'no binding: null, so the caller reads KV');
  console.log('ok - client: hashed caller, sampled successes, snapshot rows, no binding -> KV fallback');

  // 6. /v1/models merge with the hub as the source: degraded stays degraded.
  resetSharedHealthCache();
  const payload = { object: 'list', data: [
    { id: 'qwen', available: true }, { id: 'llama', available: true }, { id: 'other', available: true }] };
  const keys = { qwen: [GROQ_QWEN], llama: ['cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast:free'], other: ['x:y:free'] };
  await withHealth(env, payload, model => keys[model.id], { readRows: k => hubHealthRows(env, k) });
  assert.deepEqual(payload.data.map(model => model.status), ['blurred', 'degraded', 'available']);
  console.log('ok - /v1/models from the hub: blurred, degraded and available as reported');

  console.log('PASS: HealthHub Durable Object: global state, 30 s alarm checks, capped test requests, restart, client and /v1/models merge');
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
}
await drain();
