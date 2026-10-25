// Token estimation and credit pricing (docs/PLATFORM_CONTRACT.md §1-§2).
// Credits are micro-USD (1 USD = 1_000_000). Catalog prices are the upstream
// list price multiplied by MARKUP, expressed per million tokens. The upstream list prices
// themselves are one table, src/list-prices.js, re-exported here.

export const MARKUP = 1.25;
const MICRO = 1_000_000;
const encoder = new TextEncoder();

export { LIST_PRICES, LIST_PRICE_SCHEDULE, listPriceFor, listPriceMicro, MAX_DAILY_SPEND_CAP_USD } from './list-prices.js';

function microusd(usdPerMtok) {
  return Math.round(usdPerMtok * MICRO * MARKUP);
}

const CACHE_RATES = Object.freeze([['read', 'cache_read'], ['write', 'cache_write'], ['write_1h', 'cache_write_1h']]);

// Builds a catalog price from upstream USD-per-million-token costs. `longContext`
// describes providers that charge a higher rate above a prompt-size threshold. `cache`
// ({ read, write, write_1h }) adds prompt-cache rates (Claude: reads, 5-minute writes and
// 1-hour writes), marked up like every other rate; prices without them bill cache tokens at
// the input rate.
export function priceFromCost(inputUsd, outputUsd, longContext, cache) {
  const price = {
    input_microusd_per_mtok: microusd(inputUsd),
    output_microusd_per_mtok: microusd(outputUsd),
    upstream_cost_usd_per_mtok: { input: inputUsd, output: outputUsd },
  };
  if (longContext) {
    price.long_context = {
      threshold_tokens: longContext.threshold,
      input_microusd_per_mtok: microusd(longContext.input),
      output_microusd_per_mtok: microusd(longContext.output),
    };
  }
  for (const [key, name] of CACHE_RATES) {
    const usd = cache?.[key];
    if (usd === undefined || usd === null) continue;
    price[`${name}_microusd_per_mtok`] = microusd(usd);
    price.upstream_cost_usd_per_mtok[name] = usd;
  }
  Object.freeze(price.upstream_cost_usd_per_mtok);
  return Object.freeze(price);
}

// The catalog price of a src/list-prices.js row (USD per Mtok, cache rates included).
export function priceFromList(listPrice) {
  if (!listPrice) return null;
  return priceFromCost(listPrice.input, listPrice.output, listPrice.long_context ?? undefined,
    { read: listPrice.cache_read, write: listPrice.cache_write, write_1h: listPrice.cache_write_1h });
}

// A daily spend cap in upstream USD as the billed micro-USD a pool may charge users in a UTC day
// (zerox_reserve_v2 p_pool.cpd): $10 -> 12,500,000.
export function dailyCapMicrousd(upstreamUsdPerDay) {
  return microusd(upstreamUsdPerDay);
}

function rateFor(price, promptTokens) {
  const long = price.long_context;
  return long && promptTokens > long.threshold_tokens ? long : price;
}

const whole = value => Math.max(0, Math.ceil(Number(value) || 0));

/**
 * Settled cost in billed micro-USD. `cache` ({ cache_read_tokens, cache_write_tokens,
 * cache_write_1h_tokens }, as billableUsage returns them) splits the prompt: each part is billed
 * at its own rate, the rest as plain input. A price without cache rates bills cache tokens at its
 * input rate, so pools without them cost exactly what they did before.
 */
export function costMicrousd(price, promptTokens, completionTokens, cache = {}) {
  if (!price) return 0;
  const rate = rateFor(price, promptTokens);
  const prompt = whole(promptTokens);
  const completion = whole(completionTokens);
  const read = Math.min(prompt, whole(cache?.cache_read_tokens));
  const write = Math.min(prompt - read, whole(cache?.cache_write_tokens));
  const write1h = Math.min(prompt - read - write, whole(cache?.cache_write_1h_tokens));
  const plain = prompt - read - write - write1h;
  const readRate = price.cache_read_microusd_per_mtok ?? rate.input_microusd_per_mtok;
  const writeRate = price.cache_write_microusd_per_mtok ?? rate.input_microusd_per_mtok;
  const write1hRate = price.cache_write_1h_microusd_per_mtok ?? writeRate;
  return Math.ceil((plain * rate.input_microusd_per_mtok + read * readRate + write * writeRate +
    write1h * write1hRate + completion * rate.output_microusd_per_mtok) / MICRO);
}

/**
 * The credit hold of a paid attempt: every prompt token at the highest rate a prompt token can
 * cost through the gateway (the input rate, or the 5-minute cache-write rate when the provider
 * has one; the adapter never asks for 1-hour writes) plus all of max_tokens at the output rate.
 * For prices without cache rates this equals costMicrousd(price, prompt, maxTokens).
 */
export function reserveCostMicrousd(price, promptTokens, maxTokens) {
  if (!price) return 0;
  const rate = rateFor(price, promptTokens);
  const promptRate = Math.max(rate.input_microusd_per_mtok, price.cache_write_microusd_per_mtok ?? 0);
  return Math.ceil((whole(promptTokens) * promptRate + whole(maxTokens) * rate.output_microusd_per_mtok) / MICRO);
}

// The price block of GET /v1/models: input and output, plus cache read and write rates when the
// provider has them (Claude).
export function publicPricing(price) {
  if (!price) return null;
  const pricing = {
    input_per_mtok_usd: price.input_microusd_per_mtok / MICRO,
    output_per_mtok_usd: price.output_microusd_per_mtok / MICRO,
  };
  if (price.cache_read_microusd_per_mtok !== undefined) pricing.cache_read_per_mtok_usd = price.cache_read_microusd_per_mtok / MICRO;
  if (price.cache_write_microusd_per_mtok !== undefined) pricing.cache_write_per_mtok_usd = price.cache_write_microusd_per_mtok / MICRO;
  return pricing;
}

export function utf8Bytes(value) {
  if (value === undefined || value === null) return 0;
  return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

// Conservative pre-flight estimate: UTF-8 bytes / 3.5 for the conversation plus the
// serialized tool schemas (which every provider injects into the prompt).
export function estimatePromptTokens(messages, tools) {
  const messageTokens = Math.ceil(utf8Bytes(messages ?? []) / 3.5);
  const toolTokens = Array.isArray(tools) && tools.length ? Math.ceil(utf8Bytes(tools) / 3.5) : 0;
  return Math.max(1, messageTokens + toolTokens);
}

export function estimateOutputTokens(bytes) {
  return Math.ceil(Math.max(0, Number(bytes) || 0) / 3.5);
}

const count = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : null;
};

// The prompt-cache split of `usage` (prompt_tokens_details: cached_tokens are cache reads,
// cache_write_tokens 5-minute writes, cache_write_1h_tokens 1-hour writes; Claude reports all
// three, OpenAI-compatible providers at most cached_tokens), each clamped so that together they
// never exceed the prompt.
function cacheSplit(usage, promptTokens) {
  const details = usage?.prompt_tokens_details;
  const read = Math.min(promptTokens, count(details?.cached_tokens) ?? 0);
  const write = Math.min(promptTokens - read, count(details?.cache_write_tokens) ?? 0);
  const write1h = Math.min(promptTokens - read - write, count(details?.cache_write_1h_tokens) ?? 0);
  return { cache_read_tokens: read, cache_write_tokens: write, cache_write_1h_tokens: write1h };
}

const NO_CACHE = Object.freeze({ cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 });

// Converts upstream usage into billable prompt/completion tokens. Providers that hide
// reasoning tokens (Gemini) report them only in total_tokens, so any surplus of the
// total over prompt+completion is billed as completion (output) tokens. The prompt-cache split
// comes along (all 0 for an estimate).
export function billableUsage(usage, fallback = {}) {
  const prompt = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const total = count(usage?.total_tokens);
  if (prompt === null && completion === null && total === null) {
    const promptTokens = count(fallback.prompt_tokens) ?? 0;
    const completionTokens = count(fallback.completion_tokens) ?? 0;
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens, estimated: true, ...NO_CACHE };
  }
  let promptTokens;
  if (prompt !== null) promptTokens = prompt;
  else if (total !== null) {
    promptTokens = completion !== null ? Math.max(0, total - completion) : Math.min(total, count(fallback.prompt_tokens) ?? 0);
  } else promptTokens = count(fallback.prompt_tokens) ?? 0;
  let completionTokens = completion ?? (total !== null ? Math.max(0, total - promptTokens) : 0);
  if (total !== null && total > promptTokens + completionTokens) completionTokens = total - promptTokens;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens, estimated: false, ...cacheSplit(usage, promptTokens) };
}
