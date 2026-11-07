/**
 * Negative cache for rejected credentials (security audit 2026-11-05, F5): a bearer token or
 * device code the store has just said does not exist is remembered under its SHA-256 for
 * AUTH_NEGATIVE_CACHE_SECONDS (60), at most AUTH_NEGATIVE_CACHE_MAX (10,000) entries, oldest out
 * first, so a flood of bad tokens is answered from memory instead of becoming one Postgres RPC
 * each. Only definite rejections are cached (no record, expired, redeemed): a store that is down
 * throws and nothing is remembered. A credential minted after its rejection has a new value, so
 * a cached rejection never hides a valid credential; a session signed out is cached as rejected
 * at once. Per isolate, in both runtimes.
 *
 * Beside it, a fixed window of rejections per visitor address: after AUTH_REJECTIONS_PER_MINUTE
 * (30) rejected credentials in a minute, the anonymous endpoints that would read the database
 * (/auth/*, /v1/models with a credential) answer 429 before reading anything.
 */
import { positiveInt, windowLimiter } from './request-limits.js';

const encoder = new TextEncoder();
const rejected = new Map(); // sha256(token) -> expires (ms)
let settings = null;
let rejections = null;

function configure(env = {}) {
  if (!settings) {
    settings = {
      ttlMs: positiveInt(env.AUTH_NEGATIVE_CACHE_SECONDS, 60) * 1000,
      max: positiveInt(env.AUTH_NEGATIVE_CACHE_MAX, 10000),
      rejectionsPerMinute: positiveInt(env.AUTH_REJECTIONS_PER_MINUTE, 30),
    };
    rejections = windowLimiter(settings.rejectionsPerMinute, 60000);
  }
  return settings;
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// True while `token` was rejected within the TTL.
export async function rejectedRecently(env, token) {
  if (typeof token !== 'string' || !token) return false;
  configure(env);
  const key = await digest(token);
  const expires = rejected.get(key);
  if (expires === undefined) return false;
  if (expires <= Date.now()) { rejected.delete(key); return false; }
  return true;
}

// Remembers a definite rejection of `token`; with `address`, counts it against the visitor too.
export async function noteRejected(env, token, { address = null } = {}) {
  const { ttlMs, max } = configure(env);
  if (address) rejections(address);
  if (typeof token !== 'string' || !token) return;
  const key = await digest(token);
  // Re-inserting moves the entry to the end, so the oldest rejection is the first evicted.
  rejected.delete(key);
  if (rejected.size >= max) rejected.delete(rejected.keys().next().value);
  rejected.set(key, Date.now() + ttlMs);
}

// A credential that was just written (a session saved under this token) is valid again at once.
export async function forgetRejected(env, token) {
  if (typeof token !== 'string' || !token || rejected.size === 0) return;
  configure(env);
  rejected.delete(await digest(token));
}

// Seconds the visitor has to wait once it exceeded the rejections window, or 0.
export function rejectionsExceeded(env, address) {
  configure(env);
  if (!address) return 0;
  // Peeks without counting: only noteRejected adds to the window.
  const wait = rejections.peek(address);
  return wait;
}

// Test hook: forgets every rejection and re-reads the limits from the next env.
export function resetAuthCache() {
  rejected.clear();
  settings = null;
  rejections = null;
}

// The caller's address is rejected outright (429) while it is over its window.
export const rejectionWait = rejectionsExceeded;

export const authCacheSize = () => rejected.size;
