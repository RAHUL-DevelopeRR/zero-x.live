// Provider-type registry for the data-driven catalog (docs/PLATFORM_CONTRACT.md §2). Model rows
// live in Postgres (migration 20261025000000_catalog_models.sql); everything that decides where a
// request goes or which secret it carries stays here, in reviewed code: adapters, base URLs, id
// prefixes, the upstream id grammar, key slots, hosting flags and the spend ceilings. A row only
// names a provider type and a key slot id; it can never name a URL or an environment variable.
//
// The SQL functions zerox_catalog_public_id, zerox_catalog_upstream_ok, zerox_catalog_slot_ok and
// zerox_catalog_type_max_cap_microusd mirror this file; check-catalog-db.mjs keeps them equal.
import { MAX_DAILY_SPEND_CAP_USD } from './list-prices.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !(value instanceof RegExp) && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

// Slot id -> where the pool's secret comes from. `vault`: the provider key vault
// (src/provider-keys.js) can add more keys for this slot's free pools.
export const KEY_SLOTS = deepFreeze({
  'gemini.free': { env: 'GEMINI_API_KEY', vault: 'gemini' },
  'gemini.paid': { env: 'GEMINI_PAID_API_KEY' },
  'groq.free': { env: 'GROQ_API_KEY', vault: 'groq' },
  'groq.paid': { env: 'GROQ_PAID_API_KEY' },
  'nvidia.free': { env: 'NVIDIA_API_KEY', vault: 'nvidia' },
  'openrouter.free': { env: 'OPENROUTER_API_KEY', vault: 'openrouter' },
  'omniroute.free': { env: 'OMNIROUTE_API_KEY' },
  'cloudflare.binding': { binding: 'cloudflare' },
  'anthropic.paid': { env: 'ANTHROPIC_API_KEY' },
});

// Shared upstream budgets that new free rows of a provider start from (src/catalog.js
// POOL_LIMITS holds the same numbers for the code catalog).
const FREE_LIMITS = deepFreeze({
  gemini: { rpm: 5, rpd: 250, tpm: 120000, tpd: 5000000 },
  groq: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
  nvidia: { rpm: 40, rpd: 10000, tpm: null, tpd: null },
  openrouter: { rpm: 20, rpd: 50, tpm: null, tpd: null },
});

const ORG_MODEL = /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._-]{0,80}$/;

const type = fields => ({
  hosted_flag: null, requires_flag: {}, free_geo_block: [], paid_pricing: 'listed_or_band', requires_cache_prices: false,
  max_daily_spend_usd: 0, paid_daily_cap_usd: null, base_url_env: null, discovery_defaults: null, ...fields,
});

/**
 * adapter: src/providers.js ADAPTERS key family. base_url: the only upstream the type's adapter
 * may call (null: a binding, or base_url_env names a validated secret). id_prefix + upstream id =
 * the public model id. upstream: the upstream id grammar (model ids travel in JSON bodies, except
 * Workers AI's REST fallback, which puts them in the URL path, hence its strict pattern).
 * slots: key slots allowed per tier (no slots = the tier is not offered). max_daily_spend_usd:
 * the highest daily spend cap a paid pool of this type may have (0 = no paid pools).
 * paid_daily_cap_usd: the cap code-catalog paid pools get when their entry names none.
 */
export const PROVIDER_TYPES = deepFreeze({
  gemini: type({
    adapter: 'openai-compatible', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', id_prefix: 'gemini/',
    upstream: /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/, slots: { free: ['gemini.free'], paid: ['gemini.paid'] },
    free_geo_block: ['EEA', 'GB', 'CH'], models_var: 'GEMINI_MODELS', max_daily_spend_usd: MAX_DAILY_SPEND_CAP_USD,
    paid_daily_cap_usd: 10, discovery_defaults: { limits: FREE_LIMITS.gemini },
  }),
  groq: type({
    adapter: 'openai-compatible', base_url: 'https://api.groq.com/openai/v1', id_prefix: 'groq/',
    upstream: /^([a-z0-9][a-z0-9._-]{0,40}\/)?[a-z0-9][a-z0-9._-]{0,80}$/, slots: { free: ['groq.free'], paid: ['groq.paid'] },
    models_var: 'GROQ_MODELS', max_daily_spend_usd: MAX_DAILY_SPEND_CAP_USD, paid_daily_cap_usd: 5,
    discovery_defaults: { limits: FREE_LIMITS.groq },
  }),
  nvidia: type({
    adapter: 'openai-compatible', base_url: 'https://integrate.api.nvidia.com/v1', id_prefix: 'nvidia/', upstream: ORG_MODEL,
    slots: { free: ['nvidia.free'], paid: [] }, hosted_flag: 'NVIDIA_HOSTED', models_var: 'NVIDIA_MODELS',
    discovery_defaults: { limits: FREE_LIMITS.nvidia },
  }),
  openrouter: type({
    adapter: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1', id_prefix: '',
    // The operator key serves OpenRouter's free models only.
    upstream: /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._-]{0,80}:free$/, slots: { free: ['openrouter.free'], paid: [] },
    hosted_flag: 'OPENROUTER_HOSTED', models_var: 'OPENROUTER_MODELS', discovery_defaults: { limits: FREE_LIMITS.openrouter },
  }),
  omniroute: type({
    adapter: 'openai-compatible', base_url: null, base_url_env: 'OMNIROUTE_BASE_URL', id_prefix: 'omniroute/',
    upstream: /^[a-z0-9][a-z0-9._:/-]{0,120}$/, slots: { free: ['omniroute.free'], paid: [] }, models_var: 'OMNIROUTE_MODELS',
  }),
  cloudflare: type({
    // Binding first; the REST fallback URL is fixed in src/cloudflare-adapter.js.
    adapter: 'workers-ai', base_url: null, id_prefix: '',
    upstream: /^@cf\/[a-z0-9][a-z0-9_-]{0,40}\/[a-z0-9][a-z0-9._-]{0,80}$/,
    slots: { free: ['cloudflare.binding'], paid: ['cloudflare.binding'] }, requires_flag: { paid: 'CLOUDFLARE_PAID' },
    models_var: 'CLOUDFLARE_MODELS', max_daily_spend_usd: MAX_DAILY_SPEND_CAP_USD, paid_daily_cap_usd: 5,
  }),
  anthropic: type({
    adapter: 'anthropic', base_url: 'https://api.anthropic.com', id_prefix: 'anthropic/',
    upstream: /^claude-[a-z0-9][a-z0-9-]{0,60}$/, slots: { free: [], paid: ['anthropic.paid'] },
    models_var: 'ANTHROPIC_MODELS', paid_pricing: 'listed_only', requires_cache_prices: true, max_daily_spend_usd: 50,
  }),
});

export const PROVIDER_TYPE_IDS = Object.freeze(Object.keys(PROVIDER_TYPES));
export const TIERS = Object.freeze(['free', 'paid']);
export const MAX_UPSTREAM_LENGTH = 200;

export function providerType(id) {
  return typeof id === 'string' && Object.hasOwn(PROVIDER_TYPES, id) ? PROVIDER_TYPES[id] : null;
}

export function upstreamAllowed(typeId, upstream) {
  const registry = providerType(typeId);
  return Boolean(registry) && typeof upstream === 'string' && upstream.length <= MAX_UPSTREAM_LENGTH &&
    !upstream.includes('..') && registry.upstream.test(upstream);
}

// The public model id of an upstream model, or null when the type or the id is not allowed.
export function publicIdFor(typeId, upstream) {
  return upstreamAllowed(typeId, upstream) ? `${PROVIDER_TYPES[typeId].id_prefix}${upstream}` : null;
}

export function slotAllowed(typeId, tier, slotId) {
  const registry = providerType(typeId);
  return Boolean(registry) && TIERS.includes(tier) && registry.slots[tier].includes(slotId);
}

// The pool fields a slot resolves to: { key_var } or { binding }. Only KEY_SLOTS can produce a
// key_var, so a row can never point a pool at another Worker secret.
export function poolSource(slotId) {
  const slot = typeof slotId === 'string' && Object.hasOwn(KEY_SLOTS, slotId) ? KEY_SLOTS[slotId] : null;
  if (!slot) return null;
  return slot.binding ? { binding: slot.binding } : { key_var: slot.env };
}

// The slot id behind a code-catalog pool (its key_var or binding) for a type and tier.
export function slotForPool(typeId, tier, pool) {
  const registry = providerType(typeId);
  if (!registry || !TIERS.includes(tier)) return null;
  return registry.slots[tier].find(id => {
    const slot = KEY_SLOTS[id];
    return slot.binding ? pool?.binding === slot.binding : pool?.key_var === slot.env;
  }) ?? null;
}

// Whether a slot's secret (or binding) is present, without revealing it.
export function slotConfigured(env, slotId) {
  const slot = Object.hasOwn(KEY_SLOTS, slotId) ? KEY_SLOTS[slotId] : null;
  if (!slot) return false;
  if (slot.binding === 'cloudflare') return Boolean(env?.AI || (env?.CLOUDFLARE_ACCOUNT_ID && env?.CLOUDFLARE_API_TOKEN));
  const value = env?.[slot.env];
  return typeof value === 'string' && value.trim().length > 0;
}

// The upstream base URL of a type: a code constant, or for omniroute the OMNIROUTE_BASE_URL
// secret validated like src/providers.js omnirouteBaseResolver. Never taken from a row.
export function baseUrlFor(typeId, env = {}) {
  const registry = providerType(typeId);
  if (!registry) return null;
  if (!registry.base_url_env) return registry.base_url;
  const raw = env?.[registry.base_url_env];
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

// Provider -> the env var whose free key the vault can extend (replaces catalog.js VAULT_KEY_VARS).
export const VAULT_KEY_VARS = Object.freeze(Object.fromEntries(Object.values(KEY_SLOTS)
  .filter(slot => slot.vault).map(slot => [slot.vault, slot.env])));

// Provider -> the *_MODELS variable that narrows it (replaces catalog.js MODELS_VARS).
export const MODELS_VARS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_TYPES)
  .map(([id, registry]) => [id, registry.models_var])));

// Highest daily spend cap (upstream micro-USD) a paid pool of the type may carry.
export function typeMaxCapMicrousd(typeId) {
  const registry = providerType(typeId);
  if (!registry || !registry.slots.paid.length) return 0;
  return Math.min(registry.max_daily_spend_usd, MAX_DAILY_SPEND_CAP_USD) * 1_000_000;
}

// Allowed catalog lifecycle actions per model status (mirrors SQL zerox_catalog_can).
export const CATALOG_STATUSES = Object.freeze(['draft', 'active', 'disabled']);
export const CATALOG_ACTIONS = deepFreeze({
  draft: ['propose', 'approve', 'reject', 'disable'],
  active: ['propose', 'approve', 'reject', 'disable'],
  disabled: ['propose', 'approve', 'reject', 'enable'],
});

export function catalogCan(status, action) {
  return Boolean(CATALOG_ACTIONS[status]?.includes(action));
}
