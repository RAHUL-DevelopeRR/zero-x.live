/**
 * Isolate side of the HealthHub Durable Object (src/health-hub.js): reports attempt outcomes
 * and reads the health snapshot for /v1/models. Without the HEALTH_HUB binding (the Node
 * server) both fall back to the KV sharing in health-share.js.
 */
import { runInBackground } from './capacity.js';
import { shareHealth } from './health-share.js';
import { FailureKind } from './provider-health.js';

const HUB_ORIGIN = 'https://health-hub.internal';
const SNAPSHOT_TTL_MS = 5_000;       // /v1/models sees health at most ~5 s older than the hub's
const SNAPSHOT_TIMEOUT_MS = 1_500;
// Healthy traffic is reported once per pool per isolate and then every 30 s, so the hub can
// clear a stale failure and keep checked_at fresh without a request per completion.
const SUCCESS_HEARTBEAT_MS = 30_000;

const reported = new Map(); // poolKey -> { healthy, at }
let snapshot = null;        // { at, pools }

export function healthHub(env) {
  const namespace = env?.HEALTH_HUB;
  if (!namespace || typeof namespace.idFromName !== 'function') return null;
  return namespace.get(namespace.idFromName('global'), { locationHint: 'apac' });
}

// Timeouts count distinct callers; the hub gets a one-way tag, never a token prefix or user id.
async function callerTag(caller) {
  if (!caller) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(caller)));
  return [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Publishes one attempt outcome for `key` after the local tracker recorded it. `record` is the
 * local record (used by the KV fallback). Returns the background task when no ExecutionContext
 * can hold it, so callers in tests or Node may await it.
 */
export function publishHealth(c, env, key, record, outcome, now = Date.now()) {
  if (!key) return undefined;
  const hub = healthHub(env);
  if (!hub) return shareHealth(c, env, key, record, now);
  const last = reported.get(key);
  if (outcome.success && last?.healthy && now - last.at < SUCCESS_HEARTBEAT_MS) return undefined;
  reported.set(key, { healthy: Boolean(outcome.success), at: now });
  const task = (async () => {
    const body = { outcomes: [{
      key, success: Boolean(outcome.success), kind: outcome.kind ?? null,
      retryAfterSeconds: outcome.retryAfterSeconds ?? 0, latencyMs: outcome.latencyMs ?? 0,
      phase: outcome.phase ?? null, caller: await callerTag(outcome.caller),
    }] };
    const response = await hub.fetch(`${HUB_ORIGIN}/report`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
  })().catch(error => {
    reported.delete(key);
    console.warn('HealthHub report failed', { pool: key, message: error?.message });
  });
  if (!runInBackground(c, task)) return task;
  return undefined;
}

/**
 * Rows ({status, until, at}) for the given pool keys from the hub's snapshot, or null when
 * there is no hub or it did not answer (the caller then reads KV).
 */
export async function hubHealthRows(env, keys, now = Date.now()) {
  const hub = healthHub(env);
  if (!hub) return null;
  if (!snapshot || now - snapshot.at >= SNAPSHOT_TTL_MS) {
    try {
      const response = await hub.fetch(`${HUB_ORIGIN}/snapshot`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
      if (!response.ok) return null;
      const body = await response.json();
      snapshot = { at: now, pools: body?.pools && typeof body.pools === 'object' ? body.pools : {} };
    } catch {
      return null;
    }
  }
  return new Map(keys.map(key => [key, snapshot.pools[key] ?? null]));
}

const ROUTING_TIMEOUT_MS = 300;
const ROUTING_STALE_MS = 60_000;

/**
 * The hub's rows for every pool, for routing (router.js skips busy and blurred pools and demotes
 * degraded ones). Uses the snapshot /v1/models reads; when it is older than 5 s the hub gets at
 * most 300 ms to answer, after which a snapshot up to a minute old still serves. Null without a
 * hub or any usable snapshot: routing then uses this isolate's tracker alone.
 */
export async function hubHealthForRouting(env, now = Date.now()) {
  const hub = healthHub(env);
  if (!hub) return null;
  if (!snapshot || now - snapshot.at >= SNAPSHOT_TTL_MS) {
    try {
      const response = await hub.fetch(`${HUB_ORIGIN}/snapshot`, { signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS) });
      if (response.ok) {
        const body = await response.json();
        snapshot = { at: now, pools: body?.pools && typeof body.pools === 'object' ? body.pools : {} };
      }
    } catch { /* a slow or failed hub leaves the previous snapshot */ }
  }
  if (!snapshot || now - snapshot.at > ROUTING_STALE_MS) return null;
  return new Map(Object.entries(snapshot.pools));
}

/**
 * Marks pools whose model disappeared from the provider's public list (daily discovery job) as
 * model_unavailable: in the hub when it is bound, otherwise in this isolate's tracker. Returns
 * the number of pools marked.
 */
export async function markPoolsUnavailable(env, keys, tracker) {
  const list = [...new Set(keys)].filter(key => typeof key === 'string' && key).slice(0, 50);
  if (!list.length) return 0;
  const hub = healthHub(env);
  if (!hub) {
    for (const key of list) tracker?.recordFailure(key, { kind: FailureKind.MODEL_UNAVAILABLE });
    return tracker ? list.length : 0;
  }
  const response = await hub.fetch(`${HUB_ORIGIN}/mark`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: list, kind: FailureKind.MODEL_UNAVAILABLE }),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  snapshot = null;
  return list.length;
}

// Test hook.
export function resetHubClientCache() {
  reported.clear();
  snapshot = null;
}
