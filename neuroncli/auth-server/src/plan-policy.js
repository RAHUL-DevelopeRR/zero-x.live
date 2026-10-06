import { accountRpc, databaseConfigured } from './account-store.js';

// Development-only allocations; production policy is maintained in Postgres.
export const DEVELOPMENT_PLANS = Object.freeze({
  free: { name: 'Free', daily_tokens: 256000, daily_requests: 2000, price_usd: 0 },
  pro: { name: 'Pro', daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
  ultrawork: { name: 'Pro (Legacy Ultrawork)', daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
});
const cache = new WeakMap();

export async function loadPlanLimits(env) {
  if (!databaseConfigured(env)) {
    if (env.ALLOW_ANONYMOUS_SESSIONS === 'true') return DEVELOPMENT_PLANS;
    throw new Error('Account policy unavailable');
  }
  const cached = cache.get(env);
  if (cached?.expires > Date.now()) return cached.policies;
  const { policies } = await accountRpc(env, 'zerox_plan_policies', {}) || {};
  if (!policies?.free || Object.values(policies).some(plan =>
    typeof plan?.name !== 'string' || !Number.isSafeInteger(plan.daily_tokens) || plan.daily_tokens < 1 ||
    !Number.isSafeInteger(plan.daily_requests) || plan.daily_requests < 1 ||
    !Number.isFinite(plan.price_usd) || plan.price_usd < 0)) throw new Error('Invalid account policy');
  cache.set(env, { policies, expires: Date.now() + 60000 });
  return policies;
}
