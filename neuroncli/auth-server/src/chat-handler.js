import { errorResponse, newRequestId } from './errors.js';
import {
  buildUpstreamPayload, classifyUpstreamFailure, createCompletionStream, isOwnedSession, normalizeCompletion,
  ownedCatalog, startCompletion, streamTimeouts,
} from './providers.js';
import { globalRouter } from './router.js';
import { FailureKind, globalHealthTracker } from './provider-health.js';
import { callerCountry, loadPlanPolicies, planPolicy } from './catalog.js';
import { billableUsage, estimateOutputTokens, estimatePromptTokens, utf8Bytes } from './pricing.js';
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
  [FailureKind.MODEL_UNAVAILABLE]: 'model_unavailable',
  [FailureKind.RATE_LIMITED]: 'rate_limited',
  [FailureKind.AUTH]: 'upstream_auth',
  [FailureKind.SERVER]: 'upstream_error',
  [FailureKind.TIMEOUT]: 'upstream_timeout',
  [FailureKind.ABORTED]: 'client_disconnected',
};

function minimum(values) {
  const valid = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return valid.length ? Math.min(...valid) : undefined;
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
  if (kinds.some(kind => [FailureKind.SERVER, FailureKind.AUTH, FailureKind.MODEL_UNAVAILABLE].includes(kind))) {
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

export function createChatHandler({ validateSession, setSession, getSession, planLimits, router = globalRouter, healthTracker = globalHealthTracker }) {
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
    if (!route.ok) return fail(route.error, { message: route.message, retryAfterSeconds: route.retryAfterSeconds });

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
    const settleDb = (reservation, candidate, outcome, background) => {
      const args = settlementArgs({ reservationId: reservation.reservation_id, entry: candidate.entry, pool: candidate.pool,
        promptEstimate: promptTokens, ...outcome });
      const promise = settleCapacity(env, args).catch(error => {
        console.error('Neuron settlement failed', { name: error?.name, request_id: requestId });
      });
      return background && runInBackground(c, promise) ? Promise.resolve() : promise;
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
        await settleKv({ actualTokens: billed.total_tokens, refundRequest: false });
      }
    };
    const recordFailure = (key, kind, retryAfterSeconds, latencyMs) => {
      if (key) healthTracker.recordFailure(key, { kind, retryAfterSeconds: retryAfterSeconds || 0, latencyMs });
    };

    const timeouts = streamTimeouts(env);
    const clientSignal = c.req.raw.signal;

    const attempt = async (candidate, reservation) => {
      const { entry, pool, key } = candidate;
      const payload = buildUpstreamPayload(entry, body, candidate.maxTokens);
      const startedAt = Date.now();
      const log = { provider: entry.provider, model: entry.upstream_model, tier: pool.tier, request_id: requestId };
      let started;
      try {
        started = await startCompletion(env, session, entry, pool, payload, { clientSignal, timeouts });
      } catch (error) {
        const kind = clientSignal?.aborted ? FailureKind.ABORTED : error?.kind || FailureKind.SERVER;
        const latencyMs = Date.now() - startedAt;
        recordFailure(key, kind, error?.retryAfterSeconds, latencyMs);
        if (kind !== FailureKind.ABORTED) console.error('Neuron upstream request failed', { ...log, kind });
        return { ok: false, kind, retryAfterSeconds: error?.retryAfterSeconds ?? null, latencyMs, errorCode: ERROR_CODES_BY_KIND[kind] };
      }
      if (!started.ok) {
        const failure = classifyUpstreamFailure(started.status, started.bodyText, started.headers);
        recordFailure(key, failure.kind, failure.retryAfterSeconds, started.latencyMs);
        console.error('Neuron upstream rejected request', { ...log, status: started.status, kind: failure.kind });
        return { ok: false, ...failure, latencyMs: started.latencyMs, errorCode: ERROR_CODES_BY_KIND[failure.kind] };
      }
      const responseHeaders = { ...headers, 'x-neuron-model': entry.id, 'Cache-Control': 'no-store' };
      const info = { reservation, candidate, startedAt };
      if (!payload.stream) {
        let completion;
        try {
          completion = normalizeCompletion(started.json, entry.id, body.messages, body.tools);
        } catch {
          recordFailure(key, FailureKind.SERVER, null, started.latencyMs);
          console.error('Neuron upstream returned an invalid completion', log);
          return { ok: false, kind: FailureKind.SERVER, latencyMs: started.latencyMs, errorCode: 'upstream_error' };
        }
        if (key) healthTracker.recordSuccess(key, { latencyMs: started.latencyMs });
        await finishAttempt(info, { status: 'ok', usage: completion.usage, outputBytes: utf8Bytes(completion.choices) });
        return { ok: true, response: new Response(JSON.stringify(completion), {
          status: 200, headers: { ...responseHeaders, 'Content-Type': 'application/json' } }) };
      }
      if (key) healthTracker.recordSuccess(key, { latencyMs: started.latencyMs });
      const stream = createCompletionStream({
        ...started.stream, model: entry.id, controller: started.controller, clientSignal, timeouts, requestId, env,
        onFinish: async outcome => {
          if (outcome.status !== 'ok') {
            recordFailure(key, outcome.kind, null, Date.now() - startedAt);
            if (outcome.kind !== FailureKind.ABORTED) console.error('Neuron stream interrupted', { ...log, kind: outcome.kind });
          }
          await finishAttempt(info, outcome);
        },
      });
      return { ok: true, response: new Response(stream, { headers: { ...responseHeaders, 'Content-Type': 'text/event-stream' } }) };
    };

    const maxAttempts = positiveInt(env.ROUTER_MAX_ATTEMPTS, 3);
    const failures = [];
    const exhausted = [];
    const skipModels = new Set();
    let paidDenied = null;
    let pending = null; // reservation of the last failed attempt, settled once its fate is known
    let current = null; // reservation whose attempt is in flight
    let reservations = 0;
    let attempts = 0;
    const releasePending = async (status, outcome = {}) => {
      if (!pending) return;
      const { reservation, candidate, latencyMs = 0, errorCode = null } = pending;
      pending = null;
      await settleDb(reservation, candidate, { status, latencyMs, errorCode, ...outcome }, false);
    };

    try {
      for (const candidate of route.candidates) {
        if (attempts >= maxAttempts || clientSignal?.aborted) break;
        if (skipModels.has(candidate.entry.id) || (paidDenied && candidate.pool.tier === 'paid')) continue;
        let reservation = null;
        if (ledger) {
          // A failed attempt is refunded before failing over, so it never holds the caller's
          // concurrency slot or counts as a second request.
          await releasePending('refunded');
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
            else exhausted.push(row);
            continue;
          }
          reservations++;
          reservation = row;
          current = { reservation, candidate };
          if (row.plan) headers['x-neuron-plan'] = String(row.plan);
          setQuotaHeaders(row.remaining_requests, row.remaining_tokens);
        }
        attempts++;
        const result = await attempt(candidate, reservation);
        current = null;
        if (result.ok) return result.response;
        failures.push(result);
        if (reservation) pending = { reservation, candidate, latencyMs: result.latencyMs, errorCode: result.errorCode };
        if (result.kind === FailureKind.ABORTED) break;
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

    const final = finalError({ failures, exhausted, paidDenied });
    const aborted = failures.some(failure => failure.kind === FailureKind.ABORTED);
    // Requests the upstream rejected as invalid count against the caller; provider-side
    // failures are refunded (contract §3.3: upstream_error refunds the request).
    const clientSide = final.code === 'context_length_exceeded' || final.code === 'invalid_request';
    if (aborted) await releasePending('error', { usage: { prompt_tokens: promptTokens, completion_tokens: 0 } });
    else if (clientSide) await releasePending('error', { usage: { prompt_tokens: 0, completion_tokens: 0 } });
    else await releasePending('refunded');
    await settleKv({ actualTokens: aborted ? promptTokens : 0, refundRequest: !aborted && !clientSide });
    return fail(final.code, final);
  };
}
