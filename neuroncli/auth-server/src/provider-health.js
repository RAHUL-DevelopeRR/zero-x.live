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

// Strikes stop counting once the escalation is far past any cap (2^31 times the cooldown).
const MAX_RATE_LIMIT_STRIKES = 32;

const REQUEST_SCOPED = new Set([FailureKind.CONTEXT, FailureKind.INVALID, FailureKind.MODEL_ERROR, FailureKind.ABORTED]);

/**
 * Circuit rules: 404 parks the pool for modelUnavailableMs and auth failures for
 * authCooldownMs. A 429 parks it for the upstream's retry delay (Retry-After, Groq's reset
 * headers, Gemini's RetryInfo, a per-day quota), or cooldownMs without one; when the pool is
 * rate limited again within rateLimitWindowMs after its previous rate-limit cooldown ended, the
 * backoff doubles (up to rateLimitMaxBackoffMs, never below the upstream's delay) and stays at
 * the cap for as long as that keeps happening, so a shared free tier that is tighter than its
 * published limits is probed less and less often. Recency is measured from the end of the
 * cooldown, not from the previous 429, so a cooldown longer than the window cannot reset the
 * escalation. 429s that arrive while the circuit is already open (requests sent before it
 * opened) do not escalate. A success resets the backoff. First-byte and idle timeouts open it for
 * timeoutCooldownMs once timeoutThreshold distinct callers timed out within timeoutWindowMs:
 * a dead pool trips quickly, while one caller's long-thinking prompts (which a client can
 * provoke) cannot park a pool shared by everyone. 5xx, network errors and slow non-streaming
 * responses open it after failureThreshold consecutive failures, so one transient 503 does not
 * park a shared pool either. After a cooldown the next failure of a still-failing pool re-opens
 * it immediately.
 *
 * Every first-byte or idle timeout also marks the pool slow (slow_until) for slowWindowMs, and a
 * success clears the mark. A slow pool stays available; `auto` only tries it after the healthy
 * pools of its tier (chat-handler.js), so the next caller does not wait through the same
 * timeout while another pool can answer. Other failures (a 5xx, a slow non-streaming response)
 * never mark it. A stream the failover budget cut after its whole share of it (phase 'budget',
 * chat-handler.js) marks the pool slow and changes nothing else: it sent nothing for as long as
 * the request could wait, but it did not get its own timeout, so it is not counted as failed.
 */
export class ProviderHealthTracker {
  constructor({ failureThreshold = 3, cooldownMs = 30000, modelUnavailableMs = 600000,
    authCooldownMs = 300000, timeoutCooldownMs = 30000, timeoutThreshold = 2, timeoutWindowMs = 60000,
    maxCooldownMs = 86400000, rateLimitWindowMs = 600000, rateLimitMaxBackoffMs = 900000, slowWindowMs = 300000 } = {}) {
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
    this.rateLimitWindowMs = rateLimitWindowMs;
    this.rateLimitMaxBackoffMs = rateLimitMaxBackoffMs;
    this.slowWindowMs = slowWindowMs;
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
        rate_limit_strikes: 0,
        last_rate_limited_at: null,
        // End of the latest rate-limit cooldown (0 = none yet).
        rate_limited_until: 0,
        // End of the slow mark after the latest first-byte or idle timeout (0 = none).
        slow_until: 0,
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
    rec.rate_limit_strikes = 0;
    rec.slow_until = 0;
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
    if (kind === FailureKind.TIMEOUT && phase === 'budget') {
      rec.slow_until = now + this.slowWindowMs;
      return rec;
    }
    if (REQUEST_SCOPED.has(kind)) return rec;
    rec.failed_attempts++;
    rec.last_failure_at = now;
    rec.last_failure_kind = kind;
    const open = ms => { rec.circuit_open_until = now + Math.min(this.maxCooldownMs, Math.max(1000, ms)); };
    if (kind === FailureKind.MODEL_UNAVAILABLE) {
      rec.status = HealthState.MODEL_UNAVAILABLE;
      open(this.modelUnavailableMs);
    } else if (kind === FailureKind.RATE_LIMITED) {
      const alreadyOpen = rec.circuit_open_until > now;
      const recent = rec.rate_limited_until > 0 && now - rec.rate_limited_until < this.rateLimitWindowMs;
      if (!alreadyOpen) rec.rate_limit_strikes = recent ? Math.min(MAX_RATE_LIMIT_STRIKES, rec.rate_limit_strikes + 1) : 1;
      else rec.rate_limit_strikes = Math.max(1, rec.rate_limit_strikes);
      rec.last_rate_limited_at = now;
      rec.status = HealthState.RATE_LIMITED;
      const backoff = Math.min(this.rateLimitMaxBackoffMs, this.defaultCooldownMs * 2 ** (rec.rate_limit_strikes - 1));
      const hinted = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
      // The upstream's delay is honoured as given on the first strike; repeated strikes back off
      // at least as far as the escalation (half of it when the upstream named a delay).
      const ms = hinted ? Math.max(hinted, rec.rate_limit_strikes > 1 ? backoff / 2 : 0) : backoff;
      const until = now + Math.min(this.maxCooldownMs, Math.max(1000, ms));
      rec.circuit_open_until = Math.max(rec.circuit_open_until, until);
      rec.rate_limited_until = rec.circuit_open_until;
    } else if (kind === FailureKind.AUTH) {
      rec.status = HealthState.AUTH_FAILED;
      open(this.authCooldownMs);
    } else if (kind === FailureKind.TIMEOUT && LIVENESS_PHASES.has(phase)) {
      rec.consecutive_failures++;
      rec.slow_until = now + this.slowWindowMs;
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
