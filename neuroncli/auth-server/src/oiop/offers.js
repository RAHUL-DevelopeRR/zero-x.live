// OIOP offers (docs/OIOP.md, docs/PLATFORM_CONTRACT.md §12.1, migration
// 20261029000400_oiop_offers.sql). An offer is one way to reach a provider's models (free tier,
// paid account, trial, the caller's own key) with the terms that decide who it may serve. Every
// catalog pool belongs to one offer (offerIdFor). Routing reads offers from here: the database
// rows when they loaded (60 s cache), otherwise BUILTIN_OFFERS, which mirror the migration's
// backfill so a deployment without a database routes exactly as before.
import { databaseConfigured, rpcRows } from '../account-store.js';
import { ANTHROPIC_PAID_OFFER } from '../catalog-claude.js';

export const LIFECYCLES = Object.freeze(['discovered', 'analysed', 'pending_approval', 'rejected',
  'awaiting_credentials', 'awaiting_deployment', 'probing', 'active', 'degraded', 'review', 'suspended', 'retired']);
// Lifecycles whose pools may serve requests.
export const SERVED_LIFECYCLES = Object.freeze(['active', 'degraded']);
export const TRUST_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);
export const REDISTRIBUTION = Object.freeze(['permitted', 'byok_only', 'prohibited', 'unknown']);
export const TRAINING = Object.freeze(['no', 'yes', 'varies_by_model', 'unknown']);
export const COMMERCIAL_USE = Object.freeze(['allowed', 'prohibited', 'unknown']);
export const PROTOCOLS = Object.freeze(['openai-chat', 'anthropic-messages', 'workers-ai']);

// Mirrors zerox_offer_can_transition (the database enforces it; this copy serves the admin page
// and the checks that keep both lists equal).
export const TRANSITIONS = Object.freeze({
  discovered: Object.freeze(['analysed', 'pending_approval', 'rejected']),
  analysed: Object.freeze(['pending_approval', 'rejected']),
  pending_approval: Object.freeze(['awaiting_credentials', 'awaiting_deployment', 'rejected']),
  rejected: Object.freeze(['pending_approval']),
  awaiting_credentials: Object.freeze(['probing', 'rejected', 'retired']),
  awaiting_deployment: Object.freeze(['probing', 'rejected', 'retired']),
  probing: Object.freeze(['active', 'awaiting_credentials', 'awaiting_deployment', 'suspended']),
  active: Object.freeze(['degraded', 'review', 'suspended', 'retired']),
  degraded: Object.freeze(['active', 'review', 'suspended', 'retired']),
  review: Object.freeze(['pending_approval', 'suspended', 'retired']),
  suspended: Object.freeze(['probing', 'review', 'retired']),
  retired: Object.freeze([]),
});

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

const logo = slug => `https://models.dev/logos/${slug}.svg`;
const GEMINI_TERMS = 'https://ai.google.dev/gemini-api/terms';
const GROQ_TERMS = 'https://console.groq.com/docs/legal/services-agreement';
const CLOUDFLARE_TERMS = 'https://www.cloudflare.com/service-specific-terms-developer-platform/';
const OPENROUTER_TERMS = 'https://openrouter.ai/terms';
const OPENROUTER_DATA = { field: 'trains_on_inputs', source: 'operator',
  note: 'The gateway sends provider.data_collection deny on every OpenRouter request (src/provider-adapter.js)' };

const offer = fields => Object.freeze({
  homepage: null, logo_url: null, base_url: null, protocol: 'openai-chat', access_kind: 'hosted', owner: 'operator',
  expires_after_days: null, terms_sha256: null, terms_fetched_at: null, prerequisites: [], limits: [], evidence: [],
  lifecycle: 'active', verified_by: 'operator', manifest_version: 1, notes: null, ...fields,
});

// The offers behind the code catalog (src/catalog.js), as the migrations backfill them
// (anthropic.paid: 20261029000700_catalog_seed.sql, defined in src/catalog-claude.js). The
// redistribution of nvidia.free and openrouter.free is an operator override (2026-10-24, see the
// evidence); their hosted flags still gate them.
export const BUILTIN_OFFERS = Object.freeze([
  offer({
    id: 'gemini.free', provider: 'gemini', name: 'Google Gemini API (free tier)', homepage: 'https://ai.google.dev',
    logo_url: logo('google'), base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    trust_tier: 'T0', redistribution: 'permitted', trains_on_inputs: 'yes', commercial_use: 'allowed', terms_url: GEMINI_TERMS,
    prerequisites: [{ type: 'account', detail: 'Google account and an AI Studio API key' }],
    limits: [{ scope: 'model', rpm: 5, rpd: 250, tpm: 120000, tpd: 5000000, reset_tz: 'America/Los_Angeles' }],
    evidence: [
      { field: 'trains_on_inputs', source: 'operator', url: GEMINI_TERMS,
        note: 'docs/PROVIDER_TERMS.md: free-tier prompts may train and be human-reviewed' },
      { field: 'redistribution', source: 'operator', url: GEMINI_TERMS,
        note: 'docs/PROVIDER_TERMS.md: allowed for API clients; paid services only for users in the EEA, UK and CH (the free pool is geo-blocked there)' },
    ],
  }),
  offer({
    id: 'gemini.paid', provider: 'gemini', name: 'Google Gemini API (paid)', homepage: 'https://ai.google.dev',
    logo_url: logo('google'), base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    trust_tier: 'T0', redistribution: 'permitted', trains_on_inputs: 'no', commercial_use: 'allowed', terms_url: GEMINI_TERMS,
    prerequisites: [{ type: 'billing', detail: 'Cloud Billing linked project' }],
    evidence: [{ field: 'trains_on_inputs', source: 'operator', url: GEMINI_TERMS,
      note: 'Paid Services prompts are not used to improve Google products' }],
  }),
  offer({
    id: 'groq.free', provider: 'groq', name: 'GroqCloud (free tier)', homepage: 'https://groq.com', logo_url: logo('groq'),
    base_url: 'https://api.groq.com/openai/v1', trust_tier: 'T1', redistribution: 'permitted', trains_on_inputs: 'unknown',
    commercial_use: 'allowed', terms_url: GROQ_TERMS,
    prerequisites: [{ type: 'account', detail: 'GroqCloud organization and API key' }],
    limits: [{ scope: 'model', rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }],
    evidence: [{ field: 'redistribution', source: 'operator', url: GROQ_TERMS,
      note: 'docs/PROVIDER_TERMS.md: Services Agreement §3.1 allows End Users via Customer Applications; §6.3(c) bars resale without approval' }],
  }),
  offer({
    id: 'groq.paid', provider: 'groq', name: 'GroqCloud (Developer plan)', homepage: 'https://groq.com', logo_url: logo('groq'),
    base_url: 'https://api.groq.com/openai/v1', trust_tier: 'T1', redistribution: 'permitted', trains_on_inputs: 'unknown',
    commercial_use: 'allowed', terms_url: GROQ_TERMS, prerequisites: [{ type: 'billing', detail: 'Developer plan' }],
  }),
  offer({
    id: 'cloudflare.free', provider: 'cloudflare', name: 'Cloudflare Workers AI (free allocation)',
    homepage: 'https://developers.cloudflare.com/workers-ai/', logo_url: logo('cloudflare-workers-ai'), protocol: 'workers-ai',
    trust_tier: 'T1', redistribution: 'permitted', trains_on_inputs: 'no', commercial_use: 'allowed', terms_url: CLOUDFLARE_TERMS,
    prerequisites: [{ type: 'account', detail: 'Cloudflare account with the Workers AI binding' }],
    limits: [{ scope: 'account', neurons_per_day: 10000, reset_tz: 'UTC' }],
    evidence: [{ field: 'trains_on_inputs', source: 'operator', url: 'https://developers.cloudflare.com/workers-ai/platform/pricing',
      note: 'docs/PROVIDER_TERMS.md: no training on customer content' }],
  }),
  offer({
    id: 'cloudflare.paid', provider: 'cloudflare', name: 'Cloudflare Workers AI (Workers Paid)',
    homepage: 'https://developers.cloudflare.com/workers-ai/', logo_url: logo('cloudflare-workers-ai'), protocol: 'workers-ai',
    trust_tier: 'T1', redistribution: 'permitted', trains_on_inputs: 'no', commercial_use: 'allowed', terms_url: CLOUDFLARE_TERMS,
    prerequisites: [{ type: 'billing', detail: 'Workers Paid plan' }],
  }),
  offer({
    id: 'nvidia.free', provider: 'nvidia', name: 'NVIDIA API Catalog (trial)', homepage: 'https://build.nvidia.com',
    logo_url: logo('nvidia'), base_url: 'https://integrate.api.nvidia.com/v1', trust_tier: 'T1', redistribution: 'permitted',
    trains_on_inputs: 'unknown', commercial_use: 'prohibited',
    terms_url: 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
    prerequisites: [{ type: 'account', detail: 'NVIDIA developer account and an API catalog key' }],
    limits: [{ scope: 'key', rpm: 40, rpd: 10000 }],
    evidence: [{ field: 'redistribution', source: 'operator',
      note: 'Operator override (2026-10-24) to keep the alpha catalog serving. docs/PROVIDER_TERMS.md records Trial Terms §1.2/§1.4 (trial and internal evaluation only) and §4.2 (no making Generated Content available to others). Served only with NVIDIA_HOSTED=true.' }],
  }),
  offer({
    id: 'openrouter.free', provider: 'openrouter', name: 'OpenRouter (free models)', homepage: 'https://openrouter.ai',
    logo_url: logo('openrouter'), base_url: 'https://openrouter.ai/api/v1', trust_tier: 'T1', redistribution: 'permitted',
    trains_on_inputs: 'no', commercial_use: 'allowed', terms_url: OPENROUTER_TERMS,
    prerequisites: [
      { type: 'account', detail: 'OpenRouter account and API key' },
      { type: 'wallet_balance', amount: 10, currency: 'USD', unlocks: '1,000 free-model requests per day instead of 50',
        source: { url: 'https://openrouter.ai/docs/api-reference/limits' } },
    ],
    limits: [{ scope: 'account', rpm: 20, rpd: 50 }],
    evidence: [
      { field: 'redistribution', source: 'operator', url: OPENROUTER_TERMS,
        note: 'Operator override (2026-10-24) to keep the alpha catalog serving. docs/PROVIDER_TERMS.md records Terms §7.4 (no reselling API access to Models). Served only with OPENROUTER_HOSTED=true.' },
      OPENROUTER_DATA,
    ],
  }),
  offer({
    id: 'openrouter.byok', provider: 'openrouter', name: 'OpenRouter (your own key)', homepage: 'https://openrouter.ai',
    logo_url: logo('openrouter'), base_url: 'https://openrouter.ai/api/v1', owner: 'user', trust_tier: 'T1',
    redistribution: 'byok_only', trains_on_inputs: 'no', commercial_use: 'allowed', terms_url: OPENROUTER_TERMS,
    prerequisites: [{ type: 'account', detail: "The caller's own OpenRouter account, connected with OAuth" }],
    evidence: [OPENROUTER_DATA],
  }),
  // Claude Sonnet 5.5 and Opus 5.5 on Pro and Max, billed from credits (ANTHROPIC_API_KEY).
  offer(ANTHROPIC_PAID_OFFER),
].map(entry => Object.freeze({ ...entry, prerequisites: Object.freeze(entry.prerequisites),
  limits: Object.freeze(entry.limits), evidence: Object.freeze(entry.evidence) })));

const BUILTIN_BY_ID = new Map(BUILTIN_OFFERS.map(entry => [entry.id, entry]));

// The offer of the caller's own key per provider (BYOK sessions, router.routeOwned).
export const BYOK_OFFERS = Object.freeze({ openrouter: 'openrouter.byok' });

// The offer a catalog pool belongs to: the pool's own `offer` when the catalog names one,
// otherwise `<provider>.<tier>`.
export function offerIdFor(entry, pool) {
  return pool?.offer || `${entry?.provider}.${pool?.tier}`;
}

// ── Database rows (60 s cache per env, like loadCatalogDbModels) ──

const OFFERS_TTL_MS = 60000;
const OFFERS_RETRY_MS = 10000;
const NO_ROWS = Object.freeze({ list: Object.freeze([]), byId: new Map() });
const offerCache = new WeakMap(); // env -> { rows, expires, pending }

const freezeRow = row => Object.freeze({ ...row, prerequisites: Object.freeze([...(row.prerequisites || [])]),
  limits: Object.freeze([...(row.limits || [])]), evidence: Object.freeze([...(row.evidence || [])]) });

function dbRows(env) {
  if (!env || typeof env !== 'object' || !databaseConfigured(env)) return NO_ROWS;
  return offerCache.get(env)?.rows || NO_ROWS;
}

/**
 * Loads zerox_offers for `env` (60 s cache). Callers that route or list models await this
 * first; synchronous lookups then see the cached rows. While the database does not answer (or
 * the migration is not applied yet) the last rows that loaded stay in use, else the built-ins
 * (retried every 10 s).
 */
export async function loadOffers(env) {
  if (!env || typeof env !== 'object' || !databaseConfigured(env)) return offersList(env);
  const cached = offerCache.get(env);
  if (cached?.expires > Date.now()) return offersList(env);
  if (cached?.pending) return cached.pending;
  const pending = (async () => {
    let rows = cached?.rows || NO_ROWS;
    let ttl = OFFERS_TTL_MS;
    let failing = false;
    try {
      const list = (await rpcRows(env, 'zerox_offers_list', {})).filter(row => typeof row?.id === 'string').map(freezeRow);
      rows = { list: Object.freeze(list), byId: new Map(list.map(row => [row.id, row])) };
    } catch (error) {
      // Logged once per failure streak (e.g. before the migration is applied), not every retry.
      if (!cached?.failing) console.error('OIOP offers unavailable; keeping the last list', { name: error?.name });
      ttl = OFFERS_RETRY_MS;
      failing = true;
    }
    offerCache.set(env, { rows, failing, expires: Date.now() + ttl });
    return offersList(env);
  })();
  offerCache.set(env, { ...cached, rows: cached?.rows || NO_ROWS, expires: 0, pending });
  return pending;
}

// Drops the cached rows (after an admin change, and in tests).
export function resetOfferCache(env) {
  if (env && typeof env === 'object') offerCache.delete(env);
}

// One offer: the database row when loaded, otherwise the built-in one (null when neither).
export function offerById(env, id) {
  return dbRows(env).byId.get(id) || BUILTIN_BY_ID.get(id) || null;
}

// Every known offer: the database rows plus built-ins the database does not have.
export function offersList(env) {
  const rows = dbRows(env);
  return [...rows.list, ...BUILTIN_OFFERS.filter(entry => !rows.byId.has(entry.id))];
}

export function offerForPool(env, entry, pool) {
  return offerById(env, offerIdFor(entry, pool));
}

// Whether the operator's own keys or deployment may serve other people through this offer.
export function servesOperatorPools(offer) {
  return Boolean(offer) && SERVED_LIFECYCLES.includes(offer.lifecycle) && offer.redistribution === 'permitted';
}

// Whether callers' own keys (BYOK) may be used through this offer. Redistribution does not
// apply: the caller is the account holder.
export function servesOwnKeys(offer) {
  return Boolean(offer) && SERVED_LIFECYCLES.includes(offer.lifecycle);
}
