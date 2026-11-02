import { databaseConfigured, missingFunction, rpc } from './account-store.js';
import { deleteRecord, extendRecord, sessionExpiry, sessionTtlSeconds, sha256Hex } from './session-store.js';

// What happens when an account-backed CLI session is used (docs/PLATFORM_CONTRACT.md §10.2):
//   - its "last used" time in the linked-devices list is updated, at most every 5 minutes (A9);
//   - its expiry slides (A10): a session in use keeps CLI_SESSION_TTL_HOURS (720 h) ahead of its
//     last use, extended at most once a day and never beyond CLI_SESSION_MAX_DAYS (default 90)
//     after sign-in. An unused session still ends 720 h after its last extension.
// The session index in Postgres decides: zerox_session_touch extends the index row only while
// the session is indexed, then the record is rewritten, then the index is checked again and the
// record deleted if a sign-out or revoke landed in between (KV writes are unconditional).
// All of it runs after the response (waitUntil) and never fails a request.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TOUCH_INTERVAL_MS = 5 * MINUTE_MS;
const TOUCH_CACHE_LIMIT = 5000;
const recentTouches = new Map();
const pending = new Set();
let touchMissingUntil = 0;

export function sessionMaxLifetimeMs(env) {
  const days = Number.parseInt(env?.CLI_SESSION_MAX_DAYS, 10);
  return (Number.isSafeInteger(days) && days >= 1 && days <= 400 ? days : 90) * DAY_MS;
}

// The new expiry for a session used at `now`, or null when no extension is due. Sessions from
// before hashed storage (no `expires`) keep their fixed lifetime.
export function slidingExpiry(env, session, now = Date.now()) {
  if (!Number.isFinite(session?.created) || !Number.isFinite(session?.expires)) return null;
  const current = sessionExpiry(env, session);
  if (current <= now) return null;
  const target = Math.min(now + sessionTtlSeconds(env) * 1000, session.created + sessionMaxLifetimeMs(env));
  return target - current >= DAY_MS ? target : null;
}

function rememberTouch(hash, now) {
  if (recentTouches.size >= TOUCH_CACHE_LIMIT) recentTouches.delete(recentTouches.keys().next().value);
  recentTouches.set(hash, now);
}

// `stored` is the record as stored (sealed fields stay sealed when it is written back).
export async function noteSessionUse(env, token, stored, now = Date.now()) {
  if (!stored?.account_backed || !databaseConfigured(env) || now < touchMissingUntil) return { touched: false, extended: false };
  const hash = await sha256Hex(token);
  const extendTo = slidingExpiry(env, stored, now);
  const last = recentTouches.get(hash);
  if (!extendTo && last !== undefined && now - last < TOUCH_INTERVAL_MS) return { touched: false, extended: false };
  rememberTouch(hash, now);
  let row;
  try {
    row = await rpc(env, 'zerox_session_touch', { p_token_hash: hash, p_expires_at: extendTo ? new Date(extendTo).toISOString() : null });
  } catch (error) {
    // Without the session_devices migration, sessions keep their fixed lifetime.
    if (missingFunction(error)) { touchMissingUntil = now + 10 * MINUTE_MS; return { touched: false, extended: false }; }
    throw error;
  }
  const indexed = Date.parse(row?.expires_at);
  if (!extendTo || row?.present !== true || !(indexed > stored.expires)) return { touched: row?.present === true, extended: false };
  if (!await extendRecord(env, token, { ...stored, expires: indexed }, now)) return { touched: true, extended: false };
  const check = await rpc(env, 'zerox_session_touch', { p_token_hash: hash, p_expires_at: null });
  if (check?.present !== true) {
    await deleteRecord(env, token);
    return { touched: true, extended: false };
  }
  stored.expires = indexed;
  return { touched: true, extended: true, expires: indexed };
}

// Runs noteSessionUse after the response: through waitUntil on Workers, detached on Node.
export function trackSessionUse(env, token, stored, waitUntil = null) {
  const task = noteSessionUse(env, token, stored).catch(error => {
    console.warn('Session activity could not be recorded', { message: String(error?.message).slice(0, 160) });
  });
  pending.add(task);
  task.finally(() => pending.delete(task));
  if (typeof waitUntil === 'function') {
    try { waitUntil(task); } catch { /* no execution context: the task still runs */ }
  }
  return task;
}

// Tests: waits for every pending session-activity task.
export async function sessionActivitySettled() {
  while (pending.size) await Promise.allSettled([...pending]);
}

export function resetSessionActivity() {
  recentTouches.clear();
  touchMissingUntil = 0;
}
