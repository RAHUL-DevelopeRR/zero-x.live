/**
 * Pool health shared across isolates (alpha version of the HealthHub contract).
 *
 * provider-health.js keeps circuit state per isolate, so on its own a model that 429s in one
 * isolate still looks fine everywhere else. Each isolate publishes its pool states to KV
 * (`health:v1:<poolKey>`), throttled to one write per pool per WRITE_INTERVAL_MS, and
 * GET /v1/models reads them back. Pool rows say available | degraded | busy (short cooldown,
 * retry soon) | blurred (out until available_again_at); withHealth turns them, with the active
 * checker's rows (src/health-probes.js), into the public status available | degraded | busy |
 * unknown | unavailable. KV reads are eventually consistent, so a status is at most about a
 * minute old; the HealthHub Durable Object replaces this behind the same fields.
 */
import { HealthState } from './provider-health.js';
import { runInBackground } from './capacity.js';
import { healthStaleMs, probeView } from './probe-view.js';

const PREFIX = 'health:v1:';
const WRITE_INTERVAL_MS = 10_000;
const READ_INTERVAL_MS = 10_000;
// A rate-limit cooldown this short is "busy" (keep the model selectable); longer is "blurred".
const BUSY_MAX_MS = 60_000;
const MIN_TTL_SECONDS = 60;

// Pool rows: blurred is the rows' word for unavailable. unknown (no observation within staleMs)
// ranks before busy: routing skips a busy pool and sends the request to the unknown one.
const STATUS_RANK = Object.freeze({ available: 0, degraded: 1, unknown: 2, busy: 3, blurred: 4 });
const PUBLIC_STATUS = Object.freeze({ available: 'available', degraded: 'degraded', busy: 'busy', unknown: 'unknown',
  blurred: 'unavailable' });
// The public statuses in the same order (catalog.js rolls families up with it too).
export const PUBLIC_RANK = Object.freeze({ available: 0, degraded: 1, unknown: 2, busy: 3, unavailable: 4, blurred: 4 });

// Clients written for contract v1.3 (Neuron alpha 4, still in use) read `status` and grey a
// model out only when it says `blurred` (gateway_catalog.rs is_blurred); any other word, `unavailable`
// included, reads as usable. So `status` keeps the v1.3 word and `availability` carries the section
// 15 statuses (available | degraded | unknown | busy | unavailable), which the website and newer
// clients read. `unknown` is the same in both: a v1.3 client shows it like available, which is what
// section 15 asks (selectable; routing still tries it).
export const LEGACY_STATUS = Object.freeze({ unavailable: 'blurred' });

/**
 * Splits a listed model's public status (withHealth, then the family roll-up) into the two fields
 * of docs/PLATFORM_CONTRACT.md section 15.1: `availability` (section 15 words) and `status` (the
 * v1.3 words). A model without a status is left as it is. Returns the model.
 */
export function withLegacyStatus(model) {
  if (!model || typeof model.status !== 'string') return model;
  const availability = model.status === 'blurred' ? 'unavailable' : model.status;
  model.status = LEGACY_STATUS[availability] ?? availability;
  model.availability = availability;
  return model;
}

// Last value this isolate published or read per pool: { status, until, at }.
const known = new Map();

// slow_until is present while the pool's latest first-byte or idle timeout is recent
// (provider-health.js): `auto` then tries it after the healthy pools of its tier.
export function publicStatus(record, now = Date.now()) {
  if (!record) return { status: 'available', until: 0 };
  const slow = (record.slow_until || 0) > now ? { slow_until: record.slow_until } : {};
  const until = record.circuit_open_until || 0;
  if (until <= now) return { status: record.status === HealthState.DEGRADED ? 'degraded' : 'available', until: 0, ...slow };
  if (record.status === HealthState.RATE_LIMITED && until - now <= BUSY_MAX_MS) return { status: 'busy', until, ...slow };
  return { status: 'blurred', until, ...slow };
}

/**
 * Publishes one pool's state after an attempt. Successes only overwrite a shared
 * non-available state (checked at most every READ_INTERVAL_MS), so healthy traffic costs
 * no KV writes.
 */
export function shareHealth(c, env, key, record, now = Date.now()) {
  const kv = env?.SESSIONS_KV;
  if (!kv || !key) return;
  const next = publicStatus(record, now);
  const slowUntil = next.slow_until || 0;
  const last = known.get(key);
  const changed = !last || last.status !== next.status || Math.abs((last.until || 0) - next.until) > 5_000
    || Math.abs((last.slow_until || 0) - slowUntil) > 5_000;
  if (!changed && now - last.at < WRITE_INTERVAL_MS) return;
  const task = (async () => {
    if (next.status === 'available' && !slowUntil) {
      if (last && last.status === 'available' && !last.slow_until && now - last.at < READ_INTERVAL_MS) return;
      const shared = await kv.get(PREFIX + key, { type: 'json' }).catch(() => null);
      known.set(key, { ...next, at: now });
      if (!shared || (shared.status === 'available' && !((shared.slow_until || 0) > now))) return;
    }
    known.set(key, { ...next, at: now });
    const ttl = Math.max(MIN_TTL_SECONDS, Math.ceil((Math.max(next.until, slowUntil) - now) / 1000) + MIN_TTL_SECONDS);
    await kv.put(PREFIX + key, JSON.stringify({ ...next, at: now }), { expirationTtl: ttl });
  })().catch(() => {
    console.warn('Neuron health share failed', { pool: key });
  });
  if (!runInBackground(c, task)) return task;
}

export async function readShared(env, keys) {
  const kv = env?.SESSIONS_KV;
  if (!kv || !keys.length) return new Map();
  const rows = await Promise.all(keys.map(key => kv.get(PREFIX + key, { type: 'json' }).catch(() => null)));
  return new Map(keys.map((key, index) => [key, rows[index]]));
}

/**
 * Adds status, available_again_at, checked_at, latency_ms, last_success_at, last_failure_class and
 * stale_after_seconds to a /v1/models payload (docs/PLATFORM_CONTRACT.md section 15). A model's
 * status is that of its best pool among the tiers the caller can use; `auto` takes its best
 * candidate. `poolKeysFor(model)` returns the pool keys behind a listed model id.
 *
 * Each pool has up to three observations: this instance's own attempts (`tracker`), the shared
 * rows (`readRows`: the HealthHub snapshot on Workers, KV otherwise) and the active checker's rows
 * (`probeRows`, src/health-probes.js, on the Node gateway). The freshest one wins, so a real
 * failure flips a model at once and a passing test request brightens it again. A pool whose
 * newest observation is older than its stale horizon is unknown: no observation is never reported
 * as available. The horizon is `staleMsFor(key)` when given (on the Node gateway, the checker's
 * per-route horizon: health-probes.js routeStaleMs), else `staleMs` (HEALTH_STALE_SECONDS, 20
 * minutes); stale_after_seconds reports the horizon of the pool whose verdict is shown. `budgetState(key, now)` returns { until, at } while
 * the pool's shared budget is spent (pool-budget.js): such a pool refuses every request, however
 * healthy. Public statuses: available | degraded | busy | unknown | unavailable (the pool rows'
 * `blurred`).
 */
export async function withHealth(env, payload, poolKeysFor,
  { tracker, autoId = null, isAutoCandidate = () => false, readRows = null, probeRows = null, staleMs = healthStaleMs(env),
    staleMsFor = null, budgetState = () => null, now = Date.now() } = {}) {
  const models = payload.data;
  const keysByModel = new Map(models.map(model => [model.id, poolKeysFor(model)]));
  const allKeys = [...new Set([...keysByModel.values()].flat())];
  const shared = (readRows && await readRows(allKeys)) || await readShared(env, allKeys);
  const describePool = key => {
    const stale = Number(staleMsFor?.(key)) > 0 ? Number(staleMsFor(key)) : staleMs;
    const local = tracker?.records?.get(key);
    const localStatus = local ? {
      ...publicStatus(local, now), at: local.last_attempt_at || null, latency_ms: local.last_latency_ms ?? null,
      last_success_at: local.last_success_at || null, failure_class: local.last_failure_kind || null,
    } : null;
    const row = shared.get(key);
    // busy/blurred last until their cooldown ends; degraded has no cooldown and stands as is.
    const remote = !row ? null
      : row.status === 'degraded' || (row.until || 0) > now ? row
        : { status: 'available', until: 0, at: row.at };
    const probe = probeRows?.get(key) ? probeView(probeRows.get(key), now, stale) : null;
    // The fresher verdict wins (a probe row that is stale, or listed but never asked, reads
    // unknown and carries none).
    let pick = [localStatus, remote, probe].filter(item => item && item.at && item.status !== 'unknown')
      .sort((a, b) => (b.at || 0) - (a.at || 0))[0]
      || { status: 'unknown', until: 0, at: null };
    if (!pick.at || now - pick.at > stale) pick = { ...pick, status: 'unknown', until: 0 };
    pick = { ...pick, stale_ms: stale };
    // A spent per-minute budget is busy until the next minute, a spent daily budget blurred.
    const spent = budgetState(key, now);
    if (spent?.until > now) {
      const status = spent.until - now <= BUSY_MAX_MS ? 'busy' : 'blurred';
      if (pick.status === 'unknown' || STATUS_RANK[status] > STATUS_RANK[pick.status]
          || (status === pick.status && spent.until > (pick.until || 0))) {
        pick = { ...pick, status, until: spent.until, at: spent.at };
      }
    }
    return pick;
  };
  const describe = keys => {
    let best = null;
    for (const key of keys) {
      const pick = describePool(key);
      if (!best || STATUS_RANK[pick.status] < STATUS_RANK[best.status]
          || (pick.status === best.status && (pick.until || 0) < (best.until || 0))
          || (pick.status === best.status && (pick.until || 0) === (best.until || 0) && (pick.at || 0) > (best.at || 0))) best = pick;
    }
    return best || { status: 'unknown', until: 0, at: null, stale_ms: staleMs };
  };
  for (const model of models) {
    const keys = keysByModel.get(model.id) || [];
    if (!keys.length) continue;
    const state = describe(keys);
    model.status = PUBLIC_STATUS[state.status] ?? 'unknown';
    model.available_again_at = state.until ? new Date(state.until).toISOString() : null;
    model.checked_at = state.at ? new Date(state.at).toISOString() : null;
    model.latency_ms = Number.isFinite(state.latency_ms) ? state.latency_ms : null;
    model.last_success_at = state.last_success_at ? new Date(state.last_success_at).toISOString() : null;
    model.last_failure_class = typeof state.failure_class === 'string' ? state.failure_class : null;
    model.stale_after_seconds = Math.round((state.stale_ms || staleMs) / 1000);
  }
  const auto = autoId ? models.find(model => model.id === autoId) : null;
  if (auto) {
    const candidates = models.filter(model => model !== auto && model.available && model.status && isAutoCandidate(model));
    const best = candidates.sort((a, b) => PUBLIC_RANK[a.status] - PUBLIC_RANK[b.status])[0];
    auto.status = best ? best.status : 'unavailable';
    auto.available_again_at = best?.available_again_at ?? null;
    auto.checked_at = best?.checked_at ?? null;
    auto.latency_ms = best?.latency_ms ?? null;
    auto.last_success_at = best?.last_success_at ?? null;
    auto.last_failure_class = best?.last_failure_class ?? null;
    auto.stale_after_seconds = best?.stale_after_seconds ?? Math.round(staleMs / 1000);
  }
  return payload;
}

// Test hook: forget what this isolate published.
export function resetSharedHealthCache() {
  known.clear();
}
