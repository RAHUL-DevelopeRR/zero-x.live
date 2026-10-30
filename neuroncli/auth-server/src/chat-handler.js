import { errorResponse, newRequestId } from './errors.js';
import {
  buildUpstreamPayload, classifyUpstreamFailure, createCompletionStream, isOwnedSession, normalizeCompletion,
  ownedCatalog, reportsUsageAtStart, startCompletion, streamTimeouts, upstreamErrorSummary,
} from './providers.js';
import { globalSignatureCache } from './provider-request.js';
import { claudeTurnHooks, globalClaudeTurnCache } from './anthropic-turns.js';
import { partialUsageOf, usageNow } from './provider-adapter.js';
import { globalRouter } from './router.js';
import { FailureKind, globalHealthTracker } from './provider-health.js';
import { hubHealthForRouting, hubHealthRows, publishHealth } from './health-hub-client.js';
import { readShared } from './health-share.js';
import { callerCountry, loadCatalog, loadPlanPolicies, planPolicy, poolSecret, resolveModelId } from './catalog.js';
import { touchVaultKey } from './provider-keys.js';
import { billableUsage, estimateOutputTokens, estimatePromptTokens, reserveCostMicrousd, utf8Bytes } from './pricing.js';
import { exhaustedBudget, notePoolExhausted, notePoolReserved, poolBudgetState } from './pool-budget.js';
import { loadOffers, offerIdFor } from './oiop/offers.js';
import { callerPolicy } from './oiop/policy.js';
import { scrubMode, scrubRequest, scrubsOffer, SecretRestorer } from './oiop/scrub.js';
import {
  PAID_DENIED_STATUSES, RESERVATION_LEASE_SECONDS, RESERVATION_RENEW_MS, RESERVE_ERRORS, TERMINAL_RESERVE_STATUSES,
  renewCapacity, reservationArgs, reserveCapacity, reserveError, reserveSessionQuota, runInBackground, sessionTiers,
  settleCapacity, settleSessionQuota, settlementArgs, usesLedger,
} from './capacity.js';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
// 1 MiB holds roughly 300K tokens of prompt, which is why no catalog model advertises more
// context than the gateway can carry (Claude rows: 200,000).
const MAX_BODY_BYTES = 1048576;
// The largest max_tokens a client may send; every catalog model's max_output_tokens fits under it
// (check-routing-v2), and the router clamps each request to its model's own limit.
export const MAX_OUTPUT_TOKENS = 65536;
// Without max_tokens a request gets this, or its model's default_max_tokens (router.js).
const DEFAULT_MAX_TOKENS = 4096;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'default']);

const isSet = value => value !== undefined && value !== null;
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

// Returns a client-facing message for a malformed body, or null when it is valid.
export function validateCompletionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'The request body must be a JSON object.';
  if (typeof body.model !== 'string' || !body.model.trim()) return 'Provide a model.';
  if (!Array.isArray(body.messages) || !body.messages.length) return 'Provide at least one message.';
  if (body.messages.some(message => !message || typeof message !== 'object' || !ROLES.has(message.role))) {
    return 'Every message needs a role of system, developer, user, assistant or tool.';
  }
  if (isSet(body.stream) && typeof body.stream !== 'boolean') return 'stream must be a boolean.';
  if (isSet(body.tools) && (!Array.isArray(body.tools) || body.tools.length > 128 ||
      body.tools.some(tool => tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name))) {
    return 'tools must contain at most 128 function definitions.';
  }
  for (const name of ['max_tokens', 'max_completion_tokens']) {
    if (isSet(body[name]) && (!Number.isSafeInteger(body[name]) || body[name] < 1 || body[name] > MAX_OUTPUT_TOKENS)) {
      return `${name} must be an integer between 1 and ${MAX_OUTPUT_TOKENS}.`;
    }
  }
  if (isSet(body.n) && body.n !== 1) return 'Only n=1 is supported.';
  if (isSet(body.temperature) && !number(body.temperature, 0, 2)) return 'temperature must be between 0 and 2.';
  if (isSet(body.top_p) && !number(body.top_p, 0, 1)) return 'top_p must be between 0 and 1.';
  for (const name of ['presence_penalty', 'frequency_penalty']) {
    if (isSet(body[name]) && !number(body[name], -2, 2)) return `${name} must be between -2 and 2.`;
  }
  if (isSet(body.seed) && !Number.isSafeInteger(body.seed)) return 'seed must be an integer.';
  if (isSet(body.stop) && !(typeof body.stop === 'string' ||
      (Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every(item => typeof item === 'string')))) {
    return 'stop must be a string or an array of up to 4 strings.';
  }
  if (isSet(body.user) && (typeof body.user !== 'string' || body.user.length > 256)) return 'user must be a string of at most 256 characters.';
  if (isSet(body.reasoning_effort) && !EFFORTS.has(body.reasoning_effort)) return 'reasoning_effort is not supported.';
  if (isSet(body.response_format) && (typeof body.response_format !== 'object' || typeof body.response_format.type !== 'string')) {
    return 'response_format must be an object with a type.';
  }
  if (isSet(body.tool_choice) && typeof body.tool_choice !== 'string' && typeof body.tool_choice !== 'object') {
    return 'tool_choice must be a string or an object.';
  }
  if (isSet(body.parallel_tool_calls) && typeof body.parallel_tool_calls !== 'boolean') return 'parallel_tool_calls must be a boolean.';
  if (isSet(body.stream_options) && (typeof body.stream_options !== 'object' || Array.isArray(body.stream_options))) {
    return 'stream_options must be an object.';
  }
  return null;
}

// What the request needs from a model (router.js lacks()).
const IMAGE_PARTS = new Set(['image_url', 'input_image', 'image']);
export function requestNeeds(body) {
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: body.messages.some(message => Array.isArray(message.content) &&
      message.content.some(part => IMAGE_PARTS.has(part?.type))),
    stream: body.stream === true,
    json: ['json_object', 'json_schema'].includes(body.response_format?.type),
  };
}

// FNV-1a over text, as 8 hex digits.
function fnv(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const CONVERSATION_HEADER = /^[A-Za-z0-9._:-]{1,128}$/;
const messageText = message => (typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('') : '');

// Identifies a conversation for sticky routing: the client's X-Neuron-Conversation id when it
// sends one, otherwise a hash of the first system and user messages (the same in every turn of a
// conversation). Never stored or logged beyond the per-isolate sticky map.
export function conversationKey(header, messages) {
  if (typeof header === 'string' && CONVERSATION_HEADER.test(header.trim())) return `c:${header.trim()}`;
  const system = messages.find(message => message.role === 'system' || message.role === 'developer');
  const user = messages.find(message => message.role === 'user');
  if (!user) return null;
  return `h:${fnv(`${messageText(system).slice(0, 4000)}\u0000${messageText(user).slice(0, 4000)}`)}`;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// zerox_renew_reservation does not exist until migrations/20261028000000_reservation_leases.sql
// is applied (PostgREST reports PGRST202, Postgres 42883). Renewal is then skipped for a while.
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883']);
const RENEWAL_RECHECK_MS = 600000;

const ERROR_CODES_BY_KIND = {
  [FailureKind.CONTEXT]: 'context_length_exceeded',
  [FailureKind.INVALID]: 'invalid_request',
  [FailureKind.MODEL_ERROR]: 'model_error',
  [FailureKind.MODEL_UNAVAILABLE]: 'model_unavailable',
  [FailureKind.RATE_LIMITED]: 'rate_limited',
  [FailureKind.AUTH]: 'upstream_auth',
  [FailureKind.SERVER]: 'upstream_error',
  [FailureKind.TIMEOUT]: 'upstream_timeout',
  [FailureKind.ABORTED]: 'client_disconnected',
};

// Failures after the upstream ran the model (a model-side rejection such as tool_use_failed, a
// first-byte, idle or response timeout). The upstream counted them against its own limits, so
// they keep their share of the shared pool budget ('failed_upstream'); everything else (429,
// 5xx, network and auth failures) is returned to the pool ('refunded'). An attempt whose upstream
// reported usage before it failed (Claude's message_start, then an error event, a timeout or an
// abort) ran the model whatever its kind: it is settled 'failed_upstream' too, from that usage.
// An upstream that reports usage before the model runs (reportsUsageAtStart: Claude) and reported
// none did not run it, whatever the kind: a first-byte or response timeout, or a client abort,
// before message_start is 'refunded' (contract §13.4).
const GENERATED_KINDS = new Set([FailureKind.MODEL_ERROR, FailureKind.TIMEOUT]);

function minimum(values) {
  const valid = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return valid.length ? Math.min(...valid) : undefined;
}

// Pools another isolate saw out of capacity (busy or blurred in the HealthHub snapshot, or in
// KV on the Node server) and pools whose shared budget this isolate saw spent go after the
// other pools of their tier (free pools still come before paid ones). The router's circuit
// state only knows this isolate's own attempts, so without this a fresh isolate sends `auto`
// straight to a provider whose daily quota is gone. Slow pools (a first-byte or idle timeout
// within the last five minutes and no success since: slow_until in the shared view or in this
// isolate's record, provider-health.js) go after the healthy pools of their tier and before
// the parked ones: one caller's timeout does not open a circuit, and without this the next
// request waits through the same pool's first-byte timeout again. A 5xx or a slow
// non-streaming response does not make a pool slow. Parked and slow pools stay in the list:
// when every candidate is parked, the request still tries them in order. `sharedHealth` is the
// HealthHub snapshot the router already read (hubHealthForRouting); without one the hub is
// asked, then KV.
async function orderBySharedHealth(env, candidates, tracker, sharedHealth = null, now = Date.now()) {
  if (candidates.length < 2) return candidates;
  const keys = [...new Set(candidates.map(candidate => candidate.key))];
  let rows = null;
  try {
    rows = sharedHealth ?? (await hubHealthRows(env, keys, now)) ?? await readShared(env, keys);
  } catch {
    rows = null;
  }
  const parked = key => {
    const row = rows?.get(key);
    if (row && (row.status === 'busy' || row.status === 'blurred') && (row.until || 0) > now) return true;
    return (poolBudgetState(key, now)?.until || 0) > now;
  };
  const slow = key => (rows?.get(key)?.slow_until || 0) > now || (tracker?.records?.get(key)?.slow_until || 0) > now;
  const rank = candidate => (candidate.pool.tier === 'paid' ? 2 : 0) + (parked(candidate.key) ? 1 : 0)
    + (slow(candidate.key) ? 0.5 : 0);
  return candidates.map((candidate, index) => ({ candidate, index, rank: rank(candidate) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(item => item.candidate);
}

// A paid model whose daily spend cap (p_pool.cpd) is spent for every user until 00:00 UTC.
function spendLimitMessage(exhausted) {
  if (!exhausted.length || !exhausted.every(row => row.budget === 'cpd')) return undefined;
  const names = [...new Set(exhausted.map(row => row.model))];
  return `${names.length === 1 ? names[0] : 'This model'} has reached today's spending limit on Zero-X. ` +
    'It resets at 00:00 UTC; choose another model until then.';
}

// The client-facing error once every candidate failed (contract §3.3).
function finalError({ failures, exhausted, paidDenied }) {
  const paid = paidDenied ? reserveError(paidDenied) : null;
  if (!failures.length) {
    if (paid) return paid;
    if (exhausted.length) {
      return { code: 'capacity_exhausted', retryAfterSeconds: minimum(exhausted.map(row => row.retry_after_seconds)) ?? 60,
        message: spendLimitMessage(exhausted) };
    }
    return { code: 'service_unavailable' };
  }
  const kinds = failures.map(failure => failure.kind);
  if (kinds.includes(FailureKind.ABORTED)) return { code: 'upstream_error', message: 'The request was cancelled.' };
  if (kinds.every(kind => kind === FailureKind.CONTEXT)) return { code: 'context_length_exceeded' };
  if (kinds.every(kind => kind === FailureKind.CONTEXT || kind === FailureKind.INVALID)) {
    return { code: 'invalid_request', message: 'The model rejected the request. Check the messages, tools and parameters.' };
  }
  // Model-side rejections (e.g. a malformed tool call) are the provider's failure: refunded.
  if (kinds.some(kind => [FailureKind.SERVER, FailureKind.AUTH, FailureKind.MODEL_UNAVAILABLE,
    FailureKind.MODEL_ERROR].includes(kind))) {
    return { code: 'upstream_error' };
  }
  if (kinds.includes(FailureKind.TIMEOUT)) return { code: 'upstream_timeout' };
  if (paid) return paid;
  return {
    code: 'capacity_exhausted',
    retryAfterSeconds: minimum([...failures.map(failure => failure.retryAfterSeconds),
      ...exhausted.map(row => row.retry_after_seconds)]) ?? 30,
  };
}

export function createChatHandler({ validateSession, setSession, getSession, planLimits, router = globalRouter,
  healthTracker = globalHealthTracker, signatureCache = globalSignatureCache, claudeTurns = globalClaudeTurnCache }) {
  // Until when this isolate skips lease renewals because zerox_renew_reservation is missing.
  let renewalUnavailableUntil = 0;
  return async c => {
    const requestId = newRequestId();
    const env = c.env || {};
    const headers = { 'x-request-id': requestId };
    const fail = (code, options = {}) => errorResponse(code, { ...options, env, requestId, headers });

    let valid;
    try {
      valid = await validateSession(c);
    } catch {
      return fail('service_unavailable');
    }
    if (!valid) return fail('invalid_session');
    const { token, session } = valid;

    const raw = await c.req.text().catch(() => null);
    if (raw === null) return fail('invalid_request', { message: 'The request body could not be read.' });
    if (utf8Bytes(raw) > MAX_BODY_BYTES) return fail('invalid_request', { message: 'Completion request exceeds 1 MiB.' });
    let body = null;
    try { body = JSON.parse(raw); } catch { /* reported as invalid below */ }
    const invalid = validateCompletionBody(body);
    if (invalid) return fail('invalid_request', { message: invalid });

    const ledger = usesLedger(env, session);
    if (session.account_backed && !ledger) return fail('service_unavailable');
    const policies = ledger ? await loadPlanPolicies(env) : undefined;
    const policy = planPolicy(env, session.plan, policies);
    const [, , sharedHealth] = await Promise.all([loadCatalog(env), loadOffers(env), hubHealthForRouting(env)]);
    headers['x-neuron-plan'] = policy.id;
    const promptTokens = estimatePromptTokens(body.messages, body.tools);
    const explicitMax = body.max_completion_tokens ?? body.max_tokens;
    const requestedMax = explicitMax ?? DEFAULT_MAX_TOKENS;
    // phase ('first_byte' | 'idle' | 'response') tells liveness timeouts from slow generations;
    // caller lets the tracker require timeouts from several callers before parking a shared pool,
    // and keeps one caller on the same vault key of a model (router.js rotateKeyPools).
    const caller = session.user_id || String(token).slice(0, 16);

    let route;
    try {
      route = router.route({
        env,
        requestedModel: body.model,
        needs: requestNeeds(body),
        promptTokens,
        maxTokens: requestedMax,
        maxTokensExplicit: isSet(explicitMax),
        tiers: sessionTiers(env, session, policy),
        country: callerCountry(c.req.raw, env),
        ownedCatalog: isOwnedSession(session) ? await ownedCatalog(env, session) : null,
        affinity: caller,
        conversation: conversationKey(c.req.header('x-neuron-conversation'), body.messages),
        policy: callerPolicy(c.req.raw.headers),
        sharedHealth,
        budgetState: poolBudgetState,
      });
    } catch (error) {
      console.error('Neuron routing failed', { name: error?.name, request_id: requestId });
      return fail('service_unavailable');
    }
    if (!route.ok) {
      if (route.error === 'capacity_exhausted') {
        // Every pool that would take the request is parked after upstream 429s (provider-health.js).
        console.warn('Neuron pools rate limited upstream', { pools: route.pools, model: resolveModelId(body.model, env),
          retry_after_seconds: route.retryAfterSeconds ?? null, request_id: requestId });
      }
      return fail(route.error, { message: route.message, retryAfterSeconds: route.retryAfterSeconds, upgrade: route.upgrade });
    }

    const setQuotaHeaders = (requests, tokens) => {
      if (isSet(requests) && Number.isFinite(Number(requests))) headers['x-neuron-quota-remaining-requests'] = String(requests);
      if (isSet(tokens) && Number.isFinite(Number(tokens))) headers['x-neuron-quota-remaining-tokens'] = String(tokens);
    };

    // Anonymous/dev sessions: one daily-allocation reservation in session storage.
    let kv = null;
    if (!ledger) {
      const reserved = promptTokens + Math.max(...route.candidates.map(candidate => candidate.maxTokens));
      let quota;
      try {
        quota = await reserveSessionQuota({ c, token, session, tokens: reserved, planLimits, setSession,
          provider: route.candidates[0].entry.provider });
      } catch {
        console.error('Neuron allocation reservation unavailable', { request_id: requestId });
        return fail('service_unavailable');
      }
      if (!quota.ok) return fail('insufficient_quota', { resetsAt: quota.resetsAt });
      kv = { reserved, day: session.usage_day, settled: false };
      setQuotaHeaders(quota.remainingRequests, quota.remainingTokens);
    }
    const settleKv = async ({ actualTokens, refundRequest }) => {
      if (!kv || kv.settled) return;
      kv.settled = true;
      try {
        await settleSessionQuota({ c, token, getSession, setSession, reserved: kv.reserved, actualTokens, refundRequest, day: kv.day });
      } catch {
        console.error('Neuron allocation settlement failed', { request_id: requestId });
      }
    };
    // Settlement I/O after the response has been handed over (stream end, client cancel)
    // runs through waitUntil on Workers so it is not dropped after a disconnect.
    const background = promise => runInBackground(c, promise) ? Promise.resolve() : promise;
    // A reservation holds the user's concurrency slot for a lease (90 s) that is renewed every
    // RESERVATION_RENEW_MS while its attempt runs. When Cloudflare kills the isolate mid-stream
    // (CPU limit, eviction), nothing settles the reservation and waitUntil dies with it; the
    // timer dies too, so the lease lapses and the slot frees within 90 s. Renewals go to
    // Postgres, not KV (the Free plan allows 1,000 KV writes a day).
    // At least three renewals per lease, so one late or failed renewal never lets a running
    // attempt's lease lapse (the user's next reservation would release it under the stream).
    const leaseSeconds = Math.min(3600, positiveInt(env.RESERVATION_LEASE_SECONDS, RESERVATION_LEASE_SECONDS));
    const renewMs = Math.min(positiveInt(env.RESERVATION_RENEW_MS, RESERVATION_RENEW_MS), Math.floor(leaseSeconds * 1000 / 3));
    const leases = new Map(); // reservation id -> renewal timer
    const stopLease = id => {
      if (!leases.has(id)) return;
      clearInterval(leases.get(id));
      leases.delete(id);
    };
    const stopLeases = () => {
      for (const id of [...leases.keys()]) stopLease(id);
    };
    const holdLease = reservation => {
      const id = reservation?.reservation_id;
      if (!id || leases.has(id) || Date.now() < renewalUnavailableUntil) return;
      const timer = setInterval(() => {
        if (Date.now() < renewalUnavailableUntil) return stopLease(id);
        renewCapacity(env, id, leaseSeconds).then(renewed => {
          // Settled, or released after its lease lapsed: there is nothing left to hold.
          if (renewed === false) stopLease(id);
        }, error => {
          if (!MISSING_FUNCTION_CODES.has(error?.code)) {
            console.warn('Neuron reservation renewal failed', { name: error?.name, code: error?.code ?? null, request_id: requestId });
            return;
          }
          stopLease(id);
          if (Date.now() < renewalUnavailableUntil) return;
          renewalUnavailableUntil = Date.now() + RENEWAL_RECHECK_MS;
          console.warn('Neuron reservation renewal unavailable', { code: error.code, request_id: requestId });
        });
      }, renewMs);
      timer?.unref?.();
      leases.set(id, timer);
    };
    const settleDb = (reservation, candidate, outcome, inBackground) => {
      stopLease(reservation.reservation_id);
      const args = settlementArgs({ reservationId: reservation.reservation_id, entry: candidate.entry, pool: candidate.pool,
        promptEstimate: promptTokens, ...outcome });
      // Settling is idempotent, so a failed call is retried once. A reservation left unsettled
      // keeps its slot only until its lease lapses.
      const promise = settleCapacity(env, args).catch(() => settleCapacity(env, args)).catch(error => {
        console.error('Neuron settlement failed', { name: error?.name, request_id: requestId });
      });
      return inBackground ? background(promise) : promise;
    };
    // Settles a committed attempt with real (or estimated) usage.
    const finishAttempt = async ({ reservation, candidate, startedAt }, outcome) => {
      const status = outcome.status === 'ok' ? 'ok' : 'error';
      if (reservation) {
        await settleDb(reservation, candidate, { status, usage: outcome.usage, outputBytes: outcome.outputBytes,
          latencyMs: Date.now() - startedAt, errorCode: outcome.errorCode ?? null }, true);
      }
      if (kv) {
        const billed = billableUsage(outcome.usage, { prompt_tokens: promptTokens,
          completion_tokens: estimateOutputTokens(outcome.outputBytes) });
        await background(settleKv({ actualTokens: billed.total_tokens, refundRequest: false }));
      }
    };
    // Every outcome is also published for the whole gateway: to the HealthHub Durable Object,
    // or through KV without it (health-hub-client.js). A client abort says nothing about the pool.
    const recordFailure = (key, kind, retryAfterSeconds, latencyMs, phase = null, dailyQuota = false) => {
      if (!key) return;
      const outcome = { success: false, kind, retryAfterSeconds: retryAfterSeconds || 0, latencyMs, phase, caller, dailyQuota };
      const record = healthTracker.recordFailure(key, outcome);
      if (record && kind !== FailureKind.ABORTED) publishHealth(c, env, key, record, outcome);
    };
    const recordSuccess = (key, latencyMs, pool) => {
      if (!key) return;
      healthTracker.recordSuccess(key, { latencyMs });
      publishHealth(c, env, key, healthTracker.getRecord(key), { success: true, latencyMs });
      // Vault keys show when they last served (written at most every 10 minutes per isolate).
      const touch = pool?.key_id ? touchVaultKey(env, pool.key_id) : null;
      if (touch) background(touch);
    };

    const timeouts = streamTimeouts(env);
    const clientSignal = c.req.raw.signal;

    // Gemini thought signatures are kept per caller and upstream model (provider-request.js):
    // recorded from responses, restored into the next turn's history. Claude's thinking turns
    // (signed thinking blocks) are kept per caller the same way (anthropic-turns.js) and replayed
    // into the next request; the adapter hashes the user id into metadata.user_id.
    const signatureHooks = entry => {
      if (entry.provider === 'anthropic') {
        return { request: { caller, turns: claudeTurnHooks(claudeTurns, caller) }, onToolSignature: null };
      }
      if (entry.provider !== 'gemini') return { request: {}, onToolSignature: null };
      const scope = { caller, model: entry.upstream_model };
      return {
        request: { signatureFor: call => signatureCache.lookup({ ...scope, id: call.id, name: call.function?.name }) },
        onToolSignature: ({ id, name, signature }) => signatureCache.remember({ ...scope, id, name, signature }),
      };
    };
    // Operator diagnostics (warn): a sanitized summary of the provider's error, never the
    // request body or a key. Clients only get the masked contract errors.
    const logUpstreamDetail = (log, kind, upstream) => {
      if (upstream) console.warn('Neuron upstream error detail', { ...log, kind, upstream });
    };

    // Credentials in the prompt are replaced before it leaves the gateway and put back into the
    // answer (src/oiop/scrub.js); scrubbed once per request, for the offers OIOP_SCRUB covers.
    const scrub = scrubMode(env);
    let scrubbed = null;
    const outgoing = async offer => {
      if (!scrubsOffer(scrub, offer)) return { body, secrets: new Map(), count: 0 };
      scrubbed ||= scrubRequest(body);
      return scrubbed;
    };

    // commitBy ends this attempt's share of the failover budget: a stream's first byte and first
    // data event are due by then at the latest, however much of their own timeouts is left.
    // wholeShare: no earlier attempt took more than min(5 s, a tenth of the budget) of that share.
    const attempt = async (candidate, reservation, commitBy, wholeShare) => {
      const { entry, pool, key } = candidate;
      const sent = await outgoing(candidate.offer);
      const restorer = new SecretRestorer(sent.secrets);
      if (sent.count) headers['x-oiop-redacted'] = String(sent.count);
      else delete headers['x-oiop-redacted'];
      const payload = buildUpstreamPayload(entry, sent.body, candidate.maxTokens);
      const startedAt = Date.now();
      const log = { provider: entry.provider, model: entry.upstream_model, tier: pool.tier, request_id: requestId };
      const { request, onToolSignature } = signatureHooks(entry);
      const secrets = [poolSecret(env, pool), session.openrouter_key];
      let started;
      try {
        started = await startCompletion(env, session, entry, pool, payload, { clientSignal, timeouts, request, commitBy });
      } catch (error) {
        const kind = clientSignal?.aborted ? FailureKind.ABORTED : error?.kind || FailureKind.SERVER;
        const latencyMs = Date.now() - startedAt;
        // The failover budget, not the pool's own timeout, ended the attempt: the pool did not
        // get its full time, so it is not counted as failed. A stream that had its whole share and
        // sent no data event (SSE keep-alives at most) is slow, though, on any plan, and phase
        // 'budget' marks only that (provider-health.js): the free attempts of a plan with paid
        // capacity end at 70 % of the budget at the latest, before their own first-byte timeout,
        // so without it each such request waits out the same dead pool. A generation cut by the
        // budget says nothing about its pool. The upstream still received the request, so it
        // settles like a timeout (failed_upstream; for Claude only once message_start reported usage).
        if (kind === FailureKind.TIMEOUT && error?.phase === 'budget') {
          if (payload.stream && wholeShare) recordFailure(key, kind, null, latencyMs, 'budget');
          console.warn('Neuron failover budget ended an attempt', { ...log, latency_ms: latencyMs });
          return { ok: false, kind, budgetCut: true, retryAfterSeconds: null, latencyMs, errorCode: ERROR_CODES_BY_KIND[kind],
            usage: usageNow(partialUsageOf(error)) };
        }
        recordFailure(key, kind, error?.retryAfterSeconds, latencyMs, error?.phase ?? null, error?.dailyQuota === true);
        if (kind !== FailureKind.ABORTED) {
          console.error('Neuron upstream request failed', { ...log, kind });
          logUpstreamDetail(log, kind, error?.summary);
        }
        return { ok: false, kind, retryAfterSeconds: error?.retryAfterSeconds ?? null, latencyMs, errorCode: ERROR_CODES_BY_KIND[kind],
          usage: usageNow(partialUsageOf(error)) };
      }
      if (!started.ok) {
        const failure = classifyUpstreamFailure(started.status, started.bodyText, started.headers);
        recordFailure(key, failure.kind, failure.retryAfterSeconds, started.latencyMs, null, failure.dailyQuota);
        console.error('Neuron upstream rejected request', { ...log, status: started.status, kind: failure.kind });
        logUpstreamDetail(log, failure.kind, upstreamErrorSummary(started.status, started.bodyText, { secrets }));
        return { ok: false, ...failure, latencyMs: started.latencyMs, errorCode: ERROR_CODES_BY_KIND[failure.kind], usage: started.usage ?? null };
      }
      const responseHeaders = { ...headers, 'x-neuron-model': entry.id, 'Cache-Control': 'no-store' };
      const info = { reservation, candidate, startedAt };
      if (!payload.stream) {
        let completion;
        try {
          completion = restorer.completion(normalizeCompletion(started.json, entry.id, sent.body.messages, body.tools, { onToolSignature }));
        } catch {
          recordFailure(key, FailureKind.SERVER, null, started.latencyMs);
          console.error('Neuron upstream returned an invalid completion', log);
          return { ok: false, kind: FailureKind.SERVER, latencyMs: started.latencyMs, errorCode: 'upstream_error' };
        }
        recordSuccess(key, started.latencyMs, pool);
        await finishAttempt(info, { status: 'ok', usage: completion.usage, outputBytes: utf8Bytes(completion.choices) });
        return { ok: true, response: new Response(JSON.stringify(completion), {
          status: 200, headers: { ...responseHeaders, 'Content-Type': 'application/json' } }) };
      }
      recordSuccess(key, started.latencyMs, pool);
      const stream = createCompletionStream({
        ...started.stream, model: entry.id, controller: started.controller, clientSignal, timeouts, requestId, env,
        onToolSignature, restorer,
        onFinish: async outcome => {
          if (outcome.status !== 'ok') {
            recordFailure(key, outcome.kind, outcome.retryAfterSeconds, Date.now() - startedAt, outcome.phase ?? null,
              outcome.dailyQuota === true);
            if (outcome.kind !== FailureKind.ABORTED) {
              console.error('Neuron stream interrupted', { ...log, kind: outcome.kind });
              logUpstreamDetail(log, outcome.kind, outcome.upstream);
            }
          }
          await finishAttempt(info, outcome);
        },
      });
      return { ok: true, response: new Response(stream, { headers: { ...responseHeaders, 'Content-Type': 'text/event-stream' } }) };
    };

    // ROUTER_MAX_ATTEMPTS caps upstream attempts per request. When the plan includes paid
    // capacity, the last attempt is kept for a paid pool (while it is owed, see paidOwed) so
    // failing free pools (tried first) cannot use up every attempt of a paying user. A 429 is
    // refused before any generation, so it does not count against that cap;
    // ROUTER_MAX_RATE_LIMITED caps those refusals instead, so `auto` still reaches a provider
    // with capacity when the first ones are out of quota.
    const maxAttempts = positiveInt(env.ROUTER_MAX_ATTEMPTS, 3);
    const maxRateLimited = positiveInt(env.ROUTER_MAX_RATE_LIMITED, 6);
    // UPSTREAM_FAILOVER_BUDGET_MS (50 s, under the CLI's 60 s retry) bounds all attempts before
    // a stream is committed: each attempt gets at most what is left of it for its first byte,
    // and no attempt starts with less than min(5 s, a tenth of the budget) left. Without it,
    // three 45 s first-byte timeouts outlived the client, whose retry then ran beside the
    // abandoned request. Plans with paid capacity keep the last 30 % of the budget (15 s) for
    // their paid attempt, as they keep their last attempt for it: their free attempts are due by
    // paidCommitBy, so a free pool's 45 s first-byte timeout cannot use up the paid fallback's time.
    // A non-streaming attempt is due by its share's end plus the idle timeout (providers.js), so
    // each paid attempt of a non-streaming request starts while its share of that is left.
    const failoverBudgetMs = positiveInt(env.UPSTREAM_FAILOVER_BUDGET_MS, 50000);
    const minAttemptMs = Math.min(5000, failoverBudgetMs / 10);
    const paidReserveMs = Math.round(failoverBudgetMs * 0.3);
    const candidates = await orderBySharedHealth(env, route.candidates, healthTracker, sharedHealth);
    const paidCandidates = candidates.filter(candidate => candidate.pool.tier === 'paid');
    // The paid attempt is owed its last attempt and share of the budget only until it is made (a
    // 429 does not make it while another paid pool is left), refused or ruled out: then nothing is
    // kept for it and the free pools held back for it go next. Whether it can be reserved is
    // otherwise learned only after every free attempt, so a Pro user without credits got fewer
    // attempts and less time for free pools than a Free user, and then a refusal. Every
    // reservation row carries the account's plan and credit balance: a plan without paid pools, or
    // a balance below the credits the cheapest paid attempt holds (zerox_reserve_v2 refuses it
    // then), rules the paid attempt out.
    const paidHoldFloor = Math.min(...paidCandidates.map(candidate =>
      Math.max(1, reserveCostMicrousd(candidate.pool.price, promptTokens, candidate.maxTokens))));
    const accountCanPay = row => !(row.plan && !planPolicy(env, row.plan, policies).tiers.includes('paid'))
      && !(isSet(row.credit_balance_microusd) && Number(row.credit_balance_microusd) < paidHoldFloor);
    let paidOwed = paidCandidates.length > 0 && maxAttempts > 1;
    const failures = [];
    const exhausted = [];
    const skipModels = new Set();
    // The first candidate actually tried (after the shared-health reordering) and why it did not
    // serve, for X-OIOP-Fallback (contract §12.3).
    const first = candidates[0];
    let firstMiss = null;
    let paidDenied = null;
    let pending = null; // reservation of the last failed attempt, settled once its fate is known
    let current = null; // reservation whose attempt is in flight
    let reservations = 0;
    let attempts = 0;
    let freeAttempts = 0;
    let rateLimited = 0;
    let outOfTime = false;
    // Without an explicit status a failed attempt is settled by how it failed (see GENERATED_KINDS):
    // the user gets the request back either way (within the daily refund allowance for
    // failed_upstream), while the pool keeps attempts the upstream counted.
    // `reported`: usage the upstream reported before the attempt failed (cache split included),
    // which replaces the prompt estimate wherever usage is billed.
    const releasePending = async (status = null, outcome = {}, inBackground = false) => {
      if (!pending) return;
      const { reservation, candidate, latencyMs = 0, errorCode = null, kind = null, reported = null } = pending;
      pending = null;
      const generated = !status && (reported !== null || (GENERATED_KINDS.has(kind) && !reportsUsageAtStart(candidate.entry)));
      const settled = status || (generated ? 'failed_upstream' : 'refunded');
      const usage = generated ? reported ?? { prompt_tokens: promptTokens, completion_tokens: 0 } : undefined;
      await settleDb(reservation, candidate, { status: settled, latencyMs, errorCode, usage, ...outcome }, inBackground);
    };
    const abortedUsage = () => pending?.reported ?? { prompt_tokens: promptTokens, completion_tokens: 0 };
    // A Claude attempt the client aborted before message_start never reached the model.
    const abortedUnreached = () => Boolean(pending && pending.reported == null && reportsUsageAtStart(pending.candidate.entry));

    const failoverStart = Date.now();
    const commitBy = failoverStart + failoverBudgetMs;
    const paidCommitBy = commitBy - paidReserveMs;
    // A free attempt leaves the paid attempt its share while that is owed.
    const keepsPaidShare = candidate => paidOwed && candidate.pool.tier !== 'paid';
    const shareEnd = candidate => (keepsPaidShare(candidate) ? paidCommitBy : commitBy);
    const startBy = candidate => shareEnd(candidate) + (!body.stream && candidate.pool.tier === 'paid' ? timeouts.idleMs : 0);
    // Free pools held back for the paid attempt (its last attempt or its share of the budget).
    // Once it is made (any outcome but a 429 while another paid pool is left), refused (credits
    // held by the account's other paid requests are not in the balance) or ruled out (every paid
    // pool's budget spent, or its model rejected the request), they are tried next, before any
    // further paid pool: after a paid 5xx, a free pool that hangs or fails can take the rest of the
    // budget or the last attempt before the next paid pool gets one (GATEWAY_SETUP.md).
    const heldForPaid = [];
    const queue = [...candidates];
    const releaseHeld = index => {
      if (!paidOwed) return;
      paidOwed = false;
      queue.splice(index + 1, 0, ...heldForPaid.splice(0));
    };
    const paidLeft = index => queue.slice(index + 1).some(next => next.pool.tier === 'paid' && !skipModels.has(next.entry.id));
    try {
      for (let index = 0; index < queue.length; index++) {
        const candidate = queue[index];
        if (attempts >= maxAttempts || clientSignal?.aborted) break;
        if (skipModels.has(candidate.entry.id) || (paidDenied && candidate.pool.tier === 'paid')) continue;
        // Free pools are held back, not the paid one, once only the paid attempt's share of the
        // attempts or of the budget is left; that is not a spent budget (a 5xx from the paid
        // attempt and from the free pools tried after it still answers upstream_error).
        if (keepsPaidShare(candidate) && (freeAttempts >= maxAttempts - 1 || startBy(candidate) - Date.now() < minAttemptMs)) {
          heldForPaid.push(candidate);
          continue;
        }
        // Passed over, not the end of the loop: a later paid pool of a non-streaming request may
        // still have its start window (its share plus the idle timeout), after free pools that
        // were held back for the paid attempt and have none left.
        if (startBy(candidate) - Date.now() < minAttemptMs) {
          outOfTime = true;
          continue;
        }
        let reservation = null;
        if (ledger) {
          // A failed attempt is settled before failing over, so it never holds the caller's
          // concurrency slot or counts as a second request.
          await releasePending();
          let row;
          let args;
          try {
            args = reservationArgs({ env, session, entry: candidate.entry, pool: candidate.pool,
              requestId: reservations ? `${requestId}.${reservations}` : requestId, promptTokens, maxTokens: candidate.maxTokens });
            row = await reserveCapacity(env, args);
          } catch (error) {
            console.error('Neuron capacity reservation unavailable', { name: error?.name, request_id: requestId });
            stopLeases();
            return fail('service_unavailable');
          }
          if (!accountCanPay(row)) releaseHeld(index);
          if (row.status !== 'ok') {
            if (TERMINAL_RESERVE_STATUSES.has(row.status) || !RESERVE_ERRORS[row.status]) {
              stopLeases();
              const error = reserveError(row);
              return fail(error.code, error);
            }
            if (candidate === first) firstMiss = row.status;
            if (PAID_DENIED_STATUSES.has(row.status)) {
              paidDenied = row;
              releaseHeld(index);
            } else {
              // pool_exhausted: the shared budget of this pool (a paid pool's daily spend cap
              // included) is spent for every user.
              const budget = exhaustedBudget(args.p_pool, row.retry_after_seconds);
              exhausted.push({ ...row, budget, model: candidate.entry.display_name });
              notePoolExhausted(candidate.key, { budget, retryAfterSeconds: row.retry_after_seconds });
              console.warn('Neuron pool budget exhausted', { pool: candidate.key, model: candidate.entry.id,
                budget, retry_after_seconds: row.retry_after_seconds ?? null, request_id: requestId });
              if (!paidLeft(index)) releaseHeld(index);
            }
            continue;
          }
          notePoolReserved(candidate.key);
          reservations++;
          reservation = row;
          holdLease(row);
          current = { reservation, candidate };
          if (row.plan) headers['x-neuron-plan'] = String(row.plan);
          setQuotaHeaders(row.remaining_requests, row.remaining_tokens);
        }
        attempts++;
        if (candidate.pool.tier !== 'paid') freeAttempts++;
        headers['x-oiop-offer'] = offerIdFor(candidate.entry, candidate.pool);
        if (candidate !== first) {
          headers['x-oiop-fallback'] = `${first.entry.id}; offer=${offerIdFor(first.entry, first.pool)}; reason=${firstMiss || 'skipped'}`;
        }
        const result = await attempt(candidate, reservation, shareEnd(candidate), Date.now() - failoverStart < minAttemptMs);
        current = null;
        if (result.ok) {
          if (route.sticky) router.remember(route.sticky, candidate.entry.id);
          return result.response;
        }
        if (candidate === first) firstMiss = result.kind;
        failures.push(result);
        if (reservation) {
          pending = { reservation, candidate, latencyMs: result.latencyMs, errorCode: result.errorCode, kind: result.kind,
            reported: result.usage ?? null };
        }
        if (result.kind === FailureKind.ABORTED) break;
        if (result.kind === FailureKind.RATE_LIMITED) {
          attempts--;
          if (candidate.pool.tier !== 'paid') freeAttempts--;
          if (++rateLimited >= maxRateLimited) break;
        }
        // The same upstream model would reject the request again from another pool.
        if (result.kind === FailureKind.INVALID) skipModels.add(candidate.entry.id);
        // A paid 429 was refused before any generation and gave back its attempt: the paid
        // attempt is still owed to the next paid pool, so the held free pools wait for it.
        const paidMade = candidate.pool.tier === 'paid' && result.kind !== FailureKind.RATE_LIMITED;
        if (paidMade || !paidLeft(index)) releaseHeld(index);
      }
    } catch (error) {
      console.error('Neuron completion failed unexpectedly', { name: error?.name, request_id: requestId });
      if (current) pending = { ...current, errorCode: 'internal_error' };
      delete headers['x-oiop-offer'];
      delete headers['x-oiop-fallback'];
      await releasePending('refunded');
      stopLeases();
      await settleKv({ actualTokens: 0, refundRequest: true });
      return fail('upstream_error');
    }

    // No offer served this request.
    delete headers['x-oiop-offer'];
    delete headers['x-oiop-fallback'];
    delete headers['x-oiop-redacted'];
    const aborted = failures.some(failure => failure.kind === FailureKind.ABORTED);
    // A request that ran out of failover budget answers upstream_timeout instead of a generic
    // upstream_error; a client error (a slow 400 or 413), a cancellation or a capacity refusal
    // (with its Retry-After) still answers as such.
    const budgetSpent = outOfTime || failures.some(failure => failure.budgetCut);
    let final = finalError({ failures, exhausted, paidDenied });
    if (budgetSpent && !aborted && final.code === 'upstream_error') final = { code: 'upstream_timeout' };
    if (aborted || outOfTime) {
      console.warn(aborted ? 'Neuron client disconnected before the first byte' : 'Neuron failover budget spent',
        { kind: aborted ? FailureKind.ABORTED : FailureKind.TIMEOUT, attempts: failures.length,
          elapsed_ms: Date.now() - failoverStart, request_id: requestId });
    }
    // Requests the upstream rejected as invalid count against the caller; provider-side
    // failures are refunded (contract §3.3: upstream_error refunds the request, §6: within the
    // daily allowance when the model ran).
    const clientSide = final.code === 'context_length_exceeded' || final.code === 'invalid_request';
    // After a disconnect nobody waits for the answer, and work outside waitUntil may be cancelled
    // with the invocation, so the settlement goes through waitUntil (as after a mid-stream
    // cancel). Otherwise it completes before the answer, so a retry finds the slot released.
    const disconnected = aborted || Boolean(clientSignal?.aborted);
    if (aborted && abortedUnreached()) await releasePending('refunded', {}, true);
    else if (aborted) await releasePending('error', { usage: abortedUsage() }, true);
    else if (clientSide) await releasePending('error', { usage: { prompt_tokens: 0, completion_tokens: 0 } }, disconnected);
    else await releasePending(null, {}, disconnected);
    // No attempt runs any more (a successful one returned its response above).
    stopLeases();
    const kvSettled = settleKv({ actualTokens: aborted ? promptTokens : 0, refundRequest: !aborted && !clientSide });
    await (disconnected ? background(kvSettled) : kvSettled);
    return fail(final.code, final);
  };
}
