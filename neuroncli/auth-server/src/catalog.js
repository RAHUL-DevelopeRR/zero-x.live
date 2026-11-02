// Compliance-aware public model catalog (docs/PLATFORM_CONTRACT.md §2,
// docs/PROVIDER_TERMS.md). Only models verified against the live upstreams are listed;
// *_MODELS environment lists can disable entries but never add unknown ones.
//
// CATALOG below is the code catalog: the reviewed floor, and what serves without a database or
// with CATALOG_SOURCE=code. With a database the served catalog is the data-driven one
// (src/catalog-db.js: approved model rows, bounded by src/catalog-guardrails.js, falling back to
// these entries), and every accessor below reads that snapshot. Callers that route or list models
// await loadCatalog(env) first.
import { databaseConfigured, rpcRows } from './account-store.js';
import { priceFromCost, publicPricing } from './pricing.js';
import { vaultKeys, vaultKeySecret } from './provider-keys.js';
import { offerForPool, servesOperatorPools } from './oiop/offers.js';
import { DEFAULT_POLICY, policyBlock } from './oiop/policy.js';
import { modelsDevId, providerInfo } from './oiop/models-dev.js';
import {
  BILLED_FREE_LIMITS, MODELS_VARS as TYPE_MODELS_VARS, VAULT_KEY_VARS as SLOT_VAULT_KEY_VARS, poolSource, publicIdFor,
} from './catalog-types.js';
import { effectiveSpendCapUsd, entryFromSpec } from './catalog-guardrails.js';
import { CLAUDE_MODEL_SPECS } from './catalog-claude.js';
import { catalogSnapshot, loadCatalog, loadCatalogDbModels } from './catalog-db.js';

export { loadCatalog, loadCatalogDbModels };

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
// (rpm 5, tpm 120K; tpd unverified). The day allows 20 requests per model: on 2026-10-27 2.5, 3.5
// and 3.6 Flash answered 429 GenerateRequestsPerDayPerProjectPerModel-FreeTier, quota value 20
// (the owner may confirm per model in AI Studio). Google counts input tokens only, while a reservation
// counts the prompt plus at most 1,024 output tokens (capacity.js RESERVED_OUTPUT_TOKENS, settled
// to the real usage afterwards), so 120K never lets more than ~120K input tokens per minute
// through and still fits four sequential Neuron-sized requests (~23.5K prompt). The upstream
// max_tokens stays fitted to the per-minute budget (router.js fitMaxTokens), which Groq checks
// per request. Upstream 429s still park a pool for the provider's delay (provider-health.js).
// Workers AI pools are sized so both models together stay under the 10,000 neurons/day free
// allocation, assuming at most ~15% of tokens are output tokens. The binding bills past it, so
// these are also the ceilings catalog rows cannot exceed (src/catalog-types.js BILLED_FREE_LIMITS).
export const POOL_LIMITS = Object.freeze({
  groq_free: Object.freeze({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }),
  gemini_free: Object.freeze({ rpm: 5, rpd: 20, tpm: 120000, tpd: 5000000 }),
  workers_llama_free: BILLED_FREE_LIMITS.cloudflare['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  workers_gpt_oss_free: BILLED_FREE_LIMITS.cloudflare['@cf/openai/gpt-oss-120b'],
  // build.nvidia.com/faq (2026-10-19): up to 40 RPM and 10,000 requests per day; no token caps
  // are published, and other users' traffic can throttle the shared endpoints.
  nvidia_trial: Object.freeze({ rpm: 40, rpd: 10000, tpm: null, tpd: null }),
  openrouter_free: Object.freeze({ rpm: 20, rpd: 50, tpm: null, tpd: null }),
});

const pool = (tier, source, extra = {}) => Object.freeze({ tier, ...source, ...extra });
// A pool's key comes from a key slot of the provider-type registry (src/catalog-types.js
// KEY_SLOTS): the slot id names the env var or binding, so data rows can never name a secret.
const slot = id => ({ ...poolSource(id), key_slot: id });
const WORKERS_AI = slot('cloudflare.binding');

// Provider -> the *_MODELS variable that narrows its catalog models (src/catalog-types.js).
// OMNIROUTE_MODELS narrows the OmniRoute discovery adapter instead; no catalog model uses it.
export const MODELS_VARS = Object.freeze(Object.fromEntries(Object.entries(TYPE_MODELS_VARS)
  .filter(([provider]) => provider !== 'omniroute')));

// Daily spend caps of the paid pools, in upstream USD per UTC day (Gemini $10, Groq and Workers
// AI $5; Claude Sonnet 5.5 $10 and Opus 5.5 $6 in src/catalog-claude.js). Postgres enforces them
// (zerox_reserve_v2 p_pool.cpd, billed at MARKUP); src/catalog-guardrails.js clamps them to the
// code maximum ($100 a pool, $50 for anthropic) and PAID_DAILY_SPEND_CAP_USD.
const CAP_USD = Object.freeze({ gemini: 10, groq: 5, cloudflare: 5 });

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
      pool('free', slot('gemini.free'), { limits: POOL_LIMITS.gemini_free }),
      pool('paid', slot('gemini.paid'), { price: priceFromCost(0.30, 2.50), daily_spend_cap_usd: CAP_USD.gemini }),
    ],
  },
  {
    id: 'gemini/gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', provider: 'gemini',
    upstream_model: 'gemini-3.5-flash', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: 2,
    geo_block_free: GEMINI_FREE_GEO_BLOCK, aliases: ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    // No paid pool until a verified upstream price is recorded here.
    pools: [pool('free', slot('gemini.free'), { limits: POOL_LIMITS.gemini_free })],
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
      pool('free', slot('gemini.free'), { limits: POOL_LIMITS.gemini_free }),
      // Paid list price through 2026-12-31 (doubles from 2027-01-01).
      pool('paid', slot('gemini.paid'), { price: priceFromCost(input, output), daily_spend_cap_usd: CAP_USD.gemini }),
    ],
  })),
  {
    id: 'gemini/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', provider: 'gemini',
    upstream_model: 'gemini-2.5-pro', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, supports_vision: true, auto_rank: null,
    aliases: ['gemini-2.5-pro', 'google/gemini-2.5-pro'],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    // The free tier has no 2.5 Pro quota (404 for new projects): paid only.
    pools: [pool('paid', slot('gemini.paid'), {
      price: priceFromCost(1.25, 10, { threshold: 200000, input: 2.50, output: 15 }), daily_spend_cap_usd: CAP_USD.gemini,
    })],
  },
  {
    id: 'groq/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Groq)', provider: 'groq',
    upstream_model: 'openai/gpt-oss-120b', context_window: 131072, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: 5,
    aliases: ['gpt-oss-120b', 'openai/gpt-oss-120b'], reasoning_efforts: STANDARD_EFFORTS,
    reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [
      pool('free', slot('groq.free'), { limits: POOL_LIMITS.groq_free }),
      pool('paid', slot('groq.paid'), { price: priceFromCost(0.15, 0.60), daily_spend_cap_usd: CAP_USD.groq }),
    ],
  },
  {
    id: 'groq/qwen/qwen3.8-27b', display_name: 'Qwen 3.8 27B (Groq)', provider: 'groq',
    upstream_model: 'qwen/qwen3.8-27b', context_window: 131072, max_output_tokens: 40960,
    supports_tools: true, supports_streaming: true, auto_rank: 6,
    aliases: ['qwen3.8-27b', 'qwen/qwen3.8-27b'], reasoning_efforts: ['none', 'default'],
    reasoning_effort_map: { minimal: 'default', low: 'default', medium: 'default', high: 'default' },
    pools: [pool('free', slot('groq.free'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    id: 'groq/openai/gpt-oss-20b', display_name: 'GPT-OSS 20B (Groq)', provider: 'groq',
    upstream_model: 'openai/gpt-oss-20b', context_window: 131072, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: 7,
    aliases: ['gpt-oss-20b', 'openai/gpt-oss-20b'], reasoning_efforts: STANDARD_EFFORTS,
    reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [pool('free', slot('groq.free'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    // Not part of the 2026-10-16 live probe: enable explicitly with CLOUDFLARE_MODELS.
    id: '@cf/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Workers AI)', provider: 'cloudflare',
    upstream_model: '@cf/openai/gpt-oss-120b', context_window: 131072, max_output_tokens: 32768,
    supports_tools: true, supports_streaming: true, auto_rank: 8, default_enabled: false,
    aliases: ['workers-ai/gpt-oss-120b', 'cloudflare/gpt-oss-120b'],
    pools: [
      pool('free', WORKERS_AI, { limits: POOL_LIMITS.workers_gpt_oss_free }),
      pool('paid', WORKERS_AI, { requires_flag: 'CLOUDFLARE_PAID', price: priceFromCost(0.35, 0.75),
        daily_spend_cap_usd: CAP_USD.cloudflare }),
    ],
  },
  {
    // Explicit selection only: in production (2026-10-28) it answered 400 (5006) to every request
    // with tool history, which cost each `auto` request an attempt, and its 24K window capped the
    // window auto advertises. Rank it again only after a live multi-turn tool-call probe passes.
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', display_name: 'Llama 3.3 70B (Workers AI)',
    provider: 'cloudflare', upstream_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    context_window: 24000, max_output_tokens: 8192, supports_tools: true, supports_streaming: true,
    auto_rank: null, aliases: ['llama-3.3-70b', 'workers-ai/llama-3.3-70b', 'cloudflare/llama-3.3-70b'],
    pools: [
      pool('free', WORKERS_AI, { limits: POOL_LIMITS.workers_llama_free }),
      // Workers AI list price: 26,668 / 204,805 neurons per million tokens at $0.011 / 1K neurons.
      pool('paid', WORKERS_AI, { requires_flag: 'CLOUDFLARE_PAID', price: priceFromCost(0.293, 2.253),
        daily_spend_cap_usd: CAP_USD.cloudflare }),
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
    pools: [pool('free', slot('nvidia.free'), { limits: POOL_LIMITS.nvidia_trial })],
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
    pools: [pool('free', slot('openrouter.free'), { limits: POOL_LIMITS.openrouter_free })],
  })),
  // Claude Sonnet 5.5 and Claude Opus 5.5 (Anthropic Messages API, src/anthropic-adapter.js): paid
  // tier only (Pro and Max, billed from credits), key slot anthropic.paid (ANTHROPIC_API_KEY),
  // never chosen by `auto`. Defined once in src/catalog-claude.js (also the seed of their catalog
  // rows): 200,000 context (what MAX_BODY_BYTES can carry), 32,000 output, 16,000 default
  // max_tokens, effort medium by default, list prices with cache rates, caps $10 and $6 a day.
  ...CLAUDE_MODEL_SPECS.map(spec => entryFromSpec(publicIdFor(spec.provider_type, spec.upstream_model), spec, { source: 'code' })),
  // Z.ai's free GLM Flash models (owner lineup, 2026-10-29), key slot zai.free (GLM_API_KEY).
  // docs.z.ai: GLM-4.7-Flash 200K context and 128K output, completely free; the GLM-4.5 series
  // 128K and 96K. Output is listed at what max_tokens validation accepts (chat-handler.js
  // MAX_OUTPUT_TOKENS). Both call tools, stream, and think by default (reasoning_content), which
  // reasoning_effort "none" turns off. Z.ai publishes no request or token budget for them, so the
  // pools have none; they serve one request at a time per account and model
  // (src/catalog-types.js PROVIDER_TYPES.zai.free_concurrency), so auto tries them only after
  // every other free pool.
  ...[
    ['glm-4.7-flash', 'GLM-4.7-Flash (Z.ai, free)', 14, 200000, 65536],
    ['glm-4.5-flash', 'GLM-4.5-Flash (Z.ai, free)', 15, 131072, 65536],
  ].map(([upstream, name, rank, context, maxOutput]) => ({
    id: `zai/${upstream}`, display_name: name, provider: 'zai', upstream_model: upstream,
    context_window: context, max_output_tokens: maxOutput, supports_tools: true, supports_streaming: true,
    auto_rank: rank, aliases: [upstream], reasoning_efforts: ['none', 'default'],
    reasoning_effort_map: { minimal: 'default', low: 'default', medium: 'default', high: 'default' },
    pools: [pool('free', slot('zai.free'))],
  })),
];

function freezeEntry(entry) {
  return Object.freeze({
    default_enabled: true, hosted_flag: null, geo_block_free: [], reasoning_efforts: [], supports_vision: false,
    reasoning_effort_map: {}, ...entry, pools: Object.freeze(entry.pools),
    aliases: Object.freeze(entry.aliases || []),
  });
}

// position: the list order of /v1/models and of the catalog rows (10, 20, ...).
export const CATALOG = Object.freeze(MODELS.map((entry, index) => freezeEntry({ position: (index + 1) * 10, ...entry })));
export const AUTO_MODEL_ID = 'auto';

// The code catalog's explicit aliases (the served ones are in the catalog snapshot): no
// substring or segment matching.
export const MODEL_ALIASES = Object.freeze(Object.fromEntries([
  ['default', AUTO_MODEL_ID],
  ...CATALOG.flatMap(entry => entry.aliases.map(alias => [alias, entry.id])),
]));

// ── The served catalog (the src/catalog-db.js snapshot for env) ──

// Every model this isolate serves for `env`: the approved rows merged over the code catalog, or
// the code catalog itself (no database, CATALOG_SOURCE=code, nothing loaded yet).
export function catalogEntries(env) {
  return catalogSnapshot(env).entries;
}

export function catalogEntry(id, env) {
  return typeof id === 'string' ? catalogSnapshot(env).byId.get(id.toLowerCase()) ?? null : null;
}

function lookup(value, env) {
  if (value === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  const snapshot = catalogSnapshot(env);
  return snapshot.byId.get(value)?.id ?? snapshot.aliases.get(value) ?? null;
}

// Resolves a requested model to a public id ('auto' included). An `openai/` transport
// prefix (added by OpenAI-compatible clients) is accepted when the remainder resolves.
// Catalog rows resolve only for an `env` whose catalog was loaded (loadCatalog).
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
export const VAULT_KEY_VARS = SLOT_VAULT_KEY_VARS;

const POOL_SECRETS = new WeakMap(); // vault pool -> plaintext key (never a property)
const expandedPools = new WeakMap(); // env -> { keys, byEntry: WeakMap<entry, pools> }

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
// Cached per entry object, not per id: a refreshed catalog snapshot brings new entry objects
// (new prices, slots or limits) and must never be served the previous entry's pools.
export function entryPools(env, entry) {
  const keys = vaultKeys(env);
  if (!keys.length || !VAULT_KEY_VARS[entry.provider]) return entry.pools;
  let cache = expandedPools.get(env);
  if (!cache || cache.keys !== keys) expandedPools.set(env, cache = { keys, byEntry: new WeakMap() });
  if (!cache.byEntry.has(entry)) cache.byEntry.set(entry, expandPools(env, entry, keys));
  return cache.byEntry.get(entry);
}

// The upstream API key of a pool (null for bindings and unconfigured pools).
export function poolSecret(env, pool) {
  if (pool?.key_id) return POOL_SECRETS.get(pool) ?? null;
  const value = pool?.key_var ? env?.[pool.key_var] : null;
  return typeof value === 'string' && value ? value : null;
}

// Paid pools also need a price and a usable daily spend cap: without them a request would be
// free or unbounded, so the pool counts as not configured (fail closed).
export function poolConfigured(env, entry, pool) {
  if (pool.requires_flag && env?.[pool.requires_flag] !== 'true') return false;
  if (pool.tier === 'paid' && (!pool.price || effectiveSpendCapUsd(env, entry, pool) === null)) return false;
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

// Classifies every pool of an entry for a caller: configured, in plan, region allowed. A pool
// counts as configured only while its OIOP offer may serve other people through the operator's
// keys (src/oiop/offers.js servesOperatorPools: active or degraded, redistribution permitted).
export function poolVerdicts(env, entry, tiers, country) {
  return entryPools(env, entry).map(pool => {
    const offer = offerForPool(env, entry, pool);
    return {
      pool,
      offer,
      configured: poolConfigured(env, entry, pool) && servesOperatorPools(offer),
      inPlan: tiers.includes(pool.tier),
      region: !geoBlocked(entry, pool, country, env),
    };
  });
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

// ── GET /v1/models (contract §3.2, §12.4) ──
// The caller's data policy (src/oiop/policy.js) removes pools whose offer it rules out; a model
// whose configured pools are all ruled out is unavailable with reason policy_restricted.
function describeEntry(env, entry, tiers, country, policy) {
  const verdicts = poolVerdicts(env, entry, tiers, country);
  const permitted = verdicts.map(verdict => ({ ...verdict, configured: verdict.configured && !policyBlock(verdict.offer, policy) }));
  const configured = permitted.filter(verdict => verdict.configured).map(verdict => verdict.pool);
  const reason = verdicts.some(verdict => verdict.configured) && !configured.length ? 'policy_restricted' : unavailableReason(permitted);
  const paid = configured.find(pool => pool.tier === 'paid' && pool.price);
  const shown = configured.length ? permitted.filter(verdict => verdict.configured) : verdicts;
  const offers = [...new Map(shown.filter(verdict => verdict.offer).map(({ offer, pool }) => [offer.id, {
    id: offer.id, tier: pool.tier, owner: offer.owner, trust_tier: offer.trust_tier, trains_on_inputs: offer.trains_on_inputs,
  }])).values()];
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
    // OIOP (contract §12.4): who serves the model, under which offers, and its models.dev id.
    provider: providerInfo(entry.provider, shown.find(verdict => verdict.offer)?.offer),
    offers,
    models_dev_id: modelsDevId(entry),
  };
}

function describeAuto(models, env) {
  const candidates = models.filter(model => catalogEntry(model.id, env)?.auto_rank != null && model.capabilities.tools);
  const available = candidates.filter(model => model.available);
  const pool = available.length ? available : candidates;
  const reasons = candidates.map(model => model.unavailable_reason);
  const reason = available.length ? null : !candidates.length ? 'not_configured'
    : ['upgrade_required', 'region_unavailable', 'policy_restricted', 'not_configured'].find(value => reasons.includes(value));
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
    provider: { id: 'zero-x', name: 'Zero-X', logo_url: null, logo_fallback_url: null },
    offers: [],
    models_dev_id: null,
  };
}

// Catalog for a caller's plan, country and data policy; anonymous callers are on the free plan.
export function listModelsForCaller(env = {}, { plan = 'free', country = null, tiers, policy = DEFAULT_POLICY } = {}) {
  warnIgnoredModels(env);
  const allowed = Array.isArray(tiers) ? tiers : planPolicy(env, plan).tiers;
  const code = normalizeCountry(country);
  const data = offeredEntries(env).map(entry => describeEntry(env, entry, allowed, code, policy));
  return { object: 'list', data: [describeAuto(data, env), ...data] };
}
