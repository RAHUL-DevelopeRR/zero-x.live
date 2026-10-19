import { loadPlanCatalog, TOPUP_PACKS } from '../plan-policy.js';
import {
  AUTO_MODEL_ID, callerCountry, catalogEntry, listModelsForCaller, loadPlanPolicies, planPolicy, poolKey,
} from '../catalog.js';
import { isOwnedSession, listModelsForSession } from '../providers.js';
import { sessionTiers } from '../capacity.js';
import { withHealth } from '../health-share.js';
import { hubHealthRows } from '../health-hub-client.js';
import { globalHealthTracker } from '../provider-health.js';

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
  const payload = listModelsForCaller(env, { plan, country, tiers: sessionTiers(env, session, policy) });
  // Runtime health: the pools behind each model in the tiers listed for it, read from the
  // HealthHub Durable Object (KV on the Node server or when the hub does not answer).
  const poolKeysFor = model => {
    const entry = catalogEntry(model.id);
    return entry ? entry.pools.filter(pool => model.tiers.includes(pool.tier)).map(pool => poolKey(entry, pool)) : [];
  };
  return withHealth(env, payload, poolKeysFor, {
    tracker: globalHealthTracker, autoId: AUTO_MODEL_ID,
    isAutoCandidate: model => catalogEntry(model.id)?.auto_rank != null,
    readRows: keys => hubHealthRows(env, keys),
  });
}

// GET /v1/models/status: the part of /v1/models that changes at runtime, small enough for
// clients to poll every 30 s. The ETag lets an unchanged list answer 304 with no body.
export async function v1ModelStatusPayload(c, session = {}) {
  const models = await v1ModelsPayload(c, session);
  const data = models.data.map(model => ({
    id: model.id, available: model.available !== false, unavailable_reason: model.unavailable_reason ?? null,
    status: model.status ?? 'available', available_again_at: model.available_again_at ?? null,
  }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  const etag = `W/"${[...new Uint8Array(digest).slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  const checked = models.data.map(model => model.checked_at).filter(Boolean).sort().at(-1) ?? null;
  return { etag, body: { object: 'list', checked_at: checked, poll_interval_seconds: 30, data } };
}
