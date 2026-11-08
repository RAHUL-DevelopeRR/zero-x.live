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
import { effectiveSpendCapUsd, entryFromSpec, sponsoredTermsFor } from './catalog-guardrails.js';
import { sponsoredUnavailable } from './sponsored.js';
import { CLAUDE_MODEL_SPECS } from './catalog-claude.js';
import { catalogSnapshot, loadCatalog, loadCatalogDbModels } from './catalog-db.js';
import { familyOf, modelIdentity } from './model-families.js';

export { loadCatalog, loadCatalogDbModels, familyOf, modelIdentity };

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
  // pools have none. They serve one request at a time (src/catalog-types.js
  // PROVIDER_TYPES.zai.free_concurrency): users' reservations are limited per model, and since it is
  // not established whether Z.ai counts per model or per account, the health checker treats the
  // slot as one per account (src/health-probes.js slotSiblings). auto tries them only after every
  // other free pool.
  ...[
    ['glm-4.7-flash', 'GLM-4.7-Flash (Z.ai, free)', 14, 200000, 65536],
    ['glm-4.5-flash', 'GLM-4.5-Flash (Z.ai, free)', 15, 131072, 65536],
  // The list positions are explicit (170, 180): they were the array index when the Claude rows were two, and
  // the seeded catalog rows (migration 20261029000700) hold them; a model added above must not shift them.
  ].map(([upstream, name, rank, context, maxOutput], index) => ({
    id: `zai/${upstream}`, display_name: name, provider: 'zai', upstream_model: upstream, position: 170 + index * 10,
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

// Models that `auto` never picks for an agentic request (a tool-carrying request, or the CLI's
// `x-neuron-route: agentic` hint; src/router.js), although they declare tools and still serve
// when asked for by name. The catalog keeps no per-model tool-call rate (the HealthHub canary
// records one probe per pool, not a rate over real requests), so this is an explicit list, matched
// on the upstream model (any provider prefix, any `:variant` suffix) so that catalog rows and a
// BYOK caller's own OpenRouter models of the same model are covered too. Evidence
// (2026-11-03, Neuron alpha.3 bug sweep): on Free with `auto`, "build me a todo app in this
// folder" was served by groq/openai/gpt-oss-120b, which answered with code in chat and called no
// tool. The rest of the gpt-oss family (gpt-oss-20b on Groq and NVIDIA, gpt-oss-120b on Workers
// AI) is listed with it: auto would otherwise hand the same request to its smaller sibling. That
// the siblings behave the same is not separately measured. Remove an entry once a live multi-turn
// build probe shows the model calling tools.
export const POOR_TOOL_CALLERS = Object.freeze([
  // OpenRouter ids carry an optional variant suffix: openai/gpt-oss-120b:free, :nitro.
  Object.freeze({ upstream: /(^|\/)gpt-oss-\d+b(:[a-z0-9-]+)?$/, reason: 'answers build requests in chat without calling tools' }),
]);

export function poorToolCaller(entry) {
  return POOR_TOOL_CALLERS.some(rule => rule.upstream.test(String(entry?.upstream_model ?? '').toLowerCase()));
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

// Family id (lower case) -> { id, members } of a served snapshot, members in list order
// (src/model-families.js; contract section 14).
const familyIndexes = new WeakMap();
function familyIndex(snapshot) {
  let index = familyIndexes.get(snapshot);
  if (index) return index;
  index = new Map();
  for (const entry of snapshot.entries) {
    const family = familyOf(entry);
    const key = family.toLowerCase();
    if (!index.has(key)) index.set(key, { id: family, members: [] });
    index.get(key).members.push(entry);
  }
  familyIndexes.set(snapshot, index);
  return index;
}

// The served routes of a family, in list order ([] for an unknown family id).
export function familyMembers(familyId, env) {
  if (typeof familyId !== 'string') return [];
  return familyIndex(catalogSnapshot(env)).get(familyId.toLowerCase())?.members ?? [];
}

// True when `id` names a family rather than one route. A family whose id is also a route id (one
// route whose own id is already clean, like Claude's) resolves to that route.
export function isFamilyId(id, env) {
  if (typeof id !== 'string' || id === AUTO_MODEL_ID) return false;
  const snapshot = catalogSnapshot(env);
  return !snapshot.byId.has(id.toLowerCase()) && familyIndex(snapshot).has(id.toLowerCase());
}

// Family prefixes an OpenAI-compatible client may strip before sending: Neuron's
// strip_routing_prefix removes openai/ and xai/, so the family "openai/gpt-oss-20b" arrives as
// "gpt-oss-20b".
const CLIENT_STRIPPED_FAMILY_PREFIXES = Object.freeze(['openai/', 'xai/']);

// An alias equal to its route's family leaf ("gpt-oss-20b" for openai/gpt-oss-20b) names the
// model, not one route: it resolves to the family, so the request can fall back to another route.
// Provider-qualified aliases ("workers-ai/gpt-oss-120b") keep their route.
function aliasTarget(snapshot, index, value) {
  const routeId = snapshot.aliases.get(value);
  if (!routeId) return null;
  const entry = snapshot.byId.get(routeId.toLowerCase());
  const family = entry ? familyOf(entry).toLowerCase() : null;
  if (!family || !index.has(family) || family.slice(family.indexOf('/') + 1) !== value) return routeId;
  return index.get(family).id;
}

// Route ids first (old clients keep the route they asked for), then family ids, then aliases (a
// family-leaf alias names its family), then a bare name a client stripped a family prefix from.
function lookup(value, env) {
  if (value === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  const snapshot = catalogSnapshot(env);
  const index = familyIndex(snapshot);
  const found = snapshot.byId.get(value)?.id ?? index.get(value)?.id ?? aliasTarget(snapshot, index, value);
  if (found || value.includes('/')) return found ?? null;
  return CLIENT_STRIPPED_FAMILY_PREFIXES.map(prefix => index.get(prefix + value)?.id).find(Boolean) ?? null;
}

// Resolves a requested model to a public id ('auto' included): a route id, or a family id
// (isFamilyId) that src/router.js serves from the best healthy route of the family. An `openai/`
// transport prefix (added by OpenAI-compatible clients) is accepted when the remainder resolves.
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
  // A sponsored free pool (src/catalog-types.js SPONSORED_FREE_MODELS) is priced and capped like a paid one, and
  // fails closed while the database lacks the monthly-allowance migration (src/sponsored.js).
  if (pool.tier === 'free' && pool.sponsored === true
      && (!pool.price || effectiveSpendCapUsd(env, entry, pool) === null || sponsoredUnavailable(env))) return false;
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

// A request rebuilt from another (the body-limit middleware) keeps the original's inherited country.
export function carryCallerCountry(from, to) {
  if (INHERITED_COUNTRIES.has(from)) INHERITED_COUNTRIES.set(to, INHERITED_COUNTRIES.get(from));
  else {
    // The rebuilt request cannot have `cf` assigned on the Workers runtime (read-only), so the country
    // the platform put on the original travels here.
    const country = normalizeCountry(from?.cf?.country);
    if (country) INHERITED_COUNTRIES.set(to, country);
  }
  return to;
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
// `ledger` is whether the caller's session has an account ledger: a sponsored pool counts its
// users' monthly tokens there, so a session without one (a development session) is not in plan.
export function poolVerdicts(env, entry, tiers, country, ledger = true) {
  return entryPools(env, entry).map(pool => {
    const offer = offerForPool(env, entry, pool);
    return {
      pool,
      offer,
      configured: poolConfigured(env, entry, pool) && servesOperatorPools(offer),
      inPlan: tiers.includes(pool.tier) && (ledger || sponsoredTermsFor(entry, pool)?.requires_ledger !== true),
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
  free: Object.freeze({ id: 'free', name: 'Free', daily_requests: 100, daily_tokens: 5000000, rpm: 10,
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
// A coding agent's system prompt and tool schemas alone take ~4K tokens (Neuron alpha 4:
// 3.8K input tokens for a one-line prompt), so a window below this cannot hold a working
// session. Such a model stays listed, but never sets the window `auto` advertises.
export const AGENT_MIN_CONTEXT = 65536;

// The largest request (prompt plus max_tokens) the caller's usable pools take. A pool's
// per-minute token budget caps every request (router.js fitMaxTokens: Groq's free org refuses
// one over its 8K TPM), so on the Free plan a Groq model holds ~8K tokens, not its 131K window;
// advertising 131K let clients grow a session the gateway then refused as too large.
export function usableContextWindow(entry, pools) {
  if (!pools.length) return entry.context_window;
  return Math.min(entry.context_window, Math.max(...pools.map(pool => pool.limits?.tpm || entry.context_window)));
}

// Room the listed max_output_tokens leaves for the prompt. Clients size max_tokens from
// max_output_tokens and refuse locally to send a request whose prompt plus max_tokens exceeds
// context_window (Neuron alpha 4, api providers/mod.rs preflight_message_request), so a
// window listed with max_output_tokens equal to it blocked every request: Groq's 8K Free window
// with 8K of output left no room for alpha.4's ~4K first turn. The router still fits max_tokens to
// each request (router.js fitMaxTokens); this only keeps the listed pair sendable.
export const AGENT_PROMPT_RESERVE = 6000;
const MIN_LISTED_OUTPUT_TOKENS = 1024; // router.js MIN_OUTPUT_TOKENS

// The max_output_tokens listed with a usable window: the model's own, but never so much of the
// window that a coding agent's prompt no longer fits beside it.
export function listedMaxOutput(maxOutputTokens, window) {
  return Math.min(maxOutputTokens, window, Math.max(MIN_LISTED_OUTPUT_TOKENS, window - AGENT_PROMPT_RESERVE));
}

// `allowance: { month_tokens }` for a model with a sponsored pool among its pools.
function allowanceOf(entry, pools) {
  const terms = (pools.length ? pools : entry.pools).map(pool => sponsoredTermsFor(entry, pool)).find(Boolean);
  return terms ? { allowance: { month_tokens: terms.user_month_tokens } } : {};
}

// The caller's data policy (src/oiop/policy.js) removes pools whose offer it rules out; a model
// whose configured pools are all ruled out is unavailable with reason policy_restricted.
function describeEntry(env, entry, tiers, country, policy, ledger = true) {
  const verdicts = poolVerdicts(env, entry, tiers, country, ledger);
  const permitted = verdicts.map(verdict => ({ ...verdict, configured: verdict.configured && !policyBlock(verdict.offer, policy) }));
  const configured = permitted.filter(verdict => verdict.configured).map(verdict => verdict.pool);
  const window = usableContextWindow(entry, permitted.filter(verdict => verdict.configured && verdict.inPlan && verdict.region)
    .map(verdict => verdict.pool));
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
    // What this caller can send (usableContextWindow); native_context_window is the model's own.
    context_window: window,
    // OpenAI-compatible clients (opencode, Freebuff BYOK, Cursor) read context_length.
    context_length: window,
    native_context_window: entry.context_window,
    max_output_tokens: listedMaxOutput(entry.max_output_tokens, window),
    capabilities: {
      tools: entry.supports_tools, streaming: entry.supports_streaming,
      vision: entry.supports_vision, reasoning: entry.reasoning_efforts.length > 0,
    },
    reasoning_efforts: entry.reasoning_efforts,
    tiers: [...new Set((configured.length ? configured : entry.pools).map(pool => pool.tier))],
    available: reason === null,
    unavailable_reason: reason,
    pricing: publicPricing(paid?.price),
    // The per-user monthly token allowance of a sponsored pool (contract section 19.3), when the
    // model has one; alpha.4 clients ignore the field.
    ...allowanceOf(entry, configured),
    // OIOP (contract §12.4): who serves the model, under which offers, and its models.dev id.
    provider: providerInfo(entry.provider, shown.find(verdict => verdict.offer)?.offer),
    offers,
    models_dev_id: modelsDevId(entry),
  };
}

function describeAuto(models, env) {
  const candidates = models.filter(model => catalogEntry(model.id, env)?.auto_rank != null && model.capabilities.tools);
  const available = candidates.filter(model => model.available);
  const listed = available.length ? available : candidates;
  // A candidate below AGENT_MIN_CONTEXT serves only the requests that fit it (router.js skips it
  // otherwise), so it does not shrink the window auto advertises.
  const roomy = listed.filter(model => model.context_window >= AGENT_MIN_CONTEXT);
  const pool = roomy.length ? roomy : listed;
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
    native_context_window: pool.length ? Math.min(...pool.map(model => model.context_window)) : 0,
    max_output_tokens: pool.length ? Math.min(...pool.map(model => model.max_output_tokens)) : 0,
    capabilities: {
      tools: true, streaming: true, vision: false,
      reasoning: listed.some(model => model.capabilities.reasoning),
    },
    reasoning_efforts: [],
    tiers: [...new Set(listed.flatMap(model => model.tiers))],
    available: reason === null,
    unavailable_reason: reason,
    pricing: null,
    provider: { id: 'zero-x', name: 'Zero-X', logo_url: null, logo_fallback_url: null },
    offers: [],
    models_dev_id: null,
  };
}

// Catalog for a caller's plan, country and data policy; anonymous callers are on the free plan.
export function listModelsForCaller(env = {}, { plan = 'free', country = null, tiers, policy = DEFAULT_POLICY, ledger = true } = {}) {
  warnIgnoredModels(env);
  const allowed = Array.isArray(tiers) ? tiers : planPolicy(env, plan).tiers;
  const code = normalizeCountry(country);
  const data = offeredEntries(env).map(entry => describeEntry(env, entry, allowed, code, policy, ledger));
  return { object: 'list', data: [describeAuto(data, env), ...data] };
}

// ── Model families on /v1/models (contract section 14) ──
// GET /v1/models lists one entry per family (src/model-families.js): the routes of a model
// rolled up for the caller. Route ids stay listed under ?routes=1, each with its identity.
// Public statuses (health-share.js withHealth); `blurred` is the word clients before section 15 read.
const STATUS_RANK = Object.freeze({ available: 0, degraded: 1, unknown: 2, busy: 3, unavailable: 4, blurred: 4 });
const REASON_ORDER = Object.freeze(['upgrade_required', 'region_unavailable', 'policy_restricted', 'not_configured']);
const AUTO_IDENTITY = Object.freeze({ maker: 'zero-x', maker_name: 'Zero-X', family: AUTO_MODEL_ID, model_name: 'Auto' });

// A described route (listModelsForCaller item) plus maker, maker_name, family and model_name.
export function withIdentity(model, env) {
  if (model.id === AUTO_MODEL_ID) return { ...model, ...AUTO_IDENTITY };
  const entry = catalogEntry(model.id, env);
  if (!entry) return model;
  const { maker, maker_name: makerName, family, name } = modelIdentity(entry);
  return { ...model, maker, maker_name: makerName, family, model_name: name };
}

const time = value => (value ? Date.parse(value) || 0 : 0);
const union = lists => [...new Set(lists.flat())];

// Routes that can take a request now: available or degraded (a route without any status counts
// as available). Without one, the routes with the best status (unknown, which routing still
// tries, then busy, then unavailable): the window the model takes once they free up.
function servingRoutes(listed) {
  const rank = model => STATUS_RANK[model.status ?? 'available'] ?? STATUS_RANK.unknown;
  const now = listed.filter(model => rank(model) <= STATUS_RANK.degraded);
  if (now.length) return now;
  const best = Math.min(...listed.map(rank));
  return listed.filter(model => rank(model) === best);
}

// The data-policy fields of the routes' offers. An offer id names the serving provider
// ("groq.free"), so the family view lists the fields without it; ?routes=1 keeps the ids.
function familyOffers(listed) {
  const offers = listed.flatMap(model => model.offers || []).map(offer => ({
    tier: offer.tier, owner: offer.owner, trust_tier: offer.trust_tier, trains_on_inputs: offer.trains_on_inputs,
  }));
  return [...new Map(offers.map(offer => [JSON.stringify(offer), offer])).values()];
}

// One family entry from its described routes (with their runtime health when withHealth ran).
// Only the routes the caller can use count (all routes when none can). The context window is the
// largest the routes that can serve now take (servingRoutes; the router skips routes a request
// does not fit), so a busy route never advertises a window the healthy ones cannot serve. The
// status is the best of theirs, checked_at the newest observation. Nothing names the serving
// provider: provider is the maker, offers carry no ids, models_dev_id is null.
function describeFamily(identity, routes) {
  const usable = routes.filter(model => model.available);
  const listed = usable.length ? usable : routes;
  const serving = servingRoutes(listed);
  const largest = (key, from = listed) => Math.max(0, ...from.map(model => Number(model[key]) || 0));
  const any = key => listed.some(model => Boolean(model.capabilities?.[key]));
  const reasons = routes.map(model => model.unavailable_reason);
  const priced = listed.filter(model => model.pricing)
    .sort((a, b) => (b.pricing.input_per_mtok_usd ?? 0) - (a.pricing.input_per_mtok_usd ?? 0))[0];
  const window = largest('context_window', serving);
  const facts = listed.map(model => model.facts).find(Boolean);
  const family = {
    id: identity.family,
    object: 'model',
    created: 0,
    owned_by: identity.maker,
    display_name: identity.name,
    model_name: identity.name,
    maker: identity.maker,
    maker_name: identity.maker_name,
    family: identity.family,
    context_window: window,
    context_length: window,
    // The model's own window does not change with route health.
    native_context_window: largest('native_context_window'),
    max_output_tokens: Math.min(largest('max_output_tokens', serving), window),
    capabilities: { tools: any('tools'), streaming: any('streaming'), vision: any('vision'), reasoning: any('reasoning') },
    reasoning_efforts: union(listed.map(model => model.reasoning_efforts || [])),
    tiers: union(listed.map(model => model.tiers || [])),
    available: usable.length > 0,
    unavailable_reason: usable.length ? null : REASON_ORDER.find(reason => reasons.includes(reason)) ?? 'not_configured',
    pricing: priced?.pricing ?? null,
    ...(listed.find(model => model.allowance)?.allowance ? { allowance: listed.find(model => model.allowance).allowance } : {}),
    // The family has no single serving provider: the block names the maker.
    provider: { id: identity.maker, name: identity.maker_name, logo_url: null, logo_fallback_url: null },
    offers: familyOffers(listed),
    // A models.dev id names a provider ("groq/openai/gpt-oss-120b"): routes only.
    models_dev_id: null,
  };
  if (routes.some(model => 'facts' in model)) family.facts = facts ? { ...facts, models_dev_id: null } : null;
  const observed = listed.filter(model => model.status);
  if (observed.length) {
    // The best route speaks for the family, with its own observation time, latency and last
    // failure: a fresh failure on another route never dates an older verdict.
    const rank = model => STATUS_RANK[model.status] ?? STATUS_RANK.unknown;
    const best = [...observed].sort((a, b) => rank(a) - rank(b)
      || time(a.available_again_at) - time(b.available_again_at) || time(b.checked_at) - time(a.checked_at))[0];
    Object.assign(family, { status: best.status, available_again_at: best.available_again_at ?? null,
      checked_at: best.checked_at ?? null, latency_ms: best.latency_ms ?? null, last_success_at: best.last_success_at ?? null,
      last_failure_class: best.last_failure_class ?? null,
      ...(best.stale_after_seconds != null ? { stale_after_seconds: best.stale_after_seconds } : {}) });
  }
  return family;
}

/**
 * Rolls described routes (listModelsForCaller(...).data, after withHealth) up into one entry per
 * family, in the order each family first appears. `auto` stays as it is, with its identity.
 */
export function familyModels(models, env) {
  const groups = new Map();
  const order = [];
  for (const model of models) {
    const entry = model.id === AUTO_MODEL_ID ? null : catalogEntry(model.id, env);
    if (!entry) {
      order.push(withIdentity(model, env));
      continue;
    }
    const identity = modelIdentity(entry);
    const key = identity.family.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { identity, routes: [] });
      order.push(groups.get(key));
    }
    groups.get(key).routes.push(model);
  }
  return order.map(item => (item.identity && item.routes ? describeFamily(item.identity, item.routes) : item));
}
