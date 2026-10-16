import { loadPlanCatalog, TOPUP_PACKS } from '../plan-policy.js';
import { callerCountry, listModelsForCaller, loadPlanPolicies, planPolicy } from '../catalog.js';
import { isOwnedSession, listModelsForSession } from '../providers.js';
import { sessionTiers } from '../capacity.js';

export const microusdToUsd = value => {
  const micro = Number(value);
  return Number.isFinite(micro) ? Number((micro / 1e6).toFixed(6)) : 0;
};

export function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    price: { usd_cents: plan.price.usd_cents, inr_paise: plan.price.inr_paise },
    interval: plan.interval || 'month',
    limits: { ...plan.limits },
    monthly_credit_usd: microusdToUsd(plan.monthly_credit_microusd),
    tiers: [...plan.tiers],
    features: [...plan.features],
    highlighted: plan.highlighted === true,
  };
}

export function publicTopup(pack) {
  return { id: pack.id, credit_usd: pack.credit_usd, price: { ...pack.price } };
}

export function registerPlanRoutes(api) {
  // Public: the pricing page and the CLI read this without credentials.
  api.get('/api/plans', async c => {
    const { plans } = await loadPlanCatalog(c.env);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ currency_default: 'USD', plans: plans.map(publicPlan), topups: TOPUP_PACKS.map(publicTopup) });
  });
}

// GET /v1/models (contract §3.2): every offered model with availability computed for the
// caller's plan (anonymous = free) and country. Database plan tiers apply (loaded first, 60 s
// cache); paid tiers count only for sessions with an account ledger, exactly as routing does.
// The country comes from Cloudflare (CF-IPCountry only with TRUST_CF_IPCOUNTRY=true). Sessions
// on the caller's own OpenRouter key (BYOK) list their own models.
export async function v1ModelsPayload(c, session = {}) {
  const env = c.env || {};
  const country = callerCountry(c.req.raw, env);
  if (isOwnedSession(session)) return listModelsForSession(env, { session, country });
  const plan = session?.plan || 'free';
  const policy = planPolicy(env, plan, await loadPlanPolicies(env));
  return listModelsForCaller(env, { plan, country, tiers: sessionTiers(env, session, policy) });
}
