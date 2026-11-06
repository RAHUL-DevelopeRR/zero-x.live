// The active checker's verdict rows (table zerox_pool_health, written by the Node gateway's prober,
// src/health-probes.js) read from Postgres, for the runtime that has no checker of its own: the
// Cloudflare Worker. Without them neuron.zero-x.live showed only the HealthHub's model-list checks
// (no latency, Claude and GLM `unknown`) while zero-x.live, proxied to the Node server that runs the
// checker, showed real verdicts, and a family's usable context window (src/catalog.js
// describeFamily, from the routes that can serve now) followed whichever health each host saw
// (docs/PLATFORM_CONTRACT.md section 19.5).
//
// dbProbeRows(env) returns Map<pool key, row> in the shape probeView reads (PostgREST columns:
// available_again_at, checked_at, verdict_at, base_status, latency_ms, last_success_at,
// failure_class) or null. Cached per isolate and `env` object for ROWS_TTL_MS (the checker's own
// poll interval, 30 s; /v1/models/stream loops every 15 s, so an isolate reads Postgres at most
// twice a minute however many clients watch); concurrent callers share one read; after a failed
// read the last rows are kept for ROWS_KEEP_MS (retried after RETRY_MS). Without the RPC (migration
// 20261104000000 not applied), without a database or with HEALTH_PROBES_DB_ROWS=off it returns null
// and remembers that for ROWS_KEEP_MS: the caller then answers exactly as before (HealthHub rows and
// this isolate's own attempts).
import { databaseConfigured, rpcRows } from './account-store.js';
import { missingFunction } from './db/errors.js';

export const ROWS_TTL_MS = 30_000;
export const ROWS_KEEP_MS = 10 * 60_000;
export const ROWS_TIMEOUT_MS = 1_500;
export const ROWS_SINCE_SECONDS = 86_400;
const RETRY_MS = 5_000;

// env -> { rows, readAt, retryAt, offUntil, missing, inflight }
const states = new WeakMap();
const defaultReader = (env, args) => rpcRows(env, 'zerox_pool_health_get', args);
let reader = defaultReader;

const switchedOff = env => ['off', 'false', '0', 'no'].includes(String(env?.HEALTH_PROBES_DB_ROWS ?? 'on').trim().toLowerCase());

function stateOf(env) {
  let state = states.get(env);
  if (!state) states.set(env, state = { rows: null, readAt: 0, retryAt: 0, offUntil: 0, missing: false, inflight: null });
  return state;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const usable = (state, now) => (state.rows && now - state.readAt <= ROWS_KEEP_MS ? state.rows : null);

export async function dbProbeRows(env, now = Date.now()) {
  if (!env || typeof env !== 'object' || switchedOff(env) || !databaseConfigured(env)) return null;
  const state = stateOf(env);
  if (state.offUntil > now) return null;
  if (state.rows && now - state.readAt < ROWS_TTL_MS) return state.rows;
  if (state.retryAt > now) return usable(state, now);
  if (!state.inflight) {
    state.inflight = (async () => {
      try {
        const rows = await withTimeout(Promise.resolve(reader(env, { p_since_seconds: ROWS_SINCE_SECONDS })), ROWS_TIMEOUT_MS);
        state.rows = new Map((Array.isArray(rows) ? rows : []).filter(row => typeof row?.pool === 'string').map(row => [row.pool, row]));
        state.readAt = now;
        state.retryAt = 0;
        state.missing = false;
      } catch (error) {
        if (missingFunction(error)) {
          if (!state.missing) console.error('Checker verdicts need migration 20261104000000_health_probes.sql');
          state.missing = true;
          state.rows = null;
          state.offUntil = now + ROWS_KEEP_MS;
        } else {
          state.retryAt = now + RETRY_MS; // keep the last rows meanwhile
        }
      } finally {
        state.inflight = null;
      }
    })();
  }
  await state.inflight;
  return state.offUntil > now ? null : usable(state, now);
}

// For the operator's /health on the Worker: { source: 'database' | 'none', rows, read_at,
// missing_migration, disabled }.
export function dbProbeRowsState(env, now = Date.now()) {
  const state = env && typeof env === 'object' ? states.get(env) : null;
  const rows = state && state.offUntil <= now ? usable(state, now) : null;
  return { source: rows ? 'database' : 'none', rows: rows ? rows.size : 0, read_at: rows ? new Date(state.readAt).toISOString() : null,
    missing_migration: Boolean(state?.missing), disabled: switchedOff(env) };
}

// Test hooks.
export function setProbeRowsReader(fn) {
  const previous = reader;
  reader = fn ?? defaultReader;
  return previous;
}
export function resetProbeRows(env) {
  if (env && typeof env === 'object') states.delete(env);
}
