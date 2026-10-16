// Compliance-aware public model catalog (docs/PLATFORM_CONTRACT.md §2,
// docs/PROVIDER_TERMS.md). Only models verified against the live upstreams are listed;
// *_MODELS environment lists can disable entries but never add unknown ones.
import { databaseConfigured, rpcRows } from './account-store.js';
import { priceFromCost, publicPricing } from './pricing.js';

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
// x-ratelimit headers; Gemini free limits are conservative (AI Studio shows them only per
// project). Workers AI pools are sized so both models together stay under the 10,000
// neurons/day free allocation, assuming at most ~15% of tokens are output tokens.
export const POOL_LIMITS = Object.freeze({
  groq_free: Object.freeze({ rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 }),
  gemini_free: Object.freeze({ rpm: 10, rpd: 250, tpm: 250000, tpd: 5000000 }),
  workers_llama_free: Object.freeze({ rpm: 20, rpd: 300, tpm: 60000, tpd: 120000 }),
  workers_gpt_oss_free: Object.freeze({ rpm: 20, rpd: 200, tpm: 60000, tpd: 90000 }),
  nvidia_trial: Object.freeze({ rpm: 20, rpd: 500, tpm: 100000, tpd: 1000000 }),
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
    supports_tools: true, supports_streaming: true, auto_rank: 1,
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
    supports_tools: true, supports_streaming: true, auto_rank: 2,
    geo_block_free: GEMINI_FREE_GEO_BLOCK, aliases: ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    reasoning_efforts: STANDARD_EFFORTS, reasoning_effort_map: { minimal: 'low', none: 'low' },
    // No paid pool until a verified upstream price is recorded here.
    pools: [pool('free', key('GEMINI_API_KEY'), { limits: POOL_LIMITS.gemini_free })],
  },
  {
    id: 'gemini/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', provider: 'gemini',
    upstream_model: 'gemini-2.5-pro', context_window: 1048576, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: null,
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
    supports_tools: true, supports_streaming: true, auto_rank: 3,
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
    supports_tools: true, supports_streaming: true, auto_rank: 4,
    aliases: ['qwen3.8-27b', 'qwen/qwen3.8-27b'], reasoning_efforts: ['none', 'default'],
    reasoning_effort_map: { minimal: 'default', low: 'default', medium: 'default', high: 'default' },
    pools: [pool('free', key('GROQ_API_KEY'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    id: 'groq/openai/gpt-oss-20b', display_name: 'GPT-OSS 20B (Groq)', provider: 'groq',
    upstream_model: 'openai/gpt-oss-20b', context_window: 131072, max_output_tokens: 65536,
    supports_tools: true, supports_streaming: true, auto_rank: 5,
    aliases: ['gpt-oss-20b', 'openai/gpt-oss-20b'], reasoning_efforts: STANDARD_EFFORTS,
    reasoning_effort_map: { minimal: 'low', none: 'low' },
    pools: [pool('free', key('GROQ_API_KEY'), { limits: POOL_LIMITS.groq_free })],
  },
  {
    // Not part of the 2026-10-16 live probe: enable explicitly with CLOUDFLARE_MODELS.
    id: '@cf/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Workers AI)', provider: 'cloudflare',
    upstream_model: '@cf/openai/gpt-oss-120b', context_window: 131072, max_output_tokens: 32768,
    supports_tools: true, supports_streaming: true, auto_rank: 6, default_enabled: false,
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
    auto_rank: 7, aliases: ['llama-3.3-70b', 'workers-ai/llama-3.3-70b', 'cloudflare/llama-3.3-70b'],
    pools: [
      pool('free', WORKERS_AI, { limits: POOL_LIMITS.workers_llama_free }),
      // Workers AI list price: 26,668 / 204,805 neurons per million tokens at $0.011 / 1K neurons.
      pool('paid', WORKERS_AI, { requires_flag: 'CLOUDFLARE_PAID', price: priceFromCost(0.293, 2.253) }),
    ],
  },
  // NVIDIA API Catalog trial terms forbid production use: internal evaluation only.
  ...[
    ['nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B (NVIDIA, evaluation)', 8, 65536],
    ['stepfun-ai/step-5-preview', 'Step 5 Preview (NVIDIA, evaluation)', 9, 16384],
    ['openai/gpt-oss-20b', 'GPT-OSS 20B (NVIDIA, evaluation)', 10, 32768],
  ].map(([upstream, name, rank, maxOutput]) => ({
    id: `nvidia/${upstream}`, display_name: name, provider: 'nvidia', upstream_model: upstream,
    context_window: 131072, max_output_tokens: maxOutput, supports_tools: true, supports_streaming: true,
    auto_rank: rank, hosted_flag: 'NVIDIA_HOSTED', aliases: [],
    pools: [pool('free', key('NVIDIA_API_KEY'), { limits: POOL_LIMITS.nvidia_trial })],
  })),
  // OpenRouter forbids reselling: the operator key is used only with OPENROUTER_HOSTED=true.
  ...[
    ['cohere/north-mini-code:free', 'North Mini Code (OpenRouter, free)', 11],
    ['poolside/laguna-s-2.1:free', 'Laguna S 2.1 (OpenRouter, free)', 12],
  ].map(([upstream, name, rank]) => ({
    id: upstream, display_name: name, provider: 'openrouter', upstream_model: upstream,
    context_window: 128000, max_output_tokens: 8192, supports_tools: true, supports_streaming: true,
    auto_rank: rank, hosted_flag: 'OPENROUTER_HOSTED', aliases: [`openrouter/${upstream}`],
    pools: [pool('free', key('OPENROUTER_API_KEY'), { limits: POOL_LIMITS.openrouter_free })],
  })),
];

function freezeEntry(entry) {
  return Object.freeze({
    default_enabled: true, hosted_flag: null, geo_block_free: [], reasoning_efforts: [],
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

export function catalogEntry(id) {
  return BY_ID.get(id) || null;
}

function lookup(value) {
  if (value === AUTO_MODEL_ID) return AUTO_MODEL_ID;
  if (BY_ID.has(value)) return value;
  return Object.hasOwn(MODEL_ALIASES, value) ? MODEL_ALIASES[value] : null;
}

// Resolves a requested model to a public id ('auto' included). An `openai/` transport
// prefix (added by OpenAI-compatible clients) is accepted when the remainder resolves.
export function resolveModelId(requested) {
  if (typeof requested !== 'string') return null;
  const value = requested.trim().toLowerCase();
  if (!value || value.length > 200) return null;
  const direct = lookup(value);
  if (direct) return direct;
  return value.startsWith('openai/') ? lookup(value.slice('openai/'.length)) : null;
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
  return CATALOG.filter(entry => isHosted(env, entry) && isEnabled(env, entry));
}

// Unknown ids in *_MODELS are ignored, never silently added; operators see them here.
export function catalogWarnings(env) {
  const warnings = [];
  for (const [provider, name] of Object.entries(MODELS_VARS)) {
    const listed = listedModels(env, provider);
    if (!listed) continue;
    const known = new Set(CATALOG.filter(entry => entry.provider === provider)
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

export function poolConfigured(env, entry, pool) {
  if (pool.requires_flag && env?.[pool.requires_flag] !== 'true') return false;
  if (pool.binding === 'cloudflare') return cloudflareBound(env);
  const value = env?.[pool.key_var];
  return typeof value === 'string' && value.trim().length > 0;
}

export function poolKey(entry, pool) {
  return `${entry.provider}:${entry.upstream_model}:${pool.tier}`;
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
  return entry.pools.map(pool => ({
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
    max_output_tokens: entry.max_output_tokens,
    capabilities: { tools: entry.supports_tools, streaming: entry.supports_streaming },
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
    context_window: Math.max(0, ...pool.map(model => model.context_window)),
    max_output_tokens: Math.max(0, ...pool.map(model => model.max_output_tokens)),
    capabilities: { tools: true, streaming: true },
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
