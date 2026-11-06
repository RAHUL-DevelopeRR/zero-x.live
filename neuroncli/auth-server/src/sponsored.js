// Sponsored pools that need migration 20261106000600_sponsored_pools.sql (docs/PLATFORM_CONTRACT.md
// section 19.1). The gateway sends p_cap to zerox_reserve_v2 for a sponsored pool; a database
// without the migration has no 9-argument function (PostgREST PGRST202, Postgres 42883). Serving
// the pool without its monthly allowance would be uncapped, so the pool fails closed: it is
// treated as not configured in this isolate for a while (src/catalog.js poolConfigured), and
// the first miss is logged once. Per `env` object, like the other isolate-level caches.
import { missingFunction } from './db/errors.js';

export const SPONSORED_RETRY_MS = 10 * 60_000;
const unavailable = new WeakMap(); // env -> time the retry window ends

export function sponsoredUnavailable(env, now = Date.now()) {
  if (!env || typeof env !== 'object') return false;
  return (unavailable.get(env) ?? 0) > now;
}

// Records a failed p_cap call; returns true when it was the migration's absence (callers then skip
// the candidate and carry on), false for any other error.
export function noteSponsoredFailure(env, error, now = Date.now()) {
  if (!missingFunction(error) || !env || typeof env !== 'object') return false;
  if (!sponsoredUnavailable(env, now)) {
    console.error('Sponsored pools need migration 20261106000600_sponsored_pools.sql; they are not served until it is applied');
  }
  unavailable.set(env, now + SPONSORED_RETRY_MS);
  return true;
}

// Test hook.
export function resetSponsoredUnavailable(env) {
  if (env && typeof env === 'object') unavailable.delete(env);
}
