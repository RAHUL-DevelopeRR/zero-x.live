// Offline verification of the compliance-aware catalog, plan-aware routing, pool budgets,
// reservation/settlement and resilient streaming (WP-B2). No network: every upstream and
// database call goes through the fake fetch below.
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createChatHandler } from './src/chat-handler.js';
import { RoutingEngine, fitMaxTokens } from './src/router.js';
import { FailureKind, HealthState, ProviderHealthTracker } from './src/provider-health.js';
import {
  BUILTIN_PLANS, CATALOG, EEA_COUNTRIES, MODEL_ALIASES, POOL_LIMITS, callerCountry, catalogEntry, catalogWarnings,
  expandCountries, listModelsForCaller, loadPlanPolicies, planPolicy, poolKey, resolveModelId,
} from './src/catalog.js';
import { billableUsage, costMicrousd, estimatePromptTokens, priceFromCost } from './src/pricing.js';
import { errorBody, errorResponse } from './src/errors.js';
import { RESERVED_OUTPUT_TOKENS, reservationArgs, reservedTokens, reserveError, settlementArgs } from './src/capacity.js';
import { exhaustedBudget, poolBudgetState, resetPoolBudgets } from './src/pool-budget.js';
import { buildUpstreamPayload, classifyUpstreamFailure, listModelsForSession, retryAfterSeconds } from './src/providers.js';
import { resetHubClientCache } from './src/health-hub-client.js';
import { planPolicyRows } from './contract-rows.mjs';

// Plan policy rows exactly as WP-B1's zerox_plan_policies_v2 returns them (in-memory PGlite
// with every migration applied), so the gateway is tested against the real column names.
const B1_POLICY_ROWS = await planPolicyRows();
const policyRow = (plan, overrides = {}) => ({ ...B1_POLICY_ROWS.find(row => row.plan === plan), ...overrides });

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(name);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

// ── Fake network ──
const originalFetch = globalThis.fetch;
const calls = [];
let handlers = {};
function targetOf(url) {
  if (url.includes('/rest/v1/rpc/')) return `rpc:${url.split('/').at(-1)}`;
  for (const [name, prefix] of [['groq', 'https://api.groq.com/'], ['gemini', 'https://generativelanguage.googleapis.com/'],
    ['openrouter', 'https://openrouter.ai/'], ['nvidia', 'https://integrate.api.nvidia.com/'], ['cloudflare', 'https://api.cloudflare.com/']]) {
    if (url.startsWith(prefix)) return name;
  }
  return 'unknown';
}
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const target = targetOf(url);
  const body = options.body ? JSON.parse(options.body) : null;
  const call = { target, url, body, headers: options.headers || {}, signal: options.signal };
  calls.push(call);
  const handler = handlers[target];
  if (!handler) throw new Error(`Unexpected fetch to ${target}: ${url}`);
  return handler(call);
};
const upstreamCalls = () => calls.filter(call => !call.target.startsWith('rpc:'));
const rpcCalls = name => calls.filter(call => call.target === `rpc:${name}`);
const reset = (next = {}) => { calls.length = 0; handlers = { ...next }; };

const encoder = new TextEncoder();
function sse(events, { hangAfter = false } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
      if (!hangAfter) controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const hangingSse = () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
const untilAborted = call => new Promise((_, reject) => {
  call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
});
const completion = (message, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) =>
  Response.json({ id: 'up-1', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage });
const chunk = (delta, finish = null, extra = {}) => ({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const parseSse = text => text.split('\n\n').filter(Boolean).map(event => event.slice(6)).map(data => data === '[DONE]' ? data : JSON.parse(data));

// ── Gateway under test ──
const KEYS = { GROQ_API_KEY: 'groq-free-key', GEMINI_API_KEY: 'gemini-free-key', GROQ_PAID_API_KEY: 'groq-paid-key', GEMINI_PAID_API_KEY: 'gemini-paid-key' };
const FAST = { UPSTREAM_TTFB_TIMEOUT_MS: '150', UPSTREAM_IDLE_TIMEOUT_MS: '150' };
const DB = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const ACCOUNT = '12345678-1234-4234-8234-123456789abc';
const DEV_PLANS = { free: { name: 'Free', daily_tokens: 256000, daily_requests: 2000, price_usd: 0 } };
const today = () => new Date().toISOString().slice(0, 10);

function gateway({ tracker = new ProviderHealthTracker() } = {}) {
  const store = new Map();
  const writes = [];
  const app = new Hono();
  app.post('/v1/chat/completions', createChatHandler({
    validateSession: async c => {
      const token = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
      const raw = store.get(token);
      return raw ? { token, session: JSON.parse(raw) } : null;
    },
    setSession: async (c, token, value) => { writes.push(token); store.set(token, JSON.stringify(value)); },
    getSession: async (c, token) => JSON.parse(store.get(token) || 'null'),
    planLimits: async () => DEV_PLANS,
    router: new RoutingEngine(tracker),
    healthTracker: tracker,
  }));
  const addSession = (token, session) => store.set(token, JSON.stringify({ created: Date.now(), plan: 'free',
    requests: 0, tokens_used: 0, usage_day: today(), ...session }));
  const session = token => JSON.parse(store.get(token));
  const call = (env, body, { token = 'ses_anon', country, signal, ctx } = {}) => {
    const request = new Request('https://zero-x.live/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal,
    });
    if (country) Object.defineProperty(request, 'cf', { value: { country } });
    return app.fetch(request, env, ctx);
  };
  return { app, tracker, store, writes, addSession, session, call };
}

const messages = [{ role: 'user', content: 'Read a.js and b.js' }];
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

async function captureLogs(fn) {
  const logs = { warn: [], error: [] };
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => logs.warn.push(args);
  console.error = (...args) => logs.error.push(args);
  try {
    return { result: await fn(), logs };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

async function expectError(response, status, code) {
  assert.equal(response.status, status, `expected HTTP ${status} for ${code}`);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(body.error.param, null);
  assert.match(body.error.request_id, /^req_[a-f0-9]{32}$/);
  assert.equal(response.headers.get('x-request-id'), body.error.request_id);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(typeof body.error.type, 'string');
  return body.error;
}

try {
  // ── Pricing, errors ──
  await test('pricing applies the 1.25x markup in micro-USD per million tokens', () => {
    const flash = catalogEntry('gemini/gemini-2.5-flash').pools[1].price;
    assert.deepEqual([flash.input_microusd_per_mtok, flash.output_microusd_per_mtok], [375000, 3125000]);
    const groq = catalogEntry('groq/openai/gpt-oss-120b').pools[1].price;
    assert.deepEqual([groq.input_microusd_per_mtok, groq.output_microusd_per_mtok], [187500, 750000]);
    const pro = catalogEntry('gemini/gemini-2.5-pro').pools[0].price;
    assert.deepEqual([pro.input_microusd_per_mtok, pro.output_microusd_per_mtok], [1562500, 12500000]);
    assert.deepEqual([pro.long_context.input_microusd_per_mtok, pro.long_context.output_microusd_per_mtok], [3125000, 18750000]);
    const workers = catalogEntry('@cf/openai/gpt-oss-120b').pools[1].price;
    assert.deepEqual([workers.input_microusd_per_mtok, workers.output_microusd_per_mtok], [437500, 937500]);
    assert.equal(costMicrousd(flash, 1000, 500), 1938);
    assert.equal(costMicrousd(groq, 1000, 500), 563);
    assert.equal(costMicrousd(pro, 300000, 0), 937500, 'prompts above 200K use the long-context rate');
    assert.equal(costMicrousd(null, 1000, 1000), 0);
    assert.equal(priceFromCost(0.293, 2.253).input_microusd_per_mtok, 366250);
  });

  await test('billable usage bills hidden reasoning tokens from total_tokens', () => {
    assert.deepEqual(billableUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 150 }),
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated: false });
    assert.equal(billableUsage({ total_tokens: 13 }, { prompt_tokens: 40 }).total_tokens, 13);
    assert.deepEqual(billableUsage(null, { prompt_tokens: 7, completion_tokens: 3 }),
      { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, estimated: true });
    const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
    const toolBytes = new TextEncoder().encode(JSON.stringify(tools)).byteLength;
    assert.equal(estimatePromptTokens(messages, tools), Math.ceil(bytes / 3.5) + Math.ceil(toolBytes / 3.5));
  });

  await test('errors are OpenAI-shaped with upgrade_url, retry and reset hints', async () => {
    const body = errorBody('insufficient_quota', { requestId: 'req_x', resetsAt: '2026-10-17T00:00:00Z' });
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'param', 'request_id', 'resets_at', 'type', 'upgrade_url']);
    assert.equal(body.error.type, 'insufficient_quota');
    assert.equal(body.error.upgrade_url, 'https://zero-x.live/pricing');
    assert.equal(errorBody('upgrade_required', { env: { PRICING_URL: 'https://example.test/plans' } }).error.upgrade_url, 'https://example.test/plans');
    assert.equal(errorBody('upgrade_required', { env: { PRICING_URL: 'javascript:alert(1)' } }).error.upgrade_url, 'https://zero-x.live/pricing');
    assert.equal(errorBody('rate_limited').error.upgrade_url, undefined);
    for (const [code, status, type] of [['invalid_request', 400, 'invalid_request_error'], ['context_length_exceeded', 400, 'invalid_request_error'],
      ['invalid_session', 401, 'authentication_error'], ['insufficient_credits', 402, 'insufficient_quota'], ['upgrade_required', 403, 'permission_error'],
      ['region_unavailable', 403, 'permission_error'], ['account_suspended', 403, 'permission_error'], ['insufficient_quota', 429, 'insufficient_quota'],
      ['rate_limited', 429, 'rate_limit_error'], ['capacity_exhausted', 503, 'server_error'], ['upstream_error', 502, 'server_error'],
      ['upstream_timeout', 504, 'server_error']]) {
      const response = errorResponse(code, { requestId: 'req_y', retryAfterSeconds: 2.2 });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('x-request-id'), 'req_y');
      assert.equal(response.headers.get('retry-after'), '3');
      const error = (await response.json()).error;
      assert.equal(error.type, type);
      assert.equal(error.retry_after_seconds, 3);
    }
    assert.match(errorBody('invalid_session').error.message, /neuron auth login/);
  });

  // ── Catalog ──
  await test('explicit alias table, openai/ transport prefix and no fuzzy matching', () => {
    assert.equal(resolveModelId('openai/gemini/gemini-2.5-flash'), 'gemini/gemini-2.5-flash');
    assert.equal(resolveModelId('gemini-2.5-flash'), 'gemini/gemini-2.5-flash');
    assert.equal(resolveModelId('openai/gpt-oss-120b'), 'groq/openai/gpt-oss-120b');
    assert.equal(resolveModelId('openai/openai/gpt-oss-20b'), 'groq/openai/gpt-oss-20b');
    assert.equal(resolveModelId('Groq/OpenAI/GPT-OSS-120B'), 'groq/openai/gpt-oss-120b');
    assert.equal(resolveModelId('default'), 'auto');
    assert.equal(resolveModelId('openai/auto'), 'auto');
    for (const value of ['openai', 'groq', 'gpt-oss', 'gemini', 'openai/', '', 'x'.repeat(300), null]) {
      assert.equal(resolveModelId(value), null, `${value} must not fuzzy-match`);
    }
    for (const [alias, id] of Object.entries(MODEL_ALIASES)) assert.ok(id === 'auto' || catalogEntry(id), alias);
    assert.ok(!CATALOG.some(entry => entry.id === 'nvidia/deepseek-ai/deepseek-coder-6.7b-instruct'), 'dead upstream removed');
    assert.ok(!catalogEntry('gemini/gemini-2.5-pro').pools.some(pool => pool.tier === 'free'), '2.5 Pro has no free pool');
  });

  await test('EEA expands to the 30 member countries (plus EU territories) for free Gemini pools', () => {
    assert.equal(EEA_COUNTRIES.length, 30);
    const blocked = expandCountries(['EEA', 'GB', 'CH']);
    for (const code of [...EEA_COUNTRIES, 'GB', 'CH', 'RE', 'AX']) assert.ok(blocked.has(code), code);
    for (const code of ['US', 'IN', 'TR', 'UA']) assert.ok(!blocked.has(code), code);
    const request = new Request('https://zero-x.live/');
    Object.defineProperty(request, 'cf', { value: { country: 'de' } });
    assert.equal(callerCountry(request), 'DE');
    const spoofed = new Request('https://zero-x.live/', { headers: { 'cf-ipcountry': 'US' } });
    assert.equal(callerCountry(spoofed), null, 'CF-IPCountry is ignored unless the origin is trusted');
    assert.equal(callerCountry(spoofed, { TRUST_CF_IPCOUNTRY: 'true' }), 'US');
  });

  await test('catalog availability per plan and country with pricing and reasons', () => {
    const list = listModelsForCaller(KEYS, { plan: 'free', country: 'US' });
    assert.equal(list.object, 'list');
    const byId = Object.fromEntries(list.data.map(model => [model.id, model]));
    assert.equal(list.data[0].id, 'auto');
    assert.equal(byId.auto.available, true);
    assert.deepEqual(byId.auto.capabilities, { tools: true, streaming: true, vision: false, reasoning: true });
    const flash = byId['gemini/gemini-2.5-flash'];
    assert.deepEqual(Object.keys(flash).sort(), ['available', 'capabilities', 'context_length', 'context_window', 'created',
      'display_name', 'id', 'max_output_tokens', 'object', 'owned_by', 'pricing', 'reasoning_efforts', 'tiers',
      'unavailable_reason']);
    assert.deepEqual(flash.capabilities, { tools: true, streaming: true, vision: true, reasoning: true });
    assert.equal(flash.context_length, flash.context_window);
    assert.equal(flash.available, true);
    assert.deepEqual(flash.tiers, ['free', 'paid']);
    assert.deepEqual(flash.pricing, { input_per_mtok_usd: 0.375, output_per_mtok_usd: 3.125 });
    assert.equal(flash.context_window, 1048576);
    assert.equal(byId['gemini/gemini-2.5-pro'].available, false);
    assert.equal(byId['gemini/gemini-2.5-pro'].unavailable_reason, 'upgrade_required');
    assert.equal(byId['groq/qwen/qwen3.8-27b'].pricing, null);
    assert.equal(byId['@cf/meta/llama-3.3-70b-instruct-fp8-fast'].unavailable_reason, 'not_configured');
    assert.ok(!list.data.some(model => model.owned_by === 'nvidia' || model.owned_by === 'openrouter'), 'non-hosted providers are hidden');
    assert.ok(!byId['@cf/openai/gpt-oss-120b'], 'unprobed Workers AI model is off by default');

    const freeDe = Object.fromEntries(listModelsForCaller(KEYS, { plan: 'free', country: 'DE' }).data.map(model => [model.id, model]));
    assert.equal(freeDe['gemini/gemini-2.5-flash'].unavailable_reason, 'upgrade_required', 'paid capacity unlocks it');
    assert.equal(freeDe['gemini/gemini-3.5-flash'].unavailable_reason, 'region_unavailable');
    assert.equal(freeDe['groq/openai/gpt-oss-120b'].available, true);
    const noPaid = { GEMINI_API_KEY: 'g' };
    assert.equal(listModelsForCaller(noPaid, { country: 'FR' }).data.find(model => model.id === 'gemini/gemini-2.5-flash').unavailable_reason, 'region_unavailable');
    assert.equal(listModelsForCaller(noPaid, { country: 'FR' }).data[0].unavailable_reason, 'region_unavailable');
    const proDe = Object.fromEntries(listModelsForCaller(KEYS, { plan: 'pro', country: 'DE' }).data.map(model => [model.id, model]));
    assert.equal(proDe['gemini/gemini-2.5-flash'].available, true);
    assert.equal(proDe['gemini/gemini-2.5-pro'].available, true);
    assert.equal(proDe['gemini/gemini-3.5-flash'].unavailable_reason, 'region_unavailable');
    assert.equal(listModelsForCaller({}, {}).data[0].unavailable_reason, 'not_configured');

    const hosted = listModelsForCaller({ NVIDIA_API_KEY: 'n', NVIDIA_HOSTED: 'true', OPENROUTER_API_KEY: 'o', OPENROUTER_HOSTED: 'true' }).data;
    assert.ok(hosted.some(model => model.id === 'nvidia/stepfun-ai/step-5-preview' && model.available));
    assert.ok(hosted.some(model => model.id === 'cohere/north-mini-code:free' && model.available));
    const workers = Object.fromEntries(listModelsForCaller({ AI: {}, CLOUDFLARE_PAID: 'true' }, { plan: 'pro' }).data.map(model => [model.id, model]));
    assert.deepEqual(workers['@cf/meta/llama-3.3-70b-instruct-fp8-fast'].tiers, ['free', 'paid']);
    assert.deepEqual(listModelsForCaller({ AI: {} }).data.find(model => model.id.startsWith('@cf/meta')).tiers, ['free']);
  });

  await test('*_MODELS disables entries, enables known opt-ins and never adds unverified ids', () => {
    const env = { ...KEYS, AI: {}, GROQ_MODELS: 'openai/gpt-oss-120b, llama-3.3-70b-versatile', CLOUDFLARE_MODELS: '@cf/openai/gpt-oss-120b,@cf/meta/llama-3.1-8b-instruct' };
    const ids = listModelsForCaller(env).data.map(model => model.id);
    assert.ok(ids.includes('groq/openai/gpt-oss-120b'));
    assert.ok(!ids.includes('groq/openai/gpt-oss-20b'));
    assert.ok(!ids.some(id => id.includes('llama-3.3-70b-versatile') || id.includes('llama-3.1-8b')));
    assert.ok(ids.includes('@cf/openai/gpt-oss-120b'));
    assert.ok(!ids.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'));
    assert.deepEqual(catalogWarnings(env), [
      { variable: 'GROQ_MODELS', ignored_models: ['llama-3.3-70b-versatile'] },
      { variable: 'CLOUDFLARE_MODELS', ignored_models: ['@cf/meta/llama-3.1-8b-instruct'] },
    ]);
  });

  await test('plan policies load from zerox_plan_policies_v2 with a 60 s cache and contract fallback', async () => {
    assert.equal(await loadPlanPolicies({}), BUILTIN_PLANS);
    assert.deepEqual(BUILTIN_PLANS.free.tiers, ['free']);
    assert.deepEqual(planPolicy({}, 'ultrawork').tiers, ['free', 'paid']);
    assert.equal(planPolicy({}, 'enterprise').id, 'free');
    assert.equal(BUILTIN_PLANS.max.daily_tokens, 50000000);
    assert.deepEqual(Object.keys(B1_POLICY_ROWS[0]).filter(name => ['allowed_tiers', 'rpm_limit', 'concurrency_limit'].includes(name)).sort(),
      ['allowed_tiers', 'concurrency_limit', 'rpm_limit'], 'B1 column names');
    // The seeded rows map onto exactly the contract section 1 plans, with no fallback.
    const seeded = { ...DB };
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args);
    try {
      reset({ 'rpc:zerox_plan_policies_v2': () => Response.json(B1_POLICY_ROWS) });
      const fromSeed = await loadPlanPolicies(seeded);
      for (const id of ['free', 'pro', 'max', 'ultrawork']) assert.deepEqual({ ...fromSeed[id] }, { ...BUILTIN_PLANS[id] }, id);
      assert.deepEqual(logged, [], 'complete B1 rows report no problems');
      // A row without any recognised tiers column is reported loudly instead of routing silently.
      reset({ 'rpc:zerox_plan_policies_v2': () => Response.json([policyRow('free'), { plan: 'pro', name: 'Pro' }]) });
      await loadPlanPolicies({ ...DB });
      assert.ok(logged.some(([message, details]) => /incomplete/.test(message) && details.plan === 'pro' &&
        details.problems.includes('missing allowed_tiers')), 'missing columns are logged');
    } finally {
      console.error = originalError;
    }
    const env = { ...DB };
    reset({ 'rpc:zerox_plan_policies_v2': () => Response.json([
      policyRow('free', { daily_requests: 50, allowed_tiers: '{free}' }),
      policyRow('pro', { allowed_tiers: ['free'], daily_requests: 900, rpm_limit: 99, concurrency_limit: 9 }),
      policyRow('max', { allowed_tiers: ['free', 'bogus'] }),
      { ...policyRow('pro'), plan: 'team', name: 'Team', allowed_tiers: ['free', 'paid'] },
    ]) });
    const policies = await loadPlanPolicies(env);
    await loadPlanPolicies(env);
    assert.equal(rpcCalls('zerox_plan_policies_v2').length, 1, 'cached for 60 s');
    assert.deepEqual(policies.free.tiers, ['free']);
    assert.equal(policies.free.daily_requests, 50);
    assert.deepEqual(policies.pro.tiers, ['free'], 'allowed_tiers edited in the database');
    assert.deepEqual([policies.pro.rpm, policies.pro.concurrency], [99, 9], 'rpm_limit and concurrency_limit are read');
    assert.deepEqual(policies.max.tiers, ['free', 'paid'], 'invalid tiers fall back to the contract');
    assert.deepEqual(policies.team.tiers, ['free', 'paid'], 'a custom database plan keeps its paid tier');
    assert.deepEqual(planPolicy(env, 'pro').tiers, ['free'], 'sync lookup uses the fresh cache');
    assert.deepEqual(planPolicy(env, 'team').tiers, ['free', 'paid']);
    const broken = { ...DB };
    reset({ 'rpc:zerox_plan_policies_v2': () => new Response('down', { status: 500 }) });
    assert.equal(await loadPlanPolicies(broken), BUILTIN_PLANS);
  });

  // ── Router ──
  const ids = route => route.candidates.map(candidate => `${candidate.entry.id}#${candidate.pool.tier}`);
  await test('auto ranks by quality, free pools before paid, skipping geo-blocked free pools', () => {
    const router = new RoutingEngine(new ProviderHealthTracker());
    const base = { env: KEYS, requestedModel: 'auto', needsTools: true, promptTokens: 500, maxTokens: 2000 };
    assert.deepEqual(ids(router.route({ ...base, tiers: ['free'], country: 'US' })), ['gemini/gemini-2.5-flash#free',
      'gemini/gemini-3.5-flash#free', 'gemini/gemini-3.6-flash#free',
      'groq/openai/gpt-oss-120b#free', 'groq/qwen/qwen3.8-27b#free', 'groq/openai/gpt-oss-20b#free']);
    assert.deepEqual(ids(router.route({ ...base, tiers: ['free', 'paid'], country: 'US' })).slice(-3),
      ['gemini/gemini-2.5-flash#paid', 'gemini/gemini-3.6-flash#paid', 'groq/openai/gpt-oss-120b#paid']);
    assert.ok(!ids(router.route({ ...base, tiers: ['free', 'paid'] })).some(id => id.startsWith('gemini/gemini-2.5-pro')), 'auto never picks 2.5 Pro');
    assert.equal(ids(router.route({ ...base, tiers: ['free'], country: 'DE' }))[0], 'groq/openai/gpt-oss-120b#free');
    assert.equal(ids(router.route({ ...base, tiers: ['free', 'paid'], country: 'DE' }))[0], 'groq/openai/gpt-oss-120b#free');
    assert.ok(ids(router.route({ ...base, tiers: ['free', 'paid'], country: 'DE' })).includes('gemini/gemini-2.5-flash#paid'));
  });

  await test('auto selects by fit: Groq TPM, context windows and max_tokens clamping', () => {
    const groq = catalogEntry('groq/openai/gpt-oss-120b');
    assert.equal(fitMaxTokens(groq, groq.pools[0], 3000, 8192), 5000, 'clamped to the 8K TPM budget');
    assert.equal(fitMaxTokens(groq, groq.pools[0], 7500, 4096), 0, 'less than 1K output tokens left');
    assert.equal(fitMaxTokens(groq, groq.pools[0], 9000, 512), 0, 'prompt above TPM');
    assert.equal(fitMaxTokens(groq, groq.pools[1], 9000, 4096), 4096, 'paid pool has no 8K TPM cap');
    const router = new RoutingEngine(new ProviderHealthTracker());
    const env = { ...KEYS, AI: {} };
    const base = { env, requestedModel: 'auto', needsTools: true, maxTokens: 4096, tiers: ['free'], country: 'DE' };
    assert.deepEqual(ids(router.route({ ...base, promptTokens: 12000 })), ['@cf/meta/llama-3.3-70b-instruct-fp8-fast#free']);
    assert.equal(router.route({ ...base, promptTokens: 12000 }).candidates[0].maxTokens, 4096);
    // Groq free (the only free pool in DE without Workers AI) would take the model but not 12K
    // within its 8K TPM: the request is too large for free capacity; paid capacity would take it.
    const groqBound = router.route({ ...base, env: KEYS, promptTokens: 12000 });
    assert.equal(groqBound.error, 'context_length_exceeded');
    assert.match(groqBound.message, /free per-minute token budget \(8,000 tokens.*or upgrade for paid capacity/);
    assert.equal(groqBound.upgrade, true);
    const freeOnly = router.route({ ...base, env: { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'g' }, promptTokens: 12000 });
    assert.deepEqual([freeOnly.error, freeOnly.upgrade], ['context_length_exceeded', false], 'no paid pool configured');
    assert.doesNotMatch(freeOnly.message, /upgrade/);
    assert.equal(router.route({ ...base, env: { GEMINI_API_KEY: 'g' }, promptTokens: 12000 }).error, 'region_unavailable');
    assert.equal(router.route({ ...base, promptTokens: 2000000 }).error, 'context_length_exceeded');
    assert.equal(router.route({ ...base, country: 'US', promptTokens: 2000000 }).error, 'context_length_exceeded');
    assert.equal(ids(router.route({ ...base, country: 'US', promptTokens: 90000 }))[0], 'gemini/gemini-2.5-flash#free');
    // The free Gemini budget (120K TPM, below the observed upstream limit) cannot take a 200K
    // prompt; the paid pools (no per-minute token cap) can. Free callers are told the request is
    // too large for the free budget (with an upgrade link), not that the model is outside their plan.
    const overBudget = router.route({ ...base, country: 'US', promptTokens: 200000 });
    assert.equal(overBudget.error, 'context_length_exceeded');
    assert.match(overBudget.message, /free per-minute token budget \(120,000 tokens/);
    assert.equal(overBudget.upgrade, true);
    assert.equal(ids(router.route({ ...base, country: 'US', promptTokens: 110000 }))[0], 'gemini/gemini-2.5-flash#free');
    assert.equal(ids(router.route({ ...base, country: 'US', promptTokens: 200000, tiers: ['free', 'paid'] }))[0], 'gemini/gemini-2.5-flash#paid');
    assert.equal(router.route({ ...base, env: {}, promptTokens: 10 }).error, 'service_unavailable');
  });

  await test('explicit models fail over only between their own pools', () => {
    const router = new RoutingEngine(new ProviderHealthTracker());
    const base = { env: KEYS, needsTools: true, promptTokens: 500, maxTokens: 2000 };
    assert.deepEqual(ids(router.route({ ...base, requestedModel: 'openai/gpt-oss-120b', tiers: ['free', 'paid'] })),
      ['groq/openai/gpt-oss-120b#free', 'groq/openai/gpt-oss-120b#paid']);
    assert.deepEqual(ids(router.route({ ...base, requestedModel: 'groq/openai/gpt-oss-120b', tiers: ['free'] })), ['groq/openai/gpt-oss-120b#free']);
    assert.equal(router.route({ ...base, requestedModel: 'gemini/gemini-2.5-pro', tiers: ['free'] }).error, 'upgrade_required');
    assert.equal(router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash', tiers: ['free'], country: 'IT' }).error, 'upgrade_required');
    assert.match(router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash', tiers: ['free'], country: 'IT' }).message, /region/);
    assert.equal(router.route({ ...base, env: { GEMINI_API_KEY: 'g' }, requestedModel: 'gemini/gemini-2.5-flash', tiers: ['free'], country: 'IT' }).error, 'region_unavailable');
    assert.deepEqual(ids(router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash', tiers: ['free', 'paid'], country: 'IT' })), ['gemini/gemini-2.5-flash#paid']);
    assert.equal(router.route({ ...base, requestedModel: 'openai', tiers: ['free'] }).error, 'model_not_found');
    assert.equal(router.route({ ...base, requestedModel: 'nvidia/openai/gpt-oss-20b', tiers: ['free'], env: { NVIDIA_API_KEY: 'n' } }).error, 'model_not_found');
    assert.equal(router.route({ ...base, requestedModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', tiers: ['free'] }).error, 'model_not_found');
  });

  await test('health is keyed per pool: one dead model never trips its provider', () => {
    const tracker = new ProviderHealthTracker();
    const router = new RoutingEngine(tracker);
    const flash = catalogEntry('gemini/gemini-2.5-flash');
    tracker.recordFailure(poolKey(flash, flash.pools[0]), { kind: FailureKind.MODEL_UNAVAILABLE });
    const base = { env: KEYS, requestedModel: 'auto', needsTools: true, promptTokens: 500, maxTokens: 2000, tiers: ['free', 'paid'], country: 'US' };
    const route = router.route(base);
    assert.equal(ids(route)[0], 'gemini/gemini-3.5-flash#free');
    assert.ok(ids(route).includes('gemini/gemini-2.5-flash#paid'), 'the paid key is a separate pool');
    assert.ok(tracker.cooldownRemainingMs(poolKey(flash, flash.pools[0])) > 590000, '404 parks the model for 10 minutes');
    const groq = catalogEntry('groq/openai/gpt-oss-120b');
    tracker.recordFailure(poolKey(groq, groq.pools[0]), { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 42 });
    tracker.recordFailure(poolKey(groq, groq.pools[1]), { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 9 });
    const blocked = router.route({ ...base, requestedModel: 'groq/openai/gpt-oss-120b' });
    assert.equal(blocked.error, 'capacity_exhausted');
    assert.equal(blocked.retryAfterSeconds, 9);
    for (let i = 0; i < 3; i++) tracker.recordFailure(poolKey(flash, flash.pools[1]), { kind: FailureKind.SERVER });
    assert.equal(tracker.getRecord(poolKey(flash, flash.pools[1])).status, HealthState.DOWN);
    tracker.recordFailure(poolKey(flash, flash.pools[0]), { kind: FailureKind.CONTEXT });
    tracker.recordFailure('x', { kind: FailureKind.ABORTED });
    assert.equal(tracker.getRecord('x').failed_attempts, 0);
    const down = router.route({ ...base, requestedModel: 'gemini/gemini-2.5-flash' });
    assert.equal(down.error, 'upstream_error');
    assert.ok(down.retryAfterSeconds >= 1);
  });

  await test('upstream failure classification and retry hints', () => {
    assert.equal(classifyUpstreamFailure(413, '{"error":{"code":"rate_limit_exceeded","message":"Request too large"}}').kind, FailureKind.CONTEXT);
    assert.equal(classifyUpstreamFailure(400, 'This model\'s maximum context length is 131072 tokens').kind, FailureKind.CONTEXT);
    // Free text never selects a pool-wide state: upstream messages can quote client input
    // (review B2 P2). The previous expectations (MODEL_UNAVAILABLE / AUTH from message text)
    // were exploitable and are replaced by the structured cases below.
    assert.equal(classifyUpstreamFailure(400, 'models/gemini-x is not found for API version v1beta').kind, FailureKind.INVALID);
    assert.equal(classifyUpstreamFailure(400, 'User location is not supported for the API use.').kind, FailureKind.INVALID);
    const echoed = [{ error: { code: 400, status: 'INVALID_ARGUMENT',
      message: 'Invalid JSON payload received. Unknown name "model is not found" at \'tools[0]\': API key not valid' } }];
    assert.equal(classifyUpstreamFailure(400, JSON.stringify(echoed)).kind, FailureKind.INVALID, 'attacker-chosen field names stay request-scoped');
    assert.equal(classifyUpstreamFailure(400, 'Invalid tool schema').kind, FailureKind.INVALID);
    assert.equal(classifyUpstreamFailure(400, '{"error":{"code":"model_not_found","message":"x"}}').kind, FailureKind.MODEL_UNAVAILABLE);
    assert.equal(classifyUpstreamFailure(400, JSON.stringify([{ error: { code: 400, status: 'FAILED_PRECONDITION',
      message: 'User location is not supported for the API use.' } }])).kind, FailureKind.AUTH, 'Gemini precondition failures park the pool');
    assert.equal(classifyUpstreamFailure(400, JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }])).kind, FailureKind.AUTH, 'invalid Gemini key');
    assert.equal(classifyUpstreamFailure(401, '{"error":{"code":"invalid_api_key"}}').kind, FailureKind.AUTH);
    assert.equal(classifyUpstreamFailure(400, '{"error":{"code":"tool_use_failed","message":"Failed to call a function"}}').kind, FailureKind.MODEL_ERROR);
    assert.equal(classifyUpstreamFailure(400, '{"error":{"code":"context_length_exceeded"}}').kind, FailureKind.CONTEXT);
    assert.equal(classifyUpstreamFailure(404, '').kind, FailureKind.MODEL_UNAVAILABLE);
    assert.equal(classifyUpstreamFailure(503, '').kind, FailureKind.SERVER);
    // Workers AI error codes are structured and override the HTTP status.
    const daily = classifyUpstreamFailure(400, '{"success":false,"errors":[{"code":3036,"message":"daily free allocation"}]}');
    assert.equal(daily.kind, FailureKind.RATE_LIMITED);
    const untilMidnight = Math.ceil(((Math.floor(Date.now() / 86400000) + 1) * 86400000 - Date.now()) / 1000);
    assert.ok(Math.abs(daily.retryAfterSeconds - untilMidnight) <= 2, 'the daily allocation resets at 00:00 UTC');
    assert.equal(classifyUpstreamFailure(500, '{"errors":[{"code":3040}]}').kind, FailureKind.RATE_LIMITED);
    assert.equal(classifyUpstreamFailure(500, '{"errors":[{"code":5007}]}').kind, FailureKind.MODEL_UNAVAILABLE);
    assert.equal(classifyUpstreamFailure(500, '{"errors":[{"code":3999}]}').kind, FailureKind.SERVER);
    // In-stream errors carry no HTTP status.
    assert.equal(classifyUpstreamFailure(null, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }).kind, FailureKind.RATE_LIMITED);
    assert.equal(classifyUpstreamFailure(null, { error: { message: 'model not found; user location is not supported' } }).kind, FailureKind.SERVER);
    assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '7' })), 7);
    assert.equal(retryAfterSeconds(new Headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s' })), 180);
    assert.equal(retryAfterSeconds(new Headers({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '7.66s' })), 8);
    assert.equal(retryAfterSeconds(new Headers(), '[{"error":{"details":[{"retryDelay":"41s"}]}}]'), 41);
    const perDay = JSON.stringify([{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } }]);
    assert.equal(retryAfterSeconds(new Headers(), perDay), 3600, 'per-day quotas wait at least an hour');
    // Delay hints come only from structured fields (the old free-text match is gone).
    assert.equal(retryAfterSeconds(new Headers(), '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","retryDelay":"30s"'), null);
  });

  await test('safe OpenAI params are forwarded per provider and unsafe ones dropped', () => {
    const body = { model: 'auto', stream: true, messages: [{ role: 'developer', content: 'Be brief' }, ...messages], tools,
      tool_choice: 'auto', parallel_tool_calls: true, stop: ['END'], temperature: 0.2, top_p: 0.9, seed: 7, user: 'u1',
      presence_penalty: 0.5, frequency_penalty: 0.1, response_format: { type: 'text' }, reasoning_effort: 'minimal',
      logit_bias: { 1: 2 }, logprobs: true, n: 1, metadata: { a: 1 }, store: true, temperature_extra: 1, max_completion_tokens: 50 };
    const groq = buildUpstreamPayload(catalogEntry('groq/openai/gpt-oss-120b'), body, 900);
    assert.equal(groq.messages[0].role, 'system');
    assert.equal(body.messages[0].role, 'developer', 'the client body is not mutated');
    assert.equal(groq.max_tokens, 900);
    assert.equal(groq.reasoning_effort, 'low');
    for (const name of ['tool_choice', 'parallel_tool_calls', 'stop', 'temperature', 'top_p', 'seed', 'user', 'presence_penalty', 'frequency_penalty', 'response_format']) {
      assert.deepEqual(groq[name], body[name], name);
    }
    for (const name of ['logit_bias', 'logprobs', 'n', 'metadata', 'store', 'temperature_extra', 'max_completion_tokens']) assert.equal(groq[name], undefined, name);
    const gemini = buildUpstreamPayload(catalogEntry('gemini/gemini-2.5-flash'), body, 900);
    assert.equal(gemini.presence_penalty, undefined, 'Gemini 2.5 rejects penalties');
    assert.equal(gemini.parallel_tool_calls, undefined);
    assert.equal(gemini.user, undefined);
    assert.equal(gemini.reasoning_effort, 'low');
    assert.equal(buildUpstreamPayload(catalogEntry('gemini/gemini-2.5-flash'), { ...body, reasoning_effort: 'none' }, 9).reasoning_effort, 'none');
    assert.equal(buildUpstreamPayload(catalogEntry('groq/qwen/qwen3.8-27b'), { ...body, reasoning_effort: 'high' }, 9).reasoning_effort, 'default');
    const workers = buildUpstreamPayload(catalogEntry('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), body, 9);
    assert.equal(workers.tool_choice, undefined);
    assert.equal(workers.reasoning_effort, undefined);
    const noTools = buildUpstreamPayload(catalogEntry('groq/openai/gpt-oss-120b'), { ...body, tools: [] }, 9);
    assert.equal(noTools.tools, undefined);
    assert.equal(noTools.tool_choice, undefined);
  });

  // ── Chat handler: anonymous/dev sessions (session-KV allocation) ──
  await test('streamed Gemini tool calls get indexes, reasoning is normalized and usage settles', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ gemini: call => {
      assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      assert.equal(call.headers.Authorization, 'Bearer gemini-free-key');
      assert.equal(call.body.model, 'gemini-2.5-flash');
      assert.deepEqual(call.body.stream_options, { include_usage: true });
      assert.equal(call.body.temperature, 0);
      assert.equal(call.body.presence_penalty, undefined);
      assert.equal(call.body.logit_bias, undefined);
      return sse([
        chunk({ role: 'assistant', content: '', reasoning: 'Planning reads' }),
        chunk({ tool_calls: [{ id: 'fc_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] }),
        chunk({ tool_calls: [{ id: 'fc_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } }] }),
        chunk({}, 'stop', { usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 80 } }),
        '[DONE]',
      ]);
    } });
    const response = await gw.call({ ...KEYS }, { model: 'auto', messages, tools, stream: true, temperature: 0, presence_penalty: 1, logit_bias: { 1: 1 } }, { country: 'US' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.match(response.headers.get('x-request-id'), /^req_/);
    assert.equal(response.headers.get('x-neuron-model'), 'gemini/gemini-2.5-flash');
    assert.equal(response.headers.get('x-neuron-plan'), 'free');
    assert.equal(response.headers.get('x-neuron-quota-remaining-requests'), '1999');
    assert.ok(Number(response.headers.get('x-neuron-quota-remaining-tokens')) > 0);
    const events = parseSse(await response.text());
    assert.equal(events.at(-1), '[DONE]');
    assert.equal(events.filter(event => event === '[DONE]').length, 1);
    const chunks = events.filter(event => event !== '[DONE]');
    assert.equal(new Set(chunks.map(item => item.id)).size, 1);
    assert.ok(chunks.every(item => item.model === 'gemini/gemini-2.5-flash'));
    assert.equal(chunks[0].choices[0].delta.reasoning_content, 'Planning reads');
    assert.equal(chunks[0].choices[0].delta.reasoning, undefined);
    const toolDeltas = chunks.flatMap(item => item.choices.flatMap(choice => choice.delta.tool_calls || []));
    assert.deepEqual(toolDeltas.map(item => [item.index, item.id, item.function.name]), [[0, 'fc_a', 'read_file'], [1, 'fc_b', 'read_file']]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.equal(chunks.at(-1).usage.total_tokens, 80);
    assert.equal(gw.session('ses_anon').tokens_used, 80, 'Gemini usage billed from total_tokens');
    assert.equal(gw.session('ses_anon').requests, 1);
  });

  await test('OpenAI-style tool deltas without index keep fragments on the right call', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => sse([
      chunk({ role: 'assistant', content: null }),
      chunk({ tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '' } }, { id: 'c2', function: { name: 'list', arguments: '' } }] }),
      chunk({ tool_calls: [{ function: { arguments: '{"p' } }, { function: { arguments: '{"d' } }] }),
      chunk({ tool_calls: [{ function: { arguments: '":1}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      chunk({}, 'tool_calls'), chunk({}, null, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }), '[DONE]',
    ]) });
    const response = await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages, tools, stream: true });
    const deltas = parseSse(await response.text()).filter(event => event !== '[DONE]')
      .flatMap(item => item.choices.flatMap(choice => choice.delta.tool_calls || []));
    assert.deepEqual(deltas.map(delta => delta.index), [0, 1, 0, 1, 1, 0]);
    assert.equal(deltas[2].id, undefined, 'continuations do not repeat ids');
    assert.equal(gw.session('ses_anon').tokens_used, 10);
  });

  await test('non-streaming completions are normalized (reasoning, ids, finish_reason)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => completion({ content: null, reasoning: 'why', tool_calls: [{ id: 'call_up', type: 'function', function: { name: 'read_file', arguments: { path: 'a' } } }] },
      { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }) });
    const response = await gw.call({ ...KEYS }, { model: 'gpt-oss-120b', messages, tools });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-model'), 'groq/openai/gpt-oss-120b');
    const body = await response.json();
    assert.equal(body.model, 'groq/openai/gpt-oss-120b');
    assert.equal(body.choices[0].message.reasoning_content, 'why');
    assert.equal(body.choices[0].message.reasoning, undefined);
    assert.equal(body.choices[0].message.tool_calls[0].id, 'call_up');
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"path":"a"}');
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(gw.session('ses_anon').tokens_used, 42);
  });

  await test('404 parks one model for 10 minutes while auto fails over to the next', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ gemini: call => call.body.model === 'gemini-2.5-flash'
      ? new Response('{"error":{"message":"model not found"}}', { status: 404 })
      : completion({ content: 'from 3.5' }) });
    const first = await gw.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-neuron-model'), 'gemini/gemini-3.5-flash');
    assert.deepEqual(upstreamCalls().map(call => call.body.model), ['gemini-2.5-flash', 'gemini-3.5-flash']);
    calls.length = 0;
    const second = await gw.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.equal(second.status, 200);
    assert.deepEqual(upstreamCalls().map(call => call.body.model), ['gemini-3.5-flash'], 'the dead model is skipped, its provider is not');
    assert.equal(gw.session('ses_anon').requests, 2, 'a failover is one request');
  });

  // Production (22-24 Oct): Gemini's free daily quota ran out, and `auto` answered
  // capacity_exhausted although Groq and NVIDIA had capacity. A fresh Workers isolate does not
  // know Gemini is out, tried the three Gemini pools first, and their 429s used up all three
  // attempts (ROUTER_MAX_ATTEMPTS) before Groq was reached.
  await test('auto keeps going past 429s: a spent quota does not use up the attempts', async () => {
    const gw = gateway(); // a fresh tracker is a fresh isolate
    gw.addSession('ses_anon', {});
    const quota = () => new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota' } }), { status: 429, headers: { 'retry-after': '3600' } });
    reset({ gemini: quota, groq: () => completion({ content: 'from groq' }) });
    const response = await gw.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-model'), 'groq/openai/gpt-oss-120b');
    assert.deepEqual(upstreamCalls().map(call => call.target), ['gemini', 'gemini', 'gemini', 'groq']);
    assert.equal(gw.session('ses_anon').requests, 1, 'the refused attempts are one request');

    // Only 429s are free: real failures still stop at ROUTER_MAX_ATTEMPTS.
    reset({ gemini: () => new Response('{"error":{"message":"boom"}}', { status: 500 }), groq: () => completion({ content: 'x' }) });
    await expectError(await gateway().call({ ...KEYS }, { model: 'auto', messages, tools }, { token: 'ses_none', country: 'US' }), 401, 'invalid_session');
    const strict = gateway();
    strict.addSession('ses_anon', {});
    await expectError(await strict.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'US' }), 502, 'upstream_error');
    assert.deepEqual(upstreamCalls().map(call => call.target), ['gemini', 'gemini', 'gemini']);

    // ROUTER_MAX_RATE_LIMITED bounds the 429s one request may collect.
    const capped = gateway();
    capped.addSession('ses_anon', {});
    reset({ gemini: quota, groq: quota });
    await expectError(await capped.call({ ...KEYS, ROUTER_MAX_RATE_LIMITED: '4' }, { model: 'auto', messages, tools }, { country: 'US' }),
      503, 'capacity_exhausted');
    assert.equal(upstreamCalls().length, 4);
  });

  await test('auto tries pools other isolates saw out of quota last', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    const until = Date.now() + 3_600_000;
    // The KV rows health-share.js publishes (the HealthHub snapshot has the same shape).
    const SESSIONS_KV = {
      get: async key => key.startsWith('health:v1:gemini:') ? { status: 'blurred', until, at: Date.now() } : null,
      put: async () => {},
    };
    reset({ gemini: () => { throw new Error('a pool parked in the shared view must not be tried first'); },
      groq: () => completion({ content: 'from groq' }) });
    const response = await gw.call({ ...KEYS, SESSIONS_KV }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamCalls().map(call => call.target), ['groq']);

    // Parked pools are moved back, not dropped: an explicit request for one still tries it.
    reset({ gemini: () => completion({ content: 'from gemini' }) });
    const explicit = await gw.call({ ...KEYS, SESSIONS_KV }, { model: 'gemini/gemini-3.5-flash', messages, tools }, { country: 'US' });
    assert.equal(explicit.status, 200);
    assert.deepEqual(upstreamCalls().map(call => call.target), ['gemini']);
  });

  // Production (28 Oct): nvidia gpt-oss-20b timed out on its first byte for the same user at
  // 16:56, 16:58 and 17:10. One caller's timeout marks a pool degraded without opening its
  // circuit, so it kept its rank and the user waited through the 45 s TTFB again each time.
  await test('auto tries degraded pools after healthy ones of their tier and before parked ones', async () => {
    const order = () => upstreamCalls().map(call => `${call.target}:${call.body.model}`);
    const failing = { gemini: () => new Response('down', { status: 500 }), groq: () => new Response('down', { status: 500 }) };
    const healthy = ['gemini:gemini-3.5-flash', 'groq:openai/gpt-oss-120b', 'groq:qwen/qwen3.8-27b', 'groq:openai/gpt-oss-20b'];
    // The HealthHub snapshot: A (gemini-2.5-flash, best auto_rank) degraded, B available, C blurred.
    const pools = { 'gemini:gemini-2.5-flash:free': { status: 'degraded', until: 0, at: Date.now() },
      'gemini:gemini-3.5-flash:free': { status: 'available', until: 0, at: Date.now() },
      'gemini:gemini-3.6-flash:free': { status: 'blurred', until: Date.now() + 3_600_000, at: Date.now() } };
    const HEALTH_HUB = { idFromName: name => name, get: () => ({
      fetch: async url => String(url).endsWith('/snapshot') ? Response.json({ pools }) : new Response('ok') }) };
    resetHubClientCache();
    try {
      const hub = gateway();
      hub.addSession('ses_anon', {});
      reset(failing);
      await hub.call({ ...KEYS, HEALTH_HUB, ROUTER_MAX_ATTEMPTS: '10' }, { model: 'auto', messages, tools }, { country: 'US' });
      assert.deepEqual(order(), [...healthy, 'gemini:gemini-2.5-flash', 'gemini:gemini-3.6-flash'],
        'B and the other healthy pools first, then degraded A, then blurred C (still tried)');
    } finally { resetHubClientCache(); }

    // Without a hub row, this isolate's own first-byte timeout on A demotes it the same way...
    const local = gateway();
    local.addSession('ses_anon', {});
    local.tracker.recordFailure('gemini:gemini-2.5-flash:free', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'user-1' });
    assert.equal(local.tracker.getRecord('gemini:gemini-2.5-flash:free').status, HealthState.DEGRADED);
    reset(failing);
    await local.call({ ...KEYS, ROUTER_MAX_ATTEMPTS: '10' }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.deepEqual(order(), [healthy[0], 'gemini:gemini-3.6-flash', ...healthy.slice(1), 'gemini:gemini-2.5-flash']);

    // ...while one 5xx (also DEGRADED, circuit closed) keeps the pool's rank.
    const flaky = gateway();
    flaky.addSession('ses_anon', {});
    flaky.tracker.recordFailure('gemini:gemini-2.5-flash:free', { kind: FailureKind.SERVER });
    assert.equal(flaky.tracker.getRecord('gemini:gemini-2.5-flash:free').status, HealthState.DEGRADED);
    reset(failing);
    await flaky.call({ ...KEYS, ROUTER_MAX_ATTEMPTS: '10' }, { model: 'auto', messages, tools }, { country: 'US' });
    assert.equal(order()[0], 'gemini:gemini-2.5-flash');
  });

  await test('413 skips a pool for this request only and never opens its circuit', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: call => call.body.model === 'openai/gpt-oss-120b'
      ? new Response('{"error":{"message":"Request too large for model","code":"rate_limit_exceeded"}}', { status: 413, headers: { 'retry-after': '3' } })
      : completion({ content: 'qwen' }) });
    const auto = await gw.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'DE' });
    assert.equal(auto.headers.get('x-neuron-model'), 'groq/qwen/qwen3.8-27b');
    calls.length = 0;
    const explicit = await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages, tools });
    await expectError(explicit, 400, 'context_length_exceeded');
    assert.equal(upstreamCalls().length, 1, 'retried immediately on the next request');
    const key = 'groq:openai/gpt-oss-120b:free';
    assert.equal(gw.tracker.isAvailable(key), true);
    assert.equal(gw.tracker.getRecord(key).failed_attempts, 0);
    assert.equal(gw.session('ses_anon').requests, 2, 'a rejected oversized request still counts');
  });

  await test('429 honours retry-after and reports capacity_exhausted with Retry-After', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => new Response('provider says sensitive groq-free-key', { status: 429, headers: { 'retry-after': '7' } }) });
    const limited = await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages });
    assert.equal(limited.headers.get('retry-after'), '7');
    const error = await expectError(limited, 503, 'capacity_exhausted');
    assert.equal(error.retry_after_seconds, 7);
    assert.equal(error.upgrade_url, 'https://zero-x.live/pricing');
    assert.ok(!JSON.stringify(error).includes('groq-free-key'));
    calls.length = 0;
    const blocked = await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages });
    assert.equal(upstreamCalls().length, 0, 'circuit stays open until the reset');
    assert.ok(Number(blocked.headers.get('retry-after')) <= 7);
    await expectError(blocked, 503, 'capacity_exhausted');
    assert.equal(gw.session('ses_anon').requests, 0, 'the rate-limited request was refunded');
    assert.equal(gw.session('ses_anon').tokens_used, 0);
  });

  await test('5xx failures open the circuit after three strikes', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => new Response('boom', { status: 502 }) });
    for (let i = 0; i < 3; i++) await expectError(await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-20b', messages }), 502, 'upstream_error');
    calls.length = 0;
    await expectError(await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-20b', messages }), 502, 'upstream_error');
    assert.equal(upstreamCalls().length, 0);
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-20b:free').status, HealthState.DOWN);
    assert.equal(gw.tracker.isAvailable('groq:openai/gpt-oss-120b:free'), true);
    reset({ groq: () => new Response('denied', { status: 401 }) });
    const auth = await expectError(await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages }), 502, 'upstream_error');
    assert.equal(auth.message, 'Generation is temporarily unavailable. Retry shortly.');
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-120b:free').status, HealthState.AUTH_FAILED);
  });

  await test('client aborts are never counted against upstream health', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: untilAborted });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const response = await gw.call({ ...KEYS }, { model: 'auto', messages }, { signal: controller.signal, country: 'DE' });
    assert.equal(response.status, 502);
    assert.equal(upstreamCalls().length, 1, 'no failover after the client left');
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-120b:free').failed_attempts, 0);
    assert.equal(gw.tracker.isAvailable('groq:openai/gpt-oss-120b:free'), true);
    assert.equal(gw.session('ses_anon').tokens_used, estimatePromptTokens(messages), 'the processed prompt is billed');
  });

  await test('time-to-first-byte timeout fails over before anything reaches the client', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ gemini: call => call.body.model === 'gemini-2.5-flash' ? hangingSse() : sse([chunk({ content: 'ok' }, 'stop'), '[DONE]']) });
    const started = Date.now();
    const response = await gw.call({ ...KEYS, ...FAST }, { model: 'auto', messages, tools, stream: true }, { country: 'US' });
    assert.equal(response.headers.get('x-neuron-model'), 'gemini/gemini-3.5-flash');
    assert.ok((await response.text()).includes('"content":"ok"'));
    assert.ok(Date.now() - started < 2000);
    assert.equal(gw.tracker.getRecord('gemini:gemini-2.5-flash:free').last_failure_kind, FailureKind.TIMEOUT);
    reset({ groq: untilAborted });
    await expectError(await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true }), 504, 'upstream_timeout');
    reset({ groq: untilAborted });
    await expectError(await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-20b', messages }), 504, 'upstream_timeout');
  });

  await test('idle timeout between chunks ends the stream with an upstream_timeout event', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => sse([chunk({ role: 'assistant', content: 'partial' })], { hangAfter: true }) });
    const response = await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    assert.equal(events[0].choices[0].delta.content, 'partial');
    assert.equal(events.at(-1).error.code, 'upstream_timeout');
    assert.equal(events.at(-1).error.param, null);
    assert.match(events.at(-1).error.request_id, /^req_/);
    assert.ok(!events.includes('[DONE]'));
    const used = gw.session('ses_anon').tokens_used;
    assert.ok(used > 0 && used < 4096, 'billed the estimate, not the whole reservation');
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-120b:free').last_failure_kind, FailureKind.TIMEOUT);
  });

  await test('an in-stream error before the first chunk fails over; after it, the client sees an error event', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ gemini: call => call.body.model === 'gemini-2.5-flash'
      ? sse([{ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }])
      : sse([chunk({ content: 'ok' }, 'stop'), '[DONE]']) });
    const response = await gw.call({ ...KEYS }, { model: 'auto', messages, tools, stream: true }, { country: 'US' });
    assert.equal(response.headers.get('x-neuron-model'), 'gemini/gemini-3.5-flash');
    await response.text();
    assert.equal(gw.tracker.getRecord('gemini:gemini-2.5-flash:free').status, HealthState.RATE_LIMITED);
    reset({ groq: () => sse([chunk({ content: 'a' }), { error: { message: 'tool_use_failed' } }]) });
    const late = parseSse(await (await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true })).text());
    assert.equal(late.at(-1).error.code, 'upstream_error');
    assert.equal(late.at(-1).error.message, 'Generation interrupted. Retry your request.');
  });

  await test('client-chosen upstream error text never parks a shared pool (review B2 P2)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    // A fake Gemini that echoes an unknown schema field name chosen by the caller.
    reset({ gemini: call => {
      const field = Object.keys(call.body.tools?.[0]?.function?.parameters?.properties || {})[0];
      if (field) {
        return Response.json([{ error: { code: 400, status: 'INVALID_ARGUMENT',
          message: `Invalid JSON payload received. Unknown name "${field}": model is not found; user location is not supported` } }], { status: 400 });
      }
      return completion({ content: 'benign' });
    } });
    const crafted = [{ type: 'function', function: { name: 'x', parameters: { type: 'object',
      properties: { 'model is not found': { type: 'string' } } } } }];
    for (let i = 0; i < 3; i++) {
      await expectError(await gw.call({ ...KEYS }, { model: 'gemini/gemini-2.5-flash', messages, tools: crafted }, { country: 'US' }), 400, 'invalid_request');
    }
    const key = 'gemini:gemini-2.5-flash:free';
    assert.equal(gw.tracker.isAvailable(key), true, 'the pool stays available');
    assert.equal(gw.tracker.getRecord(key).failed_attempts, 0);
    const benign = await gw.call({ ...KEYS }, { model: 'gemini/gemini-2.5-flash', messages }, { country: 'US' });
    assert.equal(benign.status, 200);
    assert.equal(gw.session('ses_anon').requests, 4, 'the rejected requests counted against the caller');
  });

  await test('an invalid Gemini key trips AUTH and model-side 400s are refunded (review B2 P3)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ gemini: () => Response.json([{ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }], { status: 400 }) });
    await expectError(await gw.call({ ...KEYS }, { model: 'gemini/gemini-3.5-flash', messages }, { country: 'US' }), 502, 'upstream_error');
    assert.equal(gw.tracker.getRecord('gemini:gemini-3.5-flash:free').status, HealthState.AUTH_FAILED);
    calls.length = 0;
    await expectError(await gw.call({ ...KEYS }, { model: 'gemini/gemini-3.5-flash', messages }, { country: 'US' }), 502, 'upstream_error');
    assert.equal(upstreamCalls().length, 0, 'the dead key is not called again');
    assert.equal(gw.session('ses_anon').requests, 0, 'provider-side failures are refunded');

    reset({ groq: call => call.body.model === 'openai/gpt-oss-120b'
      ? Response.json({ error: { code: 'tool_use_failed', message: 'Failed to call a function', type: 'invalid_request_error' } }, { status: 400 })
      : completion({ content: 'next model' }) });
    const failover = await gw.call({ ...KEYS }, { model: 'auto', messages, tools }, { country: 'DE' });
    assert.equal(failover.status, 200, 'auto fails over after a model-side rejection');
    assert.equal(failover.headers.get('x-neuron-model'), 'groq/qwen/qwen3.8-27b');
    assert.equal(gw.tracker.isAvailable('groq:openai/gpt-oss-120b:free'), true, 'model errors are request-scoped');
    reset({ groq: () => Response.json({ error: { code: 'tool_use_failed', message: 'Failed to call a function' } }, { status: 400 }) });
    const before = gw.session('ses_anon').requests;
    const modelError = await expectError(await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages, tools }), 502, 'upstream_error');
    assert.equal(modelError.type, 'server_error');
    assert.equal(gw.session('ses_anon').requests, before, 'a model-side rejection is refunded');
  });

  await test('[DONE] completes a stream even when the upstream keeps the connection open (review B2 P3)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => sse([chunk({ role: 'assistant', content: 'done' }, 'stop'),
      chunk({}, null, { choices: [], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }), '[DONE]'], { hangAfter: true }) });
    const started = Date.now();
    const response = await gw.call({ ...KEYS, UPSTREAM_IDLE_TIMEOUT_MS: '5000' }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true });
    const events = parseSse(await response.text());
    assert.ok(Date.now() - started < 2000, 'no wait for the idle timeout');
    assert.equal(events.at(-1), '[DONE]');
    assert.ok(!events.some(event => event?.error), 'no timeout error event');
    assert.equal(gw.session('ses_anon').tokens_used, 10, 'settled with the real usage');
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-120b:free').failed_attempts, 0);
  });

  await test('SSE comment keep-alives count as upstream bytes for the first-byte and idle budgets (review B2 P3)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    // 150 ms budgets. Before the first data event the upstream sends a comment every 50 ms for
    // ~200 ms (beyond the first-byte budget, within first byte + idle, the pre-commit cap); then
    // comments for ~400 ms between data events (beyond the idle budget).
    const slowSse = () => new Response(new ReadableStream({
      async start(controller) {
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 5; i++) { controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n')); await pause(40); }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'slow' }))}\n\n`));
        for (let i = 0; i < 8; i++) { controller.enqueue(encoder.encode(':\n\n')); await pause(50); }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: ' answer' }, 'stop'))}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    reset({ groq: slowSse });
    const response = await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true });
    assert.equal(response.status, 200);
    const events = parseSse((await response.text()).split('\n\n').filter(part => part.startsWith('data:')).join('\n\n') + '\n\n');
    assert.equal(events.at(-1), '[DONE]');
    assert.equal(events.filter(event => event !== '[DONE]').map(event => event.choices[0]?.delta?.content).join(''), 'slow answer');
    assert.equal(gw.tracker.getRecord('groq:openai/gpt-oss-120b:free').failed_attempts, 0);
  });

  // Review P3 (integration): a single caller's timeout (a long hidden thinking phase a client can
  // provoke) used to park a shared pool for 30 s for every caller. Two distinct callers are needed.
  await test('liveness timeouts open the circuit only after two distinct callers time out; slow responses need three strikes', async () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordFailure('a', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'user-attacker' });
    assert.equal(tracker.isAvailable('a'), true, 'one caller cannot park a shared pool');
    tracker.recordFailure('a', { kind: FailureKind.TIMEOUT, phase: 'idle', caller: 'user-attacker' });
    assert.equal(tracker.isAvailable('a'), true, 'not even with repeated long-thinking prompts');
    assert.equal(tracker.getRecord('a').status, HealthState.DEGRADED);
    tracker.recordFailure('a', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'user-second' });
    assert.equal(tracker.isAvailable('a'), false, 'a second caller timing out opens the circuit');
    assert.equal(tracker.getRecord('a').status, HealthState.DOWN);
    assert.ok(!JSON.stringify(tracker.getSnapshot()).includes('user-'), 'caller ids never reach health snapshots');
    tracker.recordFailure('b', { kind: FailureKind.TIMEOUT, phase: 'first_byte' });
    tracker.recordFailure('b', { kind: FailureKind.TIMEOUT, phase: 'idle' });
    assert.equal(tracker.isAvailable('b'), false, 'unknown callers count as distinct');
    const windowed = new ProviderHealthTracker({ timeoutWindowMs: 40 });
    windowed.recordFailure('w', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'x' });
    await new Promise(resolve => setTimeout(resolve, 70));
    windowed.recordFailure('w', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'y' });
    assert.equal(windowed.isAvailable('w'), true, 'timeouts outside the window do not add up');
    const healed = new ProviderHealthTracker();
    healed.recordFailure('h', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'x' });
    healed.recordSuccess('h');
    healed.recordFailure('h', { kind: FailureKind.TIMEOUT, phase: 'first_byte', caller: 'y' });
    assert.equal(healed.isAvailable('h'), true, 'a success in between starts the count again');
    tracker.recordFailure('c', { kind: FailureKind.TIMEOUT, phase: 'response' });
    assert.equal(tracker.isAvailable('c'), true, 'a long generation is not a dead pool');
    const gw = gateway();
    gw.addSession('ses_anon', {});
    gw.addSession('ses_other', {});
    reset({ groq: untilAborted });
    for (let i = 0; i < 2; i++) {
      await expectError(await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true }), 504, 'upstream_timeout');
    }
    assert.equal(gw.tracker.isAvailable('groq:openai/gpt-oss-120b:free'), true, 'the same caller twice keeps the pool open');
    await expectError(await gw.call({ ...KEYS, ...FAST }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true }, { token: 'ses_other' }),
      504, 'upstream_timeout');
    assert.equal(gw.tracker.isAvailable('groq:openai/gpt-oss-120b:free'), false, 'the chat handler passes the timeout phase and the caller');
  });

  await test('Workers AI binding errors are rate limits and late streams are cancelled (review B2 P3)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({});
    const env = { AI: { run: async () => { throw new Error('3036: Account limited: you have used up your daily free allocation of 10,000 neurons'); } } };
    const limited = await expectError(await gw.call(env, { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages }), 503, 'capacity_exhausted');
    assert.ok(limited.retry_after_seconds > 0);
    const record = gw.tracker.getRecord('cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast:free');
    assert.equal(record.status, HealthState.RATE_LIMITED);
    const untilMidnight = (Math.floor(Date.now() / 86400000) + 1) * 86400000 - Date.now();
    assert.ok(Math.abs(gw.tracker.cooldownRemainingMs(record.key) - untilMidnight) < 5000, 'parked until 00:00 UTC');
    assert.equal(gw.session('ses_anon').requests, 0, 'refunded');

    const late = gateway();
    late.addSession('ses_anon', {});
    let cancelled = false;
    const lateEnv = { ...FAST, AI: { run: () => new Promise(resolve => setTimeout(() => resolve(new ReadableStream({
      start() {}, cancel() { cancelled = true; },
    })), 300)) } };
    await expectError(await late.call(lateEnv, { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages, stream: true }), 504, 'upstream_timeout');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(cancelled, true, 'the generation started after the timeout is cancelled');
  });

  await test('session-quota settlement after a client cancel runs through waitUntil (review B2 P3)', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ groq: () => sse([chunk({ role: 'assistant', content: 'partial' })], { hangAfter: true }) });
    const waited = [];
    const ctx = { waitUntil: promise => waited.push(promise), passThroughOnException() {} };
    const response = await gw.call({ ...KEYS }, { model: 'groq/openai/gpt-oss-120b', messages, stream: true }, { ctx });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(waited.length, 1, 'the KV settlement is handed to waitUntil');
    await Promise.all(waited);
    const used = gw.session('ses_anon').tokens_used;
    assert.ok(used > 0 && used < 4096, 'the reservation was replaced by the estimate');
  });

  await test('request validation and authentication errors', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({});
    const env = { ...KEYS };
    const unauthenticated = await expectError(await gw.call(env, { model: 'auto', messages }, { token: 'ses_missing' }), 401, 'invalid_session');
    assert.equal(unauthenticated.type, 'authentication_error');
    assert.match(unauthenticated.message, /neuron auth login/);
    for (const body of ['{not json', { model: 'auto' }, { model: 'auto', messages: [{ role: 'robot' }] }, { model: 'auto', messages, n: 2 },
      { model: 'auto', messages, temperature: 3 }, { model: 'auto', messages, max_tokens: 70000 }, { model: 'auto', messages, stop: [1] },
      { model: 'auto', messages, tools: [{ type: 'code' }] }, { model: 'auto', messages, stream: 'yes' }, { model: 'auto', messages, reasoning_effort: 'max' }]) {
      await expectError(await gw.call(env, body), 400, 'invalid_request');
    }
    await expectError(await gw.call(env, { model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(1048600) }] }), 400, 'invalid_request');
    await expectError(await gw.call(env, { model: 'openai', messages }), 404, 'model_not_found');
    assert.equal(upstreamCalls().length, 0);
    assert.equal(gw.session('ses_anon').requests, 0, 'rejected requests reserve nothing');
    gw.addSession('ses_full', { tokens_used: 256000 });
    const quota = await expectError(await gw.call(env, { model: 'auto', messages }, { token: 'ses_full' }), 429, 'insufficient_quota');
    assert.ok(quota.resets_at && quota.upgrade_url);
  });

  // ── Chat handler: account-backed sessions (zerox_reserve_v2 / zerox_settle_v2) ──
  const accountEnv = (extra = {}) => ({ ...KEYS, ...DB, ...extra });
  const policiesRpc = () => Response.json(B1_POLICY_ROWS);
  const okReserve = (overrides = {}) => ({ status: 'ok', reservation_id: crypto.randomUUID(), plan: 'pro', remaining_requests: 1999,
    remaining_tokens: 9990000, credit_balance_microusd: 8000000, resets_at: '2026-10-17T00:00:00.000Z', retry_after_seconds: null, ...overrides });
  const accountGateway = () => {
    const gw = gateway();
    gw.addSession('ses_pro', { account_backed: true, user_id: ACCOUNT, plan: 'pro' });
    return gw;
  };

  await test('every reservation status maps to its contract error', async () => {
    const cases = [
      ['no_account', 401, 'invalid_session', 1], ['suspended', 403, 'account_suspended', 1],
      ['user_daily_requests', 429, 'insufficient_quota', 1], ['user_daily_tokens', 429, 'insufficient_quota', 1],
      ['user_rpm', 429, 'rate_limited', 1], ['user_concurrency', 429, 'rate_limited', 1],
      ['pool_exhausted', 503, 'capacity_exhausted', 2], ['upgrade_required', 403, 'upgrade_required', 1],
      ['insufficient_credits', 402, 'insufficient_credits', 1], ['mystery', 503, 'service_unavailable', 1],
    ];
    for (const [status, http, code, reserves] of cases) {
      const gw = accountGateway();
      reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
        'rpc:zerox_reserve_v2': () => Response.json([{ status, reservation_id: null, plan: 'pro', remaining_requests: 0,
          remaining_tokens: 0, credit_balance_microusd: 0, resets_at: '2026-10-17T00:00:00.000Z', retry_after_seconds: 12 }]) });
      const model = status === 'upgrade_required' || status === 'insufficient_credits' ? 'gemini/gemini-2.5-pro' : 'groq/openai/gpt-oss-120b';
      const error = await expectError(await gw.call(accountEnv(), { model, messages }, { token: 'ses_pro' }), http, code);
      assert.equal(rpcCalls('zerox_reserve_v2').length, reserves, `${status} reservation attempts`);
      assert.equal(upstreamCalls().length, 0);
      if (code === 'insufficient_quota') assert.equal(error.resets_at, '2026-10-17T00:00:00.000Z');
      if (code === 'rate_limited' || code === 'capacity_exhausted') assert.equal(error.retry_after_seconds, 12);
      if (['insufficient_credits', 'upgrade_required', 'capacity_exhausted', 'insufficient_quota'].includes(code)) assert.ok(error.upgrade_url);
      assert.deepEqual(gw.writes, [], 'account sessions are never rewritten to session storage');
    }
    assert.equal(reserveError({ status: 'user_rpm' }).retryAfterSeconds, 60);
    assert.equal(reserveError({ status: 'pool_exhausted' }).retryAfterSeconds, 60);
  });

  await test('free pool exhaustion fails over to paid capacity; no credits gives 402', async () => {
    const gw = accountGateway();
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([call.body.p_tier === 'free'
        ? { status: 'pool_exhausted', retry_after_seconds: 30 } : { status: 'insufficient_credits', credit_balance_microusd: 0 }]) });
    const error = await expectError(await gw.call(accountEnv(), { model: 'auto', messages, tools }, { token: 'ses_pro', country: 'US' }), 402, 'insufficient_credits');
    assert.equal(error.type, 'insufficient_quota');
    assert.ok(error.upgrade_url);
    const tiers = rpcCalls('zerox_reserve_v2').map(call => call.body.p_tier);
    assert.deepEqual(tiers, [...Array(6).fill('free'), 'paid'], 'paid pools stop after the first credit refusal');
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': () => Response.json([{ status: 'pool_exhausted', retry_after_seconds: 45 }]) });
    const freeUser = gateway();
    freeUser.addSession('ses_free', { account_backed: true, user_id: ACCOUNT, plan: 'free' });
    const exhausted = await expectError(await freeUser.call(accountEnv(), { model: 'auto', messages, tools }, { token: 'ses_free', country: 'US' }), 503, 'capacity_exhausted');
    assert.equal(exhausted.retry_after_seconds, 45);
    assert.ok(rpcCalls('zerox_reserve_v2').every(call => call.body.p_tier === 'free'), 'free plans never touch paid pools');
  });

  await test('reserve arguments carry pool limits, estimated cost and the request id', async () => {
    const gw = accountGateway();
    const settled = [];
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([call.body.p_tier === 'free' ? { status: 'pool_exhausted', retry_after_seconds: 5 } : okReserve()]),
      'rpc:zerox_settle_v2': call => { settled.push(call.body); return Response.json([{ status: 'settled', credit_balance_microusd: 7999000 }]); },
      groq: call => {
        assert.equal(call.headers.Authorization, 'Bearer groq-paid-key', 'paid pool uses the paid key');
        return completion({ content: 'paid' }, { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
      } });
    const waited = [];
    const ctx = { waitUntil: promise => waited.push(promise), passThroughOnException() {} };
    const response = await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages, max_tokens: 2048 }, { token: 'ses_pro', ctx });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-plan'), 'pro');
    assert.equal(response.headers.get('x-neuron-quota-remaining-requests'), '1999');
    assert.equal(response.headers.get('x-neuron-quota-remaining-tokens'), '9990000');
    const requestId = response.headers.get('x-request-id');
    const [free, paid] = rpcCalls('zerox_reserve_v2').map(call => call.body);
    const prompt = estimatePromptTokens(messages);
    assert.deepEqual(free, { p_user_id: ACCOUNT, p_request_id: requestId, p_model: 'groq/openai/gpt-oss-120b', p_tier: 'free',
      p_tokens: prompt + RESERVED_OUTPUT_TOKENS, p_cost_microusd: 0, p_pool: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 } });
    assert.equal(paid.p_request_id, requestId, 'no reservation existed yet, so the id is reused');
    assert.equal(paid.p_tier, 'paid');
    assert.equal(paid.p_pool, null);
    assert.equal(paid.p_tokens, prompt + RESERVED_OUTPUT_TOKENS);
    assert.equal(paid.p_cost_microusd, costMicrousd(catalogEntry('groq/openai/gpt-oss-120b').pools[1].price, prompt, 2048),
      'credits are held for the full max_tokens');
    assert.equal(waited.length, 1, 'settlement runs in waitUntil');
    await Promise.all(waited);
    assert.equal(settled.length, 1);
    const settle = settled[0];
    assert.equal(settle.p_status, 'ok');
    assert.equal(settle.p_prompt_tokens, 1000);
    assert.equal(settle.p_completion_tokens, 500);
    assert.equal(settle.p_cost_microusd, 563);
    assert.equal(settle.p_provider, 'groq');
    assert.equal(settle.p_upstream_model, 'openai/gpt-oss-120b');
    assert.equal(settle.p_error_code, null);
    assert.ok(Number.isInteger(settle.p_latency_ms));
    assert.deepEqual(gw.writes, []);
    // E2E finding (2026-10-21): max_tokens fitted to the rest of Groq's 8K minute made every
    // reservation hold the whole minute budget. The pool holds the prompt plus a bounded output
    // allowance; a smaller max_tokens is held as is.
    const groq = catalogEntry('groq/openai/gpt-oss-120b');
    const args = (promptTokens, maxTokens) => reservationArgs({ session: { user_id: ACCOUNT }, requestId: 'r', entry: groq,
      pool: groq.pools[0], promptTokens, maxTokens });
    assert.equal(args(3000, 5000).p_tokens, 3000 + RESERVED_OUTPUT_TOKENS);
    assert.equal(args(1400, 6600).p_tokens, 2424, 'max_tokens 8192 fitted to 6600 still holds 1,024 output tokens');
    assert.equal(args(3000, 64).p_tokens, 3064);
    assert.equal(reservedTokens(10, 2048), 10 + RESERVED_OUTPUT_TOKENS);
    assert.ok(3 * reservedTokens(1400, 6600) <= POOL_LIMITS.groq_free.tpm, 'three such requests fit in one Groq minute at once');
  });

  await test('pool budget refusals are logged with the pool, model and budget and remembered for /v1/models', async () => {
    const gw = accountGateway();
    resetPoolBudgets();
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([call.body.p_tier === 'free'
        ? { status: 'pool_exhausted', retry_after_seconds: 42 } : { status: 'insufficient_credits', credit_balance_microusd: 0 }]) });
    const { result: response, logs } = await captureLogs(async () =>
      gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages }, { token: 'ses_pro' }));
    const error = await expectError(response, 402, 'insufficient_credits');
    assert.ok(error.upgrade_url);
    const refusals = logs.warn.filter(([message]) => message === 'Neuron pool budget exhausted');
    assert.equal(refusals.length, 1, 'one line per refused pool');
    assert.deepEqual(refusals[0][1], { pool: 'groq:openai/gpt-oss-120b:free', model: 'groq/openai/gpt-oss-120b', budget: 'rpm|tpm',
      retry_after_seconds: 42, request_id: response.headers.get('x-request-id') });
    assert.ok(!JSON.stringify(logs).includes('groq-free-key') && !JSON.stringify(logs).includes('ses_pro'), 'no keys or tokens');
    const spent = poolBudgetState('groq:openai/gpt-oss-120b:free');
    assert.equal(spent.budget, 'rpm|tpm');
    assert.ok(spent.until - Date.now() > 40000 && spent.until - Date.now() <= 42000);
    // A daily budget (retry at UTC midnight) is named as such; the free pool of OpenRouter has no tpm.
    assert.equal(exhaustedBudget(POOL_LIMITS.openrouter_free, 7200), 'rpd');
    assert.equal(exhaustedBudget(POOL_LIMITS.nvidia_trial, 30, Date.UTC(2026, 9, 21, 12, 0, 30)), 'rpm');
    assert.equal(exhaustedBudget(POOL_LIMITS.groq_free, 30, Date.UTC(2026, 9, 21, 23, 59, 30)), 'rpm|tpm|rpd|tpd',
      'in the last minute of the day both windows end together');

    // The next successful reservation on the pool clears it.
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc, 'rpc:zerox_reserve_v2': () => Response.json([okReserve({ reservation_id: 'res-ok' })]),
      'rpc:zerox_settle_v2': () => Response.json([{ status: 'settled' }]), groq: () => completion({ content: 'ok' }) });
    assert.equal((await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages }, { token: 'ses_pro' })).status, 200);
    assert.equal(poolBudgetState('groq:openai/gpt-oss-120b:free'), null);

    // Pools parked after upstream 429s answer capacity_exhausted from the router: logged as well.
    gw.tracker.recordFailure('groq:openai/gpt-oss-20b:free', { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 20 });
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc });
    const parked = await captureLogs(async () => gw.call(accountEnv(), { model: 'gpt-oss-20b', messages }, { token: 'ses_pro' }));
    await expectError(parked.result, 503, 'capacity_exhausted');
    const cooled = parked.logs.warn.find(([message]) => message === 'Neuron pools rate limited upstream');
    assert.deepEqual(cooled?.[1], { pools: ['groq:openai/gpt-oss-20b:free'], model: 'groq/openai/gpt-oss-20b',
      retry_after_seconds: 20, request_id: parked.result.headers.get('x-request-id') });
    resetPoolBudgets();
  });

  await test('failed attempts are refunded before failover and the final failure is refunded too', async () => {
    const gw = accountGateway();
    const sequence = [];
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => { sequence.push(`reserve:${call.body.p_tier}:${call.body.p_request_id}`); return Response.json([okReserve({ reservation_id: `res-${call.body.p_tier}` })]); },
      'rpc:zerox_settle_v2': call => { sequence.push(`settle:${call.body.p_reservation_id}:${call.body.p_status}:${call.body.p_error_code}`); return Response.json([{ status: 'settled' }]); },
      groq: call => call.headers.Authorization === 'Bearer groq-free-key' ? new Response('down', { status: 503 })
        : sse([chunk({ content: 'paid ok' }, 'stop'), chunk({}, null, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }), '[DONE]']) });
    const response = await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages, stream: true }, { token: 'ses_pro' });
    const requestId = response.headers.get('x-request-id');
    assert.ok((await response.text()).includes('paid ok'));
    assert.deepEqual(sequence, [`reserve:free:${requestId}`, 'settle:res-free:refunded:upstream_error', `reserve:paid:${requestId}.1`, 'settle:res-paid:ok:null']);
    const refund = rpcCalls('zerox_settle_v2')[0].body;
    assert.deepEqual([refund.p_prompt_tokens, refund.p_completion_tokens, refund.p_cost_microusd], [0, 0, 0]);
    const ok = rpcCalls('zerox_settle_v2')[1].body;
    assert.equal(ok.p_cost_microusd, costMicrousd(catalogEntry('groq/openai/gpt-oss-120b').pools[1].price, 9, 3));

    sequence.length = 0;
    handlers.groq = () => new Response('down', { status: 500 });
    await expectError(await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages }, { token: 'ses_pro' }), 502, 'upstream_error');
    assert.deepEqual(sequence.filter(item => item.startsWith('settle')), ['settle:res-free:refunded:upstream_error', 'settle:res-paid:refunded:upstream_error']);
    assert.deepEqual(gw.writes, [], 'no KV write after a DB reservation');
  });

  // Review P2 (integration): refunded attempts returned the shared pool budget even when the
  // upstream ran the model, so tool_use_failed loops and timeouts drained the free pools unseen.
  await test('attempts that reached the model settle as failed_upstream; upstream rejections stay full refunds', async () => {
    const gw = accountGateway();
    const settled = [];
    const modelError = () => Response.json({ error: { code: 'tool_use_failed', message: 'Failed to call a function', type: 'invalid_request_error' } }, { status: 400 });
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([okReserve({ reservation_id: `res-${call.body.p_tier}-${settled.length}` })]),
      'rpc:zerox_settle_v2': call => { settled.push(call.body); return Response.json([{ status: 'settled' }]); },
      groq: modelError });
    const prompt = estimatePromptTokens(messages, tools);
    await expectError(await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-20b', messages, tools }, { token: 'ses_pro' }), 502, 'upstream_error');
    assert.equal(settled.length, 1);
    assert.deepEqual([settled[0].p_status, settled[0].p_error_code, settled[0].p_prompt_tokens, settled[0].p_completion_tokens],
      ['failed_upstream', 'model_error', prompt, 0], 'a model-side rejection keeps its prompt in the pool budget');
    settled.length = 0;
    handlers.groq = untilAborted;
    await expectError(await gw.call(accountEnv(FAST), { model: 'groq/openai/gpt-oss-20b', messages, stream: true }, { token: 'ses_pro' }), 504, 'upstream_timeout');
    assert.deepEqual([settled[0].p_status, settled[0].p_error_code, settled[0].p_prompt_tokens],
      ['failed_upstream', 'upstream_timeout', estimatePromptTokens(messages)], 'so does a first-byte timeout');
    for (const status of [429, 500, 503]) {
      settled.length = 0;
      gw.tracker.reset(); // a 429 parks the pool
      handlers.groq = () => new Response('busy', { status });
      await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-20b', messages }, { token: 'ses_pro' });
      assert.deepEqual([settled[0].p_status, settled[0].p_prompt_tokens], ['refunded', 0], `HTTP ${status} is refunded to the pool`);
    }
    // Failover: the failed free attempt keeps its pool share, the paid attempt is billed.
    settled.length = 0;
    gw.tracker.reset();
    handlers.groq = call => call.headers.Authorization === 'Bearer groq-free-key' ? modelError() : completion({ content: 'paid' });
    const failover = await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-120b', messages, tools }, { token: 'ses_pro' });
    assert.equal(failover.status, 200);
    assert.deepEqual(settled.map(entry => entry.p_status), ['failed_upstream', 'ok']);
  });

  await test('paid plans keep their last attempt for paid capacity (review B2 P3)', async () => {
    const gw = accountGateway();
    const tried = [];
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([okReserve({ reservation_id: `res-${call.body.p_model}-${call.body.p_tier}` })]),
      'rpc:zerox_settle_v2': () => Response.json([{ status: 'settled' }]),
      gemini: call => {
        tried.push(`gemini:${call.headers.Authorization}`);
        return call.headers.Authorization === 'Bearer gemini-paid-key' ? completion({ content: 'paid' }) : new Response('down', { status: 503 });
      },
      groq: call => { tried.push(`groq:${call.headers.Authorization}`); return new Response('down', { status: 503 }); } });
    const response = await gw.call(accountEnv(), { model: 'auto', messages, tools }, { token: 'ses_pro', country: 'US' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-model'), 'gemini/gemini-2.5-flash');
    assert.deepEqual(tried, ['gemini:Bearer gemini-free-key', 'gemini:Bearer gemini-free-key', 'gemini:Bearer gemini-paid-key'],
      'two free attempts, then the attempt kept for the best paid pool (ROUTER_MAX_ATTEMPTS = 3)');
    const freeOnly = gateway();
    freeOnly.addSession('ses_free', { account_backed: true, user_id: ACCOUNT, plan: 'free' });
    tried.length = 0;
    await expectError(await freeOnly.call(accountEnv(), { model: 'auto', messages, tools }, { token: 'ses_free', country: 'US' }), 502, 'upstream_error');
    assert.equal(tried.length, 3, 'free plans spend every attempt on free pools');
  });

  await test('an unexpected failure after reserving releases the reservation', async () => {
    class ExplodingTracker extends ProviderHealthTracker {
      recordSuccess() { throw new Error('bug'); }
    }
    const gw = gateway({ tracker: new ExplodingTracker() });
    gw.addSession('ses_pro', { account_backed: true, user_id: ACCOUNT, plan: 'pro' });
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc, 'rpc:zerox_reserve_v2': () => Response.json([okReserve({ reservation_id: 'res-x' })]),
      'rpc:zerox_settle_v2': () => Response.json([{ status: 'settled' }]), groq: () => completion({ content: 'x' }) });
    await expectError(await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-20b', messages }, { token: 'ses_pro' }), 502, 'upstream_error');
    const settle = rpcCalls('zerox_settle_v2').map(call => call.body);
    assert.equal(settle.length, 1);
    assert.equal(settle[0].p_reservation_id, 'res-x');
    assert.equal(settle[0].p_status, 'refunded');
    assert.equal(settle[0].p_error_code, 'internal_error');
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc, 'rpc:zerox_reserve_v2': () => new Response('db down', { status: 500 }) });
    await expectError(await gw.call(accountEnv(), { model: 'groq/openai/gpt-oss-20b', messages }, { token: 'ses_pro' }), 503, 'service_unavailable');
  });

  await test('Gemini settlement bills thinking tokens and mid-stream disconnects settle as errors', async () => {
    const gw = accountGateway();
    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc,
      'rpc:zerox_reserve_v2': call => Response.json([call.body.p_tier === 'paid' ? okReserve({ reservation_id: 'res-gem' }) : { status: 'pool_exhausted' }]),
      'rpc:zerox_settle_v2': () => Response.json([{ status: 'settled' }]),
      gemini: call => {
        assert.equal(call.headers.Authorization, 'Bearer gemini-paid-key');
        return sse([chunk({ content: 'hi' }, 'stop', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 150 } }), '[DONE]']);
      } });
    const response = await gw.call(accountEnv(), { model: 'gemini/gemini-2.5-flash', messages, stream: true }, { token: 'ses_pro', country: 'US' });
    await response.text();
    const settle = rpcCalls('zerox_settle_v2')[0].body;
    assert.deepEqual([settle.p_prompt_tokens, settle.p_completion_tokens], [100, 50]);
    assert.equal(settle.p_cost_microusd, costMicrousd(catalogEntry('gemini/gemini-2.5-flash').pools[1].price, 100, 50));
    assert.equal(settle.p_upstream_model, 'gemini-2.5-flash');

    reset({ 'rpc:zerox_plan_policies_v2': policiesRpc, 'rpc:zerox_reserve_v2': () => Response.json([okReserve({ reservation_id: 'res-cut' })]),
      'rpc:zerox_settle_v2': () => Response.json([{ status: 'settled' }]),
      gemini: () => sse([chunk({ content: 'streaming' })], { hangAfter: true }) });
    const cut = await gw.call(accountEnv(), { model: 'gemini/gemini-2.5-flash', messages, stream: true }, { token: 'ses_pro', country: 'US' });
    const reader = cut.body.getReader();
    await reader.read();
    await reader.cancel();
    const disconnect = rpcCalls('zerox_settle_v2')[0].body;
    assert.equal(disconnect.p_status, 'error');
    assert.equal(disconnect.p_error_code, 'client_disconnected');
    assert.equal(disconnect.p_prompt_tokens, estimatePromptTokens(messages));
    assert.ok(disconnect.p_completion_tokens > 0);
    assert.equal(gw.tracker.getRecord('gemini:gemini-2.5-flash:free').failed_attempts, 0, 'disconnects are not provider failures');
  });

  await test('settlement arguments for refunds and estimates', () => {
    const entry = catalogEntry('gemini/gemini-2.5-flash');
    const refund = settlementArgs({ reservationId: 'r', entry, pool: entry.pools[1], usage: { total_tokens: 99 }, status: 'refunded', latencyMs: 12.4, errorCode: 'upstream_error' });
    assert.deepEqual(refund, { p_reservation_id: 'r', p_prompt_tokens: 0, p_completion_tokens: 0, p_cost_microusd: 0, p_status: 'refunded',
      p_latency_ms: 12, p_provider: 'gemini', p_upstream_model: 'gemini-2.5-flash', p_error_code: 'upstream_error' });
    const estimated = settlementArgs({ reservationId: 'r', entry, pool: entry.pools[0], usage: null, promptEstimate: 70, outputBytes: 35, status: 'error' });
    assert.deepEqual([estimated.p_prompt_tokens, estimated.p_completion_tokens, estimated.p_cost_microusd], [70, 10, 0]);
  });

  await test('plan tiers from the database gate paid pools', async () => {
    const gw = accountGateway();
    reset({ 'rpc:zerox_plan_policies_v2': () => Response.json([policyRow('free'), policyRow('pro', { allowed_tiers: ['free'] })]) });
    await expectError(await gw.call(accountEnv(), { model: 'gemini/gemini-2.5-pro', messages }, { token: 'ses_pro' }), 403, 'upgrade_required');
    assert.equal(rpcCalls('zerox_reserve_v2').length, 0, 'routing refuses before reserving');
    const anonymous = gateway();
    anonymous.addSession('ses_anon', { plan: 'pro' });
    reset({});
    await expectError(await anonymous.call({ ...KEYS }, { model: 'gemini/gemini-2.5-pro', messages }), 403, 'upgrade_required');
  });

  await test('a prompt above the free per-minute budget answers context_length_exceeded with an upgrade link', async () => {
    const gw = gateway();
    gw.addSession('ses_anon');
    reset({});
    const large = [{ role: 'user', content: 'word '.repeat(110000) }];
    assert.ok(estimatePromptTokens(large) > 120000);
    const error = await expectError(await gw.call({ ...KEYS }, { model: 'gemini/gemini-2.5-flash', messages: large, max_tokens: 4096 },
      { country: 'US' }), 400, 'context_length_exceeded');
    assert.match(error.message, /^This request is too large for the free per-minute token budget \(120,000 tokens/);
    assert.equal(error.upgrade_url, 'https://zero-x.live/pricing');
    assert.equal(error.type, 'invalid_request_error');
    const noPaid = await expectError(await gw.call({ GEMINI_API_KEY: 'g' }, { model: 'gemini/gemini-2.5-flash', messages: large },
      { country: 'US' }), 400, 'context_length_exceeded');
    assert.equal(noPaid.upgrade_url, undefined, 'no upgrade link without paid capacity');
    assert.doesNotMatch(noPaid.message, /upgrade/);
    assert.equal(gw.session('ses_anon').requests, 0, 'refused before any reservation');
  });

  // ── OpenRouter ──
  await test('BYOK OpenRouter sessions use the caller key with data_collection deny', async () => {
    const gw = gateway();
    gw.addSession('ses_byok', { openrouter_key: 'user-owned-key', owned_provider_only: true });
    const env = { ...KEYS, OPENROUTER_API_KEY: 'operator-key', OPENROUTER_MODELS: 'cohere/north-mini-code:free' };
    reset({ openrouter: call => {
      assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(call.headers.Authorization, 'Bearer user-owned-key');
      assert.deepEqual(call.body.provider, { data_collection: 'deny' });
      assert.equal(call.body.reasoning_effort, undefined);
      assert.equal(call.body.model, 'cohere/north-mini-code:free');
      return completion({ content: 'byok' });
    } });
    const response = await gw.call(env, { model: 'openai/cohere/north-mini-code:free', messages, tools, reasoning_effort: 'high' }, { token: 'ses_byok' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-model'), 'cohere/north-mini-code:free');
    assert.deepEqual(upstreamCalls()[0].body.reasoning, { effort: 'high' });
    assert.equal((await gw.call(env, { model: 'auto', messages }, { token: 'ses_byok' })).status, 200);
    await expectError(await gw.call(env, { model: 'gemini/gemini-2.5-flash', messages }, { token: 'ses_byok' }), 404, 'model_not_found');
    assert.ok(!listModelsForCaller(env).data.some(model => model.owned_by === 'openrouter'), 'operator key is not resold by default');
    const owned = await listModelsForSession(env, { session: { openrouter_key: 'user-owned-key' } });
    assert.deepEqual(owned.data.map(model => model.id), ['auto', 'cohere/north-mini-code:free']);
    assert.equal(gw.tracker.getSnapshot()['openrouter:cohere/north-mini-code:free:byok'], undefined, 'BYOK keys never affect shared health');
  });

  await test('hosted OpenRouter (OPENROUTER_HOSTED=true) also denies data collection', async () => {
    const gw = gateway();
    gw.addSession('ses_anon', {});
    reset({ openrouter: call => {
      assert.equal(call.headers.Authorization, 'Bearer operator-key');
      assert.equal(call.body.provider.data_collection, 'deny');
      return completion({ content: 'hosted' });
    } });
    const env = { OPENROUTER_API_KEY: 'operator-key', OPENROUTER_HOSTED: 'true' };
    const response = await gw.call(env, { model: 'minimax/minimax-m3.1-flash:free', messages });
    assert.equal(response.status, 200);
    await expectError(await gw.call({ OPENROUTER_API_KEY: 'operator-key' }, { model: 'minimax/minimax-m3.1-flash:free', messages }), 404, 'model_not_found');
  });
} finally {
  globalThis.fetch = originalFetch;
}

for (const name of results) console.log(`ok - ${name}`);
console.log(`PASS: ${results.length} routing v2 checks (catalog, plans, routing, health, reservations, settlement, streaming, BYOK)`);
