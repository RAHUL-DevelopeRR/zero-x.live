import { CloudflareWorkersAIAdapter } from './cloudflare-adapter.js';
import { OpenAICompatibleAdapter, partialUsageOf } from './provider-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { toolCallSignature } from './provider-request.js';
import { FailureKind, failureKindForStatus } from './provider-health.js';
import {
  AUTO_MODEL_ID, catalogEntries, catalogEntry, catalogWarnings, entryPools, isHosted, isEnabled, listModelsForCaller,
  loadCatalog, offeredEntries, poolConfigured, planPolicy,
} from './catalog.js';
import { PROVIDER_TYPES, baseUrlFor } from './catalog-types.js';
import { vaultKeys } from './provider-keys.js';
import { errorEvent } from './errors.js';
import { sessionTiers } from './capacity.js';
import { estimatePromptTokens, estimateOutputTokens, publicPricing, utf8Bytes } from './pricing.js';

export { estimatePromptTokens };

// OMNIROUTE_BASE_URL as the provider-type registry validates it (https, or http on loopback).
const omnirouteBaseResolver = env => baseUrlFor('omniroute', env);

function bedrockBaseResolver(env) {
  const region = env.BEDROCK_REGION || env.AWS_REGION;
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return null;
  return env.BEDROCK_ENDPOINT === 'runtime'
    ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`
    : `https://bedrock-mantle.${region}.api.aws/v1`;
}

// Catalog providers call the base URL of their provider type (src/catalog-types.js), the only
// place upstream hosts are defined: neither catalog rows nor OIOP offers (zerox_offers.base_url,
// display only) can choose where a request or a key goes.
export const ADAPTERS = {
  cloudflare: new CloudflareWorkersAIAdapter(),
  openrouter: new OpenAICompatibleAdapter({
    id: 'openrouter',
    keyVar: 'OPENROUTER_API_KEY',
    modelsVar: 'OPENROUTER_MODELS',
    defaultBase: PROVIDER_TYPES.openrouter.base_url,
    defaultFallbackModels: ['openrouter/free'],
  }),
  groq: new OpenAICompatibleAdapter({
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    modelsVar: 'GROQ_MODELS',
    toolModelsVar: 'GROQ_TOOL_MODELS',
    defaultBase: PROVIDER_TYPES.groq.base_url,
    providerPrefix: true,
  }),
  gemini: new OpenAICompatibleAdapter({
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    modelsVar: 'GEMINI_MODELS',
    toolModelsVar: 'GEMINI_TOOL_MODELS',
    defaultBase: PROVIDER_TYPES.gemini.base_url,
    providerPrefix: true,
  }),
  nvidia: new OpenAICompatibleAdapter({
    id: 'nvidia',
    keyVar: 'NVIDIA_API_KEY',
    modelsVar: 'NVIDIA_MODELS',
    toolModelsVar: 'NVIDIA_TOOL_MODELS',
    defaultBase: PROVIDER_TYPES.nvidia.base_url,
    providerPrefix: true,
  }),
  // Claude Sonnet 5.5 and Opus 5.5 (Messages API through @anthropic-ai/sdk): api.anthropic.com
  // only, never a followed redirect, key from the anthropic.paid slot (ANTHROPIC_API_KEY).
  anthropic: new AnthropicAdapter(),
  omniroute: new OpenAICompatibleAdapter({
    id: 'omniroute',
    keyVar: 'OMNIROUTE_API_KEY',
    modelsVar: 'OMNIROUTE_MODELS',
    toolModelsVar: 'OMNIROUTE_TOOL_MODELS',
    providerPrefix: true,
    customBaseResolver: omnirouteBaseResolver,
  }),
  bedrock: new OpenAICompatibleAdapter({
    id: 'bedrock',
    keyVar: 'BEDROCK_API_KEY',
    modelsVar: 'BEDROCK_MODELS',
    toolModelsVar: 'BEDROCK_TOOL_MODELS',
    providerPrefix: true,
    customBaseResolver: bedrockBaseResolver,
  }),
  azure: new OpenAICompatibleAdapter({
    id: 'azure',
    keyVar: 'AZURE_OPENAI_API_KEY',
    modelsVar: 'AZURE_MODELS',
    defaultBase: '',
  }),
};

const HTTP_PROVIDER_KEYS = ['openrouter', 'groq', 'gemini', 'nvidia', 'anthropic', 'omniroute', 'bedrock', 'azure'];
const HOSTED_FLAGS = { nvidia: 'NVIDIA_HOSTED', openrouter: 'OPENROUTER_HOSTED' };

export function providerConfiguration(env, session = {}) {
  const warnings = catalogWarnings(env);
  return HTTP_PROVIDER_KEYS.map(provider => {
    const adapter = ADAPTERS[provider];
    const entries = catalogEntries(env).filter(entry => entry.provider === provider);
    return {
      provider,
      configured: adapter ? adapter.isConfigured(env, session) || vaultKeys(env).some(key => key.provider === provider) : false,
      vault_keys: vaultKeys(env).filter(key => key.provider === provider).length,
      catalog_source: adapter ? adapter.catalogSource(env) : 'discovery',
      hosted: HOSTED_FLAGS[provider] ? env[HOSTED_FLAGS[provider]] === 'true' : entries.length > 0,
      catalog_models: entries.filter(entry => isHosted(env, entry) && isEnabled(env, entry)).map(entry => entry.id),
      ignored_models: warnings.find(item => item.variable === adapter?.modelsVar)?.ignored_models || [],
    };
  });
}

// ── Catalog views used by session/account responses ──

const OWNED_POOL = Object.freeze({ tier: 'byok' });

// Sessions created from the caller's own OpenRouter key (PKCE flow) never use operator keys.
export function isOwnedSession(session = {}) {
  return Boolean(session?.openrouter_key && !session.account_backed);
}

function ownedEntry(model) {
  return {
    ...model,
    upstream_model: model.upstream_model || model.upstream,
    supports_tools: Boolean(model.supports_tools ?? model.tools),
    pools: [OWNED_POOL],
    tiers: ['free'],
    pricing: null,
  };
}

function legacyEntry(entry, pools) {
  const paid = pools.find(pool => pool.tier === 'paid' && pool.price);
  return {
    id: entry.id,
    upstream: entry.upstream_model,
    upstream_model: entry.upstream_model,
    provider: entry.provider,
    display_name: entry.display_name,
    tools: entry.supports_tools,
    supports_tools: entry.supports_tools,
    supports_streaming: entry.supports_streaming,
    supports_parallel_tools: entry.supports_tools,
    context_window: entry.context_window,
    max_output_tokens: entry.max_output_tokens,
    tiers: [...new Set(pools.map(pool => pool.tier))],
    pools,
    pricing: publicPricing(paid?.price),
  };
}

// Hosted models the session's plan can use (configured pools only; region checks happen
// per request because they depend on the caller's connection).
export function modelCatalog(env, session = {}) {
  if (isOwnedSession(session)) return ADAPTERS.openrouter.listStaticModels(env, session).map(ownedEntry);
  if (session.owned_provider_only && !session.account_backed) return [];
  const tiers = sessionTiers(env, session, planPolicy(env, session.plan));
  const catalog = [];
  for (const entry of offeredEntries(env)) {
    const pools = entryPools(env, entry).filter(pool => tiers.includes(pool.tier) && poolConfigured(env, entry, pool));
    if (pools.length) catalog.push(legacyEntry(entry, pools));
  }
  return catalog;
}

const discoveryCache = new WeakMap();

async function discoverProviderCached(env, session, provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return { provider, status: 'unavailable', models: [] };

  if (adapter.catalogSource(env) === 'allowlist') {
    const models = adapter.listStaticModels(env, session);
    return {
      provider,
      status: models.length ? 'configured' : 'allowlist_required',
      discovery: false,
      models,
    };
  }

  let cache = discoveryCache.get(env);
  if (!cache) {
    cache = new Map();
    discoveryCache.set(env, cache);
  }

  const key = `${provider}:${adapter.getBaseUrl(env)}:${adapter.getApiKey(env, session)}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.promise;
  }

  const promise = adapter.discoverModels(env, session);
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(key, { promise, expires: Date.now() + 60000 });
  return promise;
}

// The caller's own OpenRouter models (allowlist or free-model discovery with their key).
export async function ownedCatalog(env, session) {
  if (!isOwnedSession(session) || !ADAPTERS.openrouter.isConfigured(env, session)) return [];
  const discovery = await discoverProviderCached(env, session, 'openrouter');
  return discovery.models.map(ownedEntry);
}

export async function resolveModelCatalog(env, session = {}) {
  if (isOwnedSession(session)) return ownedCatalog(env, session);
  await loadCatalog(env);
  return modelCatalog(env, session);
}

// Operator diagnostics: reachability of each configured upstream (no inference).
export async function providerHealth(env) {
  const healthList = [];
  for (const provider of HTTP_PROVIDER_KEYS) {
    const adapter = ADAPTERS[provider];
    if (!adapter || !adapter.isConfigured(env)) continue;

    const item = await discoverProviderCached(env, {}, provider);
    healthList.push({
      ...item,
      inference_checked: false,
      model_count: item.models.length,
    });
  }
  return healthList;
}

// Contract §3.2 item for a catalog view entry (the entry is usable for the caller).
export function publicModel(model) {
  const entry = catalogEntry(model.id);
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.provider,
    display_name: model.display_name || entry?.display_name || model.id,
    context_window: model.context_window ?? entry?.context_window ?? null,
    max_output_tokens: model.max_output_tokens ?? entry?.max_output_tokens ?? null,
    capabilities: { tools: Boolean(model.supports_tools ?? model.tools), streaming: model.supports_streaming !== false },
    tiers: model.tiers || ['free'],
    available: true,
    unavailable_reason: null,
    pricing: model.pricing ?? null,
  };
}

// GET /v1/models for an authenticated session: BYOK sessions list their own models.
export async function listModelsForSession(env, { plan, country, session } = {}) {
  if (!isOwnedSession(session)) return listModelsForCaller(env, { plan, country });
  const models = (await ownedCatalog(env, session)).map(publicModel);
  const tools = models.filter(model => model.capabilities.tools);
  const auto = {
    id: AUTO_MODEL_ID, object: 'model', created: 0, owned_by: 'openrouter',
    display_name: 'Auto (your OpenRouter models)',
    context_window: Math.max(0, ...tools.map(model => model.context_window || 0)),
    max_output_tokens: Math.max(0, ...tools.map(model => model.max_output_tokens || 0)),
    capabilities: { tools: true, streaming: true }, tiers: ['free'], available: tools.length > 0,
    unavailable_reason: tools.length ? null : 'not_configured', pricing: null,
  };
  return { object: 'list', data: [auto, ...models] };
}

// ── Request shaping ──

// Safe OpenAI parameters each upstream accepts. Anything else is dropped rather than
// risking a provider-specific 400 (e.g. Gemini rejects penalties, Workers AI tool_choice).
const SHARED_PARAMS = ['tools', 'tool_choice', 'stop', 'temperature', 'top_p', 'seed', 'response_format'];
export const PROVIDER_PARAMS = Object.freeze({
  groq: [...SHARED_PARAMS, 'parallel_tool_calls', 'presence_penalty', 'frequency_penalty', 'user', 'reasoning_effort'],
  gemini: [...SHARED_PARAMS, 'reasoning_effort'],
  nvidia: [...SHARED_PARAMS, 'presence_penalty', 'frequency_penalty'],
  openrouter: [...SHARED_PARAMS, 'parallel_tool_calls', 'presence_penalty', 'frequency_penalty', 'user', 'reasoning_effort'],
  cloudflare: ['tools', 'temperature', 'top_p', 'seed', 'presence_penalty', 'frequency_penalty'],
  // Claude 5.5 rejects sampling parameters (temperature, top_p, top_k) and the adapter builds its
  // body from a whitelist anyway (src/anthropic-request.js); this list is the first filter.
  anthropic: ['tools', 'tool_choice', 'stop', 'response_format', 'parallel_tool_calls', 'reasoning_effort'],
});
const STANDARD_EFFORTS = new Set(['low', 'medium', 'high']);

function mappedEffort(entry, value) {
  if (typeof value !== 'string') return undefined;
  const efforts = entry.reasoning_efforts || [];
  // Models without a verified effort list (BYOK, evaluation models) get standard values only.
  if (!efforts.length) return STANDARD_EFFORTS.has(value) ? value : undefined;
  if (efforts.includes(value)) return value;
  return entry.reasoning_effort_map?.[value];
}

export function buildUpstreamPayload(entry, body, maxTokens) {
  const payload = {
    // `developer` is OpenAI-only; every upstream here understands `system`.
    messages: body.messages.map(message => message.role === 'developer' ? { ...message, role: 'system' } : message),
    max_tokens: maxTokens,
    stream: Boolean(body.stream),
  };
  for (const name of PROVIDER_PARAMS[entry.provider] || PROVIDER_PARAMS.groq) {
    if (body[name] !== undefined && body[name] !== null) payload[name] = body[name];
  }
  if (payload.reasoning_effort !== undefined) {
    const effort = mappedEffort(entry, payload.reasoning_effort);
    delete payload.reasoning_effort;
    if (effort && entry.provider === 'openrouter') payload.reasoning = { effort };
    else if (effort) payload.reasoning_effort = effort;
  }
  if (!Array.isArray(payload.tools) || !payload.tools.length) {
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
  }
  return payload;
}

// ── Response normalization ──

function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '')}`;
}

function argumentsText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

// `onToolSignature({id, name, signature})` receives Gemini thought signatures, which are not
// forwarded to clients (see provider-request.js).
function normalizeCalls(calls = [], onToolSignature = null) {
  return calls.filter(call => call && typeof call === 'object').map(call => {
    const fn = call.function || { name: call.name, arguments: call.arguments };
    const id = typeof call.id === 'string' && call.id ? call.id : newCallId();
    const signature = toolCallSignature(call);
    if (signature && onToolSignature) onToolSignature({ id, name: fn.name, signature });
    return {
      id,
      type: 'function',
      function: { name: fn.name, arguments: argumentsText(fn.arguments) },
    };
  });
}

function normalizeReasoning(target) {
  if (typeof target.reasoning === 'string' && typeof target.reasoning_content !== 'string') {
    target.reasoning_content = target.reasoning;
  }
  delete target.reasoning;
  delete target.reasoning_details;
  return target;
}

function normalizeChoice(choice, position, onToolSignature) {
  const message = normalizeReasoning({ role: 'assistant', ...(choice?.message || {}) });
  delete message.extra_content;
  const calls = Array.isArray(message.tool_calls) ? normalizeCalls(message.tool_calls, onToolSignature) : [];
  if (calls.length) message.tool_calls = calls;
  else delete message.tool_calls;
  if (message.content === undefined) message.content = calls.length ? null : '';
  let finish = choice?.finish_reason ?? (calls.length ? 'tool_calls' : 'stop');
  if (finish === 'stop' && calls.length) finish = 'tool_calls';
  return { index: Number.isInteger(choice?.index) ? choice.index : position, message, finish_reason: finish };
}

export function normalizeCompletion(result, model, messages, tools, { onToolSignature = null } = {}) {
  if (!result || typeof result !== 'object') throw new Error('Provider returned an invalid completion');
  const created = Math.floor(Date.now() / 1000);
  if (Array.isArray(result.choices)) {
    const choices = result.choices.map((choice, position) => normalizeChoice(choice, position, onToolSignature));
    const outputBytes = choices.reduce((sum, choice) => sum + utf8Bytes(choice.message.content || '') +
      utf8Bytes(choice.message.reasoning_content || '') + utf8Bytes(choice.message.tool_calls || ''), 0);
    const promptTokens = estimatePromptTokens(messages, tools);
    const completionTokens = estimateOutputTokens(outputBytes);
    return {
      id: typeof result.id === 'string' && result.id ? result.id : `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Number.isInteger(result.created) ? result.created : created,
      model,
      choices,
      usage: result.usage || { prompt_tokens: promptTokens, completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens, estimated: true },
    };
  }
  // Workers AI native shape: { response, tool_calls, usage }.
  const calls = normalizeCalls(result.tool_calls);
  const content = result.response ?? result.text ?? '';
  const completion = estimateOutputTokens(utf8Bytes(content) + utf8Bytes(calls));
  const promptTokens = estimatePromptTokens(messages, tools);
  const usage = result.usage || {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
    estimated: true,
  };
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: calls.length && !content ? null : content,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: calls.length ? 'tool_calls' : 'stop',
    }],
    usage,
  };
}

// `request` carries per-request shaping context for the adapter ({ signatureFor }).
export async function requestCompletion(env, session, entry, body, signal, pool, request = {}) {
  const adapter = ADAPTERS[entry.provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${entry.provider}`);
  }
  if (entry.provider === 'cloudflare') {
    return adapter.chatCompletion(env, session, entry, body, signal, normalizeCompletion);
  }
  return adapter.chatCompletion(env, session, entry, body, signal, pool || entry.pools?.[0] || null, request);
}

// ── Upstream failure classification ──
//
// Upstream error messages can quote client input (e.g. Gemini echoes unknown schema field
// names), so pool-wide states (model unavailable, auth, rate limits and their delays) come
// only from the HTTP status and from structured fields compared with fixed values. Message
// text may only choose between request-scoped kinds (context vs. invalid).

const CONTEXT_PATTERN = /context[ _-]?(length|window)|maximum context|too many tokens|token limit|request too large|reduce the length|(input|prompt|request|message)s? (is |are )?too (long|large)|exceeds the (maximum|max|limit)/;

// google.rpc status names (Gemini) to HTTP statuses, for errors that carry no HTTP status.
const RPC_STATUS_HTTP = Object.freeze({
  INVALID_ARGUMENT: 400, FAILED_PRECONDITION: 400, OUT_OF_RANGE: 400, UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403, NOT_FOUND: 404, RESOURCE_EXHAUSTED: 429, INTERNAL: 500, UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
});
// google.rpc.ErrorInfo reasons that mean the pool's key or project cannot serve anyone.
const AUTH_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED',
  'CONSUMER_SUSPENDED', 'SERVICE_DISABLED', 'BILLING_DISABLED', 'USER_LOCATION_INVALID', 'ACCESS_TOKEN_EXPIRED']);
// OpenAI-style error.code values (Groq, NVIDIA, OpenRouter).
const AUTH_CODES = new Set(['invalid_api_key', 'api_key_invalid', 'invalid_authentication', 'account_deactivated',
  'organization_restricted']);
const MODEL_GONE_CODES = new Set(['model_not_found', 'model_decommissioned', 'model_not_available']);
const MODEL_ERROR_CODES = new Set(['tool_use_failed', 'json_validate_failed']);
const CONTEXT_CODES = new Set(['context_length_exceeded']);
const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rate_limited']);
// Workers AI internal error codes (developers.cloudflare.com/workers-ai/platform/errors).
export const WORKERS_AI_ERRORS = Object.freeze({
  3003: 400, 5004: 400, 5007: 404, 3042: 404, 3006: 413, 3007: 408, 3023: 403, 3041: 403, 5016: 403, 5018: 403,
  3036: 429, // daily free allocation used up: resets at 00:00 UTC
  3040: 429, // out of capacity
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Parses the complete part of a JSON error body that readBounded cut off: the text after the
 * last complete value is dropped (so a cut-off string, such as Groq's `failed_generation` with
 * the model's output, never survives) and the open objects and arrays are closed. Returns
 * undefined when nothing complete can be recovered.
 */
export function parseTruncatedJson(text) {
  if (typeof text !== 'string') return undefined;
  const stack = [];
  let expectKey = false;
  let inString = false;
  let stringIsKey = false;
  let cut = -1;
  let closers = '';
  const mark = position => { cut = position; closers = stack.slice().reverse().join(''); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') {
        inString = false;
        if (!stringIsKey) mark(i + 1);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringIsKey = expectKey && stack.at(-1) === '}';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      expectKey = ch === '{';
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined;
      expectKey = false;
      mark(i + 1);
    } else if (ch === ',') {
      mark(i);
      expectKey = stack.at(-1) === '}';
    } else if (ch === ':') {
      expectKey = false;
    }
  }
  if (cut < 0) return undefined;
  try { return JSON.parse(text.slice(0, cut) + closers); } catch { return undefined; }
}

// The error text of a parsed error body: error.message (OpenAI, Gemini), a string `error`,
// FastAPI's `detail` (a string, or validation entries with `loc` and `msg`; their `input`
// echoes the request and is never read), Workers AI's errors[0].message or an RFC 7807 `title`.
function errorMessage(root, error, workers) {
  const sources = error === root ? [root] : [error, root];
  for (const value of sources) if (typeof value.message === 'string') return value.message;
  if (typeof root.error === 'string') return root.error;
  if (typeof workers?.message === 'string') return workers.message;
  for (const value of sources) {
    if (typeof value.detail === 'string') return value.detail;
    const entry = Array.isArray(value.detail) ? value.detail.find(item => isObject(item) && typeof item.msg === 'string') : null;
    if (entry) {
      const path = Array.isArray(entry.loc) && entry.loc.length && entry.loc.every(part => Number.isInteger(part) ||
        (typeof part === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(part)));
      return path ? `${entry.loc.join('.')}: ${entry.msg}` : entry.msg;
    }
  }
  for (const value of sources) if (typeof value.title === 'string') return value.title;
  return '';
}

/**
 * Structured fields of an upstream error body (JSON text or a parsed error object). A body that
 * looks like JSON but does not parse (in practice: cut off at 16 KB by readBounded) is read up to
 * its last complete value and flagged `truncated`; a body that is not JSON at all (plain text,
 * HTML) becomes the message, which redactProviderMessage sanitizes. Raw JSON text is never used
 * as the message.
 */
export function parseUpstreamError(source) {
  let value = source;
  let text = '';
  let truncated = false;
  if (typeof source === 'string') {
    try {
      value = JSON.parse(source);
    } catch {
      value = undefined;
      if (/^\s*[[{]/.test(source)) {
        truncated = true;
        value = parseTruncatedJson(source);
      } else {
        text = source;
      }
    }
  }
  if (Array.isArray(value)) value = value[0]; // Gemini wraps errors in an array
  const root = isObject(value) ? value : {};
  const error = isObject(root.error) ? root.error : root;
  const details = Array.isArray(error.details) ? error.details.filter(isObject) : [];
  const workers = Array.isArray(root.errors) ? root.errors.find(isObject) : null;
  const violations = details.flatMap(item => Array.isArray(item.violations) ? item.violations.filter(isObject) : []);
  return {
    code: typeof error.code === 'string' ? error.code.toLowerCase() : null,
    numericCode: Number.isInteger(error.code) ? error.code : null,
    rpcStatus: typeof error.status === 'string' ? error.status.toUpperCase() : null,
    type: typeof error.type === 'string' ? error.type : null,
    reasons: details.map(item => item.reason).filter(reason => typeof reason === 'string').map(reason => reason.toUpperCase()),
    retryDelaySeconds: details.map(item => durationSeconds(item.retryDelay)).find(Boolean) ?? null,
    dailyQuota: violations.some(violation => /perday/i.test(String(violation.quotaId ?? ''))),
    // google.rpc.QuotaFailure: which quota tripped and its value (e.g. input tokens per minute).
    quotas: violations.map(violation => ({ id: violation.quotaId, value: violation.quotaValue }))
      .filter(quota => typeof quota.id === 'string'),
    workersCode: Number.isInteger(workers?.code) ? workers.code : null,
    message: errorMessage(root, error, workers) || text,
    truncated,
  };
}

// Patterns of credentials that an upstream message might echo back (keys, bearer tokens, JWTs,
// gateway credentials, key query parameters) and long opaque blobs (thought signatures).
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:sk-or-v1|sk-ant|sk-proj|sk|gsk|nvapi|xai|rk|pk)[-_][A-Za-z0-9_-]{16,}/g,
  /\b(?:ses|nzx|dev)_[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[^\s"',]+/gi,
];
const KEY_PARAM = /([?&](?:key|api_key|apikey|token|access_token|signature)=)[^&\s"'<>]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const BLOB = /[A-Za-z0-9+/=]{40,}/g;
// Quoted spans in a provider message are kept only when they look like a field path or an
// identifier ('messages.3', `default_api:read_file`); anything else may quote the prompt. A
// quote that is never closed (a cut-off body) is redacted up to the end of the text.
const QUOTED = /"(?:[^"\\]|\\[\s\S])*(?:"|$)|(?<![A-Za-z0-9])'(?:[^'\\]|\\[\s\S])*(?:'(?![A-Za-z0-9])|$)|`[^`]*(?:`|$)/g;
const CLOSED_QUOTE = { '"': /^"(?:[^"\\]|\\[\s\S])*"$/, "'": /^'(?:[^'\\]|\\[\s\S])*'$/, '`': /^`[^`]*`$/ };
const IDENTIFIER = /^[A-Za-z0-9_.:[\]/$#@-]{1,64}$/;
export const UPSTREAM_MESSAGE_LIMIT = 300;

/**
 * Operator-safe excerpt of an upstream error message: credentials (`secrets` are the key values
 * in use, matched exactly), e-mail addresses, opaque blobs and quoted text that may echo the
 * prompt are replaced, whitespace is collapsed and the result is cut to 300 characters.
 */
export function redactProviderMessage(message, { secrets = [] } = {}) {
  let text = typeof message === 'string' ? message : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(KEY_PARAM, '$1[redacted]')
    .replace(QUOTED, span => {
      const quote = span[0];
      if (!CLOSED_QUOTE[quote].test(span)) return `${quote}[redacted]`;
      return IDENTIFIER.test(span.slice(1, -1)) ? span : `${quote}[redacted]${quote}`;
    })
    .replace(EMAIL, '[email]')
    .replace(BLOB, blob => /\d/.test(blob) && /[A-Za-z]/.test(blob) ? '[redacted]' : blob)
    .replace(/\s+/g, ' ').trim();
  return text.length > UPSTREAM_MESSAGE_LIMIT ? `${text.slice(0, UPSTREAM_MESSAGE_LIMIT - 1)}…` : text;
}

/**
 * Structured, sanitized summary of an upstream error for operator logs: HTTP status, the
 * provider's error code/status/type, google.rpc reasons and quota violations, the retry delay
 * and a redacted message excerpt. Never includes request bodies or keys; clients never see it.
 */
export function upstreamErrorSummary(status, body = '', { secrets = [] } = {}) {
  const info = parseUpstreamError(body);
  const summary = { status: Number.isInteger(status) ? status : null };
  const code = info.code ?? info.numericCode ?? info.workersCode;
  if (code !== null && code !== undefined) summary.provider_code = typeof code === 'string' ? code.slice(0, 64) : code;
  if (info.rpcStatus) summary.provider_status = info.rpcStatus.slice(0, 64);
  if (info.type) summary.provider_type = info.type.slice(0, 64);
  if (info.reasons.length) summary.reasons = info.reasons.slice(0, 5).map(reason => reason.slice(0, 64));
  if (info.quotas.length) {
    summary.quotas = info.quotas.slice(0, 3).map(quota => ({ id: quota.id.slice(0, 120),
      ...(quota.value !== undefined && quota.value !== null ? { value: String(quota.value).slice(0, 32) } : {}) }));
  }
  if (info.retryDelaySeconds) summary.retry_delay_seconds = info.retryDelaySeconds;
  const message = redactProviderMessage(info.message, { secrets });
  if (message) summary.message = message;
  if (info.truncated) summary.truncated = true;
  return summary;
}

function secondsUntilUtcMidnight(now = Date.now()) {
  return Math.max(1, Math.ceil(((Math.floor(now / 86400000) + 1) * 86400000 - now) / 1000));
}

// Refines a rejected request (400/422, or an in-stream error) using structured fields only.
function structuredKind(info) {
  if (info.reasons.some(reason => AUTH_REASONS.has(reason)) || AUTH_CODES.has(info.code)) return FailureKind.AUTH;
  // Gemini answers FAILED_PRECONDITION when the free tier is unavailable for the project's
  // region or billing state: nobody can use this pool.
  if (info.rpcStatus === 'FAILED_PRECONDITION') return FailureKind.AUTH;
  if ([3023, 3041, 5016, 5018].includes(info.workersCode)) return FailureKind.AUTH;
  if (MODEL_GONE_CODES.has(info.code) || [5007, 3042].includes(info.workersCode)) return FailureKind.MODEL_UNAVAILABLE;
  if (MODEL_ERROR_CODES.has(info.code)) return FailureKind.MODEL_ERROR;
  if (CONTEXT_CODES.has(info.code)) return FailureKind.CONTEXT;
  return null;
}

function durationSeconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text));
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [, hours = 0, minutes = 0, secs = 0, millis = 0] = match;
  return Math.max(1, Math.ceil(Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(millis) / 1000));
}

// Delay before a rate-limited pool may be retried: Retry-After, then Groq's
// x-ratelimit-reset-* for the exhausted dimension, then the structured body (Gemini's
// QuotaFailure per-day quota and RetryInfo, Workers AI's daily allocation).
export function retryAfterSeconds(headers, body = '') {
  return retryDelay(headers, parseUpstreamError(body));
}

function retryDelay(headers, info) {
  const header = headers?.get?.('retry-after');
  if (header) {
    const number = Number(header);
    if (Number.isFinite(number) && number >= 0) return Math.max(1, Math.ceil(number));
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  const get = name => headers?.get?.(name) ?? null;
  const reset = get('x-ratelimit-remaining-requests') === '0' ? get('x-ratelimit-reset-requests')
    : get('x-ratelimit-remaining-tokens') === '0' ? get('x-ratelimit-reset-tokens')
      : get('x-ratelimit-reset-requests') || get('x-ratelimit-reset-tokens');
  const fromReset = durationSeconds(reset);
  if (fromReset) return fromReset;
  if (info.workersCode === 3036) return secondsUntilUtcMidnight();
  if (info.dailyQuota) return Math.max(3600, info.retryDelaySeconds || 0);
  return info.retryDelaySeconds;
}

/**
 * Classifies a failed upstream attempt. `status` is the HTTP status (null for an in-stream
 * error event); `body` is the bounded error body text or the parsed in-stream error.
 */
export function classifyUpstreamFailure(status, body = '', headers = null, fallbackKind = FailureKind.SERVER) {
  const info = parseUpstreamError(body);
  const httpStatus = Number.isInteger(status) && status >= 400 ? status : null;
  // A Workers AI error code is more specific than its HTTP status (e.g. 3036, the daily
  // free allocation, is a rate limit until 00:00 UTC whatever status carries it).
  const workersStatus = Object.hasOwn(WORKERS_AI_ERRORS, info.workersCode) ? WORKERS_AI_ERRORS[info.workersCode] : null;
  const effective = workersStatus ?? httpStatus ?? (info.numericCode >= 400 ? info.numericCode : null) ??
    RPC_STATUS_HTTP[info.rpcStatus] ?? null;
  let kind = effective ? failureKindForStatus(effective) : fallbackKind;
  if (kind === FailureKind.INVALID || !effective) {
    const refined = structuredKind(info);
    if (refined) kind = refined;
    else if (!effective && RATE_LIMIT_CODES.has(info.code)) kind = FailureKind.RATE_LIMITED;
    // Request-scoped only: the message may tell a context-length rejection apart.
    else if (CONTEXT_PATTERN.test(info.message.toLowerCase())) kind = FailureKind.CONTEXT;
  }
  return {
    kind,
    status: effective,
    retryAfterSeconds: kind === FailureKind.RATE_LIMITED || effective === 413 ? retryDelay(headers, info) : null,
    // The provider says a daily quota is spent (health: QUOTA_EXHAUSTED rather than RATE_LIMITED).
    dailyQuota: kind === FailureKind.RATE_LIMITED && (info.workersCode === 3036 || info.dailyQuota === true),
  };
}

// ── Streaming ──

export class UpstreamTimeoutError extends Error {
  constructor(phase) {
    super(phase === 'idle' ? 'Upstream stream went idle' : 'Upstream did not respond in time');
    this.name = 'UpstreamTimeoutError';
    this.phase = phase;
    this.kind = FailureKind.TIMEOUT;
  }
}

export class UpstreamStreamError extends Error {
  constructor(error, fallbackKind = FailureKind.SERVER) {
    super('Upstream provider reported a streaming error');
    this.name = 'UpstreamStreamError';
    const status = Number(error?.status_code);
    const body = isObject(error) ? { error } : {};
    const classified = classifyUpstreamFailure(Number.isInteger(status) ? status : null, body, null, fallbackKind);
    this.kind = classified.kind;
    this.retryAfterSeconds = classified.retryAfterSeconds;
    this.dailyQuota = classified.dailyQuota;
    // Sanitized for operator logs (no raw provider text is kept on the error).
    this.summary = upstreamErrorSummary(Number.isInteger(status) ? status : null, body);
  }
}

export class UpstreamProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamProtocolError';
    this.kind = FailureKind.SERVER;
  }
}

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Time-to-first-byte (45 s) and idle-between-chunks (90 s) budgets (contract §3.3).
export function streamTimeouts(env = {}) {
  return {
    ttfbMs: positiveMs(env.UPSTREAM_TTFB_TIMEOUT_MS, 45000),
    idleMs: positiveMs(env.UPSTREAM_IDLE_TIMEOUT_MS, 90000),
  };
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

// Resolves with `promise` unless the deadline passes (aborting the attempt) or the signal
// aborts first. `deadline()` returns an absolute time and is re-read whenever the timer
// fires, so byte progress (SSE comments and keep-alives included) can extend it.
function guarded(promise, { deadline, phase, signal, controller }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    const wait = () => Math.max(0, deadline() - Date.now());
    const check = () => {
      if (settled) return;
      if (wait() > 0) {
        timer = setTimeout(check, wait());
        return;
      }
      const error = new UpstreamTimeoutError(phase);
      finish(reject, error);
      controller?.abort(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    // Always a macrotask, so an already-settled promise wins over an expired deadline.
    timer = setTimeout(check, wait());
  });
}

async function readBounded(response, limit = 16384) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text.slice(0, limit);
}

const MAX_EVENT_BYTES = 1048576;

// Incremental SSE parser returning the data payload of each event ('[DONE]' included).
// `lastByteAt` records the last time any body bytes arrived, comments included.
export class SseEventReader {
  constructor(body) {
    this.reader = body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.queue = [];
    this.ended = false;
    this.lastByteAt = null;
  }

  push(raw) {
    const data = raw.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data.trim()) this.queue.push(data.trim());
  }

  async next() {
    while (!this.queue.length && !this.ended) {
      const { value, done } = await this.reader.read();
      if (value?.byteLength) this.lastByteAt = Date.now();
      this.buffer += done ? this.decoder.decode() : this.decoder.decode(value, { stream: true });
      this.buffer = this.buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
        this.push(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary + 2);
      }
      if (this.buffer.length > MAX_EVENT_BYTES) throw new UpstreamProtocolError('Provider SSE event exceeds size limit');
      if (done) {
        this.ended = true;
        if (this.buffer.trim()) this.push(this.buffer);
        this.buffer = '';
      }
    }
    return this.queue.length ? this.queue.shift() : null;
  }

  cancel() {
    return this.reader.cancel().catch(() => {});
  }
}

function parseEvent(data) {
  if (data === '[DONE]') return { done: true };
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    throw new UpstreamProtocolError('Provider sent malformed SSE data');
  }
  if (!value || typeof value !== 'object') throw new UpstreamProtocolError('Provider sent malformed SSE data');
  if (value.error) throw new UpstreamStreamError(value.error);
  return { value };
}

/**
 * Starts one upstream attempt. A stream is committed to the client only once its first SSE
 * data event arrives, so a dead or erroring upstream can still be failed over. Stream
 * deadlines: the first body byte within ttfbMs; after that, bytes (SSE comments and
 * keep-alives count) at most idleMs apart, with the first data event due within
 * ttfbMs + idleMs. Non-streaming calls get ttfbMs + idleMs in total.
 * Resolves { ok:false, status, headers, bodyText } for HTTP errors and
 * { ok:true, json | stream } on success; throws timeout/abort/protocol errors.
 */
export async function startCompletion(env, session, entry, pool, payload, { clientSignal, timeouts = streamTimeouts(env), request = {} } = {}) {
  const controller = new AbortController();
  const signal = clientSignal ? AbortSignal.any([clientSignal, controller.signal]) : controller.signal;
  const started = Date.now();
  const total = started + timeouts.ttfbMs + timeouts.idleMs;
  let reader = null;
  const deadline = () => {
    if (!payload.stream) return total;
    const last = reader?.lastByteAt;
    return last ? Math.min(last + timeouts.idleMs, total) : started + timeouts.ttfbMs;
  };
  const phase = payload.stream ? 'first_byte' : 'response';
  const guard = promise => guarded(promise, { deadline, phase, signal, controller });
  const response = await guard(requestCompletion(env, session, entry, payload, signal, pool, request));
  try {
    if (!response.ok) {
      const bodyText = await guard(readBounded(response)).catch(() => '');
      return { ok: false, status: response.status, headers: response.headers, bodyText, latencyMs: Date.now() - started };
    }
    if (!payload.stream) {
      const json = await guard(response.json().catch(() => {
        throw new UpstreamProtocolError('Provider returned malformed JSON');
      }));
      return { ok: true, json, controller, latencyMs: Date.now() - started };
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new UpstreamProtocolError('Provider did not return SSE');
    }
    reader = new SseEventReader(response.body);
    const first = await guard(reader.next());
    if (first === null || first === '[DONE]') throw new UpstreamProtocolError('Provider stream ended before the first event');
    parseEvent(first);
    return { ok: true, stream: { reader, first, usageSoFar: partialUsageOf(response) }, controller, latencyMs: Date.now() - started };
  } catch (error) {
    controller.abort(error);
    if (reader) await reader.cancel();
    else response.body?.cancel?.().catch?.(() => {});
    throw error;
  }
}

function toolState(state, choiceIndex) {
  if (!state.tools.has(choiceIndex)) {
    state.tools.set(choiceIndex, { ids: new Map(), next: 0, last: -1, seen: new Set(), callIds: new Map(), names: new Map() });
  }
  return state.tools.get(choiceIndex);
}

// Every streamed tool_calls delta carries `index` (contract §3.2). Gemini omits it and
// sends each call whole with its own id, so unseen ids get the next index; fragments
// without id or name continue the previous call (or follow their array position).
function normalizeToolDeltas(calls, state, choiceIndex) {
  const tracker = toolState(state, choiceIndex);
  return calls.filter(call => call && typeof call === 'object').map((call, position) => {
    const id = typeof call.id === 'string' && call.id ? call.id : null;
    const fn = call.function || (call.name !== undefined || call.arguments !== undefined
      ? { name: call.name, arguments: call.arguments } : {});
    let index;
    if (Number.isInteger(call.index) && call.index >= 0) index = call.index;
    else if (id && tracker.ids.has(id)) index = tracker.ids.get(id);
    else if (id || fn.name) index = tracker.next;
    else if (calls.length > 1) index = position;
    else index = tracker.last >= 0 ? tracker.last : 0;
    if (id) tracker.ids.set(id, index);
    tracker.next = Math.max(tracker.next, index + 1);
    tracker.last = index;
    const delta = { index };
    const first = !tracker.seen.has(index);
    tracker.seen.add(index);
    if (id || first) {
      delta.id = id || newCallId();
      delta.type = 'function';
      tracker.callIds.set(index, delta.id);
    }
    const fnDelta = {};
    if (fn.name !== undefined && fn.name !== null) {
      fnDelta.name = fn.name;
      tracker.names.set(index, fn.name);
    }
    if (fn.arguments !== undefined && fn.arguments !== null) fnDelta.arguments = argumentsText(fn.arguments);
    else if (first) fnDelta.arguments = '';
    delta.function = fnDelta;
    // Gemini's thought signature stays in the gateway (provider-request.js); clients get the
    // plain OpenAI delta and the signature is restored when the call comes back in the history.
    const signature = toolCallSignature(call);
    if (signature && state.onToolSignature) {
      state.onToolSignature({ id: tracker.callIds.get(index), name: tracker.names.get(index), signature });
    }
    return delta;
  });
}

function captureUsage(value, state) {
  const usage = value.usage || value.x_groq?.usage;
  if (usage && typeof usage === 'object' &&
      ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(name => Number.isFinite(Number(usage[name])))) {
    state.usage = usage;
  }
}

function chunkOf(state, choices, extra = {}) {
  return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices, ...extra };
}

function normalizeStreamValue(value, state) {
  captureUsage(value, state);
  if (Array.isArray(value.choices)) {
    const choices = value.choices.filter(choice => choice && typeof choice === 'object').map((choice, position) => {
      const index = Number.isInteger(choice.index) ? choice.index : position;
      const delta = normalizeReasoning({ ...(choice.delta || {}) });
      delete delta.extra_content;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        delta.tool_calls = normalizeToolDeltas(delta.tool_calls, state, index);
        state.toolChoices.add(index);
      } else {
        delete delta.tool_calls;
      }
      state.outputBytes += utf8Bytes(delta.content || '') + utf8Bytes(delta.reasoning_content || '') +
        (delta.tool_calls ? utf8Bytes(delta.tool_calls) : 0);
      let finish = choice.finish_reason ?? null;
      if (finish) state.sawFinish = true;
      if (finish === 'stop' && state.toolChoices.has(index)) finish = 'tool_calls';
      return { index, delta, finish_reason: finish };
    });
    const extra = value.usage ? { usage: value.usage } : {};
    if (value.usage) state.usageForwarded = true;
    return choices.length || value.usage ? [chunkOf(state, choices, extra)] : [];
  }
  // Workers AI native events: { response, tool_calls, usage }.
  const content = value.response ?? value.text ?? '';
  const calls = Array.isArray(value.tool_calls) && value.tool_calls.length
    ? normalizeToolDeltas(value.tool_calls, state, 0) : [];
  state.outputBytes += utf8Bytes(content) + (calls.length ? utf8Bytes(calls) : 0);
  const chunks = [];
  if (content || calls.length) {
    chunks.push(chunkOf(state, [{ index: 0, delta: { ...(content ? { content } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: null }]));
  }
  if (calls.length) {
    state.toolChoices.add(0);
    state.pendingToolFinish = true;
  }
  return chunks;
}

/**
 * Client-facing SSE stream for a committed upstream attempt. Applies the idle timeout
 * between upstream chunks, normalizes chunks and calls onFinish exactly once with
 * { status:'ok'|'error', usage, outputBytes, errorCode, kind } before the final event.
 * `usageSoFar(outputBytes)` (provider-adapter.js setPartialUsage) supplies the usage when the
 * stream ends without a usage chunk (a client abort or a mid-stream error before Claude's
 * message_delta): the input and cache counts the provider already reported, instead of the
 * byte estimate settlement would otherwise bill.
 */
export function createCompletionStream({ reader, first, model, controller, clientSignal, timeouts, onFinish, requestId, env,
  onToolSignature = null, restorer = null, usageSoFar = null }) {
  const encoder = new TextEncoder();
  const state = {
    id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model,
    tools: new Map(), toolChoices: new Set(), usage: null, usageForwarded: false, outputBytes: 0,
    sawFinish: false, sawDone: false, pendingToolFinish: false, onToolSignature,
  };
  let queue = [];
  let done = false;
  let cancelled = false;
  let finished = false;
  const reportedUsage = () => {
    if (state.usage || typeof usageSoFar !== 'function') return state.usage;
    try { return usageSoFar(state.outputBytes) ?? null; } catch { return null; }
  };
  const finish = async outcome => {
    if (finished) return;
    finished = true;
    try {
      await onFinish({ usage: reportedUsage(), outputBytes: state.outputBytes, ...outcome });
    } catch (error) {
      console.error('Neuron stream settlement failed', { name: error?.name });
    }
  };
  const handle = data => {
    const event = parseEvent(data);
    if (event.done) {
      state.sawDone = true;
      return [];
    }
    const chunks = normalizeStreamValue(event.value, state);
    // Secrets withheld from the upstream go back into the client's stream (src/oiop/scrub.js).
    return restorer?.active ? chunks.map(chunk => restorer.chunk(chunk)) : chunks;
  };
  const finalize = async () => {
    if (!state.sawDone && !state.sawFinish && !state.pendingToolFinish) {
      throw new UpstreamProtocolError('Provider stream ended before completion');
    }
    const tail = [];
    const held = restorer?.active ? restorer.finalChunk(chunkOf(state, [])) : null;
    if (held) tail.push(held);
    if (!state.sawFinish) tail.push(chunkOf(state, [{ index: 0, delta: {}, finish_reason: state.pendingToolFinish ? 'tool_calls' : 'stop' }]));
    if (state.usage && !state.usageForwarded) tail.push(chunkOf(state, [], { usage: state.usage }));
    await finish({ status: 'ok' });
    tail.push('[DONE]');
    return tail;
  };
  const encode = item => encoder.encode(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`);
  // Idle budget: measured from the last body bytes (SSE comments and keep-alives included),
  // re-read whenever the timer fires so progress inside one event extends it.
  const streamStarted = Date.now();
  const idleDeadline = () => (reader.lastByteAt ?? streamStarted) + timeouts.idleMs;
  // [DONE] completes the attempt even when the upstream keeps its connection open.
  const complete = async () => {
    queue.push(...await finalize());
    done = true;
    void reader.cancel();
  };
  queue = handle(first);

  return new ReadableStream({
    async pull(stream) {
      try {
        if (state.sawDone && !done) await complete();
        while (!queue.length && !done) {
          const data = await guarded(reader.next(), { deadline: idleDeadline, phase: 'idle', signal: clientSignal, controller });
          if (cancelled) return;
          if (data === null) {
            queue.push(...await finalize());
            done = true;
          } else {
            queue.push(...handle(data));
            if (state.sawDone) await complete();
          }
        }
        if (queue.length) stream.enqueue(encode(queue.shift()));
        else stream.close();
      } catch (error) {
        if (cancelled) return;
        done = true;
        queue = [];
        const client = Boolean(clientSignal?.aborted);
        const timeout = error instanceof UpstreamTimeoutError;
        controller.abort(error);
        await reader.cancel();
        await finish({ status: 'error', kind: client ? FailureKind.ABORTED : error.kind || FailureKind.SERVER,
          phase: timeout ? error.phase : null, retryAfterSeconds: error.retryAfterSeconds ?? null,
          dailyQuota: error.dailyQuota === true,
          errorCode: client ? 'client_disconnected' : timeout ? 'upstream_timeout' : 'upstream_error',
          upstream: error.summary ?? null });
        if (client) {
          try { stream.error(error); } catch { /* consumer already closed */ }
          return;
        }
        const code = timeout ? 'upstream_timeout' : 'upstream_error';
        const message = timeout ? 'The model stopped responding. Retry your request.' : 'Generation interrupted. Retry your request.';
        try {
          stream.enqueue(encode(errorEvent(code, { message, requestId, env })));
          stream.close();
        } catch { /* consumer already closed */ }
      }
    },
    async cancel() {
      cancelled = true;
      controller.abort(new DOMException('Client closed the stream', 'AbortError'));
      await reader.cancel();
      await finish({ status: 'error', kind: FailureKind.ABORTED, errorCode: 'client_disconnected' });
    },
  });
}
