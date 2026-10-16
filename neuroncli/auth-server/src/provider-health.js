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

// How an upstream attempt failed. Only provider-side kinds change health.
export const FailureKind = Object.freeze({
  CONTEXT: 'context',                    // 413 / context-length 400: skip for this request only
  INVALID: 'invalid',                    // other 400/422: the request itself was rejected
  MODEL_UNAVAILABLE: 'model_unavailable', // 404: model gone for this key
  RATE_LIMITED: 'rate_limited',          // 429
  AUTH: 'auth',                          // 401/403: key or project misconfigured
  SERVER: 'server',                      // 5xx, network failures
  TIMEOUT: 'timeout',                    // no first byte / idle stream
  ABORTED: 'aborted',                    // client went away: never counted
});

export function failureKindForStatus(status) {
  if (status === 413) return FailureKind.CONTEXT;
  if (status === 400 || status === 422) return FailureKind.INVALID;
  if (status === 404) return FailureKind.MODEL_UNAVAILABLE;
  if (status === 429) return FailureKind.RATE_LIMITED;
  if (status === 401 || status === 403) return FailureKind.AUTH;
  if (status === 408) return FailureKind.TIMEOUT;
  return FailureKind.SERVER;
}

const REQUEST_SCOPED = new Set([FailureKind.CONTEXT, FailureKind.INVALID, FailureKind.ABORTED]);

export class ProviderHealthTracker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, modelUnavailableMs = 600000,
    authCooldownMs = 300000, maxCooldownMs = 3600000 } = {}) {
    this.records = new Map();
    this.failureThreshold = failureThreshold;
    this.defaultCooldownMs = cooldownMs;
    this.modelUnavailableMs = modelUnavailableMs;
    this.authCooldownMs = authCooldownMs;
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

  recordSuccess(key, { latencyMs = 0 } = {}) {
    const rec = this.getRecord(key);
    const now = Date.now();
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

  recordFailure(key, { kind = FailureKind.SERVER, latencyMs = 0, retryAfterSeconds = 0 } = {}) {
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
  recordAttempt(key, { success, status, latencyMs = 0, retryAfterSeconds = 0, kind } = {}) {
    if (success) return this.recordSuccess(key, { latencyMs });
    return this.recordFailure(key, { kind: kind || failureKindForStatus(status), latencyMs, retryAfterSeconds });
  }

  reset(key) {
    if (key) this.records.delete(key);
    else this.records.clear();
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
