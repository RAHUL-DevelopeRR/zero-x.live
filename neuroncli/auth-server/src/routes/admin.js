import { rpc, databaseConfigured } from '../account-store.js';
import { errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';
import { offeredEntries, poolConfigured, poolKey } from '../catalog.js';
import { globalHealthTracker } from '../provider-health.js';

const counter = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

// Contract §3.6 pools[]: every pool this deployment offers, with today's counters from
// zerox_admin_overview, the shared budget from the catalog (null = no shared budget) and the
// in-memory health of this isolate (keyed provider:upstream_model:tier).
export function overviewPools(env, rows = [], tracker = globalHealthTracker) {
  const counters = new Map(rows.filter(row => row && typeof row === 'object').map(row => [`${row.model}#${row.tier}`, row]));
  const snapshot = tracker.getSnapshot();
  const pools = [];
  for (const entry of offeredEntries(env)) {
    for (const pool of entry.pools) {
      const row = counters.get(`${entry.id}#${pool.tier}`);
      counters.delete(`${entry.id}#${pool.tier}`);
      const health = snapshot[poolKey(entry, pool)];
      pools.push({
        model: entry.id, tier: pool.tier, provider: entry.provider, configured: poolConfigured(env, entry, pool),
        requests_today: counter(row?.requests_today), tokens_today: counter(row?.tokens_today),
        requests_this_minute: counter(row?.requests_this_minute), tokens_this_minute: counter(row?.tokens_this_minute),
        limits: pool.limits ? { rpm: pool.limits.rpm ?? null, rpd: pool.limits.rpd ?? null,
          tpm: pool.limits.tpm ?? null, tpd: pool.limits.tpd ?? null } : null,
        health: { status: health?.status ?? 'HEALTHY', circuit_open: health?.circuit_open === true,
          cooldown_remaining_ms: health?.cooldown_remaining_ms ?? 0, last_failure_kind: health?.last_failure_kind ?? null },
      });
    }
  }
  // Counters for pools no longer offered (e.g. disabled since this morning) stay visible.
  for (const row of counters.values()) {
    pools.push({ model: row.model, tier: row.tier, provider: null, configured: false,
      requests_today: counter(row.requests_today), tokens_today: counter(row.tokens_today),
      requests_this_minute: counter(row.requests_this_minute), tokens_this_minute: counter(row.tokens_this_minute),
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
  return result;
}

export function registerAdminRoutes(api) {
  // GET /admin/overview (Bearer GATEWAY_ADMIN_TOKEN) → zerox_admin_overview().overview
  api.get('/admin/overview', async c => {
    if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
    try {
      const row = await rpc(c.env, 'zerox_admin_overview', {});
      const overview = row?.overview && typeof row.overview === 'object' ? row.overview : null;
      if (!overview) throw new Error('Admin overview returned no data');
      c.header('Cache-Control', 'no-store');
      return c.json({ ...overview, pools: overviewPools(c.env, Array.isArray(overview.pools) ? overview.pools : []) });
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}
