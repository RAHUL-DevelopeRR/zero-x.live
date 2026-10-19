/**
 * Pool health shared across isolates (alpha version of the HealthHub contract).
 *
 * provider-health.js keeps circuit state per isolate, so on its own a model that 429s in one
 * isolate still looks fine everywhere else. Each isolate publishes its pool states to KV
 * (`health:v1:<poolKey>`), throttled to one write per pool per WRITE_INTERVAL_MS, and
 * GET /v1/models reads them back to give every model a public status:
 *   available | degraded | busy (short cooldown, retry soon) | blurred (greyed out until
 *   available_again_at). KV reads are eventually consistent, so a status is at most about a
 * minute old; the HealthHub Durable Object replaces this behind the same fields.
 */
import { HealthState } from './provider-health.js';
import { runInBackground } from './capacity.js';

const PREFIX = 'health:v1:';
const WRITE_INTERVAL_MS = 10_000;
const READ_INTERVAL_MS = 10_000;
// A rate-limit cooldown this short is "busy" (keep the model selectable); longer is "blurred".
const BUSY_MAX_MS = 60_000;
const MIN_TTL_SECONDS = 60;

const STATUS_RANK = Object.freeze({ available: 0, degraded: 1, busy: 2, blurred: 3 });

// Last value this isolate published or read per pool: { status, until, at }.
const known = new Map();

export function publicStatus(record, now = Date.now()) {
  if (!record) return { status: 'available', until: 0 };
  const until = record.circuit_open_until || 0;
  if (until <= now) return { status: record.status === HealthState.DEGRADED ? 'degraded' : 'available', until: 0 };
  if (record.status === HealthState.RATE_LIMITED && until - now <= BUSY_MAX_MS) return { status: 'busy', until };
  return { status: 'blurred', until };
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
  const last = known.get(key);
  const changed = !last || last.status !== next.status || Math.abs((last.until || 0) - next.until) > 5_000;
  if (!changed && now - last.at < WRITE_INTERVAL_MS) return;
  const task = (async () => {
    if (next.status === 'available') {
      if (last && last.status === 'available' && now - last.at < READ_INTERVAL_MS) return;
      const shared = await kv.get(PREFIX + key, { type: 'json' }).catch(() => null);
      known.set(key, { ...next, at: now });
      if (!shared || shared.status === 'available') return;
    }
    known.set(key, { ...next, at: now });
    const ttl = Math.max(MIN_TTL_SECONDS, Math.ceil((next.until - now) / 1000) + MIN_TTL_SECONDS);
    await kv.put(PREFIX + key, JSON.stringify({ status: next.status, until: next.until, at: now }),
      { expirationTtl: ttl });
  })().catch(() => {
    console.warn('Neuron health share failed', { pool: key });
  });
  if (!runInBackground(c, task)) return task;
}

async function readShared(env, keys) {
  const kv = env?.SESSIONS_KV;
  if (!kv || !keys.length) return new Map();
  const rows = await Promise.all(keys.map(key => kv.get(PREFIX + key, { type: 'json' }).catch(() => null)));
  return new Map(keys.map((key, index) => [key, rows[index]]));
}

/**
 * Adds status, available_again_at and checked_at to a /v1/models payload. A model's status
 * is that of its best pool among the tiers the caller can use; `auto` takes its best candidate.
 * `poolKeysFor(model)` returns the pool keys behind a listed model id.
 */
// `readRows(keys)` may supply the rows from elsewhere (the HealthHub snapshot); when it returns
// null the rows are read from KV.
export async function withHealth(env, payload, poolKeysFor,
  { tracker, autoId = null, isAutoCandidate = () => false, readRows = null, now = Date.now() } = {}) {
  const models = payload.data;
  const keysByModel = new Map(models.map(model => [model.id, poolKeysFor(model)]));
  const allKeys = [...new Set([...keysByModel.values()].flat())];
  const shared = (readRows && await readRows(allKeys)) || await readShared(env, allKeys);
  const describe = keys => {
    let best = null;
    for (const key of keys) {
      const local = tracker?.records?.get(key);
      const localStatus = local ? { ...publicStatus(local, now), at: local.last_attempt_at || now } : null;
      const row = shared.get(key);
      // busy/blurred last until their cooldown ends; degraded has no cooldown and stands as is.
      const remote = !row ? null
        : row.status === 'degraded' || (row.until || 0) > now ? row
          : { status: 'available', until: 0, at: row.at };
      // The fresher observation wins; with none, the pool counts as available.
      const pick = [localStatus, remote].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0]
        || { status: 'available', until: 0, at: null };
      if (!best || STATUS_RANK[pick.status] < STATUS_RANK[best.status]
          || (pick.status === best.status && (pick.until || 0) < (best.until || 0))) best = pick;
    }
    return best || { status: 'available', until: 0, at: null };
  };
  for (const model of models) {
    const keys = keysByModel.get(model.id) || [];
    if (!keys.length) continue;
    const state = describe(keys);
    model.status = state.status;
    model.available_again_at = state.until ? new Date(state.until).toISOString() : null;
    model.checked_at = state.at ? new Date(state.at).toISOString() : null;
  }
  const auto = autoId ? models.find(model => model.id === autoId) : null;
  if (auto) {
    const candidates = models.filter(model => model !== auto && model.available && model.status && isAutoCandidate(model));
    const best = candidates.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];
    auto.status = best ? best.status : 'blurred';
    auto.available_again_at = best?.available_again_at ?? null;
    auto.checked_at = best?.checked_at ?? null;
  }
  return payload;
}

// Test hook: forget what this isolate published.
export function resetSharedHealthCache() {
  known.clear();
}
