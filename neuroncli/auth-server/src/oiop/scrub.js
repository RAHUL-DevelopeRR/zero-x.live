// Prompt secret scrubber (docs/OIOP.md "Secrets", contract §12.3). A coding agent sends files,
// tool results and terminal output, which often hold credentials. Before a request leaves the
// gateway, every credential found in message text, text parts and tool-call arguments is replaced
// by a placeholder (`zxsecret_` + 12 hex digits: an HMAC of the secret under a key that never
// leaves this isolate, so a secret keeps its placeholder from turn to turn and upstream prompt
// caches still match). The model's output gets the real values back (SecretRestorer), so a model
// that rewrites a .env file writes the real key, not the placeholder; the provider never sees it.
//
// Rules are tuned for precision over recall: provider key formats, private key blocks, JWTs,
// passwords in connection strings, and secret-named assignments (API_KEY=…, "password": "…")
// whose value looks like a secret. OIOP_SCRUB: all (default) | untrusted (T2/T3 offers only) | off.

export const PLACEHOLDER_PREFIX = 'zxsecret_';
const PLACEHOLDER_HEX = 12;
const PLACEHOLDER = new RegExp(`${PLACEHOLDER_PREFIX}[0-9a-f]{${PLACEHOLDER_HEX}}`, 'g');
const PLACEHOLDER_LENGTH = PLACEHOLDER_PREFIX.length + PLACEHOLDER_HEX;

// Whole-match credentials.
const TOKEN_RULES = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|ant-(?:api\d\d-)?|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:gsk|xai|nvapi|hf|pplx|fw|csk)[-_][A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ses|nzx)_[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// Credentials inside a larger match: [pattern, index of the secret group].
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret|credential|kek|signing[_-]?key)[A-Za-z0-9_.-]*';
const VALUE_RULES = [
  // postgres://user:password@host
  [/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^:/\s@]{1,128}:)([^@\s/]{3,256})(@)/gi, 2],
  // API_KEY=value, export TOKEN="value", password: value (dotenv, shell, YAML)
  [new RegExp(`^(\\s*(?:export\\s+)?${SECRET_NAME}\\s*[=:]\\s*)(["']?)([^\\s"'#]{8,512})\\2`, 'gim'), 3],
  // "apiKey": "value", api_key = 'value', password="value" (JSON, code, TOML)
  [new RegExp(`(["']?${SECRET_NAME}["']?\\s*[:=]\\s*)(["'])([^"'\\s]{8,512})\\2`, 'gi'), 3],
];

const NOT_A_SECRET = /^(?:\$\{.*\}|\$[A-Za-z_]\w*|<.*>|\{\{.*\}\}|%.*%|(?:your|my|the)[-_].*|changeme|change[-_]me|placeholder|example.*|redacted.*|dummy.*|(?:x|\*|\.)+|null|none|undefined|true|false|process\.env\..*|os\.environ.*|env\(.*)$/i;
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

// Whether a value captured by a VALUE_RULES assignment looks like a real secret.
function secretLike(value) {
  if (NOT_A_SECRET.test(value) || DOTTED_IDENTIFIER.test(value) || value.startsWith(PLACEHOLDER_PREFIX)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || value.length >= 24;
}

// Every credential in `text` as [start, end) spans (non-overlapping, in order).
export function findSecrets(text) {
  if (typeof text !== 'string' || text.length < 8) return [];
  const spans = [];
  for (const rule of TOKEN_RULES) {
    for (const match of text.matchAll(rule)) spans.push([match.index, match.index + match[0].length]);
  }
  for (const [rule, group] of VALUE_RULES) {
    for (const match of text.matchAll(rule)) {
      const value = match[group];
      if (!secretLike(value)) continue;
      const offset = match.slice(1, group).reduce((sum, part) => sum + (part?.length || 0), 0);
      spans.push([match.index + offset, match.index + offset + value.length]);
    }
  }
  spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

// ── Placeholders ──

let hmacKey = null; // per isolate: placeholders are stable here and meaningless anywhere else
function placeholderKey() {
  hmacKey ||= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hmacKey;
}

async function placeholderFor(secret) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await placeholderKey(), new TextEncoder().encode(secret)));
  return PLACEHOLDER_PREFIX + [...mac.slice(0, PLACEHOLDER_HEX / 2)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ── Requests ──

// The strings of a request that are scrubbed: message content (string or text parts) and the
// arguments of tool calls in the history. Calls `visit(text, kind)`, where kind is 'text' or
// 'arguments', and stores what it returns; objects whose strings did not change are reused.
function mapStrings(messages, visit) {
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    let changed = false;
    const apply = (text, kind) => {
      const next = visit(text, kind);
      if (next !== text) changed = true;
      return next;
    };
    const next = { ...message };
    if (typeof message.content === 'string') next.content = apply(message.content, 'text');
    else if (Array.isArray(message.content)) {
      next.content = message.content.map(part => (part && typeof part === 'object' && typeof part.text === 'string'
        ? { ...part, text: apply(part.text, 'text') } : part));
    }
    if (Array.isArray(message.tool_calls)) {
      next.tool_calls = message.tool_calls.map(call => (call && typeof call.function?.arguments === 'string'
        ? { ...call, function: { ...call.function, arguments: apply(call.function.arguments, 'arguments') } } : call));
    }
    return changed ? next : message;
  });
}

// Tool-call arguments are JSON: secrets are found in each string value (so line-based rules see
// real lines), and the JSON is rewritten only when something was replaced.
function argumentStrings(text) {
  try {
    const parsed = JSON.parse(text);
    const strings = [];
    const walk = value => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(parsed);
    return { parsed, strings };
  } catch {
    return { parsed: undefined, strings: [text] };
  }
}

function replaceSpans(text, spans, placeholders) {
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + placeholders.get(text.slice(start, end));
    at = end;
  }
  return out + text.slice(at);
}

function scrubText(text, placeholders) {
  const spans = findSecrets(text);
  return spans.length ? replaceSpans(text, spans, placeholders) : text;
}

function scrubArguments(text, placeholders) {
  const { parsed, strings } = argumentStrings(text);
  if (!strings.some(value => findSecrets(value).length)) return text;
  if (parsed === undefined) return scrubText(text, placeholders);
  const walk = value => {
    if (typeof value === 'string') return scrubText(value, placeholders);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return JSON.stringify(walk(parsed));
}

/**
 * Scrubs the messages of a chat completion body. Returns { body, secrets, count }: the body
 * with placeholders (the same object when nothing was found), the placeholder -> secret map for
 * SecretRestorer, and the number of distinct secrets withheld.
 */
export async function scrubRequest(body) {
  const found = new Set();
  mapStrings(body.messages, (text, kind) => {
    const sources = kind === 'arguments' ? argumentStrings(text).strings : [text];
    for (const source of sources) for (const [start, end] of findSecrets(source)) found.add(source.slice(start, end));
    return text;
  });
  if (!found.size) return { body, secrets: new Map(), count: 0 };
  const placeholders = new Map();
  const secrets = new Map();
  for (const secret of found) {
    const placeholder = await placeholderFor(secret);
    placeholders.set(secret, placeholder);
    secrets.set(placeholder, secret);
  }
  const messages = mapStrings(body.messages, (text, kind) => (kind === 'arguments'
    ? scrubArguments(text, placeholders) : scrubText(text, placeholders)));
  return { body: { ...body, messages }, secrets, count: secrets.size };
}

// ── Responses ──

const jsonEscaped = value => JSON.stringify(value).slice(1, -1);

// Length of the longest suffix of `text` that could still grow into a placeholder.
function pendingSuffix(text) {
  const max = Math.min(text.length, PLACEHOLDER_LENGTH - 1);
  for (let length = max; length > 0; length--) {
    const tail = text.slice(text.length - length);
    const head = tail.slice(0, PLACEHOLDER_PREFIX.length);
    if (PLACEHOLDER_PREFIX.startsWith(head) && /^[0-9a-f]*$/.test(tail.slice(PLACEHOLDER_PREFIX.length))) return length;
  }
  return 0;
}

/**
 * Puts the real secrets back into the model's output. Text fields get the secret as is; tool-call
 * arguments (JSON text) get it JSON-escaped. Streams are restored delta by delta: a delta that
 * ends in what may be the start of a placeholder is held back until the next delta or the end of
 * the choice, so a placeholder split across chunks is still restored.
 */
export class SecretRestorer {
  constructor(secrets) {
    this.secrets = secrets;
    this.held = new Map(); // `${choice}|${field}` -> held text
  }

  get active() {
    return this.secrets.size > 0;
  }

  restore(text, json = false) {
    if (typeof text !== 'string' || !text.includes(PLACEHOLDER_PREFIX)) return text;
    return text.replace(PLACEHOLDER, placeholder => {
      const secret = this.secrets.get(placeholder);
      return secret === undefined ? placeholder : json ? jsonEscaped(secret) : secret;
    });
  }

  // A non-streamed completion (normalizeCompletion shape), restored in place.
  completion(completion) {
    if (!this.active) return completion;
    for (const choice of completion.choices || []) {
      const message = choice.message || {};
      if (typeof message.content === 'string') message.content = this.restore(message.content);
      if (typeof message.reasoning_content === 'string') message.reasoning_content = this.restore(message.reasoning_content);
      for (const call of message.tool_calls || []) {
        if (typeof call.function?.arguments === 'string') call.function.arguments = this.restore(call.function.arguments, true);
      }
    }
    return completion;
  }

  stream(choice, field, text, json) {
    const key = `${choice}|${field}`;
    const joined = (this.held.get(key) || '') + text;
    const hold = pendingSuffix(joined);
    this.held.set(key, joined.slice(joined.length - hold));
    return this.restore(joined.slice(0, joined.length - hold), json);
  }

  flush(choice, field, json) {
    const key = `${choice}|${field}`;
    const rest = this.held.get(key) || '';
    this.held.delete(key);
    return this.restore(rest, json);
  }

  // One normalized stream chunk (chat.completion.chunk), restored in place. When a choice
  // finishes, whatever is still held for it is released into this chunk.
  chunk(chunk) {
    if (!this.active || typeof chunk !== 'object' || !Array.isArray(chunk.choices)) return chunk;
    for (const choice of chunk.choices) {
      const delta = choice.delta || (choice.delta = {});
      for (const field of ['content', 'reasoning_content']) {
        if (typeof delta[field] === 'string') delta[field] = this.stream(choice.index, field, delta[field], false);
      }
      for (const call of delta.tool_calls || []) {
        if (typeof call.function?.arguments === 'string') {
          call.function.arguments = this.stream(choice.index, `tool:${call.index}`, call.function.arguments, true);
        }
      }
      if (choice.finish_reason) this.release(choice);
    }
    return chunk;
  }

  release(choice) {
    const delta = choice.delta || (choice.delta = {});
    for (const key of [...this.held.keys()]) {
      const [index, field] = key.split('|');
      if (Number(index) !== choice.index || !this.held.get(key)) continue;
      if (field.startsWith('tool:')) {
        const callIndex = Number(field.slice(5));
        const rest = this.flush(choice.index, field, true);
        delta.tool_calls ||= [];
        const call = delta.tool_calls.find(item => item.index === callIndex);
        if (call) call.function = { ...call.function, arguments: (call.function?.arguments || '') + rest };
        else delta.tool_calls.push({ index: callIndex, function: { arguments: rest } });
      } else {
        delta[field] = (delta[field] || '') + this.flush(choice.index, field, false);
      }
    }
  }

  // Held text of choices that never sent a finish_reason, as a final chunk (or null).
  finalChunk(template) {
    if (![...this.held.values()].some(Boolean)) return null;
    const indexes = [...new Set([...this.held.keys()].map(key => Number(key.split('|')[0])))];
    const choices = indexes.map(index => {
      const choice = { index, delta: {}, finish_reason: null };
      this.release(choice);
      return choice;
    });
    return { ...template, choices };
  }
}

export function scrubMode(env) {
  const mode = String(env?.OIOP_SCRUB || 'all').trim().toLowerCase();
  return ['all', 'untrusted', 'off'].includes(mode) ? mode : 'all';
}

// Whether requests to `offer` are scrubbed under `mode`.
export function scrubsOffer(mode, offer) {
  if (mode === 'off') return false;
  if (mode === 'untrusted') return !offer || offer.trust_tier === 'T2' || offer.trust_tier === 'T3';
  return true;
}
