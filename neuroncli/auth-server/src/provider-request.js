// Provider-specific request shaping (docs/PROVIDER_TERMS.md, "Request compatibility").
//
// buildUpstreamPayload (providers.js) chooses the parameters each upstream accepts; the adapters
// then pass the body through normalizeProviderRequest, which rewrites messages and tool calls
// into the subset each upstream accepts without changing what the model is told. Observed
// against the live upstreams with real Neuron CLI requests (2026-10-16):
//
// - Gemini 3 models reject a history whose assistant tool calls carry no thought signature
//   (400 INVALID_ARGUMENT "Function call is missing a thought_signature in functionCall
//   parts") and reject signatures they did not issue ("Corrupted thought signature."). Neuron
//   and most OpenAI clients drop the signature, so the gateway restores the one the model
//   issued for that call (remembered per caller and upstream model) and otherwise uses Google's
//   documented placeholder for calls that came from another model or session.
// - Groq rejects message properties outside the OpenAI schema (400 "property 'is_error' is
//   unsupported"); Neuron sends `is_error` on every tool result.
// - Tool JSON Schemas (type arrays, format, additionalProperties, $ref/$defs, anyOf/oneOf,
//   const, default, empty properties) and every tool_choice form are accepted by Gemini 2.5/3.5
//   Flash and Groq, so schemas are forwarded unchanged.

// Placeholder Google documents for function calls the current model did not generate
// (ai.google.dev/gemini-api/docs/thought-signatures): the call is accepted without validation.
export const GEMINI_SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';
const PLACEHOLDERS = new Set([GEMINI_SIGNATURE_PLACEHOLDER, 'context_engineering_is_the_way_to_go']);

// Providers that answer 400 for message properties outside the OpenAI schema.
const STRICT_PROVIDERS = new Set(['groq', 'gemini']);
const OPENAI_MESSAGE_FIELDS = Object.freeze({
  system: Object.freeze(['role', 'content', 'name']),
  user: Object.freeze(['role', 'content', 'name']),
  assistant: Object.freeze(['role', 'content', 'name', 'tool_calls']),
  tool: Object.freeze(['role', 'content', 'tool_call_id', 'name']),
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function pick(value, fields) {
  const out = {};
  for (const name of fields) if (value[name] !== undefined) out[name] = value[name];
  return out;
}

function argumentsText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
}

const ERROR_PREFIX = /^\s*(error|failed|failure)\b/i;

// A failed tool result (`is_error: true`) keeps its meaning once the flag is gone.
export function errorToolContent(content) {
  if (typeof content === 'string') return ERROR_PREFIX.test(content) ? content : `Error: ${content}`;
  if (Array.isArray(content)) {
    const first = content[0];
    if (isObject(first) && typeof first.text === 'string' && ERROR_PREFIX.test(first.text)) return content;
    return [{ type: 'text', text: 'Error:' }, ...content];
  }
  return content === undefined || content === null ? 'Error' : `Error: ${JSON.stringify(content)}`;
}

/** Thought signature carried by an OpenAI-shaped tool call (Gemini's `extra_content`). */
export function toolCallSignature(call) {
  const value = call?.extra_content?.google?.thought_signature;
  return typeof value === 'string' && value ? value : null;
}

function normalizeToolCalls(calls, { strict, gemini, signatureFor }) {
  const out = calls.map(call => {
    if (!isObject(call)) return call;
    const fn = isObject(call.function) ? call.function : {};
    const next = strict ? { id: call.id, type: call.type || 'function', function: pick(fn, ['name']) } : { ...call, function: { ...fn } };
    // Gemini-only field; signatures are re-attached below for Gemini, never forwarded as sent
    // (the gateway cannot know which model issued a client-supplied one).
    delete next.extra_content;
    if (next.id === undefined) delete next.id;
    next.function.arguments = argumentsText(fn.arguments);
    return next;
  });
  if (!gemini) return out;
  // Gemini emits a signature on the first call of each step (and on later parallel calls only
  // when it chose to): restore what it issued; without any, the placeholder goes on every call.
  const signatures = out.map(call => (isObject(call) && signatureFor ? signatureFor(call) : null) || null);
  const restored = signatures.some(Boolean);
  out.forEach((call, index) => {
    if (!isObject(call)) return;
    const signature = signatures[index] || (index === 0 || !restored ? GEMINI_SIGNATURE_PLACEHOLDER : null);
    if (signature) call.extra_content = { google: { thought_signature: signature } };
  });
  return out;
}

function normalizeMessage(message, options) {
  if (!isObject(message)) return message;
  let next = { ...message };
  if (next.role === 'tool' && Object.hasOwn(next, 'is_error')) {
    const failed = next.is_error === true;
    delete next.is_error;
    if (failed) next.content = errorToolContent(next.content);
  }
  if (next.role === 'assistant') {
    if (Array.isArray(next.tool_calls) && next.tool_calls.length) next.tool_calls = normalizeToolCalls(next.tool_calls, options);
    else delete next.tool_calls; // an explicit empty array is a 400 on several upstreams
    // OpenAI allows a null content only next to tool calls.
    if ((next.content === null || next.content === undefined) && !next.tool_calls) next.content = '';
  }
  if (options.strict && OPENAI_MESSAGE_FIELDS[next.role]) next = pick(next, OPENAI_MESSAGE_FIELDS[next.role]);
  return next;
}

/**
 * Returns a copy of an OpenAI-shaped chat body that `provider` accepts (the input is not
 * mutated). `signatureFor(call)` returns the Gemini thought signature the target model issued
 * for an assistant tool call, or null.
 */
export function normalizeProviderRequest(provider, body, { signatureFor = null } = {}) {
  if (!isObject(body) || !Array.isArray(body.messages)) return body;
  const options = { strict: STRICT_PROVIDERS.has(provider), gemini: provider === 'gemini', signatureFor };
  return { ...body, messages: body.messages.map(message => normalizeMessage(message, options)) };
}

/**
 * Thought signatures Gemini issued for tool calls, kept per caller and upstream model so the
 * next turn of a conversation can send them back (clients drop them). Per isolate, bounded
 * (least recently stored entries are evicted first) and short-lived; a miss falls back to the
 * placeholder, which Gemini accepts. Keys include the function name because Gemini 3 call ids
 * are short numbers that may repeat across conversations.
 */
export class ThoughtSignatureCache {
  constructor({ maxEntries = 2000, ttlMs = 6 * 3600000, maxSignatureLength = 32768 } = {}) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.maxSignatureLength = maxSignatureLength;
  }

  key({ caller, model, id, name }) {
    if (!caller || !model || typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
    return JSON.stringify([String(caller), String(model), id, name]);
  }

  remember({ caller, model, id, name, signature }, now = Date.now()) {
    const key = this.key({ caller, model, id, name });
    if (!key || typeof signature !== 'string' || !signature || signature.length > this.maxSignatureLength ||
        PLACEHOLDERS.has(signature)) return false;
    this.entries.delete(key);
    this.entries.set(key, { signature, expires: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return true;
  }

  lookup({ caller, model, id, name }, now = Date.now()) {
    const key = this.key({ caller, model, id, name });
    const entry = key ? this.entries.get(key) : null;
    if (!entry) return null;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.signature;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export const globalSignatureCache = new ThoughtSignatureCache();
