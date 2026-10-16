import { rpc, databaseConfigured } from '../account-store.js';
import { errorResponse, sendApiError } from '../auth-context.js';
import { isOperator } from '../operator-auth.js';

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
      return c.json(overview);
    } catch (error) {
      return sendApiError(c, error);
    }
  });
}
