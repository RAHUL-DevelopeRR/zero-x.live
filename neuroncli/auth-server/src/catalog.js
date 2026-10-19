// Compliance-aware public model catalog (docs/PLATFORM_CONTRACT.md §2,
// docs/PROVIDER_TERMS.md). Only models verified against the live upstreams are listed;
// *_MODELS environment lists can disable entries but never add unknown ones.
import { databaseConfigured, rpcRows } from './account-store.js';
import { priceFromCost, publicPricing } from './pricing.js';
import { vaultKeys, vaultKeySecret } from './provider-keys.js';

// EU-27 plus Iceland, Liechtenstein and Norway.
export const EEA_COUNTRIES = Object.freeze(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO']);
// EU territories that Cloudflare geolocates under their own ISO codes (Åland and the
// outermost regions). They are EU territory, so they follow the EEA rule.
const EU_TERRITORIES = Object.freeze(['AX', 'GF', 'GP', 'MQ', 'RE', 'YT', 'MF']);
// Cloudflare reports Tor exit traffic as T1 and unlocatable addresses as XX: the caller's
// jurisdiction is unknown, so geo-restricted free pools treat them as blocked.
const UNKNOWN_JURISDICTIONS = Object.freeze(['T1', 'XX']);

export function expandCountries(list = []) {
  const countries = new Set();
  for (const code of list) {
    if (code === 'EEA') [...EEA_COUNTRIES, ...EU_TERRITORIES].forEach(value => countries.add(value));
    else countries.add(String(code).toUpperCase());
  }
  return countries;
}

const GEMINI_FREE_GEO_BLOCK = Object.freeze(['EEA', 'GB', 'CH']);

// Shared upstream budgets (per model, all users). Groq free org limits are confirmed by
// x-ratelimit headers. Gemini free limits are shown only per project in AI Studio and are
// tighter than the published 10 RPM / 250K TPM: on 2026-10-16 gemini-2.5-flash answered 429
// after 6 requests (~125K input tokens) within 16 s, so the per-minute budget stays below that
// (rpm 5, tpm 120K; rpd/tpd unverified). Google counts input tokens only, while a reservation
// counts the prompt plus at most 1,024 output tokens (capacity.js RESERVED_OUTPUT_TOKENS, settled
// to the real usage afterwards), so 120K never lets more than ~120K input tokens per minute
// through and still fits four sequential Neuron-sized requests (~23.5K prompt). The upstream
// max_tokens stays fitted to the per-minute budget (router.js fitMaxTokens), which Groq checks
// per request. Upstream 429s still park a pool for the provider's delay (provider-health.js).
// Workers AI pools are sized so both models together stay under the 10,000 neurons/day free
// allocation, assuming at most ~15% of tokens are output tokens.
export const POOL_LIMITS = Object.freeze({
  groq_free: Object.freeze({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }),
  gemini_free: Object.freeze({ rpm: 5, rpd: 250, tpm: 120000, tpd: 5000000 }),
  workers_llama_free: Object.freeze({ rpm: 20, rpd: 300, tpm: 60000, tpd: 120000 }),
  workers_gpt_oss_free: Object.freeze({ rpm: 20, rpd: 200, tpm: 60000, tpd: 90000 }),
  // build.nvidia.com/faq (2026-10-19): up to 40 RPM and 10,000 requests per day; no token caps
  // are published, and other users' traffic can throttle the shared endpoints.
  nvidia_trial: Object.freeze({ rpm: 40, rpd: 10000, tpm: null, tpd: null }),
  openrouter_free: Object.freeze({ rpm: 20, rpd: 50, tpm: null, tpd: null }),
});

const pool = (tier, source, extra = {}) => Object.freeze({ tier, ...source, ...extra });
const key = name => ({ key_var: name });
const WORKERS_AI = { binding: 'cloudflare' };

export const MODELS_VARS = Object.freeze({
  groq: 'GROQ_MODELS', gemini: 'GEMINI_MODELS', cloudflare: 'CLOUDFLARE_MODELS',
  nvidia: 'NVIDIA_MODELS', openrouter: 'OPENROUTER_MODELS',
});

const STANDARD_EFFORTS = Object.freeze(['low', 'medium', 'high']);

// auto_rank orders `model: "auto"` candidates (lower is better); null = never chosen by auto.
const MODELS = [
  {
    id: 'gemini/gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', provider: 'gemini',
    upstream_model: 'gemini-2.5-flash', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: 1,
    geo_block_free: GEMINI_FREE_GEO_BLOCK, aliases: ['gemini-2.5-flash', 'google/gemini-2.5-flash'],
    reasoning_efforts: ['none', 'low', 'medium', 'high'], reasoning_effort_map: { minimal: 'low' },
    pools: [
      pool('free', key('GEMINI_API_KEY'), { limits: POOL_LIMITS.gemini_free }),
      pool('paid', key('GEMINI_PAID_API_KEY'), { price: priceFromCost(0.30, 2.50) }),
    ],
  },
  {
    id: 'gemini/gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', provider: 'gemini',
    upstream_model: 'gemini-3.5-flash', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: 2,
    geo_block_free: GEMINI_FREE_GEO_BLOCK, aliases: ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    // No paid pool until a verified upstream price is recorded here.
    pools: [pool('free', key('GEMINI_API_KEY'), { limits: POOL_LIMITS.gemini_free })],
  },
  // Listed by the free-tier key's /v1beta/models on 2026-10-19 and priced "Free of charge" on the
  // pricing page. Free limits are per model, so each entry adds its own daily budget. Live probe
  // 2026-10-19: 3.6 Flash answered streamed tool calls in 2-4 s. Not listed: 3.8 and 3.7 Flash,
  // which took 44-60 s to the first byte or answered "temporarily unavailable" on the free tier.
  ...[
    ['gemini-3.6-flash', 'Gemini 3.6 Flash', 3, 0.75, 3.75],
  ].map(([upstream, name, rank, input, output]) => ({
    id: `gemini/${upstream}`, display_name: name, provider: 'gemini',
    upstream_model: upstream, context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: rank,
    geo_block_free: GEMINI_FREE_GEO_BLOCK, aliases: [upstream, `google/${upstream}`],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [
      pool('free', key('GEMINI_API_KEY'), { limits: POOL_LIMITS.gemini_free }),
      // Paid list price through 2026-12-31 (doubles from 2027-01-01).
      pool('paid', key('GEMINI_PAID_API_KEY'), { price: priceFromCost(input, output) }),
    ],
  })),
  {
    id: 'gemini/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', provider: 'gemini',
    upstream_model: 'gemini-2.5-pro', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: null,
    aliases: ['gemini-2.5-pro', 'google/gemini-2.5-pro'],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    // The free tier has no 2.5 Pro quota (404 for new projects): paid only.
    pools: [pool('paid', key('GEMINI_PAID_API_KEY'), {
      price: priceFromCost(1.25, 10, { threshold: 200000, input: 2.50, output: 15 }),
    })],
  },
  {
    id: 'groq/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Groq)', provider: 'groq',
    upstream_model: 'openai/gpt-oss-120b', context_window: 131072, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: 5,
    aliases: ['gpt-oss-120b', 'openai/gpt-oss-120b'], reasoning_efforts: STANDARD_EFFORTS,
    reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [
      pool('free', key('GROQ_API_KEY'), { limits: POOL_LIMITS.groq_free }),
      pool('paid', key('GROQ_PAID_API_KEY'), { price: priceFromCost(0.15, 0.60) }),
    ],
  },
  {
    id: 'groq/qwen/qwen3.8-27b', display_name: 'Qwen 3.8 27B (Groq)', provider: 'groq',
    upstream_model: 'qwen/qwen3.8-27b', context_window: 131072, max_output_tokens: 40960,
    supports_tools: true, supports_streaming: true, auto_rank: 6,
    aliases: ['qwen3.8-27b', 'qwen/qwen3.8-27b'], reasoning_efforts: ['none', 'default'],
    reasoning_effort_map: { minimal: 'default', low: 'default', medium: 'default', high: 'default' },
    pools: [pool('free', key('GROQ_API_KEY'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    id: 'groq/openai/gpt-oss-20b', display_name: 'GPT-OSS 20B (Groq)', provider: 'groq',
    upstream_model: 'openai/gpt-oss-20b', context_window: 131072, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: 7,
    aliases: ['gpt-oss-20b', 'openai/gpt-oss-20b'], reasoning_efforts: STANDARD_EFFORTS,
    reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [pool('free', key('GROQ_API_KEY'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    // Not part of the 2026-10-16 live probe: enable explicitly with CLOUDFLARE_MODELS.
    id: '@cf/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Workers AI)', provider: 'cloudflare',
    upstream_model: '@cf/openai/gpt-oss-120b', context_window: 131072, max_output_tokens: 32768,
    supports_tools: true, supports_streaming: true, auto_rank: 8, default_enabled: false,
    aliases: ['workers-ai/gpt-oss-120b', 'cloudflare/gpt-oss-120b'],
    pools: [
      pool('free', WORKERS_AI, { limits: POOL_LIMITS.workers_gpt_oss_free }),
      pool('paid', WORKERS_AI, { requires_flag: 'CLOUDFLARE_PAID', price: priceFromCost(0.35, 0.75) }),
    ],
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', display_name: 'Llama 3.3 70B (Workers AI)',
    provider: 'cloudflare', upstream_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    context_window: 24000, max_output_tokens: 8192, supports_tools: true, supports_streaming: true,
    auto_rank: 9, aliases: ['llama-3.3-70b', 'workers-ai/llama-3.3-70b', 'cloudflare/llama-3.3-70b'],
    pools: [
      pool('free', WORKERS_AI, { limits: POOL_LIMITS.workers_llama_free }),
      // Workers AI list price: 26,668 / 204,805 neurons per million tokens at $0.011 / 1K neurons.
      pool('paid', WORKERS_AI, { requires_flag: 'CLOUDFLARE_PAID', price: priceFromCost(0.293, 2.253) }),
    ],
  },
  // NVIDIA API Catalog trial keys (terms: evaluation use). Offered to users only when
  // NVIDIA_HOSTED=true. The shared free endpoints are erratic (two live probes, 2026-10-19):
  // gpt-oss-20b passed both (5-11 s), nemotron-3-ultra both (0.7-40 s), step-5-preview once
  // (the other run returned no tool call after 59 s), so auto never picks step-5-preview.
  // Dropped: nemotron-3-super-120b-a12b (deprecated 2026-10-19) and deepseek-v4.1-flash (no
  // response within 90 s).
  ...[
    ['openai/gpt-oss-20b', 'GPT-OSS 20B (NVIDIA)', 10, 131072, 32768],
    ['nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra 550B (NVIDIA)', 11, 1048576, 32768],
    ['stepfun-ai/step-5-preview', 'Step 5 Preview (NVIDIA)', null, 131072, 16384],
  ].map(([upstream, name, rank, context, maxOutput]) => ({
    id: `nvidia/${upstream}`, display_name: name, provider: 'nvidia', upstream_model: upstream,
    context_window: context, max_output_tokens: maxOutput, supports_tools: true, supports_streaming: true,
    auto_rank: rank, hosted_flag: 'NVIDIA_HOSTED', aliases: [],
    pools: [pool('free', key('NVIDIA_API_KEY'), { limits: POOL_LIMITS.nvidia_trial })],
  })),
  // OpenRouter terms restrict reselling: the operator key is used only with OPENROUTER_HOSTED=true.
  // The 50 requests/day free cap is per account across every ':free' model, so two entries.
  // thinkingmachines/inkling:free was not added: OpenRouter serves it only to registered apps (403).
  ...[
    ['cohere/north-mini-code:free', 'North Mini Code (OpenRouter, free)', 12, 256000, 64000, false],
    ['minimax/minimax-m3.1-flash:free', 'MiniMax M3.1 Flash (OpenRouter, free)', 13, 1000000, 65536, true],
  ].map(([upstream, name, rank, context, maxOutput, vision]) => ({
    id: upstream, display_name: name, provider: 'openrouter', upstream_model: upstream,
    context_window: context, max_output_tokens: maxOutput, supports_tools: true, supports_streaming: true,
    supports_vision: vision, auto_rank: rank, hosted_flag: 'OPENROUTER_HOSTED',
    aliases: [`openrouter/${upstream}`],
    pools: [pool('free', key('OPENROUTER_API_KEY'), { limits: POOL_LIMITS.openrouter_free })],
  })),
];

function freezeEntry(entry) {
  return Object.freeze({
    default_enabled: true, hosted_flag: null, geo_block_free: [], reasoning_efforts: [], supports_vision: false,
    reasoning_effort_map: {}, ...entry, pools: Object.freeze(entry.pools),
    aliases: Object.freeze(entry.aliases || []),
  });
}

export const CATALOG = Object.freeze(MODELS.map(freezeEntry));
const BY_ID = new Map(CATALOG.map(entry => [entry.id, entry]));
export const AUTO_MODEL_ID = 'auto';

// Explicit aliases only: no substring or segment matching.
export const MODEL_ALIASES = Object.freeze(Object.fromEntries([
  ['default', AUTO_MODEL_ID],
  ...CATALOG.flatMap(entry => entry.aliases.map(alias => [alias, entry.id])),
]));

// ── Verified discovery models (contract §8.4) ──
// Rows the operator promoted from a verified discovery candidate (zerox_catalog_db_models,
// src/routes/discovery.js). They join this catalog only with CATALOG_DB_MODELS=true and only
// through the templates below, which fix everything that decides where a request goes and what
// it may cost (adapter, key, hosting flag, shared budget). The database supplies the upstream
// id, display name, context window, output limit and vision. They are free pools only, never
// chosen by `auto`, never replace a code-defined id, and *_MODELS still narrows them.
export const DB_MODEL_TEMPLATES = Object.freeze({
  openrouter: Object.freeze({
    publicId: upstream => upstream, hosted_flag: 'OPENROUTER_HOSTED',
    pools: Object.freeze([pool('free', key('OPENROUTER_API_KEY'), { limits: POOL_LIMITS.openrouter_free })]),
  }),
  nvidia: Object.freeze({
    publicId: upstream => `nvidia/${upstream}`, hosted_flag: 'NVIDIA_HOSTED',
    pools: Object.freeze([pool('free', key('NVIDIA_API_KEY'), { limits: POOL_LIMITS.nvidia_trial })]),
  }),
});
const DB_MODELS_TTL_MS = 60000;
const DB_MODELS_RETRY_MS = 10000;
const NO_DB_MODELS = Object.freeze({ entries: Object.freeze([]), byId: new Map() });
const dbModelCache = new WeakMap();

export function dbModelsEnabled(env) {
  return env?.CATALOG_DB_MODELS === 'true' && databaseConfigured(env);
}

const positive = value => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

// Catalog entry for one zerox_catalog_db_models row, or null when no template fits.
export function dbCatalogEntry(row) {
  const template = DB_MODEL_TEMPLATES[row?.provider_id];
  const upstream = typeof row?.provider_model_id === 'string' ? row.provider_model_id.trim() : '';
  if (!template || !/^[\x21-\x7e]{1,200}$/.test(upstream)) return null;
  const id = template.publicId(upstream);
  const lower = id.toLowerCase();
  // The row must name what the template builds, and code-defined ids and aliases always win.
  if (row.public_model_id !== id || BY_ID.has(lower) || Object.hasOwn(MODEL_ALIASES, lower) || lower === AUTO_MODEL_ID) return null;
  const context = positive(row.context_window);
  const maxOutput = positive(row.max_output_tokens);
  if (!context || !maxOutput || maxOutput > context) return null;
  return freezeEntry({
    id, display_name: typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim().slice(0, 120) : id,
    provider: row.provider_id, upstream_model: upstream, context_window: context, max_output_tokens: maxOutput,
    supports_tools: true, supports_streaming: true, supports_vision: row.supports_vision === true, auto_rank: null,
    hosted_flag: template.hosted_flag, aliases: [], pools: template.pools, source: 'database',
    candidate_id: positive(row.candidate_id),
  });
}

function dbModels(env) {
  if (!env || typeof env !== 'object' || !dbModelsEnabled(env)) return NO_DB_MODELS;
  return dbModelCache.get(env)?.models || NO_DB_MODELS;
}

/**
 * Loads the promoted discovery models for `env` (60 s cache). Callers that route or list
 * models await this first; synchronous lookups then see the cached rows. While the database
 * does not answer, the last list that loaded stays in use (retried every 10 s).
 */
export async function loadCatalogDbModels(env) {
  if (!env || typeof env !== 'object' || !dbModelsEnabled(env)) return NO_DB_MODELS.entries;
  const cached = dbModelCache.get(env);
  if (cached?.expires > Date.now()) return cached.models.entries;
  if (cached?.pending) return cached.pending;
  const pending = (async () => {
    let models = cached?.models || NO_DB_MODELS;
    let ttl = DB_MODELS_TTL_MS;
    try {
      const entries = [];
      const seen = new Set();
      for (const row of await rpcRows(env, 'zerox_catalog_db_models', {})) {
        const entry = dbCatalogEntry(row);
        if (!entry || seen.has(entry.id.toLowerCase())) continue;
        seen.add(entry.id.toLowerCase());
        entries.push(entry);
      }
      models = { entries: Object.freeze(entries), byId: new Map(entries.map(entry => [entry.id.toLowerCase(), entry])) };
    } catch (error) {
      console.error('Neuron catalog database models unavailable; keeping the last list', { name: error.name });
      ttl = DB_MODELS_RETRY_MS;
    }
    dbModelCache.set(env, { models, expires: Date.now() + ttl });
    return models.entries;
  })();
  dbModelCache.set(env, { ...cached, models: cached?.models || NO_DB_MODELS, expires: 0, pending });
  return pending;
}

// Code-defined entries plus the loaded discovery models of this deployment.
export function catalogEntries(env) {
  const extra = dbModels(env).entries;
  return extra.length ? [...CATALOG, ...extra] : CATALOG;
}

export function catalogEntry(id, env) {
  return BY_ID.get(id) || (typeof id === 'string' ? dbModels(env).byId.get(id.toLowerCase()) : null) || null;
}

function lookup(value, env) {
  if (value === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  if (BY_ID.has(value)) return value;
  if (Object.hasOwn(MODEL_ALIASES, value)) return MODEL_ALIASES[value];
  return dbModels(env).byId.get(value)?.id ?? null;
}

// Resolves a requested model to a public id ('auto' included). An `openai/` transport
// prefix (added by OpenAI-compatible clients) is accepted when the remainder resolves.
// Discovery models resolve only for an `env` whose models were loaded (loadCatalogDbModels).
export function resolveModelId(requested, env) {
  if (typeof requested !== 'string') return null;
  const value = requested.trim().toLowerCase();
  if (!value || value.length > 200) return null;
  const direct = lookup(value, env);
  if (direct) return direct;
  return value.startsWith('openai/') ? lookup(value.slice('openai/'.length), env) : null;
}

function listedModels(env, provider) {
  const raw = env?.[MODELS_VARS[provider]];
  if (raw === undefined || raw === null) return null;
  return new Set(String(raw).split(',').map(id => id.trim().toLowerCase()).filter(Boolean));
}

export function isHosted(env, entry) {
  return !entry.hosted_flag || env?.[entry.hosted_flag] === 'true';
}

export function isEnabled(env, entry) {
  const listed = listedModels(env, entry.provider);
  if (!listed) return entry.default_enabled;
  return listed.has(entry.upstream_model.toLowerCase()) || listed.has(entry.id.toLowerCase());
}

// Entries this deployment offers (enabled and hosted), whether or not keys are present.
export function offeredEntries(env) {
  return catalogEntries(env).filter(entry => isHosted(env, entry) && isEnabled(env, entry));
}

// Unknown ids in *_MODELS are ignored, never silently added; operators see them here.
export function catalogWarnings(env) {
  const warnings = [];
  for (const [provider, name] of Object.entries(MODELS_VARS)) {
    const listed = listedModels(env, provider);
    if (!listed) continue;
    const known = new Set(catalogEntries(env).filter(entry => entry.provider === provider)
      .flatMap(entry => [entry.upstream_model.toLowerCase(), entry.id.toLowerCase()]));
    const ignored = [...listed].filter(id => !known.has(id));
    if (ignored.length) warnings.push({ variable: name, ignored_models: ignored });
  }
  return warnings;
}

const warned = new WeakSet();
export function warnIgnoredModels(env) {
  if (!env || typeof env !== 'object' || warned.has(env)) return;
  warned.add(env);
  for (const warning of catalogWarnings(env)) {
    console.warn('Neuron catalog ignores unverified models', warning);
  }
}

export function cloudflareBound(env) {
  return Boolean(env?.AI || (env?.CLOUDFLARE_ACCOUNT_ID && env?.CLOUDFLARE_API_TOKEN));
}

// ── Provider key vault pools (src/provider-keys.js) ──
// Free pools whose key the operator can also add on the admin page. Every active vault key of
// the provider becomes its own pool (`<pool key>#<key id>`) with its own health, so several Groq
// orgs or Gemini projects rotate through the routing; the environment key stays as the last
// (fallback) pool unless the vault holds the same key.
export const VAULT_KEY_VARS = Object.freeze({
  groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', nvidia: 'NVIDIA_API_KEY', openrouter: 'OPENROUTER_API_KEY',
});

const POOL_SECRETS = new WeakMap(); // vault pool -> plaintext key (never a property)
const expandedPools = new WeakMap(); // env -> { keys, byEntry }

// The model's upstream budget across N keys is N times one key's (each org or project has its
// own). Reservations check each key's own budget (src/capacity.js reservationArgs); the sum is
// what the admin overview reports for the model.
function scaledLimits(limits, count) {
  const scale = value => value === null || value === undefined ? null : value * count;
  return Object.freeze({ rpm: scale(limits.rpm), rpd: scale(limits.rpd), tpm: scale(limits.tpm), tpd: scale(limits.tpd) });
}

function expandPools(env, entry, keys) {
  const vaultVar = VAULT_KEY_VARS[entry.provider];
  const pools = [];
  for (const pool of entry.pools) {
    if (pool.tier !== 'free' || !vaultVar || pool.key_var !== vaultVar) {
      pools.push(pool);
      continue;
    }
    const own = keys.filter(key => key.provider === entry.provider);
    const envKey = typeof env?.[pool.key_var] === 'string' ? env[pool.key_var].trim() : '';
    const envPool = Boolean(envKey) && !own.some(key => vaultKeySecret(key) === envKey);
    const count = own.length + (envPool ? 1 : 0);
    const shared = count > 1 && pool.limits ? { shared_limits: scaledLimits(pool.limits, count) } : {};
    for (const key of own) {
      const keyed = Object.freeze({ ...pool, ...shared, key_var: null, key_id: key.id });
      POOL_SECRETS.set(keyed, vaultKeySecret(key));
      pools.push(keyed);
    }
    if (envPool) pools.push(count > 1 ? Object.freeze({ ...pool, ...shared }) : pool);
    // No key at all: the pool stays listed so the model reports not_configured.
    if (!count) pools.push(pool);
  }
  return Object.freeze(pools);
}

// The pools of an entry in this isolate: the catalog's, with vault keys expanded once loaded.
export function entryPools(env, entry) {
  const keys = vaultKeys(env);
  if (!keys.length || !VAULT_KEY_VARS[entry.provider]) return entry.pools;
  let cache = expandedPools.get(env);
  if (!cache || cache.keys !== keys) expandedPools.set(env, cache = { keys, byEntry: new Map() });
  if (!cache.byEntry.has(entry.id)) cache.byEntry.set(entry.id, expandPools(env, entry, keys));
  return cache.byEntry.get(entry.id);
}

// The upstream API key of a pool (null for bindings and unconfigured pools).
export function poolSecret(env, pool) {
  if (pool?.key_id) return POOL_SECRETS.get(pool) ?? null;
  const value = pool?.key_var ? env?.[pool.key_var] : null;
  return typeof value === 'string' && value ? value : null;
}

export function poolConfigured(env, entry, pool) {
  if (pool.requires_flag && env?.[pool.requires_flag] !== 'true') return false;
  if (pool.binding === 'cloudflare') return cloudflareBound(env);
  if (pool.key_id) return POOL_SECRETS.has(pool);
  const value = env?.[pool.key_var];
  return typeof value === 'string' && value.trim().length > 0;
}

export function poolKey(entry, pool) {
  return `${entry.provider}:${entry.upstream_model}:${pool.tier}${pool.key_id ? `#${pool.key_id}` : ''}`;
}

// Two-character ISO 3166 code (or Cloudflare's T1/XX), otherwise null.
export function normalizeCountry(country) {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9]$/.test(code) ? code : null;
}

// Geo-restricted free pools fail closed: blocked for listed countries, for unknown
// jurisdictions (T1, XX) and, unless ALLOW_UNKNOWN_COUNTRY=true (local development only),
// for callers whose country is not known at all.
export function geoBlocked(entry, pool, country, env = {}) {
  if (pool.tier !== 'free' || !entry.geo_block_free?.length) return false;
  const code = normalizeCountry(country);
  if (!code) return env?.ALLOW_UNKNOWN_COUNTRY !== 'true';
  return UNKNOWN_JURISDICTIONS.includes(code) || expandCountries(entry.geo_block_free).has(code);
}

// Caller country from Cloudflare's request metadata. CF-IPCountry is trusted only when an
// operator states the Node origin is reachable exclusively through Cloudflare.
// Internal sub-requests (POST /v1/models/health) are built by the gateway and carry no
// request.cf, so they inherit the outer caller's country through this map. Keys are the
// gateway's own Request objects, which callers cannot reach or forge.
const INHERITED_COUNTRIES = new WeakMap();
export function inheritCallerCountry(request, country) {
  INHERITED_COUNTRIES.set(request, country ?? null);
  return request;
}

export function callerCountry(request, env = {}) {
  if (request && INHERITED_COUNTRIES.has(request)) return INHERITED_COUNTRIES.get(request);
  let country = request?.cf?.country;
  if (!country && env.TRUST_CF_IPCOUNTRY === 'true') country = request?.headers?.get?.('cf-ipcountry');
  return normalizeCountry(country);
}

// Classifies every pool of an entry for a caller: configured, in plan, region allowed.
export function poolVerdicts(env, entry, tiers, country) {
  return entryPools(env, entry).map(pool => ({
    pool,
    configured: poolConfigured(env, entry, pool),
    inPlan: tiers.includes(pool.tier),
    region: !geoBlocked(entry, pool, country, env),
  }));
}

export function unavailableReason(verdicts) {
  const configured = verdicts.filter(verdict => verdict.configured);
  if (!configured.length) return 'not_configured';
  if (configured.some(verdict => verdict.inPlan && verdict.region)) return null;
  // Prefer the actionable reason: an upgrade unlocks a configured pool outside the plan.
  if (configured.some(verdict => !verdict.inPlan && verdict.region)) return 'upgrade_required';
  return configured.some(verdict => verdict.inPlan) ? 'region_unavailable' : 'upgrade_required';
}

// ── Plans (contract §1) ──
export const BUILTIN_PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', name: 'Free', daily_requests: 100, daily_tokens: 500000, rpm: 10,
    concurrency: 2, tiers: Object.freeze(['free']), monthly_credit_microusd: 0 }),
  pro: Object.freeze({ id: 'pro', name: 'Pro', daily_requests: 2000, daily_tokens: 10000000, rpm: 30,
    concurrency: 4, tiers: Object.freeze(['free', 'paid']), monthly_credit_microusd: 8000000 }),
  max: Object.freeze({ id: 'max', name: 'Max', daily_requests: 10000, daily_tokens: 50000000, rpm: 60,
    concurrency: 8, tiers: Object.freeze(['free', 'paid']), monthly_credit_microusd: 35000000 }),
  ultrawork: Object.freeze({ id: 'ultrawork', name: 'Pro (legacy)', daily_requests: 2000,
    daily_tokens: 10000000, rpm: 30, concurrency: 4, tiers: Object.freeze(['free', 'paid']),
    monthly_credit_microusd: 8000000 }),
});

const VALID_TIERS = new Set(['free', 'paid']);
const POLICY_TTL_MS = 60000;
const POLICY_RETRY_MS = 10000;
const policyCache = new WeakMap();

function parseTiers(value) {
  let list = value;
  if (typeof value === 'string') list = value.replace(/^\{|\}$/g, '').split(',');
  if (!Array.isArray(list)) return null;
  const tiers = [...new Set(list.map(tier => String(tier).trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean))];
  return tiers.length && tiers.every(tier => VALID_TIERS.has(tier)) ? tiers : null;
}

const isSet = value => value !== undefined && value !== null && value !== '';

// One zerox_plan_policies_v2 row: plan, name, daily_requests, daily_tokens, rpm_limit,
// concurrency_limit, allowed_tiers, monthly_credit_microusd (plus pricing/display columns).
// Missing or invalid values fall back to the built-in plan of the same id (or the free plan)
// and are returned as problems so the loader can report them.
function policyFromRow(row) {
  const id = String(row?.plan ?? row?.id ?? row?.plan_id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) return null;
  const builtin = BUILTIN_PLANS[id] || BUILTIN_PLANS.free;
  const problems = [];
  const tierValue = row.allowed_tiers ?? row.tiers;
  let tiers = parseTiers(tierValue);
  if (!tiers) {
    problems.push(`${isSet(tierValue) ? 'invalid' : 'missing'} allowed_tiers`);
    tiers = builtin.tiers;
  }
  const number = (value, fallback, column) => {
    if (isSet(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0) return Number(value);
    problems.push(`${isSet(value) ? 'invalid' : 'missing'} ${column}`);
    return fallback;
  };
  const policy = Object.freeze({
    id, name: typeof row.name === 'string' && row.name ? row.name : builtin.name,
    daily_requests: number(row.daily_requests, builtin.daily_requests, 'daily_requests'),
    daily_tokens: number(row.daily_tokens, builtin.daily_tokens, 'daily_tokens'),
    rpm: number(row.rpm_limit ?? row.rpm, builtin.rpm, 'rpm_limit'),
    concurrency: number(row.concurrency_limit ?? row.concurrency, builtin.concurrency, 'concurrency_limit'),
    tiers: Object.freeze(tiers),
    monthly_credit_microusd: number(row.monthly_credit_microusd, builtin.monthly_credit_microusd, 'monthly_credit_microusd'),
  });
  return { policy, problems };
}

// Loads plan policies from zerox_plan_policies_v2 (60 s cache). Falls back to the
// contract's built-in plans when no database is configured or the RPC fails.
export async function loadPlanPolicies(env) {
  const cached = env && typeof env === 'object' ? policyCache.get(env) : null;
  if (cached && cached.expires > Date.now()) return cached.policies;
  if (!databaseConfigured(env || {})) return BUILTIN_PLANS;
  let policies = BUILTIN_PLANS;
  let ttl = POLICY_TTL_MS;
  try {
    const rows = await rpcRows(env, 'zerox_plan_policies_v2', {});
    const loaded = {};
    for (const row of rows) {
      const parsed = policyFromRow(row);
      if (!parsed) continue;
      // Loud on purpose: a column mismatch would otherwise route silently on built-in tiers.
      if (parsed.problems.length) {
        console.error('Neuron plan policy row is incomplete; using built-in values',
          { plan: parsed.policy.id, problems: parsed.problems });
      }
      loaded[parsed.policy.id] = parsed.policy;
    }
    if (!loaded.free) throw new Error('Plan policies are missing the free plan');
    policies = Object.freeze(loaded);
  } catch (error) {
    console.error('Neuron plan policies unavailable; using built-in plans', { name: error.name });
    ttl = POLICY_RETRY_MS;
  }
  policyCache.set(env, { policies, expires: Date.now() + ttl });
  return policies;
}

export function normalizePlanId(plan) {
  return String(plan || 'free').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'free';
}

// Synchronous lookup using the cached database policies when fresh.
export function planPolicy(env, plan, policies) {
  const source = policies || (env && typeof env === 'object' && policyCache.get(env)?.expires > Date.now()
    ? policyCache.get(env).policies : BUILTIN_PLANS);
  const id = normalizePlanId(plan);
  return source[id] || source.free || BUILTIN_PLANS.free;
}

// ── GET /v1/models (contract §3.2) ──
function describeEntry(env, entry, tiers, country) {
  const verdicts = poolVerdicts(env, entry, tiers, country);
  const configured = verdicts.filter(verdict => verdict.configured).map(verdict => verdict.pool);
  const reason = unavailableReason(verdicts);
  const paid = configured.find(pool => pool.tier === 'paid' && pool.price);
  return {
    id: entry.id,
    object: 'model',
    created: 0,
    owned_by: entry.provider,
    display_name: entry.display_name,
    context_window: entry.context_window,
    // OpenAI-compatible clients (opencode, Freebuff BYOK, Cursor) read context_length.
    context_length: entry.context_window,
    max_output_tokens: entry.max_output_tokens,
    capabilities: {
      tools: entry.supports_tools, streaming: entry.supports_streaming,
      vision: entry.supports_vision, reasoning: entry.reasoning_efforts.length > 0,
    },
    reasoning_efforts: entry.reasoning_efforts,
    tiers: [...new Set((configured.length ? configured : entry.pools).map(pool => pool.tier))],
    available: reason === null,
    unavailable_reason: reason,
    pricing: publicPricing(paid?.price),
  };
}

function describeAuto(models) {
  const candidates = models.filter(model => catalogEntry(model.id)?.auto_rank != null && model.capabilities.tools);
  const available = candidates.filter(model => model.available);
  const pool = available.length ? available : candidates;
  const reasons = candidates.map(model => model.unavailable_reason);
  const reason = available.length ? null : !candidates.length ? 'not_configured'
    : ['upgrade_required', 'region_unavailable', 'not_configured'].find(value => reasons.includes(value));
  return {
    id: AUTO_MODEL_ID,
    object: 'model',
    created: 0,
    owned_by: 'zero-x',
    display_name: 'Auto (best available model)',
    // auto can fail over to any candidate mid-task, so it advertises the smallest window:
    // advertising the largest (1M from Gemini) made clients defer compaction until a
    // 131K-context fallback rejected the request.
    context_window: pool.length ? Math.min(...pool.map(model => model.context_window)) : 0,
    context_length: pool.length ? Math.min(...pool.map(model => model.context_window)) : 0,
    max_output_tokens: pool.length ? Math.min(...pool.map(model => model.max_output_tokens)) : 0,
    capabilities: {
      tools: true, streaming: true, vision: false,
      reasoning: pool.some(model => model.capabilities.reasoning),
    },
    reasoning_efforts: [],
    tiers: [...new Set(pool.flatMap(model => model.tiers))],
    available: reason === null,
    unavailable_reason: reason,
    pricing: null,
  };
}

// Catalog for a caller's plan and country; anonymous callers are on the free plan.
export function listModelsForCaller(env = {}, { plan = 'free', country = null, tiers } = {}) {
  warnIgnoredModels(env);
  const allowed = Array.isArray(tiers) ? tiers : planPolicy(env, plan).tiers;
  const code = normalizeCountry(country);
  const data = offeredEntries(env).map(entry => describeEntry(env, entry, allowed, code));
  return { object: 'list', data: [describeAuto(data), ...data] };
}
