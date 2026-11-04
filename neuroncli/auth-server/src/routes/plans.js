import { loadPlanCatalog, TOPUP_PACKS } from '../plan-policy.js';
import {
  AUTO_MODEL_ID, callerCountry, catalogEntry, entryPools, familyModels, listModelsForCaller, loadCatalog, loadPlanPolicies,
  planPolicy, poolKey, withIdentity,
} from '../catalog.js';
import { catalogStatus } from '../catalog-db.js';
import { isOwnedSession, listModelsForSession } from '../providers.js';
import { sessionTiers } from '../capacity.js';
import { withHealth } from '../health-share.js';
import { hubHealthRows } from '../health-hub-client.js';
import { globalHealthTracker } from '../provider-health.js';
import { poolBudgetState } from '../pool-budget.js';
import { loadOffers } from '../oiop/offers.js';
import { callerPolicy } from '../oiop/policy.js';
import { modelsDevFacts } from '../oiop/models-dev.js';

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

// `?routes=1` (or true/yes) on /v1/models, /v1/models/status and /v1/models/stream lists the
// routes (one per provider type) instead of the model families (contract section 14).
export function wantsRoutes(c) {
  const value = c?.req?.query?.('routes') ?? (c?.req?.raw?.url ? new URL(c.req.raw.url).searchParams.get('routes') : null);
  return ['1', 'true', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

// GET /v1/models (contract §3.2, section 14): one entry per model family with availability
// computed for the caller's plan (anonymous = free) and country, rolled up from the routes that
// serve it; `routes: true` lists the routes themselves. Database plan tiers apply (loaded first,
// 60 s cache); paid tiers count only for sessions with an account ledger, exactly as routing does.
// The country comes from Cloudflare (CF-IPCountry only with TRUST_CF_IPCOUNTRY=true). Sessions
// on the caller's own OpenRouter key (BYOK) list their own models.
export async function v1ModelsPayload(c, session = {}, { routes = wantsRoutes(c) } = {}) {
  const env = c.env || {};
  const country = callerCountry(c.req.raw, env);
  if (isOwnedSession(session)) return listModelsForSession(env, { session, country });
  const plan = session?.plan || 'free';
  const [policies, , , facts] = await Promise.all([loadPlanPolicies(env), loadCatalog(env), loadOffers(env),
    modelsDevFacts(env)]);
  const policy = planPolicy(env, plan, policies);
  const tiers = sessionTiers(env, session, policy);
  const payload = listModelsForCaller(env, { plan, country, tiers, policy: callerPolicy(c.req.raw.headers) });
  // models.dev facts (refreshed daily by the cron; null until then or for models it lacks).
  for (const model of payload.data) model.facts = model.id === AUTO_MODEL_ID ? null : facts[model.id] ?? null;
  // Runtime health: the pools behind each model (one per provider key) in the tiers listed for
  // it that the caller can use (all listed tiers when it can use none), read from the HealthHub
  // Durable Object (KV on the Node server or when the hub does not answer), plus pool budgets
  // this isolate saw spent. A model stays bright while any of its keys can serve.
  const poolKeysFor = model => {
    const entry = catalogEntry(model.id, env);
    if (!entry) return [];
    const listed = entryPools(env, entry).filter(pool => model.tiers.includes(pool.tier));
    const usable = listed.filter(pool => tiers.includes(pool.tier));
    return (usable.length ? usable : listed).map(pool => poolKey(entry, pool));
  };
  await withHealth(env, payload, poolKeysFor, {
    tracker: globalHealthTracker, autoId: AUTO_MODEL_ID,
    isAutoCandidate: model => catalogEntry(model.id, env)?.auto_rank != null,
    readRows: keys => hubHealthRows(env, keys),
    budgetState: poolBudgetState,
  });
  // Health is read per route (pool keys belong to routes), then rolled up per family.
  payload.data = routes ? payload.data.map(model => withIdentity(model, env)) : familyModels(payload.data, env);
  return payload;
}

// GET /v1/models/status: the part of /v1/models that changes at runtime, small enough for
// clients to poll every 30 s. The ETag lets an unchanged list answer 304 with no body.
// catalog_version (src/catalog-db.js) changes with every approved catalog revision, so an approved
// change that keeps availability (a new price or display name) still changes the ETag and
// /v1/models/stream emits catalog.updated: clients then reload /v1/models.
// Each row also names the model (family, maker, display_name) and its usable context window, so a
// page can draw the live list from this endpoint alone; checked_at is the row's newest observation.
export async function v1ModelStatusPayload(c, session = {}, options = {}) {
  const models = await v1ModelsPayload(c, session, options);
  const data = models.data.map(model => ({
    id: model.id, family: model.family ?? null, maker: model.maker ?? null, display_name: model.display_name ?? model.id,
    context_window: model.context_window ?? null, native_context_window: model.native_context_window ?? null,
    available: model.available !== false, unavailable_reason: model.unavailable_reason ?? null,
    status: model.status ?? 'available', available_again_at: model.available_again_at ?? null,
    checked_at: model.checked_at ?? null,
  }));
  const catalogVersion = catalogStatus(c.env || {}).version;
  // checked_at moves with every observation, so it stays out of the ETag (as the top-level one did).
  const stable = data.map(({ checked_at: _checked, ...row }) => row);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ v: catalogVersion, data: stable })));
  const etag = `W/"${[...new Uint8Array(digest).slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  const checked = models.data.map(model => model.checked_at).filter(Boolean).sort().at(-1) ?? null;
  return { etag, body: { object: 'list', checked_at: checked, poll_interval_seconds: 30, catalog_version: catalogVersion, data } };
}
