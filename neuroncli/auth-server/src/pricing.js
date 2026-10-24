// Token estimation and credit pricing (docs/PLATFORM_CONTRACT.md §1-§2).
// Credits are micro-USD (1 USD = 1_000_000). Catalog prices are the upstream
// list price multiplied by MARKUP, expressed per million tokens.

export const MARKUP = 1.25;
const MICRO = 1_000_000;
const encoder = new TextEncoder();

function microusd(usdPerMtok) {
  return Math.round(usdPerMtok * MICRO * MARKUP);
}

// Builds a catalog price from upstream USD-per-million-token costs. `longContext`
// describes providers that charge a higher rate above a prompt-size threshold.
export function priceFromCost(inputUsd, outputUsd, longContext) {
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
  return Object.freeze(price);
}

function rateFor(price, promptTokens) {
  const long = price.long_context;
  return long && promptTokens > long.threshold_tokens ? long : price;
}

export function costMicrousd(price, promptTokens, completionTokens) {
  if (!price) return 0;
  const rate = rateFor(price, promptTokens);
  const prompt = Math.max(0, Math.ceil(Number(promptTokens) || 0));
  const completion = Math.max(0, Math.ceil(Number(completionTokens) || 0));
  return Math.ceil((prompt * rate.input_microusd_per_mtok + completion * rate.output_microusd_per_mtok) / MICRO);
}

export function publicPricing(price) {
  if (!price) return null;
  return {
    input_per_mtok_usd: price.input_microusd_per_mtok / MICRO,
    output_per_mtok_usd: price.output_microusd_per_mtok / MICRO,
  };
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

// Converts upstream usage into billable prompt/completion tokens. Providers that hide
// reasoning tokens (Gemini) report them only in total_tokens, so any surplus of the
// total over prompt+completion is billed as completion (output) tokens.
export function billableUsage(usage, fallback = {}) {
  const prompt = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const total = count(usage?.total_tokens);
  if (prompt === null && completion === null && total === null) {
    const promptTokens = count(fallback.prompt_tokens) ?? 0;
    const completionTokens = count(fallback.completion_tokens) ?? 0;
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens, estimated: true };
  }
  let promptTokens;
  if (prompt !== null) promptTokens = prompt;
  else if (total !== null) {
    promptTokens = completion !== null ? Math.max(0, total - completion) : Math.min(total, count(fallback.prompt_tokens) ?? 0);
  } else promptTokens = count(fallback.prompt_tokens) ?? 0;
  let completionTokens = completion ?? (total !== null ? Math.max(0, total - promptTokens) : 0);
  if (total !== null && total > promptTokens + completionTokens) completionTokens = total - promptTokens;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens, estimated: false };
}
