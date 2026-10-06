import assert from 'node:assert/strict';
import { ProviderAdapter, OpenAICompatibleAdapter } from './src/provider-adapter.js';
import { CloudflareWorkersAIAdapter } from './src/cloudflare-adapter.js';
import { HealthState, ProviderHealthTracker } from './src/provider-health.js';
import { RoutingEngine } from './src/router.js';
import { ADAPTERS, modelCatalog } from './src/providers.js';

console.log('Running Phase 1 Architecture Verification Tests...');

// 1. Adapter Abstraction & Polymorphism
assert.ok(ADAPTERS.cloudflare instanceof ProviderAdapter);
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
const customEntry = customAdapter.catalogEntry({ CUSTOM_TOOL_MODELS: 'tool-model' }, 'tool-model');
assert.equal(customEntry.id, 'custom-ai/tool-model');
assert.equal(customEntry.tools, true);

// Error normalization
const normErr = customAdapter.normalizeError(429, { error: { message: 'Rate exceeded' } }, 'req_123');
assert.equal(normErr.error.type, 'rate_limit_error');
assert.equal(normErr.error.code, 'rate_limited');
assert.equal(normErr.error.request_id, 'req_123');

// 2. Provider Health & Circuit Breaker
const tracker = new ProviderHealthTracker();
assert.equal(tracker.isAvailable('groq'), true);

// Simulate failures tripping circuit breaker
tracker.recordAttempt('groq', { success: false, status: 500 });
assert.equal(tracker.isAvailable('groq'), true);
tracker.recordAttempt('groq', { success: false, status: 500 });
assert.equal(tracker.isAvailable('groq'), true);
tracker.recordAttempt('groq', { success: false, status: 500 });
// 3rd failure trips circuit breaker
assert.equal(tracker.isAvailable('groq'), false);
const snapshot = tracker.getSnapshot();
assert.equal(snapshot.groq.status, HealthState.DOWN);
assert.equal(snapshot.groq.circuit_open, true);

// 429 trips circuit breaker immediately
tracker.recordAttempt('gemini', { success: false, status: 429, retryAfterSeconds: 60 });
assert.equal(tracker.isAvailable('gemini'), false);
assert.equal(tracker.getRecord('gemini').status, HealthState.RATE_LIMITED);

// Successful attempt recovers circuit breaker
tracker.recordAttempt('gemini', { success: true, status: 200, latencyMs: 150 });
assert.equal(tracker.isAvailable('gemini'), true);
assert.equal(tracker.getRecord('gemini').status, HealthState.HEALTHY);

// 3. Routing Engine & Deterministic Capability Matching
const router = new RoutingEngine(tracker);
const mockCatalog = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', provider: 'cloudflare', tools: true },
  { id: 'groq/llama-3.3-70b-versatile', provider: 'groq', tools: true },
  { id: 'gemini/gemini-2.5-flash', provider: 'gemini', tools: true },
  { id: 'nvidia/simple-model', provider: 'nvidia', tools: false },
];

// auto route with tools needed: Cloudflare is preferred healthy coding default
const autoWithTools = router.selectCandidates({
  requestedModel: 'auto',
  needsTools: true,
  catalog: mockCatalog,
});
assert.equal(autoWithTools.primary.id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
assert.ok(autoWithTools.fallbacks.some(m => m.id === 'gemini/gemini-2.5-flash'));
assert.ok(!autoWithTools.fallbacks.some(m => m.id === 'nvidia/simple-model'), 'Models lacking tools are excluded');

// Requesting tool capability on non-tool model fails with capability_unsupported
const nonToolReq = router.selectCandidates({
  requestedModel: 'nvidia/simple-model',
  needsTools: true,
  catalog: mockCatalog,
});
assert.equal(nonToolReq.error, 'capability_unsupported');

// Requesting unknown model fails with model_not_found
const unknownReq = router.selectCandidates({
  requestedModel: 'unknown/model',
  catalog: mockCatalog,
});
assert.equal(unknownReq.error, 'model_not_found');

// Router failover: when primary in auto is down, healthy fallback is chosen
tracker.recordAttempt('cloudflare', { success: false, status: 500 });
tracker.recordAttempt('cloudflare', { success: false, status: 500 });
tracker.recordAttempt('cloudflare', { success: false, status: 500 });
assert.equal(tracker.isAvailable('cloudflare'), false);

const failoverRes = router.selectCandidates({
  requestedModel: 'auto',
  needsTools: true,
  catalog: mockCatalog,
});
assert.notEqual(failoverRes.primary.provider, 'cloudflare', 'Down provider was bypassed');
assert.equal(failoverRes.primary.provider, 'gemini', 'Healthy tool-capable provider was selected');

console.log('PASS: Phase 1 ProviderAdapter, CloudflareAdapter, HealthTracker, and RoutingEngine verified');
