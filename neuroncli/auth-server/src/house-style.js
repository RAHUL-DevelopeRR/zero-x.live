// The Zero-X house style: one short, fixed preface that the gateway puts at the start of the
// system prompt of coding-agent requests (docs.html#house-style, docs/HOUSE_STYLE.md).
//
// Everything here is pure: no I/O, no clock, no randomness, so every rule is unit-testable
// (check-house-style.mjs) and the Worker and the Node server decide the same way.
//
//   - The text is a compile-time constant. Nothing from a request (header, body, user) is ever
//     interpolated into it, and it never varies by model or time, so it is byte-identical in
//     every request and provider prompt caching of what follows it is never broken.
//   - It is a default, not a control: its first sentence says the user's, the project's and any
//     later system instruction win.
//   - It is added once per request, after secret scrubbing (src/oiop/scrub.js) and before the
//     provider adapters build their payload (chat-handler.js attempt()).
//   - It is not charged to the user (creditPreface, capacity.js settlementArgs). The shared pool
//     counters are settled from the same figure, so they run about HOUSE_STYLE_TOKENS below what the
//     provider metered per styled request (docs/HOUSE_STYLE.md, Shared pool budgets drift).
//
// The three sections follow the ideas of the public Ponytail (economy), gstack (build
// discipline) and anti-slop UI design (design taste) projects, in Zero-X's own words (NOTICE).

export const HOUSE_STYLE_VERSION = 'v1';

// Changing a word is a release: bump HOUSE_STYLE_VERSION, update docs.html (the check compares
// the two) and expect one prompt-cache miss per conversation. Plain ASCII, LF line ends.
export const HOUSE_STYLE_TEXT = [
  "Zero-X house style v1. Defaults only: anything the user, the project (AGENTS.md, rules files) or a later system message says overrides them.",
  "",
  "Economy",
  "- Use the fewest words and the least correct code. Before adding code or a dependency, check whether the platform, the language's library or this codebase already covers the need, and whether it is a need at all.",
  "- Read the code you will change first. Fix the cause with the smallest diff. Add no layers, settings or packages nobody asked for.",
  "- No filler, no repeating the question. Close with a few lines: the change, anything left out, how to check it.",
  "",
  "Build discipline",
  "- Work in small steps and verify each: run the tests or build when possible; add a small test for new logic. Report only results you checked.",
  "- Shortening must never remove handling of untrusted input, protection against data loss, security or accessibility.",
  "- Leave unrelated code alone. Never make up APIs, paths or facts; say when unsure.",
  "",
  "Design taste (UI work)",
  "- Settle on one design direction for the product and its audience before coding, then follow it and the repo's design system.",
  "- Avoid the stock AI page look: a gradient hero, three matching feature cards, made-up testimonials or figures, an eyebrow label over every heading.",
  "- Every control must work. Readable text, visible focus, layouts that hold from phone width up. Real content, no lorem ipsum.",
].join("\n");

export const HOUSE_STYLE_BYTES = new TextEncoder().encode(HOUSE_STYLE_TEXT).byteLength;
// Providers do not tell the gateway how many prompt tokens the preface took. Four bytes a token is
// the usual figure for English prose; it is an estimate used only to leave the preface out of
// what a user is charged and to keep it inside a model's context window.
export const HOUSE_STYLE_TOKENS = Math.ceil(HOUSE_STYLE_BYTES / 4);

// The request header, and the response header that says what was done. Request values:
//   off     the caller does not want the preface (the per-request opt-out);
//   client  the caller is a client that already applies its own house style (Neuron's bundled
//           skills), so the gateway never pays for the same rules twice;
//   anything else, or no header: the default rules.
// Response: HOUSE_STYLE_VERSION when the preface was added, absent otherwise.
export const STYLE_HEADER = 'x-neuron-style';
export const STYLE_HEADER_OFF = 'off';
export const STYLE_HEADER_CLIENT = 'client';

// A system message that carries one of these already has a house style, ours (a request that came
// through another Zero-X gateway), the Neuron client's marker line, or the rules that Neuron
// builds with bundled skills send in every system prompt (both labels together).
export const MARKER_TEXTS = Object.freeze(['Zero-X house style', 'Neuron house style']);
export const LEGACY_CLIENT_LABELS = Object.freeze(['Ponytail:', 'AntiSlop:']);

// Requests asking for at most this many tokens are title, summary and classifier calls.
export const TINY_MAX_TOKENS = 256;

export const STYLE_MODES = Object.freeze(['auto', 'on', 'off']);

// HOUSE_STYLE: auto (default) applies to eligible requests inside HOUSE_STYLE_PERCENT; on ignores
// the percentage; off is the operator's kill switch. Unknown values mean auto.
export function houseStyleMode(env) {
  const mode = String(env?.HOUSE_STYLE ?? 'auto').trim().toLowerCase();
  return STYLE_MODES.includes(mode) ? mode : 'auto';
}

// HOUSE_STYLE_PERCENT: 0 to 100, default 100; a bad value means 100 (never a silent 0).
export function houseStylePercent(env) {
  const raw = env?.HOUSE_STYLE_PERCENT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 100;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.floor(value))) : 100;
}

// What the operator's /health shows.
export function houseStyleStatus(env) {
  return { mode: houseStyleMode(env), percent: houseStylePercent(env), version: HOUSE_STYLE_VERSION };
}

// The x-neuron-style request header as one of 'off', 'client' or 'auto'.
export function parseStyleHeader(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === STYLE_HEADER_OFF || text === STYLE_HEADER_CLIENT ? text : 'auto';
}

// FNV-1a over UTF-16 code units, then 0..99: one caller always lands in the same bucket, so a
// rollout percentage never flips the preface on and off between the turns of a conversation.
export function rolloutBucket(caller) {
  const text = String(caller ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

const isSystemMessage = message => message?.role === 'system' || message?.role === 'developer';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
}

// True when a system or developer message already carries a house style. User, assistant and tool
// messages are never read: a user who pastes the marker into a prompt does not switch it off.
export function carriesMarker(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    const text = textOf(message.content);
    if (MARKER_TEXTS.some(marker => text.includes(marker))) return true;
    if (LEGACY_CLIENT_LABELS.every(label => text.includes(label))) return true;
  }
  return false;
}

/**
 * Whether this request gets the preface. Inputs must be stable across the turns of a
 * conversation, so the provider's prompt cache is not flipped:
 *   env     HOUSE_STYLE, HOUSE_STYLE_PERCENT;
 *   header  the x-neuron-style request header (string or null);
 *   body    the validated chat completion body;
 *   caller  the stable user id (or token prefix) that picks the rollout bucket.
 * Returns { apply, reason }; reason is a short code for debug logs, never content.
 * Order: operator kill switch, caller opt-out, no tools (plain chat is never touched), requests
 * that are not agent turns (a forced tool call, JSON mode, tool_choice none, a tiny max_tokens),
 * a house style already present, then the rollout bucket.
 */
export function styleDecision({ env, header = null, body, caller = '' }) {
  const mode = houseStyleMode(env);
  if (mode === 'off') return { apply: false, reason: 'mode_off' };
  const asked = parseStyleHeader(header);
  if (asked === STYLE_HEADER_OFF) return { apply: false, reason: 'opted_out' };
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return { apply: false, reason: 'no_tools' };
  const choice = body.tool_choice;
  if (choice !== undefined && choice !== null && choice !== 'auto') {
    return { apply: false, reason: choice === 'none' ? 'tool_choice_none' : 'forced_tool' };
  }
  if (['json_object', 'json_schema'].includes(body.response_format?.type)) return { apply: false, reason: 'json_mode' };
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (typeof max === 'number' && max <= TINY_MAX_TOKENS) return { apply: false, reason: 'tiny_max_tokens' };
  if (asked === STYLE_HEADER_CLIENT || carriesMarker(body.messages)) return { apply: false, reason: 'client_marker' };
  if (mode === 'auto' && rolloutBucket(caller) >= houseStylePercent(env)) return { apply: false, reason: 'rollout' };
  return { apply: true, reason: 'applied' };
}

/**
 * A copy of the body with the preface at the start of its system prompt. The input is never
 * mutated (scrubbing and failover reuse it).
 *   first message is a system or developer message with a string: the preface and a blank line
 *     go in front of that string, so there is still one system message first (some chat
 *     templates reject a second one) and the client's own text follows the preface;
 *   with an array of parts: one text part is put in front;
 *   otherwise: a new system message goes first.
 */
export function applyHouseStyle(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const head = messages[0];
  let merged = null;
  if (isSystemMessage(head) && typeof head.content === 'string') {
    merged = { ...head, content: head.content.trim() ? `${HOUSE_STYLE_TEXT}\n\n${head.content}` : HOUSE_STYLE_TEXT };
  } else if (isSystemMessage(head) && Array.isArray(head.content)) {
    merged = { ...head, content: [{ type: 'text', text: `${HOUSE_STYLE_TEXT}\n\n` }, ...head.content] };
  }
  return { ...body, messages: merged ? [merged, ...messages.slice(1)] : [{ role: 'system', content: HOUSE_STYLE_TEXT }, ...messages] };
}

const whole = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : 0;
};

const reported = value => value !== undefined && value !== null;

// Whether `usage` came from the provider and so counts the preface: it has a prompt count, or a
// total with a completion count to take it from. Not an estimate built from the client's own
// messages (no usage at all, or flagged: `estimate` by the aborted and failed-attempt fallbacks in
// chat-handler.js, `estimated` by normalizeCompletion when a reply carries no usage block), and
// not a bare total (billableUsage then takes the smaller of the total and that estimate as the
// prompt). Both spellings count: an estimate that went through the gateway as a usage block still
// has a prompt figure, and taking the preface off it would credit tokens it never held.
export function usageCountsPreface(usage) {
  if (!usage || usage.estimate === true || usage.estimated === true) return false;
  return reported(usage.prompt_tokens) || (reported(usage.total_tokens) && reported(usage.completion_tokens));
}

// The usage block of a non-streaming reply, with any estimate pinned to the client's own prompt
// estimate. normalizeCompletion builds its estimate from the messages it is given: the gateway
// gives it the client's, but the Workers AI adapter (src/cloudflare-adapter.js) gives it the
// payload it sent, which holds the preface. Either way an estimate is what the client's messages
// would cost, so a styled request is charged the same as an unstyled one. Provider usage is
// returned as is.
export function clientEstimate(usage, promptTokens) {
  if (!usage || (usage.estimated !== true && usage.estimate !== true)) return usage;
  const prompt = whole(promptTokens);
  return { ...usage, prompt_tokens: prompt, total_tokens: prompt + whole(usage.completion_tokens) };
}

/**
 * What the user is charged for a request that carried the preface: the provider's prompt count
 * includes it, so its estimated tokens come off the prompt side (never below 0), and the
 * prompt-cache split (billableUsage) is clamped to what is left. `billed` is billableUsage()'s
 * result for `usage`; when that usage does not count the preface (usageCountsPreface) it is
 * returned as is. Returns a new object otherwise.
 */
export function creditPreface(billed, usage, styleTokens = HOUSE_STYLE_TOKENS) {
  const credit = whole(styleTokens);
  if (!billed || !credit || billed.estimated || !usageCountsPreface(usage)) return billed;
  const prompt = Math.max(0, whole(billed.prompt_tokens) - credit);
  const read = Math.min(prompt, whole(billed.cache_read_tokens));
  const write = Math.min(prompt - read, whole(billed.cache_write_tokens));
  const write1h = Math.min(prompt - read - write, whole(billed.cache_write_1h_tokens));
  return { ...billed, prompt_tokens: prompt, total_tokens: prompt + whole(billed.completion_tokens),
    cache_read_tokens: read, cache_write_tokens: write, cache_write_1h_tokens: write1h };
}
