import assert from 'node:assert/strict';
import { ProviderAdapter, OpenAICompatibleAdapter } from './src/provider-adapter.js';
import { CloudflareWorkersAIAdapter } from './src/cloudflare-adapter.js';
import { HealthState, ProviderHealthTracker } from './src/provider-health.js';
import { RoutingEngine } from './src/router.js';
import { ADAPTERS } from './src/providers.js';
import { catalogEntry, poolKey } from './src/catalog.js';

console.log('Running Phase 1 Architecture Verification Tests...');

// 1. Adapter Abstraction & Polymorphism
assert.ok(ADAPTERS.cloudflare instanceof ProviderAdapter);
assert.ok(ADAPTERS.cloudflare instanceof CloudflareWorkersAIAdapter);
assert.ok(ADAPTERS.groq instanceof OpenAICompatibleAdapter);
assert.ok(ADAPTERS.gemini instanceof OpenAICompatibleAdapter);
assert.ok(ADAPTERS.nvidia instanceof OpenAICompatibleAdapter);
assert.ok(ADAPTERS.openrouter instanceof OpenAICompatibleAdapter);
assert.ok(ADAPTERS.omniroute instanceof OpenAICompatibleAdapter);
assert.ok(ADAPTERS.bedrock instanceof OpenAICompatibleAdapter);

const customAdapter = new OpenAICompatibleAdapter({
  id: 'custom-ai',
  keyVar: 'CUSTOM_KEY',
  modelsVar: 'CUSTOM_MODELS',
  defaultBase: 'https://custom.ai/v1',
  providerPrefix: true,
});
assert.equal(customAdapter.getBaseUrl({}), 'https://custom.ai/v1');
assert.equal(customAdapter.isConfigured({ CUSTOM_KEY: 'test' }), true);
assert.equal(customAdapter.isConfigured({}), false);
assert.equal(customAdapter.getApiKey({ CUSTOM_KEY: 'free', CUSTOM_PAID_KEY: 'paid' }, {}, { key_var: 'CUSTOM_PAID_KEY' }), 'paid');
const customEntry = customAdapter.catalogEntry({ CUSTOM_TOOL_MODELS: 'tool-model' }, 'tool-model');
assert.equal(customEntry.id, 'custom-ai/tool-model');
assert.equal(customEntry.tools, true);

// Error normalization
const normErr = customAdapter.normalizeError(429, { error: { message: 'Rate exceeded' } }, 'req_123');
assert.equal(normErr.error.type, 'rate_limit_error');
assert.equal(normErr.error.code, 'rate_limited');
assert.equal(normErr.error.request_id, 'req_123');

// Workers AI receives bare function definitions and only the parameters it supports.
const workersBody = ADAPTERS.cloudflare.requestBody({ messages: [], max_tokens: 8, tools: [{ type: 'function', function: { name: 'f' } }],
  tool_choice: 'auto', stream_options: { include_usage: true } });
assert.deepEqual(workersBody, { messages: [], max_tokens: 8, tools: [{ name: 'f' }] });

// 2. Provider Health & Circuit Breaker (keyed per pool)
const tracker = new ProviderHealthTracker();
const groqFree = poolKey(catalogEntry('groq/openai/gpt-oss-120b'), catalogEntry('groq/openai/gpt-oss-120b').pools[0]);
assert.equal(groqFree, 'groq:openai/gpt-oss-120b:free');
assert.equal(tracker.isAvailable(groqFree), true);

// Simulate failures tripping circuit breaker
tracker.recordAttempt(groqFree, { success: false, status: 500 });
assert.equal(tracker.isAvailable(groqFree), true);
tracker.recordAttempt(groqFree, { success: false, status: 500 });
assert.equal(tracker.isAvailable(groqFree), true);
tracker.recordAttempt(groqFree, { success: false, status: 500 });
// 3rd failure trips circuit breaker
assert.equal(tracker.isAvailable(groqFree), false);
const snapshot = tracker.getSnapshot();
assert.equal(snapshot[groqFree].status, HealthState.DOWN);
assert.equal(snapshot[groqFree].circuit_open, true);
assert.equal(tracker.isAvailable('groq:openai/gpt-oss-20b:free'), true, 'other models of the provider stay available');

// 429 trips circuit breaker immediately for the retry-after window
tracker.recordAttempt('gemini:gemini-2.5-flash:free', { success: false, status: 429, retryAfterSeconds: 60 });
assert.equal(tracker.isAvailable('gemini:gemini-2.5-flash:free'), false);
assert.equal(tracker.getRecord('gemini:gemini-2.5-flash:free').status, HealthState.RATE_LIMITED);
assert.ok(tracker.cooldownRemainingMs('gemini:gemini-2.5-flash:free') > 55000);

// Request-scoped rejections (413/400) and client aborts never change health
tracker.recordAttempt('gemini:gemini-3.5-flash:free', { success: false, status: 413 });
tracker.recordAttempt('gemini:gemini-3.5-flash:free', { success: false, status: 400 });
tracker.recordAttempt('gemini:gemini-3.5-flash:free', { success: false, kind: 'aborted' });
assert.equal(tracker.getRecord('gemini:gemini-3.5-flash:free').status, HealthState.HEALTHY);
assert.equal(tracker.getRecord('gemini:gemini-3.5-flash:free').failed_attempts, 0);

// A 404 parks only that model for 10 minutes
tracker.recordAttempt('gemini:gemini-2.5-pro:paid', { success: false, status: 404 });
assert.equal(tracker.getRecord('gemini:gemini-2.5-pro:paid').status, HealthState.MODEL_UNAVAILABLE);
assert.ok(tracker.cooldownRemainingMs('gemini:gemini-2.5-pro:paid') > 590000);

// Successful attempt recovers circuit breaker
tracker.recordAttempt('gemini:gemini-2.5-flash:free', { success: true, status: 200, latencyMs: 150 });
assert.equal(tracker.isAvailable('gemini:gemini-2.5-flash:free'), true);
assert.equal(tracker.getRecord('gemini:gemini-2.5-flash:free').status, HealthState.HEALTHY);

// 3. Routing Engine: deterministic quality order and capability matching over the verified catalog
const routingTracker = new ProviderHealthTracker();
const router = new RoutingEngine(routingTracker);
const env = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'g', AI: {} };
const request = overrides => router.route({ env, requestedModel: 'auto', needsTools: true, promptTokens: 400,
  maxTokens: 2048, tiers: ['free'], country: 'US', ...overrides });

const autoWithTools = request();
assert.equal(autoWithTools.candidates[0].entry.id, 'gemini/gemini-2.5-flash', 'best tool-capable model first');
assert.equal(autoWithTools.candidates.at(-1).entry.id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Workers AI is the last resort');
assert.ok(autoWithTools.candidates.every(candidate => candidate.entry.supports_tools), 'auto only picks tool-capable models');

// Unknown models and fuzzy prefixes are rejected
assert.equal(request({ requestedModel: 'unknown/model' }).error, 'model_not_found');
assert.equal(request({ requestedModel: 'openai' }).error, 'model_not_found');

// Router failover: a pool whose circuit is open is bypassed, its provider's other models are not
const flash = catalogEntry('gemini/gemini-2.5-flash');
for (let index = 0; index < 3; index++) routingTracker.recordAttempt(poolKey(flash, flash.pools[0]), { success: false, status: 500 });
const failoverRes = request();
assert.notEqual(failoverRes.candidates[0].entry.id, 'gemini/gemini-2.5-flash', 'Down pool was bypassed');
assert.equal(failoverRes.candidates[0].entry.id, 'gemini/gemini-3.5-flash', 'Healthy model of the same provider was selected');

console.log('PASS: Phase 1 ProviderAdapter, CloudflareAdapter, per-pool HealthTracker, and plan-aware RoutingEngine verified');
