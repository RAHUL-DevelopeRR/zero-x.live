/**
 * How a row of the active health checker (src/health-probes.js, table zerox_pool_health) reads
 * at a given time, and how long an observation stays current. Kept apart from the checker, which
 * imports the provider adapters, so health-share.js can use it on every runtime.
 */
const MINUTE = 60_000;

export const clampInt = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

// Milliseconds from a number or an ISO time; null when absent or invalid.
export const timeMs = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// A pool with no observation for this long reports unknown, never available
// (HEALTH_STALE_SECONDS: 1200 by default, 120-86400).
export function healthStaleMs(env = {}) {
  return clampInt(env?.HEALTH_STALE_SECONDS, 1200, 120, 86_400) * 1000;
}

/**
 * A checker row now, in the pool-row shape health-share.js and the router use:
 * { status: available | degraded | busy | blurred | unknown, until, at, latency_ms,
 *   last_success_at, failure_class }. `at` is when the state was observed: checked_at for the
 * row's state, or verdict_at once a timed state has ended and the row's last request-level
 * verdict (base_status) applies again. A model list never moves either (it only sets listed_at),
 * so a listed model whose last test request is older than staleMs is unknown. An unavailable pool
 * (blurred) without an end time is held for staleMs from its observation, so routing never skips
 * a pool forever on one verdict.
 */
export function probeView(row, now = Date.now(), staleMs = healthStaleMs()) {
  if (!row) return null;
  const until = timeMs(row.until ?? row.available_again_at);
  let at = timeMs(row.checked_at);
  let status = row.status;
  let end = until;
  if (status !== 'unknown' && until && until <= now) {
    status = row.base_status || 'unknown';
    end = null;
    at = timeMs(row.verdict_at);
  }
  if (!at || now - at > staleMs) status = 'unknown';
  if (!['available', 'degraded', 'busy', 'unavailable', 'unknown'].includes(status)) status = 'unknown';
  const view = {
    status: status === 'unavailable' ? 'blurred' : status, until: 0, at,
    latency_ms: Number.isFinite(row.latency_ms) ? row.latency_ms : null, last_success_at: timeMs(row.last_success_at),
    failure_class: row.failure_class ?? null, source: 'probe',
  };
  if (view.status === 'busy') view.until = end || now + MINUTE;
  if (view.status === 'blurred') view.until = end || at + staleMs;
  return view;
}
