// Guardrails for data-driven catalog rows (src/catalog-db.js, docs/PLATFORM_CONTRACT.md §2).
// Every row is bounded by reviewed code before it can serve: the provider type and key slot must
// be in src/catalog-types.js, a paid pool serves only for a model listed in src/list-prices.js
// and at exactly that price (cache rates included), every paid pool needs a daily spend cap no
// higher than the code maximum, and a free pool on a billed slot (Workers AI) only for a model in
// catalog-types.js BILLED_FREE_LIMITS, with every limit set and none above it. Spend caps are
// enforced in Postgres (zerox_reserve_v2, p_pool.cpd); this module only decides which rows and
// pools may be offered.
//
// A spec is the canonical description of one model revision. Money is upstream micro-USD per
// million tokens (integers); MARKUP lives only in src/pricing.js and is applied there.
//   { provider_type, upstream_model, display_name, context_window, max_output_tokens,
//     default_max_tokens, supports_tools, supports_vision, reasoning_efforts, reasoning_effort_map,
//     default_reasoning_effort, aliases, geo_block_free, auto_rank, position, default_enabled,
//     pools: [{ tier, key_slot, price: null | { input, output, cache_read, cache_write, cache_write_1h,
//       long: null | { threshold, input, output } }, limits: { rpm, rpd, tpm, tpd },
//       daily_spend_cap_microusd }] }
import { MARKUP, priceFromCost, publicPricing } from './pricing.js';
import { listPriceMicro, MAX_DAILY_SPEND_CAP_USD } from './list-prices.js';
import {
  PROVIDER_TYPES, TIERS, billedFreeLimits, poolSource, providerType, publicIdFor, slotAllowed, slotBilled, slotForPool,
  typeMaxCapMicrousd, upstreamAllowed,
} from './catalog-types.js';
import { canonicalJson } from './oiop/manifest.js';

export { LIST_PRICES, listPriceFor, listPriceMicro } from './list-prices.js';

export const HARD_MAX_DAILY_SPEND_USD = MAX_DAILY_SPEND_CAP_USD;
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'default']);
const MAX_PRICE_MICROUSD = 1_000_000_000;

const MODEL_ID = /^[a-z0-9@][a-z0-9@./:_-]{0,199}$/;
const ALIAS = /^[a-z0-9][a-z0-9./:_-]{0,99}$/;
const GEO = /^(EEA|[A-Z]{2})$/;
const DISPLAY_FORBIDDEN = /[\u0000-\u001f\u007f<>]/;
const RESERVED_ALIASES = new Set(['auto', 'default']);
const PRICE_KEYS = Object.freeze(['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h']);
const LIMIT_KEYS = Object.freeze(['rpm', 'rpd', 'tpm', 'tpd']);
const MICRO = 1_000_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const or = (value, fallback) => (value === undefined ? fallback : value);

// ── Canonical form ──

function normalizePrice(price) {
  if (price === undefined || price === null) return null;
  if (!isObject(price)) return price;
  const long = price.long === undefined || price.long === null ? null
    : isObject(price.long) ? { threshold: or(price.long.threshold, null), input: or(price.long.input, null), output: or(price.long.output, null) }
      : price.long;
  return { ...Object.fromEntries(PRICE_KEYS.map(key => [key, or(price[key], null)])), long };
}

function normalizePool(pool) {
  if (!isObject(pool)) return pool;
  const limits = isObject(pool.limits) ? pool.limits : {};
  return {
    tier: or(pool.tier, null), key_slot: or(pool.key_slot, null), price: normalizePrice(pool.price),
    limits: Object.fromEntries(LIMIT_KEYS.map(key => [key, or(limits[key], null)])),
    daily_spend_cap_microusd: or(pool.daily_spend_cap_microusd, null),
  };
}

const tierOrder = pool => (isObject(pool) && TIERS.includes(pool.tier) ? TIERS.indexOf(pool.tier) : TIERS.length);

// Fills defaults and orders pools free, paid. Never throws; invalid values are kept for validateSpec.
export function normalizeSpec(spec) {
  const s = isObject(spec) ? spec : {};
  const pools = Array.isArray(s.pools) ? s.pools.map(normalizePool).sort((a, b) => tierOrder(a) - tierOrder(b)) : or(s.pools, []);
  return {
    provider_type: or(s.provider_type, null), upstream_model: or(s.upstream_model, null), display_name: or(s.display_name, null),
    context_window: or(s.context_window, null), max_output_tokens: or(s.max_output_tokens, null),
    default_max_tokens: or(s.default_max_tokens, null), supports_tools: or(s.supports_tools, true),
    supports_vision: or(s.supports_vision, false), reasoning_efforts: or(s.reasoning_efforts, []),
    reasoning_effort_map: or(s.reasoning_effort_map, {}), default_reasoning_effort: or(s.default_reasoning_effort, null),
    aliases: or(s.aliases, []), geo_block_free: or(s.geo_block_free, []), auto_rank: or(s.auto_rank, null),
    position: or(s.position, 1000), default_enabled: or(s.default_enabled, true), pools,
  };
}

// Canonical JSON of a spec (sorted keys), or null when it holds a value JSON cannot carry.
export function canonicalSpec(spec) {
  try { return canonicalJson(normalizeSpec(spec)); } catch { return null; }
}

export function sameSpec(left, right) {
  const a = canonicalSpec(left);
  return a !== null && a === canonicalSpec(right);
}

// The spec of a zerox_catalog_snapshot / zerox_catalog_list row (its `spec` jsonb column).
export function specFromRow(row) {
  return normalizeSpec(row?.spec);
}

// ── Validation ──

function samePrice(price, list) {
  if (PRICE_KEYS.some(key => (price[key] ?? null) !== (list[key] ?? null))) return false;
  if (!price.long || !list.long) return !price.long && !list.long;
  return price.long.threshold === list.long.threshold && price.long.input === list.long.input &&
    price.long.output === list.long.output;
}

function priceShapeValid(price) {
  if (!isObject(price)) return false;
  if (PRICE_KEYS.some(key => price[key] !== null && !isInt(price[key], 0, MAX_PRICE_MICROUSD))) return false;
  if (price.long === null) return true;
  return isObject(price.long) && isInt(price.long.threshold, 1024, 10_000_000) &&
    isInt(price.long.input, 1, MAX_PRICE_MICROUSD) && isInt(price.long.output, 1, MAX_PRICE_MICROUSD);
}

// A free pool on a billed slot (catalog-types.js KEY_SLOTS `billed`): the model must be in
// BILLED_FREE_LIMITS and the pool must set every limit, none above the code ceiling.
function billedFreeReasons(typeId, spec, pool) {
  const ceiling = billedFreeLimits(typeId, spec.upstream_model);
  if (!ceiling) return ['free_pool_not_listed'];
  const reasons = [];
  if (LIMIT_KEYS.some(key => pool.limits[key] === null)) reasons.push('free_limits_required');
  if (LIMIT_KEYS.some(key => isInt(pool.limits[key], 0, 1e15) && (ceiling[key] === null || pool.limits[key] > ceiling[key]))) {
    reasons.push('free_limits_above_max');
  }
  return reasons;
}

function poolReasons(typeId, spec, pool, now) {
  const registry = PROVIDER_TYPES[typeId];
  const reasons = [];
  const { tier } = pool;
  if (!registry.slots[tier].length) reasons.push('tier_not_offered');
  if (!slotAllowed(typeId, tier, pool.key_slot)) reasons.push('key_slot_not_allowed');
  if (LIMIT_KEYS.some(key => pool.limits[key] !== null && !isInt(pool.limits[key], 0, 1e15))) reasons.push('limits_invalid');
  if (tier === 'free') {
    if (pool.price !== null || pool.daily_spend_cap_microusd !== null) reasons.push('free_pool_priced');
    if (slotBilled(pool.key_slot)) reasons.push(...billedFreeReasons(typeId, spec, pool));
    return reasons;
  }
  const price = pool.price;
  if (price === null) reasons.push('paid_without_price');
  else if (!priceShapeValid(price)) reasons.push('price_invalid');
  else if (!(price.input > 0) || !(price.output > 0)) reasons.push('paid_without_price');
  else {
    // Listed only, for every provider type: a model without a list price would be billed at
    // whatever the row declares, and its daily cap counts that declared price, not the upstream's.
    const list = upstreamAllowed(typeId, spec.upstream_model) ? listPriceMicro(typeId, spec.upstream_model, now) : null;
    if (!list) reasons.push('unlisted_paid_not_allowed');
    else if (!samePrice(price, list)) reasons.push('price_mismatch_list');
    if (registry.requires_cache_prices && (price.cache_read === null || price.cache_write === null)) reasons.push('cache_price_missing');
  }
  const cap = pool.daily_spend_cap_microusd;
  if (cap === null) reasons.push('cap_missing');
  else if (!isInt(cap, 1, Number.MAX_SAFE_INTEGER)) reasons.push('cap_invalid');
  else if (cap > typeMaxCapMicrousd(typeId)) reasons.push('cap_above_max');
  return reasons;
}

function aliasValid(typeId, id, alias) {
  if (typeof alias !== 'string' || !ALIAS.test(alias) || RESERVED_ALIASES.has(alias) || alias === id) return false;
  // An alias must not squat another provider type's id space.
  for (const [other, registry] of Object.entries(PROVIDER_TYPES)) {
    if (other === typeId) continue;
    if (registry.id_prefix ? alias.startsWith(registry.id_prefix) : upstreamAllowed(other, alias)) return false;
  }
  return true;
}

function effortsValid(spec) {
  const efforts = spec.reasoning_efforts;
  if (!Array.isArray(efforts) || efforts.length > REASONING_EFFORTS.length || new Set(efforts).size !== efforts.length ||
      efforts.some(value => !REASONING_EFFORTS.includes(value))) return false;
  const map = spec.reasoning_effort_map;
  if (!isObject(map)) return false;
  const entries = Object.entries(map);
  if (!efforts.length && (entries.length || spec.default_reasoning_effort !== null)) return false;
  if (entries.some(([key, value]) => !REASONING_EFFORTS.includes(key) || (value !== 'default' && !efforts.includes(value)))) return false;
  return spec.default_reasoning_effort === null || efforts.includes(spec.default_reasoning_effort);
}

/**
 * Checks a spec against the code bounds. `id` is the public id the row is stored under (null to
 * skip that check). Returns { id, model: reasons, pools: { free?: reasons, paid?: reasons } }:
 * a model-level reason keeps the whole model from serving, a pool-level reason only that pool.
 * `now` picks the list price in force (src/list-prices.js LIST_PRICE_SCHEDULE).
 */
export function validateSpec(id, spec, { now = Date.now() } = {}) {
  const s = normalizeSpec(spec);
  const model = [];
  const pools = {};
  const typeId = s.provider_type;
  const registry = providerType(typeId);
  const expected = registry ? publicIdFor(typeId, s.upstream_model) : null;
  if (!registry) model.push('unknown_provider_type');
  else if (!expected) model.push('upstream_pattern');
  else if (id !== null && id !== undefined && id !== expected) model.push('id_mismatch');
  if (typeof id === 'string' && !MODEL_ID.test(id)) model.push('id_invalid');
  if (typeof s.display_name !== 'string' || !s.display_name.trim() || s.display_name.length > 120 ||
      DISPLAY_FORBIDDEN.test(s.display_name)) model.push('display_name_invalid');
  if (!isInt(s.context_window, 1024, 10_000_000) || !isInt(s.max_output_tokens, 256, Math.min(1_000_000, s.context_window))) {
    model.push('context_invalid');
  }
  if (s.default_max_tokens !== null && !isInt(s.default_max_tokens, 256, isInt(s.max_output_tokens, 256, 1_000_000) ? s.max_output_tokens : 0)) {
    model.push('default_max_tokens_invalid');
  }
  if (typeof s.supports_tools !== 'boolean' || typeof s.supports_vision !== 'boolean' || typeof s.default_enabled !== 'boolean') {
    model.push('flags_invalid');
  }
  if (!effortsValid(s)) model.push('effort_invalid');
  if (!Array.isArray(s.aliases) || s.aliases.length > 8 || new Set(s.aliases).size !== s.aliases.length ||
      !s.aliases.every(alias => aliasValid(typeId, expected ?? id, alias))) model.push('alias_invalid');
  if (!Array.isArray(s.geo_block_free) || s.geo_block_free.length > 64 || !s.geo_block_free.every(code => typeof code === 'string' && GEO.test(code))) {
    model.push('geo_invalid');
  }
  if (s.auto_rank !== null && !isInt(s.auto_rank, 1, 1000)) model.push('auto_rank_invalid');
  if (!isInt(s.position, 0, 100_000)) model.push('position_invalid');
  if (!Array.isArray(s.pools) || !s.pools.length) model.push('no_pools');
  else if (s.pools.length > TIERS.length || s.pools.some(pool => !isObject(pool) || !TIERS.includes(pool.tier))) model.push('pools_invalid');
  else if (new Set(s.pools.map(pool => pool.tier)).size !== s.pools.length) model.push('duplicate_tier');
  else if (registry) {
    for (const pool of s.pools) pools[pool.tier] = poolReasons(typeId, s, pool, now);
  }
  return { id: expected, model, pools };
}

// Tiers whose pools failed validation.
export function droppedTiers(validation) {
  return Object.entries(validation.pools).filter(([, reasons]) => reasons.length).map(([tier]) => tier);
}

// True when the model and every one of its pools pass.
export function specValid(validation) {
  return !validation.model.length && !droppedTiers(validation).length;
}

// ── Spend caps ──

/**
 * The daily spend cap of a paid pool in upstream USD: the pool's own cap (code-catalog pools
 * without one get their type's paid_daily_cap_usd), clamped to the type maximum, the code maximum
 * and PAID_DAILY_SPEND_CAP_USD when that is set above 0. null means the pool has no usable cap
 * and must not serve (fail closed). zerox_reserve_v2 enforces it as p_pool.cpd (billed micro-USD,
 * billedDailyCapMicrousd).
 */
export function effectiveSpendCapUsd(env, entry, pool) {
  if (pool?.tier !== 'paid') return null;
  const registry = providerType(entry?.provider);
  if (!registry) return null;
  const own = Number(pool.daily_spend_cap_usd) > 0 ? Number(pool.daily_spend_cap_usd) : registry.paid_daily_cap_usd;
  const typeMax = typeMaxCapMicrousd(entry.provider) / MICRO;
  if (!(own > 0) || !(typeMax > 0)) return null;
  let cap = Math.min(own, typeMax, MAX_DAILY_SPEND_CAP_USD);
  const envCap = Number(env?.PAID_DAILY_SPEND_CAP_USD);
  if (Number.isFinite(envCap) && envCap > 0) cap = Math.min(cap, envCap);
  return cap;
}

// The same cap in billed micro-USD (what a day of the pool may charge users), or null.
export function billedDailyCapMicrousd(env, entry, pool) {
  const usd = effectiveSpendCapUsd(env, entry, pool);
  return usd === null ? null : Math.round(usd * MICRO * MARKUP);
}

// ── Entries ──

/**
 * The billed catalog price of a spec price (pricing.js shape): priceFromCost for input, output,
 * the long-context rate and the cache rates the provider has, marked up in src/pricing.js.
 */
export function priceFromSpec(price) {
  if (!price) return null;
  const usd = value => (value === null || value === undefined ? null : value / MICRO);
  const long = price.long ? { threshold: price.long.threshold, input: usd(price.long.input), output: usd(price.long.output) } : undefined;
  return priceFromCost(usd(price.input), usd(price.output), long,
    { read: usd(price.cache_read), write: usd(price.cache_write), write_1h: usd(price.cache_write_1h) });
}

function poolFromSpec(typeId, pool) {
  const registry = PROVIDER_TYPES[typeId];
  const limited = LIMIT_KEYS.some(key => pool.limits[key] !== null);
  const flag = registry.requires_flag[pool.tier];
  return Object.freeze({
    tier: pool.tier,
    ...poolSource(pool.key_slot),
    ...(limited ? { limits: Object.freeze({ ...pool.limits }) } : {}),
    ...(flag ? { requires_flag: flag } : {}),
    ...(pool.price ? { price: priceFromSpec(pool.price) } : {}),
    ...(pool.daily_spend_cap_microusd !== null ? { daily_spend_cap_usd: pool.daily_spend_cap_microusd / MICRO } : {}),
    key_slot: pool.key_slot,
  });
}

/**
 * A frozen catalog entry (src/catalog.js shape) for a validated spec. Adapter, hosting flag,
 * flag-gated pools, key sources and the free-pool geo block come from the provider type, never
 * from the row. `dropPools` lists tiers left out (pool-level validation failures).
 */
export function entryFromSpec(id, spec, { dropPools = [], source = 'database', revisionId = null } = {}) {
  const s = normalizeSpec(spec);
  const registry = PROVIDER_TYPES[s.provider_type];
  const pools = s.pools.filter(pool => !dropPools.includes(pool.tier)).map(pool => poolFromSpec(s.provider_type, pool));
  const geo = pools.some(pool => pool.tier === 'free')
    ? [...new Set([...registry.free_geo_block, ...s.geo_block_free])] : [...s.geo_block_free];
  return Object.freeze({
    id, display_name: s.display_name, provider: s.provider_type, upstream_model: s.upstream_model,
    context_window: s.context_window, max_output_tokens: s.max_output_tokens,
    supports_tools: s.supports_tools, supports_streaming: true, supports_vision: s.supports_vision,
    auto_rank: s.auto_rank, default_enabled: s.default_enabled, hosted_flag: registry.hosted_flag,
    geo_block_free: Object.freeze(geo), aliases: Object.freeze([...s.aliases]),
    reasoning_efforts: Object.freeze([...s.reasoning_efforts]), reasoning_effort_map: Object.freeze({ ...s.reasoning_effort_map }),
    ...(s.default_max_tokens !== null ? { default_max_tokens: s.default_max_tokens } : {}),
    ...(s.default_reasoning_effort !== null ? { default_reasoning_effort: s.default_reasoning_effort } : {}),
    pools: Object.freeze(pools), position: s.position, source, revision_id: revisionId,
  });
}

const usdToMicro = value => (value === null || value === undefined ? null : Math.round(value * MICRO));
const billedToMicro = value => (value === null || value === undefined ? null : Math.round(value / MARKUP));

// Upstream micro prices of a billed catalog price (inverse of priceFromSpec).
function priceToMicro(price) {
  const upstream = price.upstream_cost_usd_per_mtok || {};
  const component = key => (upstream[key] !== undefined && upstream[key] !== null ? usdToMicro(upstream[key])
    : billedToMicro(price[`${key}_microusd_per_mtok`]));
  const long = price.long_context;
  return {
    input: component('input'), output: component('output'), cache_read: component('cache_read'),
    cache_write: component('cache_write'), cache_write_1h: component('cache_write_1h'),
    long: long ? { threshold: long.threshold_tokens, input: billedToMicro(long.input_microusd_per_mtok),
      output: billedToMicro(long.output_microusd_per_mtok) } : null,
  };
}

function codeCapMicro(entry, pool) {
  if (pool.tier !== 'paid') return null;
  if (Number(pool.daily_spend_cap_usd) > 0) return usdToMicro(Number(pool.daily_spend_cap_usd));
  if (Number(pool.limits?.cpd) > 0) return billedToMicro(Number(pool.limits.cpd));
  const fallback = providerType(entry.provider)?.paid_daily_cap_usd;
  return fallback > 0 ? usdToMicro(fallback) : null;
}

// The spec of a code-catalog entry (src/catalog.js CATALOG). `position` applies when the entry
// carries none (catalog order x 10).
export function codeSpec(entry, { position = 1000 } = {}) {
  return normalizeSpec({
    provider_type: entry.provider, upstream_model: entry.upstream_model, display_name: entry.display_name,
    context_window: entry.context_window, max_output_tokens: entry.max_output_tokens,
    default_max_tokens: entry.default_max_tokens ?? null, supports_tools: entry.supports_tools,
    supports_vision: entry.supports_vision === true, reasoning_efforts: [...(entry.reasoning_efforts || [])],
    reasoning_effort_map: { ...(entry.reasoning_effort_map || {}) }, default_reasoning_effort: entry.default_reasoning_effort ?? null,
    aliases: [...(entry.aliases || [])], geo_block_free: [...(entry.geo_block_free || [])], auto_rank: entry.auto_rank ?? null,
    position: entry.position ?? position, default_enabled: entry.default_enabled !== false,
    pools: entry.pools.map(pool => ({
      tier: pool.tier, key_slot: pool.key_slot ?? slotForPool(entry.provider, pool.tier, pool),
      price: pool.price ? priceToMicro(pool.price) : null,
      limits: Object.fromEntries(LIMIT_KEYS.map(key => [key, pool.limits?.[key] ?? null])),
      daily_spend_cap_microusd: codeCapMicro(entry, pool),
    })),
  });
}

// ── Operator API form (USD decimals) ──

const API_KEYS = Object.freeze(['provider_type', 'upstream_model', 'display_name', 'context_window', 'max_output_tokens',
  'default_max_tokens', 'supports_tools', 'supports_vision', 'reasoning_efforts', 'reasoning_effort_map',
  'default_reasoning_effort', 'aliases', 'geo_block_free', 'auto_rank', 'position', 'default_enabled', 'pools']);
const API_POOL_KEYS = Object.freeze(['tier', 'key_slot', 'price', 'limits', 'daily_spend_cap_usd']);
const API_PRICE_KEYS = Object.freeze({
  input_usd_per_mtok: 'input', output_usd_per_mtok: 'output', cache_read_usd_per_mtok: 'cache_read',
  cache_write_usd_per_mtok: 'cache_write', cache_write_1h_usd_per_mtok: 'cache_write_1h',
});
const API_LONG_KEYS = Object.freeze({ threshold_tokens: 'threshold', input_usd_per_mtok: 'input', output_usd_per_mtok: 'output' });

function toMicro(value, path, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
    errors.push(`invalid_amount:${path}`);
    return null;
  }
  const micro = Math.round(value * MICRO);
  if (Math.abs(value * MICRO - micro) > 1e-3) {
    errors.push(`too_many_decimals:${path}`);
    return null;
  }
  return micro;
}

function unknownKeys(object, allowed, path, errors) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) errors.push(`unknown_field:${path}${key}`);
}

/**
 * The spec of an operator API body (USD per Mtok and USD per day, at most 6 decimals). Unknown
 * fields are errors, so nothing like a base_url or an env var name can ride along.
 * Returns { spec, errors }; a spec with errors must not be stored.
 */
export function specFromApi(body) {
  const errors = [];
  if (!isObject(body)) return { spec: null, errors: ['invalid_spec'] };
  unknownKeys(body, API_KEYS, '', errors);
  const pools = Array.isArray(body.pools) ? body.pools.map((pool, index) => {
    if (!isObject(pool)) { errors.push(`invalid_pool:${index}`); return pool; }
    const path = `pools.${pool.tier ?? index}.`;
    unknownKeys(pool, API_POOL_KEYS, path, errors);
    let price = null;
    if (pool.price !== undefined && pool.price !== null) {
      if (!isObject(pool.price)) errors.push(`invalid_price:${path}price`);
      else {
        unknownKeys(pool.price, [...Object.keys(API_PRICE_KEYS), 'long_context'], `${path}price.`, errors);
        price = Object.fromEntries(Object.entries(API_PRICE_KEYS)
          .map(([key, name]) => [name, toMicro(pool.price[key], `${path}price.${key}`, errors)]));
        const long = pool.price.long_context;
        if (long === undefined || long === null) price.long = null;
        else if (!isObject(long)) errors.push(`invalid_price:${path}price.long_context`);
        else {
          unknownKeys(long, Object.keys(API_LONG_KEYS), `${path}price.long_context.`, errors);
          price.long = { threshold: long.threshold_tokens ?? null,
            input: toMicro(long.input_usd_per_mtok, `${path}price.long_context.input_usd_per_mtok`, errors),
            output: toMicro(long.output_usd_per_mtok, `${path}price.long_context.output_usd_per_mtok`, errors) };
        }
      }
    }
    if (pool.limits !== undefined && pool.limits !== null) {
      if (!isObject(pool.limits)) errors.push(`invalid_limits:${path}limits`);
      else unknownKeys(pool.limits, LIMIT_KEYS, `${path}limits.`, errors);
    }
    return {
      tier: pool.tier, key_slot: pool.key_slot, price, limits: isObject(pool.limits) ? pool.limits : {},
      daily_spend_cap_microusd: toMicro(pool.daily_spend_cap_usd, `${path}daily_spend_cap_usd`, errors),
    };
  }) : body.pools;
  const { pools: _pools, ...rest } = body;
  return { spec: normalizeSpec({ ...rest, pools }), errors };
}

const toUsd = value => (value === null || value === undefined ? null : value / MICRO);

// The operator API form of a spec (inverse of specFromApi).
export function apiFromSpec(spec) {
  const s = normalizeSpec(spec);
  return {
    ...s,
    pools: (Array.isArray(s.pools) ? s.pools : []).map(pool => ({
      tier: pool.tier, key_slot: pool.key_slot,
      price: pool.price ? {
        ...Object.fromEntries(Object.entries(API_PRICE_KEYS).map(([key, name]) => [key, toUsd(pool.price[name])])),
        long_context: pool.price.long ? { threshold_tokens: pool.price.long.threshold, input_usd_per_mtok: toUsd(pool.price.long.input),
          output_usd_per_mtok: toUsd(pool.price.long.output) } : null,
      } : null,
      limits: { ...pool.limits },
      daily_spend_cap_usd: toUsd(pool.daily_spend_cap_microusd),
    })),
  };
}

// ── Diffs ──

const RISKY_FLAGS = new Set(['price_up', 'price_down', 'price_added', 'cap_up', 'slot_changed', 'auto_rank_changed']);

function compareFlag(from, to, up, down) {
  if (from === null || from === undefined) return to === null || to === undefined ? null : `${up.split('_')[0]}_added`;
  if (to === null || to === undefined) return `${up.split('_')[0]}_removed`;
  return to > from ? up : to < from ? down : null;
}

/**
 * Field-by-field changes from `before` (null for a new model) to `after`, in operator units
 * (USD). Each item: { path, from, to, flag, billed? }. Prices carry the billed (marked-up) values.
 */
export function specDiff(before, after) {
  const next = normalizeSpec(after);
  const items = [];
  if (!before) {
    items.push({ path: 'model', from: null, to: `${next.provider_type}:${next.upstream_model}`, flag: 'new_model' });
    for (const pool of Array.isArray(next.pools) ? next.pools : []) {
      items.push({ path: `pools.${pool.tier}`, from: null, to: pool.key_slot, flag: 'tier_added' });
    }
    return items;
  }
  const prev = normalizeSpec(before);
  for (const key of API_KEYS.filter(name => name !== 'pools')) {
    const from = prev[key];
    const to = next[key];
    if (canonicalJson(from ?? null) === canonicalJson(to ?? null)) continue;
    items.push({ path: key, from, to, flag: key === 'auto_rank' ? 'auto_rank_changed' : 'changed' });
  }
  const byTier = list => new Map((Array.isArray(list) ? list : []).filter(isObject).map(pool => [pool.tier, pool]));
  const oldPools = byTier(prev.pools);
  const newPools = byTier(next.pools);
  for (const tier of TIERS) {
    const a = oldPools.get(tier);
    const b = newPools.get(tier);
    if (!a && !b) continue;
    if (!a) { items.push({ path: `pools.${tier}`, from: null, to: b.key_slot, flag: 'tier_added' }); continue; }
    if (!b) { items.push({ path: `pools.${tier}`, from: a.key_slot, to: null, flag: 'tier_removed' }); continue; }
    if (a.key_slot !== b.key_slot) items.push({ path: `pools.${tier}.key_slot`, from: a.key_slot, to: b.key_slot, flag: 'slot_changed' });
    for (const [apiKey, name] of Object.entries(API_PRICE_KEYS)) {
      const from = toUsd(a.price?.[name] ?? null);
      const to = toUsd(b.price?.[name] ?? null);
      if (from === to) continue;
      items.push({ path: `pools.${tier}.price.${apiKey}`, from, to, flag: compareFlag(from, to, 'price_up', 'price_down'),
        billed: { from: from === null ? null : from * MARKUP, to: to === null ? null : to * MARKUP } });
    }
    if (canonicalJson(a.price?.long ?? null) !== canonicalJson(b.price?.long ?? null)) {
      items.push({ path: `pools.${tier}.price.long_context`, from: a.price?.long ?? null, to: b.price?.long ?? null, flag: 'price_up' });
    }
    for (const key of LIMIT_KEYS) {
      if ((a.limits[key] ?? null) !== (b.limits[key] ?? null)) {
        items.push({ path: `pools.${tier}.limits.${key}`, from: a.limits[key], to: b.limits[key], flag: 'changed' });
      }
    }
    const capFrom = toUsd(a.daily_spend_cap_microusd);
    const capTo = toUsd(b.daily_spend_cap_microusd);
    if (capFrom !== capTo) {
      items.push({ path: `pools.${tier}.daily_spend_cap_usd`, from: capFrom, to: capTo,
        flag: compareFlag(capFrom, capTo, 'cap_up', 'cap_down') === 'cap_added' ? 'cap_up' : compareFlag(capFrom, capTo, 'cap_up', 'cap_down') });
    }
  }
  return items;
}

// Diff items that need the operator to type the model id when approving: price changes, a higher
// cap, a new key slot, a new paid pool, a new auto rank.
export function riskyChanges(diff) {
  return diff.filter(item => RISKY_FLAGS.has(item.flag) || (item.flag === 'tier_added' && item.path === 'pools.paid'));
}

// The public price block a spec's paid pool would show on /v1/models (pricing.js publicPricing,
// cache rates included when the provider has them).
export function publicSpecPricing(spec) {
  const paid = (normalizeSpec(spec).pools || []).find(pool => isObject(pool) && pool.tier === 'paid' && pool.price);
  return paid ? publicPricing(priceFromSpec(paid.price)) : null;
}
