import { rpc, databaseConfigured } from '../account-store.js';
import { errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { entryPools, loadCatalog, offeredEntries, poolConfigured, poolKey } from '../catalog.js';
import { globalHealthTracker } from '../provider-health.js';

const counter = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const counters = row => ({
  requests_today: counter(row?.requests_today), tokens_today: counter(row?.tokens_today),
  requests_this_minute: counter(row?.requests_this_minute), tokens_this_minute: counter(row?.tokens_this_minute),
});
const budget = limits => limits ? { rpm: limits.rpm ?? null, rpd: limits.rpd ?? null, tpm: limits.tpm ?? null, tpd: limits.tpd ?? null } : null;

// Contract §3.6 pools[]: every pool this deployment offers, with today's counters from
// zerox_admin_overview, the shared budget from the catalog (null = no shared budget) and the
// in-memory health of this isolate (keyed provider:upstream_model:tier). A pool served by
// provider key vault keys (§11.1) lists each key in `keys` with its own counters (its Postgres
// bucket), budget and health. The pool itself reports the model totals: counters summed over
// its keys, `limits` the sum of their budgets and its best key's health, since it serves while
// any key can. Keys disabled since they served today keep their counters (with no budget or
// health), as they are part of the totals.
export function overviewPools(env, rows = [], tracker = globalHealthTracker) {
  const byPool = new Map(rows.filter(row => row && typeof row === 'object').map(row => [`${row.model}#${row.tier}`, row]));
  const snapshot = tracker.getSnapshot();
  const healthOf = key => {
    const health = snapshot[key];
    return { status: health?.status ?? 'HEALTHY', circuit_open: health?.circuit_open === true,
      cooldown_remaining_ms: health?.cooldown_remaining_ms ?? 0, last_failure_kind: health?.last_failure_kind ?? null };
  };
  const pools = [];
  for (const entry of offeredEntries(env)) {
    const expanded = entryPools(env, entry);
    for (const pool of entry.pools) {
      const row = byPool.get(`${entry.id}#${pool.tier}`);
      byPool.delete(`${entry.id}#${pool.tier}`);
      // zerox_admin_overview buckets: pool_key is the vault pool's key, null for the default bucket.
      const buckets = new Map((Array.isArray(row?.keys) ? row.keys : [])
        .filter(item => item && typeof item === 'object').map(item => [item.pool_key || null, item]));
      const served = expanded.filter(item => item.tier === pool.tier);
      const keys = served.map(item => {
        const bucket = item.key_id ? poolKey(entry, item) : null;
        const usage = buckets.get(bucket);
        buckets.delete(bucket);
        return { key_id: item.key_id ?? null, source: item.key_id ? 'vault' : 'env', ...counters(usage),
          limits: budget(item.limits), health: healthOf(poolKey(entry, item)) };
      });
      const best = keys.reduce((left, right) => !left.health.circuit_open ? left : !right.health.circuit_open ? right
        : right.health.cooldown_remaining_ms < left.health.cooldown_remaining_ms ? right : left);
      for (const [bucket, usage] of buckets) {
        keys.push({ key_id: bucket ? bucket.slice(bucket.lastIndexOf('#') + 1) : null, source: bucket ? 'vault' : 'env',
          ...counters(usage), limits: null, health: null });
      }
      pools.push({
        model: entry.id, tier: pool.tier, provider: entry.provider,
        configured: served.some(item => poolConfigured(env, entry, item)),
        ...counters(row),
        limits: budget(served[0]?.shared_limits || pool.limits),
        health: best.health,
        ...(keys.some(key => key.source === 'vault') ? { keys } : {}),
      });
    }
  }
  // Counters for pools no longer offered (e.g. disabled since this morning) stay visible.
  for (const row of byPool.values()) {
    pools.push({ model: row.model, tier: row.tier, provider: null, configured: false, ...counters(row),
      limits: null, health: null });
  }
  return pools;
}

// Cron (wrangler [triggers] */10): frees reservations left by interrupted requests and
// downgrades accounts whose subscriptions ended. Rejects when either job failed so the
// invocation is reported as failed; each job runs even if the other fails.
export async function runScheduledMaintenance(env) {
  if (!databaseConfigured(env)) return { skipped: true };
  const [released, expired] = await Promise.allSettled([
    rpc(env, 'zerox_release_stale_reservations', {}),
    rpc(env, 'zerox_apply_subscription_expiry', {}),
  ]);
  const result = {
    released: released.status === 'fulfilled' ? Number(released.value?.released ?? 0) : null,
    downgraded: expired.status === 'fulfilled' ? Number(expired.value?.downgraded ?? 0) : null,
  };
  const failed = [released, expired].filter(job => job.status === 'rejected');
  if (failed.length) {
    console.error('Scheduled maintenance failed', { result, errors: failed.map(job => job.reason?.message) });
    throw new Error('Scheduled maintenance failed');
  }
  if (result.released || result.downgraded) console.log('Scheduled maintenance', result);
  // Housekeeping only (expired device sign-in grants): a failure is logged, not reported.
  await rpc(env, 'zerox_device_purge', {}).catch(error => {
    console.warn('Device grant purge failed', { message: error?.message });
  });
  return result;
}

export function registerAdminRoutes(api) {
  // GET /admin/overview (Bearer GATEWAY_ADMIN_TOKEN) → zerox_admin_overview().overview
  api.get('/admin/overview', async c => {
    if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
    try {
      const [row] = await Promise.all([rpc(c.env, 'zerox_admin_overview', {}), loadCatalog(c.env)]);
      const overview = row?.overview && typeof row.overview === 'object' ? row.overview : null;
      if (!overview) throw new Error('Admin overview returned no data');
      c.header('Cache-Control', 'no-store');
      return c.json({ ...overview, pools: overviewPools(c.env, Array.isArray(overview.pools) ? overview.pools : []) });
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}
