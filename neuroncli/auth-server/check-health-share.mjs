// Shared pool health (src/health-share.js) and GET /v1/models/status: offline, fake KV.
//   node check-health-share.mjs
import assert from 'node:assert/strict';
import { publicStatus, resetSharedHealthCache, shareHealth, withHealth } from './src/health-share.js';
import { HealthState, ProviderHealthTracker, FailureKind } from './src/provider-health.js';
import { v1ModelsPayload, v1ModelStatusPayload } from './src/routes/plans.js';
import { catalogEntry, poolKey } from './src/catalog.js';
import { notePoolExhausted, notePoolReserved, poolBudgetState, resetPoolBudgets } from './src/pool-budget.js';

function fakeKv() {
  const store = new Map();
  const writes = [];
  return {
    store, writes,
    get: async (key, options) => {
      const value = store.get(key);
      if (value == null) return null;
      return options?.type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key, value, options) => { store.set(key, value); writes.push({ key, value: JSON.parse(value), options }); },
    delete: async key => { store.delete(key); },
  };
}
// No ExecutionContext: shareHealth returns the task so the test can await it.
const ctx = {};
const now = Date.UTC(2026, 9, 19, 12, 0, 0);

// 1. Public status mapping.
assert.equal(publicStatus(null, now).status, 'available');
assert.equal(publicStatus({ status: HealthState.HEALTHY, circuit_open_until: 0 }, now).status, 'available');
assert.equal(publicStatus({ status: HealthState.DEGRADED, circuit_open_until: 0 }, now).status, 'degraded');
assert.deepEqual(publicStatus({ status: HealthState.RATE_LIMITED, circuit_open_until: now + 30_000 }, now),
  { status: 'busy', until: now + 30_000 });
assert.equal(publicStatus({ status: HealthState.RATE_LIMITED, circuit_open_until: now + 300_000 }, now).status, 'blurred');
assert.equal(publicStatus({ status: HealthState.MODEL_UNAVAILABLE, circuit_open_until: now + 600_000 }, now).status, 'blurred');
assert.equal(publicStatus({ status: HealthState.DOWN, circuit_open_until: now - 1 }, now).status, 'available',
  'an expired cooldown is half-open: the next request decides');
console.log('ok - public status: available, degraded, busy (<=60 s), blurred, half-open after cooldown');

// 2. Publishing: failures write, repeats are throttled, a success clears a shared bad state.
{
  resetSharedHealthCache();
  const kv = fakeKv();
  const env = { SESSIONS_KV: kv };
  const key = 'gemini:gemini-3.6-flash:free';
  const blurred = { status: HealthState.RATE_LIMITED, circuit_open_until: now + 3_600_000 };
  await shareHealth(ctx, env, key, blurred, now);
  assert.equal(kv.writes.length, 1);
  assert.equal(kv.writes[0].key, `health:v1:${key}`);
  assert.equal(kv.writes[0].value.status, 'blurred');
  assert.ok(kv.writes[0].options.expirationTtl >= 3600, 'kept at least until the cooldown ends');
  await shareHealth(ctx, env, key, blurred, now + 2_000);
  assert.equal(kv.writes.length, 1, 'same state within 10 s is not rewritten');

  const healthy = { status: HealthState.HEALTHY, circuit_open_until: 0 };
  await shareHealth(ctx, env, key, healthy, now + 3_000);
  assert.equal(kv.writes.length, 2, 'success overwrites a shared non-available state');
  assert.equal(kv.writes[1].value.status, 'available');
  await shareHealth(ctx, env, key, healthy, now + 4_000);
  assert.equal(kv.writes.length, 2, 'healthy traffic costs no further writes');

  resetSharedHealthCache();
  const quiet = fakeKv();
  await shareHealth(ctx, { SESSIONS_KV: quiet }, key, healthy, now);
  assert.equal(quiet.writes.length, 0, 'a success with nothing shared writes nothing');
  await shareHealth(ctx, {}, key, blurred, now);
  console.log('ok - publish: failure written with TTL, 10 s throttle, success clears shared state, no KV is a no-op');
}

// 3. Merging into a models payload.
{
  resetSharedHealthCache();
  const kv = fakeKv();
  const env = { SESSIONS_KV: kv };
  kv.store.set('health:v1:p:a:free', JSON.stringify({ status: 'blurred', until: now + 600_000, at: now - 1_000 }));
  kv.store.set('health:v1:p:b:free', JSON.stringify({ status: 'blurred', until: now - 1, at: now - 900_000 }));
  kv.store.set('health:v1:p:c:free', JSON.stringify({ status: 'busy', until: now + 20_000, at: now - 1_000 }));
  const payload = { object: 'list', data: [
    { id: 'auto', available: true },
    { id: 'a', available: true }, { id: 'b', available: true }, { id: 'c', available: true },
    { id: 'd', available: true },
  ] };
  const keys = { a: ['p:a:free'], b: ['p:b:free'], c: ['p:c:free', 'p:c2:free'], d: ['p:d:free'] };
  await withHealth(env, payload, model => keys[model.id] || [], { autoId: 'auto', isAutoCandidate: () => true, now });
  const by = Object.fromEntries(payload.data.map(model => [model.id, model]));
  assert.equal(by.a.status, 'blurred');
  assert.equal(by.a.available_again_at, new Date(now + 600_000).toISOString());
  assert.equal(by.b.status, 'available', 'an expired shared cooldown counts as available');
  assert.equal(by.c.status, 'available', 'the best pool wins: c2 has no failures');
  assert.equal(by.d.status, 'available');
  assert.equal(by.auto.status, 'available');

  // Local isolate knowledge that is fresher than KV wins.
  const tracker = new ProviderHealthTracker();
  tracker.recordFailure('p:d:free', { kind: FailureKind.MODEL_UNAVAILABLE });
  const second = { object: 'list', data: [{ id: 'd', available: true }] };
  await withHealth(env, second, () => ['p:d:free'], { tracker });
  assert.equal(second.data[0].status, 'blurred');
  console.log('ok - merge: blurred with available_again_at, expired rows ignored, best pool wins, local state counts');
}

// 4. Through the routes: every model gets a status; /v1/models/status is small and ETagged.
{
  resetSharedHealthCache();
  const kv = fakeKv();
  const env = {
    SESSIONS_KV: kv, GROQ_API_KEY: 'groq-test', GEMINI_API_KEY: 'gemini-test', NVIDIA_API_KEY: 'nvidia-test',
    NVIDIA_HOSTED: 'true', OPENROUTER_API_KEY: 'or-test', OPENROUTER_HOSTED: 'true', ALLOW_UNKNOWN_COUNTRY: 'true',
    OPENROUTER_MODELS: 'cohere/north-mini-code:free,minimax/minimax-m3.1-flash:free',
  };
  const c = { env, req: { raw: new Request('https://zero-x.live/v1/models') } };
  const entry = catalogEntry('gemini/gemini-3.6-flash');
  assert.ok(entry, 'gemini-3.6-flash is in the catalog');
  const freePool = entry.pools.find(pool => pool.tier === 'free');
  kv.store.set(`health:v1:${poolKey(entry, freePool)}`,
    JSON.stringify({ status: 'blurred', until: Date.now() + 600_000, at: Date.now() }));

  const models = await v1ModelsPayload(c, {});
  const byId = Object.fromEntries(models.data.map(model => [model.id, model]));
  assert.equal(byId['gemini/gemini-3.6-flash'].status, 'blurred');
  assert.ok(byId['gemini/gemini-3.6-flash'].available_again_at);
  assert.equal(byId['groq/openai/gpt-oss-120b'].status, 'available');
  assert.equal(byId['gemini/gemini-3.6-flash'].capabilities.vision, true);
  assert.equal(byId['groq/openai/gpt-oss-120b'].capabilities.vision, false);
  assert.equal(byId['groq/openai/gpt-oss-120b'].capabilities.reasoning, true);
  assert.equal(byId['groq/openai/gpt-oss-120b'].context_length, 131072);
  assert.ok(byId['nvidia/stepfun-ai/step-5-preview'], 'NVIDIA models are offered with NVIDIA_HOSTED=true');
  assert.ok(!byId['nvidia/nvidia/nemotron-3-super-120b-a12b'], 'the deprecated Nemotron 3 Super is gone');
  assert.ok(byId['minimax/minimax-m3.1-flash:free'] && byId['cohere/north-mini-code:free'], 'hosted OpenRouter models');
  const smallest = Math.min(...models.data.filter(model => model.id !== 'auto' && model.available
    && catalogEntry(model.id)?.auto_rank != null).map(model => model.context_window));
  assert.equal(byId.auto.context_window, smallest, 'auto advertises the smallest candidate window');
  assert.equal(byId.auto.status, 'available');

  const first = await v1ModelStatusPayload(c, {});
  assert.match(first.etag, /^W\/"[0-9a-f]{24}"$/);
  assert.equal(first.body.poll_interval_seconds, 30);
  const row = first.body.data.find(model => model.id === 'gemini/gemini-3.6-flash');
  assert.deepEqual(Object.keys(row).sort(), ['available', 'available_again_at', 'id', 'status', 'unavailable_reason']);
  const again = await v1ModelStatusPayload(c, {});
  assert.equal(again.etag, first.etag, 'unchanged state, same ETag');
  kv.store.delete(`health:v1:${poolKey(entry, freePool)}`);
  resetSharedHealthCache();
  const changed = await v1ModelStatusPayload(c, {});
  assert.notEqual(changed.etag, first.etag, 'a recovered model changes the ETag');
  console.log('ok - routes: status on every model, vision/reasoning/context_length, NVIDIA + OpenRouter hosted, auto window, ETag');
}

// 5. Spent pool budgets (E2E finding 2026-10-21: a model stayed "available" while its pool refused
//    every request): busy until the next minute, blurred until a daily budget resets, judged on
//    the pools the caller can use, cleared by the next successful reservation.
{
  resetSharedHealthCache();
  resetPoolBudgets();
  const env = { GROQ_API_KEY: 'groq-test', GROQ_PAID_API_KEY: 'groq-paid-test', GEMINI_API_KEY: 'gemini-test', ALLOW_UNKNOWN_COUNTRY: 'true' };
  const c = { env, req: { raw: new Request('https://zero-x.live/v1/models') } };
  const pool = id => poolKey(catalogEntry(id), catalogEntry(id).pools[0]);
  const at = Date.now();
  notePoolExhausted(pool('groq/openai/gpt-oss-120b'), { budget: 'rpm|tpm', retryAfterSeconds: 40, now: at });
  notePoolExhausted(pool('groq/qwen/qwen3.8-27b'), { budget: 'rpd|tpd', retryAfterSeconds: 3600, now: at });
  notePoolExhausted(pool('groq/openai/gpt-oss-20b'), { budget: 'rpm|tpm', retryAfterSeconds: 5, now: at - 10_000 });
  const byId = Object.fromEntries((await v1ModelsPayload(c, {})).data.map(model => [model.id, model]));
  const gptOss = byId['groq/openai/gpt-oss-120b'];
  assert.deepEqual(gptOss.tiers, ['free', 'paid'], 'the paid pool is configured');
  assert.equal(gptOss.status, 'busy', 'a free caller cannot use the paid pool, so the spent free budget decides');
  assert.equal(gptOss.available_again_at, new Date(at + 40_000).toISOString());
  assert.equal(gptOss.checked_at, new Date(at).toISOString());
  assert.equal(byId['groq/qwen/qwen3.8-27b'].status, 'blurred');
  assert.equal(byId['groq/qwen/qwen3.8-27b'].available_again_at, new Date(at + 3_600_000).toISOString());
  assert.equal(byId['groq/openai/gpt-oss-20b'].status, 'available', 'a budget that has reset no longer counts');
  const status = await v1ModelStatusPayload(c, {});
  assert.deepEqual(status.body.data.find(model => model.id === 'groq/openai/gpt-oss-120b'), { id: 'groq/openai/gpt-oss-120b',
    available: true, unavailable_reason: null, status: 'busy', available_again_at: new Date(at + 40_000).toISOString() });

  // A caller that can also use the paid pool still has a way through it.
  const both = { object: 'list', data: [{ id: 'gpt-oss', available: true }] };
  await withHealth(env, both, () => [pool('groq/openai/gpt-oss-120b'), 'groq:openai/gpt-oss-120b:paid'], { budgetState: poolBudgetState });
  assert.equal(both.data[0].status, 'available');

  notePoolReserved(pool('groq/openai/gpt-oss-120b'));
  resetSharedHealthCache();
  const cleared = await v1ModelStatusPayload(c, {});
  assert.equal(cleared.body.data.find(model => model.id === 'groq/openai/gpt-oss-120b').status, 'available');
  assert.notEqual(cleared.etag, status.etag, 'the ETag follows the budget state');
  resetPoolBudgets();
  console.log('ok - spent pool budgets: busy (per minute) or blurred (daily) with available_again_at, usable tiers only, cleared on reserve');
}

console.log('PASS: shared health and /v1/models/status');
