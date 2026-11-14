// The prompt tokens a reservation holds against shared pool budgets (zerox_reserve_v2 p_tokens).
//
// pricing.js estimatePromptTokens (UTF-8 bytes / 3.5) is a ceiling: it decides whether a prompt fits
// a model's context window and how many credits a paid attempt holds, and it stays as it is. For
// the pool budgets it was too high: on 2026-11-13 Neuron's first turn on GPT-OSS 120B (Groq free
// pool, 8,000 tokens per minute) was 20,587 request bytes, estimated at 5,882 prompt tokens, while
// Groq counted 4,025 (the byte estimate was 46 % high). The reservation held 6,906 tokens of the
// minute and the next turn, 10 s later, was refused for 44 s.
//
// Two corrections, both only ever lower the hold toward the provider's own count:
// 1. Tool schemas are JSON, which tokenizes at about 4 or more bytes per token on every catalog
//    tokenizer: budgetPromptBase counts them at TOOL_BYTES_PER_TOKEN (4) instead of 3.5. The
//    conversation stays at 3.5 (code and non-English text tokenize denser).
// 2. Each upstream model learns the ratio of the provider's prompt_tokens to that base from its
//    settled attempts (notePromptUsage) and holds base x ratio x CALIBRATION_MARGIN (15 % above the
//    observed count), never more than the base and never less than CALIBRATION_FLOOR of it. A
//    sample above the current ratio is taken at once (a denser prompt is never under-held twice);
//    lower samples move it a fifth of the way, so one unusual prompt cannot drop the hold.
// Settlement still replaces the hold with the provider's real usage, so a calibrated hold never
// changes what a request counts; it only stops an estimate from refusing requests that fit.
// The state is per process (per isolate on Workers): a fresh process starts from the base.

import { utf8Bytes } from './pricing.js';

export const MESSAGE_BYTES_PER_TOKEN = 3.5;
export const TOOL_BYTES_PER_TOKEN = 4;
export const CALIBRATION_MARGIN = 1.15;
export const CALIBRATION_FLOOR = 0.5;
// Prompts below this many base tokens are dominated by per-message overhead: not learned from.
export const MIN_SAMPLE_TOKENS = 256;
const DECAY = 0.2;
const MAX_MODELS = 500;
const ratios = new Map(); // calibration key -> { ratio, samples, at }

export function budgetPromptBase(messages, tools) {
  const messageTokens = Math.ceil(utf8Bytes(messages ?? []) / MESSAGE_BYTES_PER_TOKEN);
  const toolTokens = Array.isArray(tools) && tools.length ? Math.ceil(utf8Bytes(tools) / TOOL_BYTES_PER_TOKEN) : 0;
  return Math.max(1, messageTokens + toolTokens);
}

// One tokenizer per upstream model and provider (a provider may add its own framing tokens).
export function calibrationKey(entry) {
  return entry ? `${entry.provider}:${entry.upstream_model}` : null;
}

// Learns from one settled attempt: `base` is budgetPromptBase of the request, `actual` the prompt
// tokens the provider reported (cached input included). Estimated usage must not be passed.
export function notePromptUsage(key, base, actual, now = Date.now()) {
  const estimate = Number(base);
  const real = Number(actual);
  if (!key || !Number.isFinite(estimate) || estimate < MIN_SAMPLE_TOKENS || !Number.isFinite(real) || real <= 0) return null;
  const sample = Math.min(4, Math.max(0.05, real / estimate));
  const previous = ratios.get(key);
  const ratio = !previous || sample >= previous.ratio ? sample : previous.ratio + DECAY * (sample - previous.ratio);
  if (!previous && ratios.size >= MAX_MODELS) ratios.delete(ratios.keys().next().value);
  const state = { ratio, samples: (previous?.samples ?? 0) + 1, at: now };
  ratios.set(key, state);
  return state;
}

export function promptCalibration(key) {
  return ratios.get(key) ?? null;
}

// The prompt tokens to reserve for `base` on the model behind `key`; `ceiling` (the context and
// credit estimate) is never exceeded.
export function budgetPromptTokens(key, base, ceiling = Infinity) {
  const value = Math.max(1, Math.ceil(Number(base) || 1));
  const state = key ? ratios.get(key) : null;
  const factor = state ? Math.min(1, Math.max(CALIBRATION_FLOOR, state.ratio * CALIBRATION_MARGIN)) : 1;
  return Math.max(1, Math.min(Number(ceiling) || Infinity, Math.ceil(value * factor)));
}

// Test hook.
export function resetPromptCalibration() {
  ratios.clear();
}
