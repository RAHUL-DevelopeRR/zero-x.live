/**
 * Per-pool upstream health (per isolate). Records are keyed by pool
 * (`provider:upstream_model:tier`, see catalog.poolKey), so one dead model or one
 * exhausted key never trips the rest of a provider.
 */

export const HealthState = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  AUTH_FAILED: 'AUTH_FAILED',
  DOWN: 'DOWN',
});

// How an upstream attempt failed. Only provider-side kinds change health, and those are
// derived from HTTP statuses and structured provider fields, never from free-text messages
// (which can quote client input).
export const FailureKind = Object.freeze({
  CONTEXT: 'context',                    // 413 / context-length 400: skip for this request only
  INVALID: 'invalid',                    // other 400/422: the request itself was rejected
  MODEL_ERROR: 'model_error',            // model-side 400 (e.g. tool_use_failed): request only, refunded
  MODEL_UNAVAILABLE: 'model_unavailable', // 404: model gone for this key
  RATE_LIMITED: 'rate_limited',          // 429
  AUTH: 'auth',                          // 401/403, invalid key, region/billing precondition
  SERVER: 'server',                      // 5xx, network failures
  TIMEOUT: 'timeout',                    // no first byte / idle stream / slow response
  ABORTED: 'aborted',                    // client went away: never counted
});

// Timeouts measured while waiting for upstream bytes. A non-streaming 'response' timeout may
// just be a long generation, so it counts like a 5xx instead.
const LIVENESS_PHASES = new Set(['first_byte', 'idle']);

export function failureKindForStatus(status) {
  if (status === 413) return FailureKind.CONTEXT;
  if (status === 400 || status === 422) return FailureKind.INVALID;
  if (status === 404) return FailureKind.MODEL_UNAVAILABLE;
  if (status === 429) return FailureKind.RATE_LIMITED;
  if (status === 401 || status === 403) return FailureKind.AUTH;
  if (status === 408) return FailureKind.TIMEOUT;
  return FailureKind.SERVER;
}

const REQUEST_SCOPED = new Set([FailureKind.CONTEXT, FailureKind.INVALID, FailureKind.MODEL_ERROR, FailureKind.ABORTED]);

/**
 * Circuit rules: 404 parks the pool for modelUnavailableMs, 429 for the upstream's retry
 * delay and auth failures for authCooldownMs. First-byte and idle timeouts open it for
 * timeoutCooldownMs once timeoutThreshold distinct callers timed out within timeoutWindowMs:
 * a dead pool trips quickly, while one caller's long-thinking prompts (which a client can
 * provoke) cannot park a pool shared by everyone. 5xx, network errors and slow non-streaming
 * responses open it after failureThreshold consecutive failures, so one transient 503 does not
 * park a shared pool either. After a cooldown the next failure of a still-failing pool re-opens
 * it immediately.
 */
export class ProviderHealthTracker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, modelUnavailableMs = 600000,
    authCooldownMs = 300000, timeoutCooldownMs = 30000, timeoutThreshold = 2, timeoutWindowMs = 60000,
    maxCooldownMs = 86400000 } = {}) {
    this.records = new Map();
    // Recent liveness timeouts per pool ({caller, at}); kept apart from the records so caller
    // identities never appear in health snapshots.
    this.timeouts = new Map();
    this.timeoutThreshold = timeoutThreshold;
    this.timeoutWindowMs = timeoutWindowMs;
    this.failureThreshold = failureThreshold;
    this.defaultCooldownMs = cooldownMs;
    this.modelUnavailableMs = modelUnavailableMs;
    this.authCooldownMs = authCooldownMs;
    this.timeoutCooldownMs = timeoutCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
  }

  getRecord(key) {
    let rec = this.records.get(key);
    if (!rec) {
      rec = {
        key,
        status: HealthState.HEALTHY,
        consecutive_failures: 0,
        total_attempts: 0,
        successful_attempts: 0,
        failed_attempts: 0,
        last_attempt_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_failure_kind: null,
        last_latency_ms: null,
        circuit_open_until: 0,
      };
      if (this.records.size >= 1000) this.records.delete(this.records.keys().next().value);
      this.records.set(key, rec);
    }
    return rec;
  }

  isAvailable(key, now = Date.now()) {
    const rec = this.records.get(key);
    return !rec || rec.circuit_open_until <= now;
  }

  cooldownRemainingMs(key, now = Date.now()) {
    const rec = this.records.get(key);
    return rec ? Math.max(0, rec.circuit_open_until - now) : 0;
  }

  // Distinct callers with a liveness timeout on this pool within the window, this one included.
  // An unknown caller counts as a new one.
  timeoutCallers(key, caller, now) {
    const recent = (this.timeouts.get(key) || []).filter(entry => now - entry.at < this.timeoutWindowMs);
    recent.push({ caller: caller ?? Symbol('caller'), at: now });
    if (!this.timeouts.has(key) && this.timeouts.size >= 1000) this.timeouts.delete(this.timeouts.keys().next().value);
    this.timeouts.set(key, recent.slice(-50));
    return new Set(recent.map(entry => entry.caller)).size;
  }

  recordSuccess(key, { latencyMs = 0 } = {}) {
    const rec = this.getRecord(key);
    const now = Date.now();
    this.timeouts.delete(key);
    rec.total_attempts++;
    rec.successful_attempts++;
    rec.consecutive_failures = 0;
    rec.last_attempt_at = now;
    rec.last_success_at = now;
    rec.last_latency_ms = latencyMs;
    rec.circuit_open_until = 0;
    rec.status = HealthState.HEALTHY;
    return rec;
  }

  recordFailure(key, { kind = FailureKind.SERVER, latencyMs = 0, retryAfterSeconds = 0, phase = null, caller = null } = {}) {
    if (kind === FailureKind.ABORTED) return this.records.get(key) || null;
    const rec = this.getRecord(key);
    const now = Date.now();
    rec.total_attempts++;
    rec.last_attempt_at = now;
    rec.last_latency_ms = latencyMs;
    if (REQUEST_SCOPED.has(kind)) return rec;
    rec.failed_attempts++;
    rec.last_failure_at = now;
    rec.last_failure_kind = kind;
    const open = ms => { rec.circuit_open_until = now + Math.min(this.maxCooldownMs, Math.max(1000, ms)); };
    if (kind === FailureKind.MODEL_UNAVAILABLE) {
      rec.status = HealthState.MODEL_UNAVAILABLE;
      open(this.modelUnavailableMs);
    } else if (kind === FailureKind.RATE_LIMITED) {
      rec.status = HealthState.RATE_LIMITED;
      open(retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : this.defaultCooldownMs);
    } else if (kind === FailureKind.AUTH) {
      rec.status = HealthState.AUTH_FAILED;
      open(this.authCooldownMs);
    } else if (kind === FailureKind.TIMEOUT && LIVENESS_PHASES.has(phase)) {
      rec.consecutive_failures++;
      if (this.timeoutCallers(key, caller, now) >= this.timeoutThreshold) {
        rec.status = HealthState.DOWN;
        open(this.timeoutCooldownMs);
      } else {
        rec.status = HealthState.DEGRADED;
      }
    } else {
      rec.consecutive_failures++;
      if (rec.consecutive_failures >= this.failureThreshold) {
        rec.status = HealthState.DOWN;
        open(this.defaultCooldownMs);
      } else {
        rec.status = HealthState.DEGRADED;
      }
    }
    return rec;
  }

  // Compatibility entry point: classifies by HTTP status unless `kind` is given.
  recordAttempt(key, { success, status, latencyMs = 0, retryAfterSeconds = 0, kind, phase, caller } = {}) {
    if (success) return this.recordSuccess(key, { latencyMs });
    return this.recordFailure(key, { kind: kind || failureKindForStatus(status), latencyMs, retryAfterSeconds, phase, caller });
  }

  reset(key) {
    if (key) { this.records.delete(key); this.timeouts.delete(key); }
    else { this.records.clear(); this.timeouts.clear(); }
  }

  getSnapshot() {
    const now = Date.now();
    const snapshot = {};
    for (const [key, rec] of this.records.entries()) {
      snapshot[key] = {
        ...rec,
        circuit_open: rec.circuit_open_until > now,
        cooldown_remaining_ms: Math.max(0, rec.circuit_open_until - now),
      };
    }
    return snapshot;
  }
}

export const globalHealthTracker = new ProviderHealthTracker();
