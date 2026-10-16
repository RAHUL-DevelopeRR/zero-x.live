import assert from 'node:assert/strict';
import app from './src/index.js';
import { ADAPTERS, modelCatalog, providerConfiguration, providerHealth, requestCompletion, resolveModelCatalog } from './src/providers.js';
import { CATALOG } from './src/catalog.js';

const originalFetch = globalThis.fetch;
const providers = {
  groq: ['https://api.groq.com/openai/v1', 'GROQ_API_KEY'],
  openrouter: ['https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY'],
  nvidia: ['https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY'],
  omniroute: ['https://router.example/v1', 'OMNIROUTE_API_KEY'],
  bedrock: ['https://bedrock-mantle.us-east-1.api.aws/v1', 'BEDROCK_API_KEY'],
};
const env = { OMNIROUTE_BASE_URL: 'https://router.example/v1/', BEDROCK_REGION: 'us-east-1' };
for (const [provider, [, key]] of Object.entries(providers)) env[key] = `${provider}-test-key`;
try {
  // Operator health: discovery reaches every configured upstream without leaking keys.
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    const provider = Object.keys(providers).find(name => url === `${providers[name][0]}/models`);
    assert.ok(provider, `Unexpected URL ${url}`);
    assert.equal(options.headers.Authorization, `Bearer ${env[providers[provider][1]]}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return Response.json({ data: [{ id: 'chat-model', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
      { id: 'unknown-capabilities', pricing: { prompt: '0', completion: '0' } },
      { id: 'malformed-capabilities', supported_parameters: 'notools', pricing: { prompt: '0', completion: '0' } },
      { id: 'unknown-price', pricing: { prompt: null, completion: null } },
      { id: '' }, { id: 'image-only', architecture: { output_modalities: ['image'] } },
      { id: 'paid-model', pricing: { prompt: '1', completion: '1' } }, { id: 'disabled', active: false }] });
  };
  const health = await providerHealth(env);
  assert.equal(requests, 6);
  for (const provider of Object.keys(providers)) {
    const item = health.find(entry => entry.provider === provider);
    assert.equal(item.status, 'reachable');
    assert.equal(item.inference_checked, false);
    assert.ok(item.models.some(model => model.upstream === 'chat-model' && model.tools));
    // Tool support needs an explicit supported_parameters array (BYOK and health discovery).
    assert.equal(item.models.find(model => model.upstream === 'unknown-capabilities').tools, false);
    assert.equal(item.models.find(model => model.upstream === 'malformed-capabilities').tools, false);
    assert.ok(!item.models.some(model => ['disabled', 'image-only', ''].includes(model.upstream)));
  }
  assert.ok(!health.find(item => item.provider === 'openrouter').models.some(model => ['paid-model', 'unknown-price'].includes(model.upstream)));
  assert.ok(!JSON.stringify(health).includes('test-key'));
  await providerHealth(env);
  assert.equal(requests, 6, 'discovery results are cached');

  // The routable catalog is the verified static catalog: discovery never adds models and
  // non-hosted providers (NVIDIA trial, OpenRouter operator key) are excluded.
  const catalog = await resolveModelCatalog(env);
  assert.equal(requests, 6, 'resolving the catalog makes no network calls');
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every(model => CATALOG.some(entry => entry.id === model.id)));
  assert.ok(!catalog.some(model => model.upstream === 'chat-model'));
  assert.ok(!catalog.some(model => ['nvidia', 'openrouter', 'omniroute', 'bedrock'].includes(model.provider)));
  assert.deepEqual([...new Set(catalog.map(model => model.provider))].sort(), ['gemini', 'groq']);
  assert.ok(!catalog.some(model => model.id === 'gemini/gemini-2.5-pro'), 'paid-only models need a paid plan and key');
  const configuration = providerConfiguration({ ...env, NVIDIA_HOSTED: 'true', GROQ_MODELS: 'openai/gpt-oss-120b,made-up' });
  assert.equal(configuration.find(item => item.provider === 'nvidia').hosted, true);
  assert.equal(configuration.find(item => item.provider === 'openrouter').hosted, false);
  assert.deepEqual(configuration.find(item => item.provider === 'groq').ignored_models, ['made-up']);
  assert.deepEqual(configuration.find(item => item.provider === 'groq').catalog_models, ['groq/openai/gpt-oss-120b']);

  // Each adapter calls its own endpoint with its own key.
  globalThis.fetch = async (url, options) => {
    const provider = Object.keys(providers).find(name => url === `${providers[name][0]}/chat/completions`);
    assert.ok(provider, `Unexpected URL ${url}`);
    assert.equal(options.headers.Authorization, `Bearer ${env[providers[provider][1]]}`);
    assert.equal(JSON.parse(options.body).model, 'chat-model');
    assert.equal(options.redirect, 'error');
    return Response.json({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 3 } });
  };
  for (const provider of Object.keys(providers)) {
    const entry = { id: `${provider}/chat-model`, provider, upstream: 'chat-model' };
    assert.equal((await requestCompletion(env, {}, entry, { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 })).status, 200);
  }
  const paidEnv = { GROQ_API_KEY: 'groq-free', GROQ_PAID_API_KEY: 'groq-paid' };
  const paidEntry = CATALOG.find(entry => entry.id === 'groq/openai/gpt-oss-120b');
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer groq-paid', 'pools carry their own key');
    assert.equal(JSON.parse(options.body).model, 'openai/gpt-oss-120b');
    return Response.json({ choices: [] });
  };
  await requestCompletion(paidEnv, {}, paidEntry, { messages: [], max_tokens: 8 }, undefined, paidEntry.pools[1]);

  const runtimeEnv = { BEDROCK_API_KEY: 'runtime-test', BEDROCK_REGION: 'eu-west-1', BEDROCK_ENDPOINT: 'runtime', BEDROCK_MODELS: 'openai.gpt-oss-120b-1:0' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer runtime-test');
    return Response.json({ choices: [] });
  };
  await requestCompletion(runtimeEnv, {}, { id: 'bedrock/openai.gpt-oss-120b-1:0', provider: 'bedrock', upstream: 'openai.gpt-oss-120b-1:0' }, { messages: [], max_tokens: 8 });
  const runtimeHealth = (await providerHealth(runtimeEnv)).find(item => item.provider === 'bedrock');
  assert.equal(runtimeHealth.status, 'configured');
  assert.equal(runtimeHealth.model_count, 1);
  assert.equal(runtimeHealth.inference_checked, false);
  assert.equal((await providerHealth({ ...runtimeEnv, BEDROCK_MODELS: undefined })).find(item => item.provider === 'bedrock').status, 'allowlist_required');
  assert.equal(modelCatalog(runtimeEnv).length, 0, 'operator-custom providers are not in the hosted catalog');
  assert.equal(ADAPTERS.bedrock.isConfigured({ ...runtimeEnv, BEDROCK_REGION: 'https://evil.example' }), false);
  assert.equal(ADAPTERS.omniroute.isConfigured({ OMNIROUTE_API_KEY: 'x', OMNIROUTE_BASE_URL: 'https://user:password@example.com/v1' }), false);

  // BYOK: a caller's own OpenRouter key discovers only their models and nothing else.
  let ownedRequests = 0;
  globalThis.fetch = async (url, options) => {
    ownedRequests++;
    assert.equal(url, 'https://openrouter.ai/api/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer owned-key');
    return Response.json({ data: [{ id: 'owned-only', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] });
  };
  const owned = await resolveModelCatalog(env, { owned_provider_only: true, openrouter_key: 'owned-key' });
  assert.ok(owned.every(item => item.provider === 'openrouter'));
  assert.ok(owned.some(item => item.id === 'owned-only'));
  assert.ok(owned.every(item => item.pools[0].tier === 'byok'));
  assert.equal(ownedRequests, 1);
  assert.ok(!catalog.some(item => item.id === 'owned-only'));

  // Provisioned accounts always use server-side keys, never a stale user key.
  const managedSession = { account_backed: true, owned_provider_only: true, openrouter_key: 'stale-user-key' };
  const managedEnv = { AI: { run: async () => ({ response: 'OK' }) }, OPENROUTER_API_KEY: 'server-key', OPENROUTER_MODELS: 'cohere/north-mini-code:free' };
  const managedCatalog = await resolveModelCatalog(managedEnv, managedSession);
  assert.equal(managedCatalog[0].provider, 'cloudflare', 'Provisioned accounts keep the server-backed coding default');
  assert.ok(managedCatalog[0].tools);
  assert.ok(!managedCatalog.some(model => model.provider === 'openrouter'), 'operator OpenRouter needs OPENROUTER_HOSTED');
  const hostedCatalog = await resolveModelCatalog({ ...managedEnv, OPENROUTER_HOSTED: 'true' }, managedSession);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer server-key', 'Provisioned accounts never depend on a user provider key');
    assert.equal(JSON.parse(options.body).provider.data_collection, 'deny');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  await requestCompletion(managedEnv, managedSession, hostedCatalog.find(model => model.provider === 'openrouter'), { messages: [], max_tokens: 8 });
  assert.equal(modelCatalog({ AI: managedEnv.AI }, managedSession)[0].provider, 'cloudflare');

  // A failed discovery is reported to operators but does not change the verified catalog.
  globalThis.fetch = async () => new Response('sensitive provider diagnostics secret-token', { status: 401 });
  const failedEnv = { GROQ_API_KEY: 'secret-token' };
  const failedHealth = await providerHealth(failedEnv);
  assert.equal(failedHealth.find(item => item.provider === 'groq').status, 'unauthorized');
  assert.ok(!JSON.stringify(failedHealth).includes('secret-token'));
  assert.deepEqual((await resolveModelCatalog(failedEnv)).map(model => model.id),
    ['groq/openai/gpt-oss-120b', 'groq/qwen/qwen3.8-27b', 'groq/openai/gpt-oss-20b']);

  const sessions = new Map([['ses_probe', JSON.stringify({ created: Date.now(), plan: 'free', requests: 0,
    tokens_used: 0, usage_day: new Date().toISOString().slice(0, 10) })]]);
  const probeEnv = { GATEWAY_ADMIN_TOKEN: 'operator-test-token-with-32-characters', ALLOW_ANONYMOUS_SESSIONS: 'true', AI: { run: async (_, payload) => {
    assert.equal(payload.max_tokens, 8);
    return { response: 'OK', usage: { total_tokens: 3 } };
  } }, SESSIONS_KV: { get: async key => sessions.get(key), put: async (key, value) => sessions.set(key, value) } };
  const probe = (path, model, token = 'ses_probe') => app.request(`https://zero-x.live${path}`, {
    method: model ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(model ? { body: JSON.stringify({ model }) } : {}),
  }, probeEnv);
  assert.equal((await probe('/v1/providers/health', null, 'bad')).status, 401);
  assert.equal((await probe('/v1/providers/health', null)).status, 401);
  assert.equal((await probe('/v1/providers/health', null, probeEnv.GATEWAY_ADMIN_TOKEN)).status, 200);
  assert.equal((await probe('/v1/models/health', 'auto', 'bad')).status, 401);
  const response = await probe('/v1/models/health', 'auto');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'healthy');
  assert.equal(JSON.parse(sessions.get('ses_probe')).tokens_used, 3);
  assert.equal(JSON.parse(sessions.get('ses_probe')).requests, 1);
  probeEnv.AI.run = async () => ({ response: '' });
  assert.equal((await probe('/v1/models/health', 'auto')).status, 502);
  sessions.set('ses_probe', JSON.stringify({ ...JSON.parse(sessions.get('ses_probe')), tokens_used: 256000 }));
  assert.equal((await probe('/v1/models/health', 'auto')).status, 429);
  console.log('Provider discovery health, verified catalog, per-pool credentials, credential isolation and quota-backed inference probes passed');
} finally { globalThis.fetch = originalFetch; }
