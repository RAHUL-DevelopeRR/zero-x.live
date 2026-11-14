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
//    the provider's prompt_tokens minus the conversation read at MESSAGE_SPARSE_BYTES_PER_TOKEN.
//    That reading is an assumption, not a bound: a conversation sparser than 4.5 bytes a token
//    (long prose, indented code, whitespace, a base64 image) makes the tool share read too low.
//    Three rules keep a sample like that from lowering what later requests hold:
//    a. Only samples whose tools outweigh the conversation (tool base >= conversation base, as on
//       a first turn) teach, and only when the tool share is positive: the sparse reading then
//       moves the sample by little. A long or image-bearing conversation teaches nothing.
//    b. The ratio is the highest sample of the current and the previous LEARNING_WINDOW_MS. A
//       lower sample never lowers it while a higher one is that recent, so a request the provider
//       counted is held at least at that count (its tool share x 1.15 plus its conversation at
//       3.5 bytes a token, above the 4.5 the share was read at; tools denser than the base are capped
//       at it) whatever samples follow it.
//       A sample above the ratio is taken at once. The ratio only falls once a window passes
//       with no higher sample (a model whose tools really got cheaper).
//    c. CALIBRATION_FLOOR (0.85 of the tool base, tools at 4.7 bytes a token) is the backstop for
//       a ratio taught only by unusual or adversarial samples (sparse descriptions, many dummy
//       tools). On 2026-11-13 Neuron's tool schemas, about 15.7 KB, cost 2,947 tokens on Groq (5.3
//       bytes a token, 0.75 of the base): the floor holds them 13 % above that, and the incident
//       first turn at 4,728 tokens or more against the 4,025 Groq counted. The learned hold for
//       that turn (0.75 x 1.15 = 0.86 of the base) sits just above the floor.
//    One ratio serves the free and the paid pools of a model: they meter the same tokenizer, and
//    since no sample can lower a recent higher one, paid traffic cannot lower the free pool's hold.
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
export const CALIBRATION_FLOOR = 0.85;
// Tool schemas below this many base tokens are dominated by per-request framing: not learned from.
export const MIN_SAMPLE_TOKENS = 256;
// The ratio is the highest sample of this window and the one before it (rule 2b above).
export const LEARNING_WINDOW_MS = 10 * 60_000;
const MAX_MODELS = 500;
const ratios = new Map(); // calibration key -> { ratio, peak, previous, windowStart, samples, at }

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
  const { messages, tools, messageBytes } = parts(base);
  const real = Number(actual);
  if (!key || tools < MIN_SAMPLE_TOKENS || tools < messages || !Number.isFinite(real) || real <= 0) return null;
  const toolShare = real - messageBytes / MESSAGE_SPARSE_BYTES_PER_TOKEN;
  if (toolShare <= 0) return null;
  const sample = Math.min(4, toolShare / tools);
  const previous = ratios.get(key);
  let peak = sample;
  let earlier = 0;
  let windowStart = now;
  if (previous) {
    const elapsed = Math.max(0, now - previous.windowStart); // a clock step back stays in the window
    if (elapsed < LEARNING_WINDOW_MS) {
      peak = Math.max(previous.peak, sample);
      earlier = previous.previous;
      windowStart = previous.windowStart;
    } else if (elapsed < 2 * LEARNING_WINDOW_MS) {
      earlier = previous.peak;
    }
  }
  if (!previous && ratios.size >= MAX_MODELS) ratios.delete(ratios.keys().next().value);
  const state = Object.freeze({ ratio: Math.max(peak, earlier), peak, previous: earlier, windowStart,
    samples: (previous?.samples ?? 0) + 1, at: now });
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
