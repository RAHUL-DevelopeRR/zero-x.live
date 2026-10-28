import { errorResponse, newRequestId } from './errors.js';
import {
  buildUpstreamPayload, classifyUpstreamFailure, createCompletionStream, isOwnedSession, normalizeCompletion,
  ownedCatalog, startCompletion, streamTimeouts, upstreamErrorSummary,
} from './providers.js';
import { globalSignatureCache } from './provider-request.js';
import { globalRouter } from './router.js';
import { FailureKind, HealthState, globalHealthTracker } from './provider-health.js';
import { hubHealthRows, publishHealth } from './health-hub-client.js';
import { readShared } from './health-share.js';
import { callerCountry, loadCatalogDbModels, loadPlanPolicies, planPolicy, resolveModelId } from './catalog.js';
import { billableUsage, estimateOutputTokens, estimatePromptTokens, utf8Bytes } from './pricing.js';
import { exhaustedBudget, notePoolExhausted, notePoolReserved, poolBudgetState } from './pool-budget.js';
import {
  PAID_DENIED_STATUSES, RESERVE_ERRORS, TERMINAL_RESERVE_STATUSES, reservationArgs, reserveCapacity, reserveError,
  reserveSessionQuota, runInBackground, sessionTiers, settleCapacity, settleSessionQuota, settlementArgs, usesLedger,
} from './capacity.js';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const MAX_BODY_BYTES = 1048576;
export const MAX_OUTPUT_TOKENS = 65536;
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

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
// 5xx, network and auth failures) is returned to the pool ('refunded').
const GENERATED_KINDS = new Set([FailureKind.MODEL_ERROR, FailureKind.TIMEOUT]);

function minimum(values) {
  const valid = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return valid.length ? Math.min(...valid) : undefined;
}

// Pools another isolate saw out of capacity (busy or blurred in the HealthHub snapshot, or in
// KV on the Node server) and pools whose shared budget this isolate saw spent go after the
// other pools of their tier (free pools still come before paid ones). The router's circuit
// state only knows this isolate's own attempts, so without this a fresh isolate sends `auto`
// straight to a provider whose daily quota is gone. Degraded pools (degraded in the shared
// view, or this isolate's last attempt on them timed out) go after the healthy pools of their
// tier and before the parked ones: one caller's timeout does not open a circuit, and without
// this the same user waits through the same pool's first-byte timeout again. Parked and
// degraded pools stay in the list: when every candidate is parked, the request still tries
// them in order.
async function orderBySharedHealth(env, candidates, tracker, now = Date.now()) {
  if (candidates.length < 2) return candidates;
  const keys = [...new Set(candidates.map(candidate => candidate.key))];
  let rows = null;
  try {
    rows = (await hubHealthRows(env, keys, now)) || await readShared(env, keys);
  } catch {
    rows = null;
  }
  const parked = key => {
    const row = rows?.get(key);
    if (row && (row.status === 'busy' || row.status === 'blurred') && (row.until || 0) > now) return true;
    return (poolBudgetState(key, now)?.until || 0) > now;
  };
  const degraded = key => {
    if (rows?.get(key)?.status === 'degraded') return true;
    const record = tracker?.records?.get(key);
    return record?.status === HealthState.DEGRADED && record.last_failure_kind === FailureKind.TIMEOUT;
  };
  const rank = candidate => (candidate.pool.tier === 'paid' ? 2 : 0) + (parked(candidate.key) ? 1 : 0)
    + (degraded(candidate.key) ? 0.5 : 0);
  return candidates.map((candidate, index) => ({ candidate, index, rank: rank(candidate) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(item => item.candidate);
}

// The client-facing error once every candidate failed (contract §3.3).
function finalError({ failures, exhausted, paidDenied }) {
  const paid = paidDenied ? reserveError(paidDenied) : null;
  if (!failures.length) {
    if (paid) return paid;
    if (exhausted.length) {
      return { code: 'capacity_exhausted', retryAfterSeconds: minimum(exhausted.map(row => row.retry_after_seconds)) ?? 60 };
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
  healthTracker = globalHealthTracker, signatureCache = globalSignatureCache }) {
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
    const policy = planPolicy(env, session.plan, ledger ? await loadPlanPolicies(env) : undefined);
    await loadCatalogDbModels(env);
    headers['x-neuron-plan'] = policy.id;
    const promptTokens = estimatePromptTokens(body.messages, body.tools);
    const requestedMax = body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS;

    let route;
    try {
      route = router.route({
        env,
        requestedModel: body.model,
        needsTools: Array.isArray(body.tools) && body.tools.length > 0,
        promptTokens,
        maxTokens: requestedMax,
        tiers: sessionTiers(env, session, policy),
        country: callerCountry(c.req.raw, env),
        ownedCatalog: isOwnedSession(session) ? await ownedCatalog(env, session) : null,
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
    const settleDb = (reservation, candidate, outcome, inBackground) => {
      const args = settlementArgs({ reservationId: reservation.reservation_id, entry: candidate.entry, pool: candidate.pool,
        promptEstimate: promptTokens, ...outcome });
      const promise = settleCapacity(env, args).catch(error => {
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
    // phase ('first_byte' | 'idle' | 'response') tells liveness timeouts from slow generations;
    // caller lets the tracker require timeouts from several callers before parking a shared pool.
    const caller = session.user_id || String(token).slice(0, 16);
    // Every outcome is also published for the whole gateway: to the HealthHub Durable Object,
    // or through KV without it (health-hub-client.js). A client abort says nothing about the pool.
    const recordFailure = (key, kind, retryAfterSeconds, latencyMs, phase = null) => {
      if (!key) return;
      const outcome = { success: false, kind, retryAfterSeconds: retryAfterSeconds || 0, latencyMs, phase, caller };
      const record = healthTracker.recordFailure(key, outcome);
      if (record && kind !== FailureKind.ABORTED) publishHealth(c, env, key, record, outcome);
    };
    const recordSuccess = (key, latencyMs) => {
      if (!key) return;
      healthTracker.recordSuccess(key, { latencyMs });
      publishHealth(c, env, key, healthTracker.getRecord(key), { success: true, latencyMs });
    };

    const timeouts = streamTimeouts(env);
    const clientSignal = c.req.raw.signal;

    // Gemini thought signatures are kept per caller and upstream model (provider-request.js):
    // recorded from responses, restored into the next turn's history.
    const signatureHooks = entry => {
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

    // commitBy ends the request's failover budget: a stream's first byte and first data event
    // are due by then at the latest, however much of their own timeouts is left.
    const attempt = async (candidate, reservation, commitBy) => {
      const { entry, pool, key } = candidate;
      const payload = buildUpstreamPayload(entry, body, candidate.maxTokens);
      const startedAt = Date.now();
      const log = { provider: entry.provider, model: entry.upstream_model, tier: pool.tier, request_id: requestId };
      const { request, onToolSignature } = signatureHooks(entry);
      const secrets = [pool.key_var ? env[pool.key_var] : null, session.openrouter_key];
      let started;
      try {
        started = await startCompletion(env, session, entry, pool, payload, { clientSignal, timeouts, request, commitBy });
      } catch (error) {
        const kind = clientSignal?.aborted ? FailureKind.ABORTED : error?.kind || FailureKind.SERVER;
        const latencyMs = Date.now() - startedAt;
        recordFailure(key, kind, error?.retryAfterSeconds, latencyMs, error?.phase ?? null);
        if (kind !== FailureKind.ABORTED) {
          console.error('Neuron upstream request failed', { ...log, kind });
          logUpstreamDetail(log, kind, error?.summary);
        }
        return { ok: false, kind, retryAfterSeconds: error?.retryAfterSeconds ?? null, latencyMs, errorCode: ERROR_CODES_BY_KIND[kind] };
      }
      if (!started.ok) {
        const failure = classifyUpstreamFailure(started.status, started.bodyText, started.headers);
        recordFailure(key, failure.kind, failure.retryAfterSeconds, started.latencyMs);
        console.error('Neuron upstream rejected request', { ...log, status: started.status, kind: failure.kind });
        logUpstreamDetail(log, failure.kind, upstreamErrorSummary(started.status, started.bodyText, { secrets }));
        return { ok: false, ...failure, latencyMs: started.latencyMs, errorCode: ERROR_CODES_BY_KIND[failure.kind] };
      }
      const responseHeaders = { ...headers, 'x-neuron-model': entry.id, 'Cache-Control': 'no-store' };
      const info = { reservation, candidate, startedAt };
      if (!payload.stream) {
        let completion;
        try {
          completion = normalizeCompletion(started.json, entry.id, body.messages, body.tools, { onToolSignature });
        } catch {
          recordFailure(key, FailureKind.SERVER, null, started.latencyMs);
          console.error('Neuron upstream returned an invalid completion', log);
          return { ok: false, kind: FailureKind.SERVER, latencyMs: started.latencyMs, errorCode: 'upstream_error' };
        }
        recordSuccess(key, started.latencyMs);
        await finishAttempt(info, { status: 'ok', usage: completion.usage, outputBytes: utf8Bytes(completion.choices) });
        return { ok: true, response: new Response(JSON.stringify(completion), {
          status: 200, headers: { ...responseHeaders, 'Content-Type': 'application/json' } }) };
      }
      recordSuccess(key, started.latencyMs);
      const stream = createCompletionStream({
        ...started.stream, model: entry.id, controller: started.controller, clientSignal, timeouts, requestId, env,
        onToolSignature,
        onFinish: async outcome => {
          if (outcome.status !== 'ok') {
            recordFailure(key, outcome.kind, outcome.retryAfterSeconds, Date.now() - startedAt, outcome.phase ?? null);
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
    // capacity, the last attempt is kept for a paid pool so failing free pools (tried first)
    // cannot use up every attempt of a paying user. A 429 is refused before any generation, so
    // it does not count against that cap; ROUTER_MAX_RATE_LIMITED caps those refusals instead,
    // so `auto` still reaches a provider with capacity when the first ones are out of quota.
    const maxAttempts = positiveInt(env.ROUTER_MAX_ATTEMPTS, 3);
    const maxRateLimited = positiveInt(env.ROUTER_MAX_RATE_LIMITED, 6);
    // UPSTREAM_FAILOVER_BUDGET_MS (50 s, under the CLI's 60 s retry) bounds all attempts before
    // a stream is committed: each attempt gets at most what is left of it for its first byte,
    // and no attempt starts with less than a tenth of it (5 s) left. Without it, three 45 s
    // first-byte timeouts outlived the client, whose retry then ran beside the abandoned request.
    const failoverBudgetMs = positiveInt(env.UPSTREAM_FAILOVER_BUDGET_MS, 50000);
    const minAttemptMs = Math.min(5000, failoverBudgetMs / 10);
    const candidates = await orderBySharedHealth(env, route.candidates, healthTracker);
    const paidCandidates = candidates.some(candidate => candidate.pool.tier === 'paid');
    const freeAttemptLimit = paidCandidates && maxAttempts > 1 ? maxAttempts - 1 : maxAttempts;
    const failures = [];
    const exhausted = [];
    const skipModels = new Set();
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
    const releasePending = async (status = null, outcome = {}) => {
      if (!pending) return;
      const { reservation, candidate, latencyMs = 0, errorCode = null, kind = null } = pending;
      pending = null;
      const generated = !status && GENERATED_KINDS.has(kind);
      const settled = status || (generated ? 'failed_upstream' : 'refunded');
      const usage = generated ? { prompt_tokens: promptTokens, completion_tokens: 0 } : undefined;
      await settleDb(reservation, candidate, { status: settled, latencyMs, errorCode, usage, ...outcome }, false);
    };

    const failoverStart = Date.now();
    const commitBy = failoverStart + failoverBudgetMs;
    try {
      for (const candidate of candidates) {
        if (attempts >= maxAttempts || clientSignal?.aborted) break;
        if (skipModels.has(candidate.entry.id) || (paidDenied && candidate.pool.tier === 'paid')) continue;
        if (candidate.pool.tier !== 'paid' && !paidDenied && freeAttempts >= freeAttemptLimit) continue;
        if (commitBy - Date.now() < minAttemptMs) {
          outOfTime = true;
          break;
        }
        let reservation = null;
        if (ledger) {
          // A failed attempt is settled before failing over, so it never holds the caller's
          // concurrency slot or counts as a second request.
          await releasePending();
          let row;
          try {
            row = await reserveCapacity(env, reservationArgs({ session, entry: candidate.entry, pool: candidate.pool,
              requestId: reservations ? `${requestId}.${reservations}` : requestId, promptTokens, maxTokens: candidate.maxTokens }));
          } catch (error) {
            console.error('Neuron capacity reservation unavailable', { name: error?.name, request_id: requestId });
            return fail('service_unavailable');
          }
          if (row.status !== 'ok') {
            if (TERMINAL_RESERVE_STATUSES.has(row.status) || !RESERVE_ERRORS[row.status]) {
              const error = reserveError(row);
              return fail(error.code, error);
            }
            if (PAID_DENIED_STATUSES.has(row.status)) paidDenied = row;
            else {
              // pool_exhausted: the shared budget of this pool is spent for every user.
              exhausted.push(row);
              const budget = exhaustedBudget(candidate.pool.limits, row.retry_after_seconds);
              notePoolExhausted(candidate.key, { budget, retryAfterSeconds: row.retry_after_seconds });
              console.warn('Neuron pool budget exhausted', { pool: candidate.key, model: candidate.entry.id,
                budget, retry_after_seconds: row.retry_after_seconds ?? null, request_id: requestId });
            }
            continue;
          }
          notePoolReserved(candidate.key);
          reservations++;
          reservation = row;
          current = { reservation, candidate };
          if (row.plan) headers['x-neuron-plan'] = String(row.plan);
          setQuotaHeaders(row.remaining_requests, row.remaining_tokens);
        }
        attempts++;
        if (candidate.pool.tier !== 'paid') freeAttempts++;
        const result = await attempt(candidate, reservation, commitBy);
        current = null;
        if (result.ok) return result.response;
        failures.push(result);
        if (reservation) pending = { reservation, candidate, latencyMs: result.latencyMs, errorCode: result.errorCode, kind: result.kind };
        if (result.kind === FailureKind.ABORTED) break;
        if (result.kind === FailureKind.RATE_LIMITED) {
          attempts--;
          if (candidate.pool.tier !== 'paid') freeAttempts--;
          if (++rateLimited >= maxRateLimited) break;
        }
        // The same upstream model would reject the request again from another pool.
        if (result.kind === FailureKind.INVALID) skipModels.add(candidate.entry.id);
      }
    } catch (error) {
      console.error('Neuron completion failed unexpectedly', { name: error?.name, request_id: requestId });
      if (current) pending = { ...current, errorCode: 'internal_error' };
      await releasePending('refunded');
      await settleKv({ actualTokens: 0, refundRequest: true });
      return fail('upstream_error');
    }

    const aborted = failures.some(failure => failure.kind === FailureKind.ABORTED);
    // A spent failover budget went to upstreams that did not answer in time.
    const final = outOfTime ? { code: 'upstream_timeout' } : finalError({ failures, exhausted, paidDenied });
    if (aborted || outOfTime) {
      console.warn(aborted ? 'Neuron client disconnected before the first byte' : 'Neuron failover budget spent',
        { kind: aborted ? FailureKind.ABORTED : FailureKind.TIMEOUT, attempts: failures.length,
          elapsed_ms: Date.now() - failoverStart, request_id: requestId });
    }
    // Requests the upstream rejected as invalid count against the caller; provider-side
    // failures are refunded (contract §3.3: upstream_error refunds the request, §6: within the
    // daily allowance when the model ran).
    const clientSide = final.code === 'context_length_exceeded' || final.code === 'invalid_request';
    if (aborted) await releasePending('error', { usage: { prompt_tokens: promptTokens, completion_tokens: 0 } });
    else if (clientSide) await releasePending('error', { usage: { prompt_tokens: 0, completion_tokens: 0 } });
    else await releasePending();
    await settleKv({ actualTokens: aborted ? promptTokens : 0, refundRequest: !aborted && !clientSide });
    return fail(final.code, final);
  };
}
