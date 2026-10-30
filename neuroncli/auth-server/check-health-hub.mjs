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

  // 1b. Slow pools. Only a first-byte or idle timeout marks a pool slow (slow_until in the
  // snapshot, which chat-handler.js reads to try it after healthy pools), for five minutes or
  // until a success. One 5xx or one slow non-streaming response leaves it ranked as before.
  {
    const before = offset;
    const slowHub = new HealthHub(fakeState(), ENV, { now: clock });
    await slowHub.ready;
    slowHub.report([{ key: GROQ_120B, success: false, kind: FailureKind.SERVER },
      { key: GROQ_QWEN, success: false, kind: FailureKind.TIMEOUT, phase: 'response', caller: 'one-user' },
      { key: NVIDIA_20B, success: false, kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'one-user' }]);
    let pools = slowHub.snapshot().pools;
    assert.deepEqual([pools[GROQ_120B].status, pools[GROQ_120B].slow_until], ['degraded', undefined], 'one 5xx is not slow');
    assert.deepEqual([pools[GROQ_QWEN].status, pools[GROQ_QWEN].slow_until], ['degraded', undefined], 'nor a slow response');
    assert.equal(pools[NVIDIA_20B].slow_until, clock() + 300_000, 'a first-byte timeout: slow for five minutes');
    slowHub.report([{ key: NVIDIA_20B, success: false, kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'other-user' }]);
    assert.equal(slowHub.snapshot().pools[NVIDIA_20B].status, 'blurred', 'two callers: parked');
    offset += 31_000;
    pools = slowHub.snapshot().pools;
    assert.equal(pools[NVIDIA_20B].status, 'available', 'half-open after the cooldown');
    assert.ok(pools[NVIDIA_20B].slow_until > clock(), 'and still slow');
    offset += 270_000;
    assert.equal(slowHub.snapshot().pools[NVIDIA_20B].slow_until, undefined, 'the mark ends five minutes after the last timeout');
    slowHub.report([{ key: GEMINI_25, success: false, kind: FailureKind.TIMEOUT, phase: 'idle', caller: 'one-user' }]);
    assert.ok(slowHub.snapshot().pools[GEMINI_25].slow_until > clock(), 'an idle timeout too');
    slowHub.report([{ key: GEMINI_25, success: true }]);
    assert.equal(slowHub.snapshot().pools[GEMINI_25].slow_until, undefined, 'a success clears it');
    // A stream the failover budget cut after its whole share (chat-handler.js, phase 'budget'):
    // slow, but not failed, so it is neither degraded nor parked, even from two callers.
    const failed = slowHub.tracker.records.get(GEMINI_25).failed_attempts;
    for (const caller of ['one-user', 'other-user']) {
      slowHub.report([{ key: GEMINI_25, success: false, kind: FailureKind.TIMEOUT, phase: 'budget', caller }]);
    }
    pools = slowHub.snapshot().pools;
    assert.deepEqual([pools[GEMINI_25].status, pools[GEMINI_25].until, pools[GEMINI_25].slow_until],
      ['available', 0, clock() + 300_000], 'a budget cut only marks the pool slow');
    assert.equal(slowHub.tracker.records.get(GEMINI_25).failed_attempts, failed, 'and is not counted as failed');
    offset = before;
  }
  console.log('ok - slow pools: first-byte and idle timeouts and whole-share budget cuts only, five minutes or until a success, kept after a cooldown');

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

  // Owner lineup (2026-10-29): GEMINI_MODELS and CLOUDFLARE_MODELS = "" (wrangler.toml) leave
  // Gemini and Workers AI without pools here, so nothing checks or tests them.
  {
    const lineupHub = new HealthHub(fakeState(), { ...ENV, GEMINI_MODELS: '', CLOUDFLARE_MODELS: '' }, { now: clock });
    await lineupHub.ready;
    const units = lineupHub.checkUnits(lineupHub.pools()).map(unit => unit.id);
    assert.ok(units.includes('list:groq:env') && units.includes('status:groq'));
    assert.ok(!units.some(id => /gemini|cloudflare/.test(id)), `no Gemini or Workers AI check (${units.join(', ')})`);
    assert.ok(![...lineupHub.pools().keys()].some(provider => provider === 'gemini' || provider === 'cloudflare'));
  }
  console.log('ok - lineup: with Gemini and Workers AI switched off by configuration, no check or test request goes to them');

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

  // 3b. Gemini's free tier allows 20 requests per model per day, so it gets no test requests
  // (its model list is free). Each test request logs one line: pool, outcome, time; no bodies.
  {
    assert.equal(PROBE_DAILY_CAPS.gemini, 0);
    const before = offset;
    const probeHub = new HealthHub(fakeState(), ENV, { now: clock });
    await probeHub.ready;
    probeHub.report([{ key: GROQ_120B, success: false, kind: FailureKind.SERVER },
      { key: GEMINI_25, success: false, kind: FailureKind.SERVER }]);
    assert.equal(probeHub.tracker.records.get(GEMINI_25).status, HealthState.DEGRADED);
    upstream = {
      'https://api.groq.com/openai/v1/chat/completions': () => json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
      'https://generativelanguage.googleapis.com/': () => json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
    };
    calls.length = 0;
    offset += 150_000;
    const lines = [];
    const realInfo = console.info;
    const realLog = console.log;
    console.info = (...args) => lines.push(args);
    console.log = (...args) => lines.push(args);
    try {
      await probeHub.runProbes(probeHub.pools(), clock());
    } finally {
      console.info = realInfo;
      console.log = realLog;
    }
    assert.ok(!calls.some(call => call.url.startsWith('https://generativelanguage.googleapis.com/')), 'no test request to Gemini');
    assert.equal(calls.filter(call => call.url === 'https://api.groq.com/openai/v1/chat/completions').length, 1, 'Groq is still tested');
    assert.equal(probeHub.snapshot().pools[GROQ_120B].status, 'available');
    assert.equal(lines.length, 1, 'one log line per test request');
    const [message, fields] = lines[0];
    assert.equal(message, 'HealthHub probe');
    assert.deepEqual(Object.keys(fields).sort(), ['ms', 'outcome', 'pool']);
    assert.deepEqual([fields.pool, fields.outcome, typeof fields.ms], [GROQ_120B, 'ok', 'number']);
    offset = before;
  }
  console.log('ok - test requests: none for Gemini (cap 0), Groq still tested, one log line {pool, outcome, ms} per test request');

  // 3c. A check that never answers is cut off at its timeout and logged (check, time, status);
  // the other checks of the alarm still run. A non-200 answer or an unreadable body is logged too.
  // Keyed checks are named after the key (list:groq:env), never the key itself.
  {
    const before = offset;
    const hangCalls = [];
    const hangHub = new HealthHub(fakeState(), ENV, { now: clock, fetchTimeoutMs: 20, fetchImpl: (url, { signal } = {}) => {
      hangCalls.push(url);
      if (url === 'https://api.groq.com/openai/v1/models') {
        // Never answers. Node's AbortSignal.timeout does not hold the event loop open, this timer does.
        const open = setTimeout(() => {}, 10_000);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => { clearTimeout(open); reject(signal.reason); }));
      }
      if (url.startsWith('https://generativelanguage.googleapis.com/')) {
        return Promise.resolve(json({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-3.5-flash' },
          { name: 'models/gemini-3.6-flash' }] }));
      }
      if (url === 'https://integrate.api.nvidia.com/v1/models') return Promise.resolve(json({}, 503));
      if (url === 'https://openrouter.ai/api/v1/models') return Promise.resolve(new Response('{"data": [', { status: 200 }));
      return Promise.resolve(json({ data: [] }));
    } });
    await hangHub.ready;
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      offset += 31_000;
      await hangHub.alarm();
      assert.deepEqual(hangCalls, ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        'https://api.groq.com/openai/v1/models', 'https://groqstatus.com/api/v2/summary.json',
        'https://www.cloudflarestatus.com/api/v2/summary.json'], 'the status pages run after the Groq list hung');
      assert.equal(hangHub.seen.get(GEMINI_25), clock(), 'and the Gemini list result is used');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], 'HealthHub check failed');
      assert.equal(warnings[0][1].check, 'list:groq:env');
      assert.equal(warnings[0][1].status, null);
      assert.equal(typeof warnings[0][1].ms, 'number');
      warnings.length = 0;
      offset += 31_000;
      await hangHub.alarm();
      const nvidia = warnings.find(([, fields]) => fields?.check === 'list:nvidia');
      assert.ok(nvidia, 'a 503 on a list is logged');
      assert.equal(nvidia[1].status, 503);
      const openrouter = warnings.find(([, fields]) => fields?.check === 'list:openrouter');
      assert.deepEqual([openrouter?.[1].status, openrouter?.[1].error], [200, 'SyntaxError'], 'so is a 200 whose body cannot be read');
      assert.ok(!JSON.stringify(warnings).includes('-test'), 'no key in the log');
      assert.ok(!JSON.stringify(warnings).includes('"data"'), 'no body in the log');
    } finally {
      console.warn = realWarn;
    }
    offset = before;
  }
  console.log('ok - checks: a hung check times out with a warning naming it, the next check still runs, non-200 and unreadable bodies logged');

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
