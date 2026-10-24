// Test helper: rows exactly as WP-B1's SQL returns them, read from an in-memory PGlite database
// with every migration applied. Suites that stub PostgREST use these so the gateway is tested
// against the real column names (rpm_limit, concurrency_limit, allowed_tiers, ...) instead of a
// hand-written shape.
import { closePglite, pgliteRpcRows } from './src/db/pglite.js';

const ENV = { DATABASE_DRIVER: 'pglite' };
let cached;

// zerox_plan_policies_v2() rows (free, pro, max, ultrawork as seeded per contract section 1).
export async function planPolicyRows() {
  cached ||= (async () => {
    try { return await pgliteRpcRows(ENV, 'zerox_plan_policies_v2', {}); }
    finally { await closePglite(ENV); }
  })();
  return structuredClone(await cached);
}

// One zerox_plan_policies_v2 row with column overrides.
export async function planPolicyRow(plan, overrides = {}) {
  const row = (await planPolicyRows()).find(item => item.plan === plan);
  if (!row) throw new Error(`No seeded plan ${plan}`);
  return { ...row, ...overrides };
}

// WP-B1 argument checks that stubs must mirror (migrations/20261016000200_business_billing.sql).
export const B1_KEY_PREFIX = /^nzx_[A-Za-z0-9_-]{0,28}$/;
export const B1_CREDIT_REASON = /^[a-z][a-z0-9_]{0,63}$/;
