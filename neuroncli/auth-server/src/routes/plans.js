import { loadPlanCatalog, offeredPlans, TOPUP_PACKS } from '../plan-policy.js';
import {
  AUTO_MODEL_ID, callerCountry, catalogEntry, entryPools, familyModels, listModelsForCaller, loadCatalog, loadPlanPolicies,
  planPolicy, poolKey, withIdentity,
} from '../catalog.js';
import { catalogStatus } from '../catalog-db.js';
import { isOwnedSession, listModelsForSession } from '../providers.js';
import { sessionTiers, usesLedger } from '../capacity.js';
import { withHealth, withLegacyStatus } from '../health-share.js';
import { hubHealthRows } from '../health-hub-client.js';
import { healthStaleMs, probeHealthRows, probeStaleMsFor, routeStaleMap } from '../health-probes.js';
import { dbProbeRows } from '../probe-rows-db.js';
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
    return c.json({ currency_default: 'USD', plans: offeredPlans(plans).map(publicPlan), topups: TOPUP_PACKS.map(publicTopup) });
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
  // Sponsored pools count their users' monthly tokens in the account ledger, so a session without one
  // (a development session) lists them as upgrade_required; an anonymous caller is shown the Free plan's view.
  const anonymous = !session || Object.keys(session).length === 0;
  const payload = listModelsForCaller(env, { plan, country, tiers, policy: callerPolicy(c.req.raw.headers),
    ledger: anonymous || usesLedger(env, session) });
  // models.dev facts (refreshed daily by the cron; null until then or for models it lacks).
  for (const model of payload.data) model.facts = model.id === AUTO_MODEL_ID ? null : facts[model.id] ?? null;
  // Runtime health: the pools behind each model (one per provider key) in the tiers listed for
  // it that the caller can use (all listed tiers when it can use none), read from the HealthHub
  // Durable Object (KV on the Node server or when the hub does not answer), the active checker's
  // rows on the Node gateway (src/health-probes.js), this instance's own attempts and the pool
  // budgets it saw spent. A model stays bright while any of its keys can serve; a model nobody
  // observed within HEALTH_STALE_SECONDS is unknown.
  const poolKeysFor = model => {
    const entry = catalogEntry(model.id, env);
    if (!entry) return [];
    const listed = entryPools(env, entry).filter(pool => model.tiers.includes(pool.tier));
    const usable = listed.filter(pool => tiers.includes(pool.tier));
    return (usable.length ? usable : listed).map(pool => poolKey(entry, pool));
  };
  // The checker's rows: its own cache on the Node gateway; on the Worker (which runs no checker) the
  // same rows from Postgres, cached per isolate (src/probe-rows-db.js), so both hosts show the same
  // verdicts, latency and stale horizons. Without the RPC the Worker answers as before.
  const probeRows = probeHealthRows() ?? await dbProbeRows(env);
  const floorMs = healthStaleMs(env);
  // Per route (1.5 times the route's own test interval, at least HEALTH_STALE_SECONDS): a Groq free
  // verdict tested hourly stays current for 90 minutes. The Node gateway's checker has its own map; a
  // runtime that reads the checker's rows from Postgres computes the same one from the catalog. With no
  // checker rows (none written yet, migration missing, switched off) the horizon is HEALTH_STALE_SECONDS for
  // every route, as before.
  const staleMap = probeRows?.size > 0 && !probeHealthRows() ? routeStaleMap(env) : null;
  await withHealth(env, payload, poolKeysFor, {
    tracker: globalHealthTracker, autoId: AUTO_MODEL_ID,
    isAutoCandidate: model => catalogEntry(model.id, env)?.auto_rank != null,
    readRows: keys => hubHealthRows(env, keys),
    probeRows,
    staleMs: floorMs,
    staleMsFor: probeStaleMsFor() ?? (staleMap ? key => staleMap.get(key) ?? floorMs : null),
    budgetState: poolBudgetState,
  });
  // Health is read per route (pool keys belong to routes), then rolled up per family.
  payload.data = routes ? payload.data.map(model => withIdentity(model, env)) : familyModels(payload.data, env);
  // Last: `status` in the v1.3 words Neuron alpha 4 reads, `availability` in section 15's.
  for (const model of payload.data) withLegacyStatus(model);
  return payload;
}

// GET /v1/models/status: the part of /v1/models that changes at runtime, small enough for
// clients to poll every 30 s. The ETag lets an unchanged list answer 304 with no body.
// catalog_version (src/catalog-db.js) changes with every approved catalog revision, so an approved
// change that keeps availability (a new price or display name) still changes the ETag and
// /v1/models/stream emits catalog.updated: clients then reload /v1/models.
// Each row also names the model (family, maker, display_name) and its usable context window, so a
// page can draw the live list from this endpoint alone. checked_at is when the verdict in status
// was last confirmed (null: never), with the latency of the last test request, the last success
// and the class of the last failure (docs/PLATFORM_CONTRACT.md section 15). Each row's
// stale_after_seconds says how long its verdict stands without a new observation before the
// model reads unknown (per route on the Node gateway); the top-level one is the floor,
// HEALTH_STALE_SECONDS. `status` is in the v1.3 words alpha.4 reads, `availability` in section 15's.
export async function v1ModelStatusPayload(c, session = {}, options = {}) {
  const models = await v1ModelsPayload(c, session, options);
  const floorSeconds = Math.round(healthStaleMs(c.env || {}) / 1000);
  const data = models.data.map(model => ({
    id: model.id, family: model.family ?? null, maker: model.maker ?? null, display_name: model.display_name ?? model.id,
    context_window: model.context_window ?? null, native_context_window: model.native_context_window ?? null,
    available: model.available !== false, unavailable_reason: model.unavailable_reason ?? null,
    status: model.status ?? 'unknown', availability: model.availability ?? model.status ?? 'unknown',
    available_again_at: model.available_again_at ?? null,
    checked_at: model.checked_at ?? null, latency_ms: model.latency_ms ?? null,
    last_success_at: model.last_success_at ?? null, last_failure_class: model.last_failure_class ?? null,
    stale_after_seconds: model.stale_after_seconds ?? floorSeconds,
  }));
  const catalogVersion = catalogStatus(c.env || {}).version;
  // checked_at, latency_ms and last_success_at move with every observation, so they stay out of
  // the ETag (as the top-level checked_at did): a 304 means the verdicts did not change.
  const stable = data.map(({ checked_at: _checked, latency_ms: _latency, last_success_at: _success, ...row }) => row);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ v: catalogVersion, data: stable })));
  const etag = `W/"${[...new Uint8Array(digest).slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  const checked = models.data.map(model => model.checked_at).filter(Boolean).sort().at(-1) ?? null;
  return { etag, body: { object: 'list', checked_at: checked, poll_interval_seconds: 30,
    stale_after_seconds: floorSeconds, catalog_version: catalogVersion, data } };
}

// One status payload and one serialised SSE frame per view per tick (security audit 2026-11-05, F2):
// /v1/models/stream used to recompute the payload (catalog, health merge, SHA-256) once per open
// connection every 15 s. Callers with the same view (plan, ledger, country, routes flag, caller
// policy) now share one computation for `ttlMs`, shorter than the stream interval, so a change is
// still seen on the next tick. A caller on its own OpenRouter key lists its own models and is never
// shared. At most 64 views are kept per isolate.
const sharedFrames = new Map();
const SHARED_VIEWS_MAX = 64;

export function resetSharedStatusFrames() { sharedFrames.clear(); }

export async function sharedStatusFrame(c, session = {}, ttlMs = 5000) {
  const env = c.env || {};
  const build = async () => {
    const { etag, body } = await v1ModelStatusPayload(c, session);
    return { etag, body, frame: `id: ${etag}\nevent: catalog.updated\ndata: ${JSON.stringify(body)}\n\n` };
  };
  if (isOwnedSession(session)) return build();
  const view = JSON.stringify([session?.plan || 'free', usesLedger(env, session), callerCountry(c.req.raw, env), wantsRoutes(c),
    callerPolicy(c.req.raw.headers)]);
  const now = Date.now();
  const held = sharedFrames.get(view);
  if (held && now - held.at < ttlMs) return held.promise;
  const promise = build();
  if (sharedFrames.size >= SHARED_VIEWS_MAX) sharedFrames.delete(sharedFrames.keys().next().value);
  sharedFrames.set(view, { at: now, promise });
  // A failed build is not kept for the next tick.
  promise.catch(() => { if (sharedFrames.get(view)?.promise === promise) sharedFrames.delete(view); });
  return promise;
}
