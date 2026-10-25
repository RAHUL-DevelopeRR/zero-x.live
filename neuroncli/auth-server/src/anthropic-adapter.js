// Native Claude adapter (Anthropic Messages API) for Claude Sonnet 5.5 and Claude Opus 5.5 on
// the paid tier. It returns a Response like every other adapter: an OpenAI SSE stream or an
// OpenAI chat.completion JSON, or a non-ok Response carrying Claude's error body, so
// startCompletion, createCompletionStream, normalizeCompletion and classifyUpstreamFailure in
// providers.js handle it unchanged.
//
// Transport is the official @anthropic-ai/sdk with three shims: a fetch wrapper (redirect
// 'manual', api.anthropic.com only, a byte tap for liveness; src/anthropic-transport.js), SDK
// errors turned back into upstream-shaped Responses, and abort mapping. maxRetries is 0: the
// router owns failover.
import Anthropic from '@anthropic-ai/sdk';
import { ProviderAdapter, setPartialUsage } from './provider-adapter.js';
import { catalogEntries, poolSecret } from './catalog.js';
import { FailureKind } from './provider-health.js';
import { ANTHROPIC, BINDING_BETA, ClaudeRequestError, messageFingerprint, toClaudeRequest } from './anthropic-request.js';
import { ERROR_STATUS, Liveness, openAIStream, openaiUsage, streamErrorBody, ClaudeStreamTranslator } from './anthropic-stream.js';
import { claudeTurnHooks, globalClaudeTurnCache } from './anthropic-turns.js';
import { anthropicClient, anthropicFetch, isAnthropicUrl } from './anthropic-transport.js';

export { anthropicFetch, isAnthropicUrl };

const SDK_TIMEOUT_MS = 600_000; // headers only; the gateway's first-byte and idle budgets apply first
const ERROR_TYPES = Object.freeze(Object.fromEntries(Object.entries(ERROR_STATUS).map(([type, status]) => [status, type])));
const BETA_REJECTED = [
  new RegExp(`${BINDING_BETA}[\\s\\S]*anthropic-beta|anthropic-beta[\\s\\S]*${BINDING_BETA}`),
  /block_binding[\s\S]*Extra inputs are not permitted/,
];
const SIGNATURE_REJECTED = /signature[\s\S]*thinking|thinking[\s\S]*signature/i;

function claudeClient(apiKey, liveness) {
  return anthropicClient(apiKey, { timeout: SDK_TIMEOUT_MS, liveness });
}

/**
 * metadata.user_id: the first 32 hex digits of SHA-256('zx-user:' + internal user id). It is
 * pseudonymous and lets Anthropic act on one abusive user instead of the whole key. It sits
 * outside system, tools and messages, so it does not affect prompt caching.
 */
export async function metadataUserId(id) {
  if ((typeof id !== 'string' && typeof id !== 'number') || id === '') return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`zx-user:${id}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function errorJson(status, type, message, headers = {}) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// SDK errors become what an OpenAI-compatible upstream would have returned, so the existing
// classifier, Retry-After parsing and log redaction apply. Aborts are rethrown as the original
// abort or timeout reason, so the attempt records ABORTED or TIMEOUT.
function errorResponse(error, signal) {
  if (signal?.aborted) throw signal.reason ?? error;
  if (error instanceof Anthropic.APIUserAbortError) throw error;
  if (error instanceof Anthropic.APIConnectionError) { // includes APIConnectionTimeoutError
    throw Object.assign(new Error('The connection to Claude failed'), { name: 'ClaudeConnectionError', kind: FailureKind.SERVER });
  }
  if (typeof error?.status === 'number') {
    const status = error.status;
    const headers = {};
    const retryAfter = error.headers?.get?.('retry-after');
    if (retryAfter) headers['retry-after'] = retryAfter;
    const requestId = error.headers?.get?.('request-id');
    if (requestId) headers['request-id'] = requestId;
    if (status >= 400 && status <= 599) {
      const body = error.error && typeof error.error === 'object' && error.error.error && typeof error.error.error === 'object'
        ? error.error : { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message: '' } };
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    }
    // A redirect body is never forwarded: it does not come from the API.
    if (status >= 300 && status <= 399) return errorJson(status, 'api_error', 'Claude answered with a redirect, which is never followed.', headers);
    return errorJson(502, 'api_error', 'Claude answered with an unexpected status.', headers);
  }
  throw error;
}

// 'beta': the thinking-binding beta (or block_binding) was rejected; 'signature': a replayed
// thinking block was rejected. Either way the request is retried once without replay.
function bindingFallback(error, mapped) {
  if (error?.status !== 400) return null;
  const message = String(error?.error?.error?.message ?? '');
  if (mapped.betas.length && BETA_REJECTED.some(pattern => pattern.test(message))) return 'beta';
  if (mapped.replayed > 0 && SIGNATURE_REJECTED.test(message)) return 'signature';
  return null;
}

function mapRequest(entry, payload, options) {
  try {
    return toClaudeRequest(entry, payload, options);
  } catch (error) {
    if (error instanceof ClaudeRequestError) return errorJson(400, 'invalid_request_error', error.message);
    throw error;
  }
}

const createParams = mapped => (mapped.betas.length ? { ...mapped.body, betas: mapped.betas } : mapped.body);

// `request.turns` ({lookup, remember}) when the caller injects them (tests, chat-handler), or the
// isolate's cache scoped to `request.caller`. No caller, no replay.
function turnHooks(request) {
  const turns = request?.turns;
  if (turns && typeof turns.lookup === 'function' && typeof turns.remember === 'function') return turns;
  return request?.caller ? claudeTurnHooks(globalClaudeTurnCache, request.caller) : null;
}

async function aggregate(sdkStream, translator, signal, onTurn) {
  try {
    for await (const event of sdkStream) translator.translate(event);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    const body = streamErrorBody(error);
    return errorJson(body.status_code, body.type, body.message);
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  if (!translator.finished) return errorJson(502, 'api_error', 'The Claude stream ended before the response was complete.');
  try { onTurn?.(); } catch { /* replay is best effort */ }
  return new Response(JSON.stringify(translator.completion()), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export class AnthropicAdapter extends ProviderAdapter {
  constructor({ keepAliveMs = 10_000, betaRetryMs = 3600_000 } = {}) {
    super(ANTHROPIC.id);
    this.keepAliveMs = keepAliveMs;
    this.betaRetryMs = betaRetryMs;
    // Set when the API rejects BINDING_BETA: this isolate stops sending it for betaRetryMs.
    this.bindingBetaRejectedUntil = 0;
  }

  capabilities() {
    return { tools: true, streaming: true, parallel_tools: true, vision: true, reasoning: true };
  }

  getBaseUrl() {
    return ANTHROPIC.apiBase;
  }

  // The pool's key (key variable or vault key, see catalog.js poolSecret), else ANTHROPIC_API_KEY.
  getApiKey(env, session = {}, pool = null) {
    const secret = pool && (pool.key_id || pool.key_var) ? poolSecret(env, pool) : env?.[ANTHROPIC.keyVar];
    return typeof secret === 'string' && secret.trim() ? secret.trim() : null;
  }

  isConfigured(env, session = {}) {
    if (session?.owned_provider_only && !session.account_backed) return false;
    return Boolean(this.getApiKey(env, session));
  }

  catalogSource() {
    return 'allowlist';
  }

  listStaticModels(env, session = {}) {
    if (!this.isConfigured(env, session)) return [];
    return catalogEntries(env).filter(entry => entry.provider === this.id);
  }

  listModels(env, session = {}) {
    return this.listStaticModels(env, session);
  }

  // No network call: the models are the catalog's Claude rows.
  async discoverModels(env, session = {}) {
    const configured = this.isConfigured(env, session);
    return { provider: this.id, status: configured ? 'configured' : 'not_configured', discovery: false,
      models: configured ? this.listStaticModels(env, session) : [] };
  }

  async healthCheck(env) {
    return { provider: this.id, status: this.isConfigured(env) ? 'configured' : 'not_configured', inference_checked: false };
  }

  // OpenAI-shape usage plus the cache split billing prices separately.
  extractUsage(result) {
    const usage = result?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const details = usage.prompt_tokens_details || {};
    return { ...usage, cache_read_tokens: details.cached_tokens ?? 0,
      cache_write_tokens: (details.cache_write_tokens ?? 0) + (details.cache_write_1h_tokens ?? 0) };
  }

  /**
   * One upstream attempt. `request` is the per-request context: { caller, turns? } enables the
   * preserved-thinking replay (anthropic-turns.js); without it nothing is replayed.
   * Env: ANTHROPIC_THINKING_REPLAY=false sends no binding beta and replays nothing.
   */
  async chatCompletion(env, session, entry, payload, signal, pool = null, request = {}) {
    const apiKey = this.getApiKey(env, session, pool);
    if (!apiKey) return errorJson(401, 'authentication_error', 'The Claude API key is not configured.');
    const replayAllowed = env?.ANTHROPIC_THINKING_REPLAY !== 'false';
    const turns = replayAllowed ? turnHooks(request) : null;
    const options = {
      restore: turns ? message => turns.lookup(messageFingerprint(message)) : null,
      metadataUserId: await metadataUserId(session?.user_id || request?.caller),
      bindingBeta: replayAllowed && Date.now() >= this.bindingBetaRejectedUntil,
    };
    let mapped = mapRequest(entry, payload, options);
    if (mapped instanceof Response) return mapped;

    const liveness = new Liveness();
    const client = claudeClient(apiKey, liveness);
    let sdkStream = null;
    for (let attempt = 0; !sdkStream; attempt++) {
      try {
        sdkStream = await client.beta.messages.create(createParams(mapped), { signal });
      } catch (error) {
        const fallback = attempt === 0 ? bindingFallback(error, mapped) : null;
        if (!fallback) return errorResponse(error, signal);
        if (fallback === 'beta') {
          this.bindingBetaRejectedUntil = Date.now() + this.betaRetryMs;
          options.bindingBeta = false;
        }
        options.restore = null;
        // No message text: it could quote the request.
        console.warn(fallback === 'beta' ? 'Claude rejected the thinking-binding beta; retrying without it'
          : 'Claude rejected a replayed thinking block; retrying without replay', { model: mapped.body.model });
        mapped = mapRequest(entry, payload, options);
        if (mapped instanceof Response) return mapped;
      }
    }

    const translator = new ClaudeStreamTranslator({ model: entry.id, toolNames: mapped.toolNames });
    // An attempt that fails from here on (an error event, a timeout, an abort; streamed or not) is
    // settled from what message_start reported (provider-adapter.js setPartialUsage).
    setPartialUsage(signal, outputBytes => translator.usageSoFar(outputBytes));
    const onTurn = turns && mapped.rememberTurns ? () => {
      const record = translator.turnRecord();
      if (record) for (const fingerprint of record.fingerprints) turns.remember(fingerprint, record.blocks);
    } : null;
    if (!payload.stream) return aggregate(sdkStream, translator, signal, onTurn);
    const response = new Response(openAIStream({ sdkStream, translator, liveness, signal, onTurn, keepAliveMs: this.keepAliveMs }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    // The usage chunk only comes with message_delta: an abort or a mid-stream error before it is
    // settled from message_start's input and cache counts (createCompletionStream usageSoFar).
    return setPartialUsage(response, outputBytes => translator.usageSoFar(outputBytes));
  }
}

export { openaiUsage };
