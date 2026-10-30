import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import app from './src/index.js';
import { ADAPTERS, PROVIDER_PARAMS, buildUpstreamPayload, classifyUpstreamFailure, createCompletionStream, modelCatalog,
  providerConfiguration, providerHealth, requestCompletion, resolveModelCatalog, startCompletion } from './src/providers.js';
import { CATALOG } from './src/catalog.js';
import { KEY_SLOTS, PROVIDER_TYPES, baseUrlFor } from './src/catalog-types.js';
import { BUILTIN_OFFERS, loadOffers, offerById } from './src/oiop/offers.js';

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
    assert.equal(options.redirect, 'manual');
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
    assert.equal(options.redirect, 'manual');
    return Response.json({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 3 } });
  };
  for (const provider of Object.keys(providers)) {
    const entry = { id: `${provider}/chat-model`, provider, upstream: 'chat-model' };
    assert.equal((await requestCompletion(env, {}, entry, { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 })).status, 200);
  }

  // A redirect is never followed with the key: the 3xx comes back and fails the attempt.
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } });
  };
  const redirected = await startCompletion(env, {}, { id: 'groq/chat-model', provider: 'groq', upstream: 'chat-model' },
    null, { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 8 });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.status, 302);
  assert.equal(classifyUpstreamFailure(redirected.status, redirected.bodyText).kind, 'server');

  // The Workers runtime throws on fetch(..., { redirect: 'error' }) ("does not make sense at the
  // edge"), which failed every Groq, Gemini, NVIDIA and OpenRouter call in production.
  const sources = readdirSync(new URL('./src/', import.meta.url), { recursive: true })
    .filter(file => String(file).endsWith('.js'));
  for (const file of sources) {
    const text = readFileSync(new URL(`./src/${String(file).replaceAll('\\', '/')}`, import.meta.url), 'utf8');
    assert.ok(!/redirect:\s*['"]error['"]/.test(text), `src/${file} uses redirect: 'error', which Workers rejects`);
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
  const response = await probe('/v1/models/health', 'llama-3.3-70b');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'healthy');
  assert.equal(JSON.parse(sessions.get('ses_probe')).tokens_used, 3);
  assert.equal(JSON.parse(sessions.get('ses_probe')).requests, 1);
  // Workers AI llama-3.3 is explicit-only, so a gateway with only the AI binding has no auto model.
  assert.equal((await probe('/v1/models/health', 'auto')).status, 503);
  probeEnv.AI.run = async () => ({ response: '' });
  assert.equal((await probe('/v1/models/health', 'llama-3.3-70b')).status, 502);
  sessions.set('ses_probe', JSON.stringify({ ...JSON.parse(sessions.get('ses_probe')), tokens_used: 256000 }));
  assert.equal((await probe('/v1/models/health', 'llama-3.3-70b')).status, 429);
  // onFinish settles the attempt's reservation (and frees its concurrency slot), so a committed
  // stream calls it exactly once even when releasing the upstream reader fails: on an upstream
  // error, on a client cancel, when the stream's idle watchdog fires and after [DONE].
  for (const scenario of ['upstream_error', 'client_cancel', 'idle_timeout', 'done']) {
    const finishes = [];
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const pending = [JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), '[DONE]'];
    // Like a ReadableStream reader, a cancel ends the read in flight even when it rejects.
    let endRead = () => {};
    const reader = {
      lastByteAt: Date.now(),
      next: scenario === 'upstream_error' ? async () => { throw new Error('connection reset'); }
        : scenario === 'done' ? async () => pending.shift() ?? new Promise(() => {})
          : () => new Promise(resolve => { endRead = () => resolve(null); }),
      cancel: async () => {
        endRead();
        throw new Error('cancel failed');
      },
    };
    const stream = createCompletionStream({ reader, first: JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
      model: 'groq/chat-model', controller: new AbortController(), clientSignal: null,
      timeouts: { idleMs: scenario === 'idle_timeout' ? 30 : 60000 },
      onFinish: async outcome => { finishes.push(outcome); }, requestId: 'req_cancel', env: {} });
    const client = stream.getReader();
    let text = new TextDecoder().decode((await client.read()).value);
    if (scenario === 'client_cancel') await client.cancel();
    else for (let read = await client.read(); !read.done; read = await client.read()) text += new TextDecoder().decode(read.value);
    await new Promise(resolve => setTimeout(resolve, 20));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(finishes.length, 1, `${scenario}: onFinish runs exactly once`);
    assert.equal(finishes[0].status, scenario === 'done' ? 'ok' : 'error', scenario);
    const errorCode = { upstream_error: 'upstream_error', client_cancel: 'client_disconnected', idle_timeout: 'upstream_timeout' }[scenario];
    if (scenario !== 'done') assert.equal(finishes[0].errorCode, errorCode);
    if (scenario === 'upstream_error' || scenario === 'idle_timeout') assert.match(text, new RegExp(errorCode), 'the client still gets the error event');
    if (scenario === 'done') assert.match(text, /\[DONE\]/);
    assert.deepEqual(unhandled, [], `${scenario}: a failed cancel is not an unhandled rejection`);
  }
  // Upstream hosts come from the provider-type registry (src/catalog-types.js) only.
  for (const type of ['gemini', 'groq', 'nvidia', 'openrouter']) {
    assert.equal(ADAPTERS[type].getBaseUrl({}), PROVIDER_TYPES[type].base_url, `${type}: the adapter calls the registry's base URL`);
  }
  const omniEnv = { OMNIROUTE_BASE_URL: 'https://router.example/v1/' };
  assert.equal(ADAPTERS.omniroute.getBaseUrl(omniEnv), baseUrlFor('omniroute', omniEnv));
  assert.equal(ADAPTERS.omniroute.getBaseUrl({ OMNIROUTE_BASE_URL: 'http://router.example/v1' }), null, 'plain http only on loopback');
  // An offer's base_url is display only: a database offer naming another host never moves a request.
  const offerEnv = { SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SECRET_KEY: 'sb_secret_check', GEMINI_API_KEY: 'gemini-key' };
  const fetched = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/rpc/zerox_offers_list')) {
      return Response.json(BUILTIN_OFFERS.map(offer => ({ ...offer, base_url: 'https://evil.example/v1' })));
    }
    fetched.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer gemini-key');
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  await loadOffers(offerEnv);
  assert.equal(offerById(offerEnv, 'gemini.free').base_url, 'https://evil.example/v1');
  const flash = CATALOG.find(entry => entry.id === 'gemini/gemini-2.5-flash');
  assert.equal((await requestCompletion(offerEnv, {}, flash, { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 8 }, undefined,
    flash.pools[0])).status, 200);
  assert.deepEqual(fetched, ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']);

  // Workers AI REST fallback: model ids are encoded per path segment and dot segments are refused.
  const restEnv = { CLOUDFLARE_ACCOUNT_ID: 'acct/1', CLOUDFLARE_API_TOKEN: 'cf-token' };
  const llama = CATALOG.find(entry => entry.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  const restUrls = [];
  globalThis.fetch = async (url, options) => {
    restUrls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer cf-token');
    return Response.json({ success: true, result: { response: 'OK' } });
  };
  const hello = { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 8 };
  assert.equal((await requestCompletion(restEnv, {}, llama, hello)).status, 200);
  assert.equal((await requestCompletion(restEnv, {}, { ...llama, upstream_model: '@cf/acme/model?x=1#y' }, hello)).status, 200);
  assert.deepEqual(restUrls, ['https://api.cloudflare.com/client/v4/accounts/acct%2F1/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    'https://api.cloudflare.com/client/v4/accounts/acct%2F1/ai/run/@cf/acme/model%3Fx%3D1%23y']);
  for (const model of ['@cf/../../accounts/x', '@cf/meta/..', '@cf/%2e%2E/x', '@cf//x', '@cf/meta/.']) {
    await assert.rejects(requestCompletion(restEnv, {}, { ...llama, upstream_model: model }, hello), /not a plain model path/, model);
  }
  assert.equal(restUrls.length, 2, 'a refused id never reaches the network');

  // Claude: registered with the catalog's key slot, sampling parameters filtered, only
  // api.anthropic.com, never a followed redirect.
  const sonnet = CATALOG.find(entry => entry.id === 'anthropic/claude-sonnet-5-5');
  assert.equal(ADAPTERS.anthropic.id, 'anthropic');
  assert.equal(ADAPTERS.anthropic.getBaseUrl(), 'https://api.anthropic.com/v1');
  assert.equal(ADAPTERS.anthropic.getBaseUrl(), `${PROVIDER_TYPES.anthropic.base_url}/v1`);
  assert.deepEqual(sonnet.pools.map(pool => [pool.tier, pool.key_slot, pool.key_var]), [['paid', 'anthropic.paid', 'ANTHROPIC_API_KEY']]);
  assert.deepEqual(PROVIDER_PARAMS.anthropic, ['tools', 'tool_choice', 'stop', 'response_format', 'parallel_tool_calls', 'reasoning_effort']);
  const claudePayload = buildUpstreamPayload(sonnet, { messages: [{ role: 'user', content: 'Hi' }], temperature: 0.3, top_p: 0.9, seed: 1,
    user: 'u', presence_penalty: 1, frequency_penalty: 1, reasoning_effort: 'high' }, 1024);
  assert.ok(!['temperature', 'top_p', 'seed', 'user', 'presence_penalty', 'frequency_penalty'].some(name => name in claudePayload));
  assert.equal(claudePayload.reasoning_effort, 'high');
  const claudeEnv = { ANTHROPIC_API_KEY: 'sk-ant-api03-providers-check' };
  const claudeCalls = [];
  globalThis.fetch = async (url, options) => {
    claudeCalls.push(String(url));
    assert.equal(options.redirect, 'manual', 'x-api-key must never follow a redirect');
    assert.equal(new Headers(options.headers).get('x-api-key'), claudeEnv.ANTHROPIC_API_KEY);
    const body = JSON.parse(options.body);
    assert.ok(!('temperature' in body) && !('top_p' in body) && !('top_k' in body));
    return new Response('moved', { status: 302, headers: { Location: 'https://evil.example/v1/messages' } });
  };
  const claudeRedirect = await startCompletion(claudeEnv, {}, sonnet, sonnet.pools[0], claudePayload);
  assert.deepEqual([claudeRedirect.ok, claudeRedirect.status], [false, 302]);
  assert.equal(classifyUpstreamFailure(claudeRedirect.status, claudeRedirect.bodyText).kind, 'server');
  assert.ok(!claudeRedirect.bodyText.includes('evil.example'), 'a redirect body is never forwarded');
  assert.deepEqual(claudeCalls, ['https://api.anthropic.com/v1/messages?beta=true']);
  const claudeConfig = providerConfiguration(claudeEnv).find(item => item.provider === 'anthropic');
  assert.deepEqual([claudeConfig.configured, claudeConfig.catalog_source, claudeConfig.catalog_models],
    [true, 'allowlist', ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5']]);
  assert.equal(providerConfiguration({}).find(item => item.provider === 'anthropic').configured, false);
  const claudeHealth = (await providerHealth(claudeEnv)).find(item => item.provider === 'anthropic');
  assert.deepEqual([claudeHealth.status, claudeHealth.model_count, claudeHealth.inference_checked], ['configured', 2, false],
    'operator health lists the Claude rows without a paid call');
  assert.equal(claudeCalls.length, 1);

  // deploy.yml pushes every provider key the hosted catalog reads: a secret missing from
  // OPTIONAL_SECRETS or from either env block never reaches the Worker.
  const workflow = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const optional = workflow.match(/OPTIONAL_SECRETS: ([^\n]+)/)[1].trim().split(/\s+/);
  const catalogKeys = [...new Set(CATALOG.flatMap(entry => entry.pools.map(pool => pool.key_var)).filter(Boolean))].sort();
  assert.deepEqual(catalogKeys, ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_PAID_API_KEY', 'GROQ_API_KEY', 'GROQ_PAID_API_KEY',
    'NVIDIA_API_KEY', 'OPENROUTER_API_KEY']);
  for (const name of catalogKeys) {
    assert.ok(Object.values(KEY_SLOTS).some(slot => slot.env === name), `${name} is a key slot`);
    assert.ok(optional.includes(name), `${name} is in deploy.yml OPTIONAL_SECRETS`);
    assert.equal(workflow.split(`          ${name}: \${{ secrets.${name} }}\n`).length - 1, 2, `${name} is in both deploy.yml env blocks`);
  }
  console.log('Provider discovery health, verified catalog, per-pool credentials, credential isolation and quota-backed inference probes passed');
  console.log('Registry base URLs (offers never move a request), Workers AI path encoding, the Claude adapter (slot, filtered params, api.anthropic.com only, redirect manual) and deploy.yml provider secrets passed');
} finally { globalThis.fetch = originalFetch; }
