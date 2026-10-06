/**
 * ProviderHealth - In-memory health tracker and circuit breaker.
 */

export const HealthState = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  DOWN: 'DOWN',
});

export class ProviderHealthTracker {
  constructor() {
    this.records = new Map();
    this.failureThreshold = 3;
    this.defaultCooldownMs = 30000;
  }

  getRecord(provider) {
    let rec = this.records.get(provider);
    if (!rec) {
      rec = {
        provider,
        status: HealthState.HEALTHY,
        consecutive_failures: 0,
        total_attempts: 0,
        successful_attempts: 0,
        failed_attempts: 0,
        last_attempt_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_latency_ms: null,
        circuit_open_until: 0,
      };
      this.records.set(provider, rec);
    }
    return rec;
  }

  isAvailable(provider) {
    const rec = this.getRecord(provider);
    const now = Date.now();
    if (rec.circuit_open_until > now) {
      return false;
    }
    return rec.status !== HealthState.DOWN;
  }

  recordAttempt(provider, { success, status, latencyMs = 0, retryAfterSeconds = 0 }) {
    const rec = this.getRecord(provider);
    const now = Date.now();
    rec.total_attempts++;
    rec.last_attempt_at = now;
    rec.last_latency_ms = latencyMs;

    if (success) {
      rec.successful_attempts++;
      rec.consecutive_failures = 0;
      rec.last_success_at = now;
      rec.circuit_open_until = 0;
      rec.status = HealthState.HEALTHY;
    } else {
      rec.failed_attempts++;
      rec.consecutive_failures++;
      rec.last_failure_at = now;

      if (status === 429) {
        rec.status = HealthState.RATE_LIMITED;
        const cooldown = (retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : this.defaultCooldownMs);
        rec.circuit_open_until = now + cooldown;
      } else if (rec.consecutive_failures >= this.failureThreshold) {
        rec.status = HealthState.DOWN;
        rec.circuit_open_until = now + this.defaultCooldownMs;
      } else {
        rec.status = HealthState.DEGRADED;
      }
    }
    return rec;
  }

  reset(provider) {
    if (provider) {
      this.records.delete(provider);
    } else {
      this.records.clear();
    }
  }

  getSnapshot() {
    const now = Date.now();
    const snapshot = {};
    for (const [provider, rec] of this.records.entries()) {
      snapshot[provider] = {
        ...rec,
        circuit_open: rec.circuit_open_until > now,
        cooldown_remaining_ms: Math.max(0, rec.circuit_open_until - now),
      };
    }
    return snapshot;
  }
}

export const globalHealthTracker = new ProviderHealthTracker();
