import { CloudflareWorkersAIAdapter } from './cloudflare-adapter.js';
import { OpenAICompatibleAdapter } from './provider-adapter.js';
import { FailureKind, failureKindForStatus } from './provider-health.js';
import {
  AUTO_MODEL_ID, catalogEntry, catalogWarnings, isHosted, isEnabled, listModelsForCaller, offeredEntries,
  CATALOG, poolConfigured, planPolicy,
} from './catalog.js';
import { errorEvent } from './errors.js';
import { sessionTiers } from './capacity.js';
import { estimatePromptTokens, estimateOutputTokens, publicPricing, utf8Bytes } from './pricing.js';

export { estimatePromptTokens };

function omnirouteBaseResolver(env) {
  if (!env.OMNIROUTE_BASE_URL) return null;
  try {
    const url = new URL(env.OMNIROUTE_BASE_URL);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function bedrockBaseResolver(env) {
  const region = env.BEDROCK_REGION || env.AWS_REGION;
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return null;
  return env.BEDROCK_ENDPOINT === 'runtime'
    ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`
    : `https://bedrock-mantle.${region}.api.aws/v1`;
}

export const ADAPTERS = {
  cloudflare: new CloudflareWorkersAIAdapter(),
  openrouter: new OpenAICompatibleAdapter({
    id: 'openrouter',
    keyVar: 'OPENROUTER_API_KEY',
    modelsVar: 'OPENROUTER_MODELS',
    defaultBase: 'https://openrouter.ai/api/v1',
    defaultFallbackModels: ['openrouter/free'],
  }),
  groq: new OpenAICompatibleAdapter({
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    modelsVar: 'GROQ_MODELS',
    toolModelsVar: 'GROQ_TOOL_MODELS',
    defaultBase: 'https://api.groq.com/openai/v1',
    providerPrefix: true,
  }),
  gemini: new OpenAICompatibleAdapter({
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    modelsVar: 'GEMINI_MODELS',
    toolModelsVar: 'GEMINI_TOOL_MODELS',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    providerPrefix: true,
  }),
  nvidia: new OpenAICompatibleAdapter({
    id: 'nvidia',
    keyVar: 'NVIDIA_API_KEY',
    modelsVar: 'NVIDIA_MODELS',
    toolModelsVar: 'NVIDIA_TOOL_MODELS',
    defaultBase: 'https://integrate.api.nvidia.com/v1',
    providerPrefix: true,
  }),
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

const HTTP_PROVIDER_KEYS = ['openrouter', 'groq', 'gemini', 'nvidia', 'omniroute', 'bedrock', 'azure'];
const HOSTED_FLAGS = { nvidia: 'NVIDIA_HOSTED', openrouter: 'OPENROUTER_HOSTED' };

export function providerConfiguration(env, session = {}) {
  const warnings = catalogWarnings(env);
  return HTTP_PROVIDER_KEYS.map(provider => {
    const adapter = ADAPTERS[provider];
    const entries = CATALOG.filter(entry => entry.provider === provider);
    return {
      provider,
      configured: adapter ? adapter.isConfigured(env, session) : false,
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
    const pools = entry.pools.filter(pool => tiers.includes(pool.tier) && poolConfigured(env, entry, pool));
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

function normalizeCalls(calls = []) {
  return calls.filter(call => call && typeof call === 'object').map(call => {
    const fn = call.function || { name: call.name, arguments: call.arguments };
    return {
      id: typeof call.id === 'string' && call.id ? call.id : newCallId(),
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

function normalizeChoice(choice, position) {
  const message = normalizeReasoning({ role: 'assistant', ...(choice?.message || {}) });
  const calls = Array.isArray(message.tool_calls) ? normalizeCalls(message.tool_calls) : [];
  if (calls.length) message.tool_calls = calls;
  else delete message.tool_calls;
  if (message.content === undefined) message.content = calls.length ? null : '';
  let finish = choice?.finish_reason ?? (calls.length ? 'tool_calls' : 'stop');
  if (finish === 'stop' && calls.length) finish = 'tool_calls';
  return { index: Number.isInteger(choice?.index) ? choice.index : position, message, finish_reason: finish };
}

export function normalizeCompletion(result, model, messages, tools) {
  if (!result || typeof result !== 'object') throw new Error('Provider returned an invalid completion');
  const created = Math.floor(Date.now() / 1000);
  if (Array.isArray(result.choices)) {
    const choices = result.choices.map(normalizeChoice);
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

export async function requestCompletion(env, session, entry, body, signal, pool) {
  const adapter = ADAPTERS[entry.provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${entry.provider}`);
  }
  if (entry.provider === 'cloudflare') {
    return adapter.chatCompletion(env, session, entry, body, signal, normalizeCompletion);
  }
  return adapter.chatCompletion(env, session, entry, body, signal, pool || entry.pools?.[0] || null);
}

// ── Upstream failure classification ──

const CONTEXT_PATTERN = /context[ _-]?(length|window)|maximum context|too many tokens|token limit|request too large|reduce the length|(input|prompt|request|message)s? (is |are )?too (long|large)|exceeds the (maximum|max|limit)/;
const MODEL_GONE_PATTERN = /model[^\n]{0,60}(not found|does not exist|not supported|is not available|decommissioned|deprecated)|not a valid model|unknown model|no endpoints found/;

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
// x-ratelimit-reset-* for the exhausted dimension, then Gemini's RetryInfo.
export function retryAfterSeconds(headers, text = '') {
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
  if (/perday/i.test(text)) return 3600;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return delay ? Math.max(1, Math.ceil(Number(delay[1]))) : null;
}

export function classifyUpstreamFailure(status, text = '', headers = null) {
  const lower = String(text).toLowerCase();
  let kind = failureKindForStatus(status);
  if (kind === FailureKind.INVALID || kind === FailureKind.CONTEXT) {
    if (CONTEXT_PATTERN.test(lower)) kind = FailureKind.CONTEXT;
    else if (MODEL_GONE_PATTERN.test(lower)) kind = FailureKind.MODEL_UNAVAILABLE;
    // Gemini rejects whole projects whose egress region is unsupported: a pool problem.
    else if (/user location is not supported/.test(lower)) kind = FailureKind.AUTH;
  }
  return {
    kind,
    status,
    retryAfterSeconds: kind === FailureKind.RATE_LIMITED || status === 413 ? retryAfterSeconds(headers, text) : null,
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
    const status = Number(error?.code ?? error?.status_code);
    const text = JSON.stringify(error ?? {}).slice(0, 4000);
    const classified = Number.isInteger(status) && status >= 400
      ? classifyUpstreamFailure(status, text)
      : /resource_exhausted|rate.?limit/i.test(text) ? { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: retryAfterSeconds(null, text) }
        : { kind: CONTEXT_PATTERN.test(text.toLowerCase()) ? FailureKind.CONTEXT : fallbackKind, retryAfterSeconds: null };
    this.kind = classified.kind;
    this.retryAfterSeconds = classified.retryAfterSeconds;
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

// Resolves with `promise` unless the deadline passes (aborting the attempt) or the
// signal aborts first.
function guarded(promise, { ms, phase, signal, controller }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    const timer = setTimeout(() => {
      const error = new UpstreamTimeoutError(phase);
      finish(reject, error);
      controller?.abort(error);
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
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
export class SseEventReader {
  constructor(body) {
    this.reader = body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.queue = [];
    this.ended = false;
  }

  push(raw) {
    const data = raw.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data.trim()) this.queue.push(data.trim());
  }

  async next() {
    while (!this.queue.length && !this.ended) {
      const { value, done } = await this.reader.read();
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
 * Starts one upstream attempt. Streams are not committed to the client until the first
 * SSE event arrives within the TTFB budget, so a dead or erroring upstream can still be
 * failed over. Non-streaming calls get TTFB + idle as their total budget.
 * Resolves { ok:false, status, headers, bodyText } for HTTP errors and
 * { ok:true, json | stream } on success; throws timeout/abort/protocol errors.
 */
export async function startCompletion(env, session, entry, pool, payload, { clientSignal, timeouts = streamTimeouts(env) } = {}) {
  const controller = new AbortController();
  const signal = clientSignal ? AbortSignal.any([clientSignal, controller.signal]) : controller.signal;
  const started = Date.now();
  const budget = payload.stream ? timeouts.ttfbMs : timeouts.ttfbMs + timeouts.idleMs;
  const phase = payload.stream ? 'first_byte' : 'response';
  const remaining = () => budget - (Date.now() - started);
  const guard = promise => guarded(promise, { ms: remaining(), phase, signal, controller });
  const response = await guard(requestCompletion(env, session, entry, payload, signal, pool));
  let reader = null;
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
    return { ok: true, stream: { reader, first }, controller, latencyMs: Date.now() - started };
  } catch (error) {
    controller.abort(error);
    if (reader) await reader.cancel();
    else response.body?.cancel?.().catch?.(() => {});
    throw error;
  }
}

function toolState(state, choiceIndex) {
  if (!state.tools.has(choiceIndex)) state.tools.set(choiceIndex, { ids: new Map(), next: 0, last: -1, seen: new Set() });
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
    }
    const fnDelta = {};
    if (fn.name !== undefined && fn.name !== null) fnDelta.name = fn.name;
    if (fn.arguments !== undefined && fn.arguments !== null) fnDelta.arguments = argumentsText(fn.arguments);
    else if (first) fnDelta.arguments = '';
    delta.function = fnDelta;
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
 */
export function createCompletionStream({ reader, first, model, controller, clientSignal, timeouts, onFinish, requestId, env }) {
  const encoder = new TextEncoder();
  const state = {
    id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model,
    tools: new Map(), toolChoices: new Set(), usage: null, usageForwarded: false, outputBytes: 0,
    sawFinish: false, sawDone: false, pendingToolFinish: false,
  };
  let queue = [];
  let done = false;
  let cancelled = false;
  let finished = false;
  const finish = async outcome => {
    if (finished) return;
    finished = true;
    try {
      await onFinish({ usage: state.usage, outputBytes: state.outputBytes, ...outcome });
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
    return normalizeStreamValue(event.value, state);
  };
  const finalize = async () => {
    if (!state.sawDone && !state.sawFinish && !state.pendingToolFinish) {
      throw new UpstreamProtocolError('Provider stream ended before completion');
    }
    const tail = [];
    if (!state.sawFinish) tail.push(chunkOf(state, [{ index: 0, delta: {}, finish_reason: state.pendingToolFinish ? 'tool_calls' : 'stop' }]));
    if (state.usage && !state.usageForwarded) tail.push(chunkOf(state, [], { usage: state.usage }));
    await finish({ status: 'ok' });
    tail.push('[DONE]');
    return tail;
  };
  const encode = item => encoder.encode(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`);
  queue = handle(first);

  return new ReadableStream({
    async pull(stream) {
      try {
        while (!queue.length && !done) {
          const data = await guarded(reader.next(), { ms: timeouts.idleMs, phase: 'idle', signal: clientSignal, controller });
          if (cancelled) return;
          if (data === null) {
            queue.push(...await finalize());
            done = true;
          } else {
            queue.push(...handle(data));
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
          errorCode: client ? 'client_disconnected' : timeout ? 'upstream_timeout' : 'upstream_error' });
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
