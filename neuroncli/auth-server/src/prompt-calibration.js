// The prompt tokens a reservation holds against shared pool budgets (zerox_reserve_v2 p_tokens).
//
// pricing.js estimatePromptTokens (UTF-8 bytes / 3.5) is a ceiling: it decides whether a prompt fits
// a model's context window and how many credits a paid attempt holds, and it stays as it is. For
// the pool budgets it was too high: on 2026-11-13 Neuron's first turn on GPT-OSS 120B (Groq free
// pool, 8,000 tokens per minute) was 20,587 request bytes, estimated at 5,882 prompt tokens, while
// Groq counted 4,025 (the byte estimate was 46 % high). The reservation held 6,906 tokens of the
// minute and the next turn, 10 s later, was refused for 44 s.
//
// Only the tool schemas are discounted. The conversation is always held at its byte estimate (3.5
// bytes a token), because its density changes from request to request (English prose, code,
// non-English text) and a ratio learned from one kind would under-hold the next: a tools-free
// request is never held below its byte estimate, whatever the model learned before. Tool schemas
// are JSON whose density barely moves between requests (Neuron sends the same set every turn):
// 1. budgetPromptBase counts them at TOOL_BYTES_PER_TOKEN (4) instead of 3.5.
// 2. Each upstream model learns how many prompt tokens its tool schemas really cost per base token
//    (notePromptUsage) and holds tool base x ratio x CALIBRATION_MARGIN (15 % above), never more
//    than the tool base and never less than CALIBRATION_FLOOR of it. The tool share of a sample is
//    the provider's prompt_tokens minus the conversation read as sparse as it can plausibly be
//    (MESSAGE_SPARSE_BYTES_PER_TOKEN), so it never under-reads what the tools cost. A sample above
//    the current ratio is taken at once (denser tools are never under-held twice); lower samples
//    move it a fifth of the way, so one unusual request cannot drop the hold.
// Settlement still replaces the hold with the provider's real usage, so a calibrated hold never
// changes what a request counts; it only stops an estimate from refusing requests that fit.
// Only the provider's own count teaches (chat-handler.js skips usage the gateway synthesized).
// The state is per process (per isolate on Workers): a fresh process starts from the base.

import { utf8Bytes } from './pricing.js';

export const MESSAGE_BYTES_PER_TOKEN = 3.5;
// The sparsest a conversation plausibly tokenizes (plain English on the catalog's tokenizers).
export const MESSAGE_SPARSE_BYTES_PER_TOKEN = 4.5;
export const TOOL_BYTES_PER_TOKEN = 4;
export const CALIBRATION_MARGIN = 1.15;
export const CALIBRATION_FLOOR = 0.5;
// Tool schemas below this many base tokens are dominated by per-request framing: not learned from.
export const MIN_SAMPLE_TOKENS = 256;
const DECAY = 0.2;
const MAX_MODELS = 500;
const ratios = new Map(); // calibration key -> { ratio, samples, at }

const whole = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : 0;
};

// The two parts of the prompt a pool hold is built from: { messages, tools, messageBytes } in
// tokens (messages at 3.5 bytes a token, tools at 4), plus `total`.
export function budgetPromptBase(messages, tools) {
  const messageBytes = utf8Bytes(messages ?? []);
  const messageTokens = Math.ceil(messageBytes / MESSAGE_BYTES_PER_TOKEN);
  const toolTokens = Array.isArray(tools) && tools.length ? Math.ceil(utf8Bytes(tools) / TOOL_BYTES_PER_TOKEN) : 0;
  return Object.freeze({ messages: messageTokens, tools: toolTokens, messageBytes, total: Math.max(1, messageTokens + toolTokens) });
}

// A bare number is read as conversation tokens only (nothing to discount).
function parts(base) {
  if (base && typeof base === 'object') {
    const messages = whole(base.messages);
    return { messages, tools: whole(base.tools),
      messageBytes: whole(base.messageBytes) || Math.ceil(messages * MESSAGE_BYTES_PER_TOKEN) };
  }
  const messages = Math.max(1, whole(base));
  return { messages, tools: 0, messageBytes: Math.ceil(messages * MESSAGE_BYTES_PER_TOKEN) };
}

// One tokenizer per upstream model and provider (a provider may add its own framing tokens).
export function calibrationKey(entry) {
  return entry ? `${entry.provider}:${entry.upstream_model}` : null;
}

// Learns from one settled attempt: `base` is budgetPromptBase of the request, `actual` the prompt
// tokens the provider reported (cached input included). Estimated usage must not be passed.
export function notePromptUsage(key, base, actual, now = Date.now()) {
  const { tools, messageBytes } = parts(base);
  const real = Number(actual);
  if (!key || tools < MIN_SAMPLE_TOKENS || !Number.isFinite(real) || real <= 0) return null;
  const toolShare = real - messageBytes / MESSAGE_SPARSE_BYTES_PER_TOKEN;
  const sample = Math.min(4, Math.max(0.05, toolShare / tools));
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

// The prompt tokens to reserve for `base` on the model behind `key`: the conversation at its byte
// estimate plus the calibrated tool share. `ceiling` (the context and credit estimate) is never
// exceeded.
export function budgetPromptTokens(key, base, ceiling = Infinity) {
  const { messages, tools } = parts(base);
  const state = key && tools ? ratios.get(key) : null;
  const factor = state ? Math.min(1, Math.max(CALIBRATION_FLOOR, state.ratio * CALIBRATION_MARGIN)) : 1;
  return Math.max(1, Math.min(Number(ceiling) || Infinity, messages + Math.ceil(tools * factor)));
}

// Test hook.
export function resetPromptCalibration() {
  ratios.clear();
}
