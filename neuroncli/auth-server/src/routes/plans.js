import { loadPlanCatalog, TOPUP_PACKS } from '../plan-policy.js';

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

// GET /v1/models: delegates to WP-B2's listModelsForCaller(env, {plan, country}) when
// src/catalog.js provides it, otherwise uses the legacy provider catalogue.
// The import sits inside try/await so bundlers treat a missing module as optional.
async function importCatalog() {
  try { return await import('../catalog.js'); }
  catch { return null; }
}
let catalogModule;
export function loadCatalogModule() {
  catalogModule ||= importCatalog();
  return catalogModule;
}

export function callerCountry(c) {
  const country = c.req.raw.cf?.country || c.req.header('cf-ipcountry') || '';
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

export async function v1ModelsPayload(c, session, { catalog, legacy }) {
  if (typeof catalog?.listModelsForCaller === 'function') {
    const result = await catalog.listModelsForCaller(c.env, { plan: session?.plan || 'free', country: callerCountry(c), session });
    if (Array.isArray(result)) return { object: 'list', data: result };
    if (Array.isArray(result?.data)) return { object: 'list', ...result };
  }
  return { object: 'list', data: await legacy() };
}
