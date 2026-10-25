// Native Claude adapter, request side: an OpenAI chat body (already shaped by
// buildUpstreamPayload) becomes a Claude Messages API body.
//
// Everything here is synchronous and deterministic. The same OpenAI body always yields
// byte-identical JSON, and the next turn's messages start with this turn's messages, which is
// what prompt caching (a prefix match) and preserved thinking (signatures bound to the
// conversation prefix) both need. Never put timestamps, random ids or unordered keys here.

export const ANTHROPIC = Object.freeze({
  id: 'anthropic',
  // The only upstream. The SDK appends /v1/messages; apiBase is the provider-type base URL.
  baseURL: 'https://api.anthropic.com',
  apiBase: 'https://api.anthropic.com/v1',
  host: 'api.anthropic.com',
  keyVar: 'ANTHROPIC_API_KEY',
  keySlot: 'anthropic.paid',
  protocol: 'anthropic-messages',
});

// thinking.block_binding.prefix_mismatch_behavior is only accepted under this beta.
export const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

// Upstream ids a catalog row may name (the same rule as the catalog's provider type).
export const UPSTREAM_MODEL = /^claude-[a-z0-9][a-z0-9-]{0,60}$/;

// API behaviour per upstream id. Both 5.5 models: adaptive thinking only (`disabled` and
// `budget_tokens` are 400s), forced tool_choice is a 400, mid-conversation system messages are
// supported, thinking blocks are bound to the model and the conversation. Sonnet 5.5 alone
// accepts {type:'between_tools'} as its lowest thinking setting.
export const CLAUDE_TRAITS = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ adaptive: true, display: 'summarized', defaultEffort: 'medium',
    thinkingOff: 'between_tools', replay: true, systemMessages: true }),
  'claude-opus-5-5': Object.freeze({ adaptive: true, display: 'summarized', defaultEffort: 'medium',
    thinkingOff: null, replay: true, systemMessages: true }),
});
// Claude ids without verified traits (operator-approved rows) get fields every Messages model
// accepts: no thinking, effort, beta, replay or mid-conversation system messages.
export const PLAIN_TRAITS = Object.freeze({ adaptive: false, display: null, defaultEffort: null,
  thinkingOff: null, replay: false, systemMessages: false });
export const claudeTraits = model => (Object.hasOwn(CLAUDE_TRAITS, model) ? CLAUDE_TRAITS[model] : PLAIN_TRAITS);

// A request this mapper cannot express for Claude. The adapter answers it as a synthesized
// 400 invalid_request_error, which the router classifies as INVALID (auto moves on).
export class ClaudeRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeRequestError';
  }
}

const EFFORTS = new Set(['low', 'medium', 'high']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\r\n]+)$/;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EPHEMERAL = Object.freeze({ type: 'ephemeral' }); // 5-minute TTL: never a 1-hour write
const TEXT_PARTS = new Set(['text', 'input_text']);
const IMAGE_PARTS = new Set(['image_url', 'input_image', 'image']);
const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking']);
const hasText = value => typeof value === 'string' && /\S/.test(value);
const isSystem = message => message?.role === 'system' || message?.role === 'developer';
const reminder = text => `<system-reminder>\n${text}\n</system-reminder>`;

// FNV-1a over two 32-bit lanes, 16 hex digits. Synchronous, so the mapper stays synchronous.
export function hash64(text) {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// Tool names Claude accepts; others become a stable, readable form with a hash suffix. The
// adapter keeps the reverse map, so clients see their own names in tool calls.
export function safeName(name) {
  const text = String(name ?? '');
  return NAME.test(text) ? text : `${text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 47)}_${hash64(text)}`;
}

// The same rewrite on tool_use.id and tool_result.tool_use_id, so foreign ids still pair.
// Claude's own toolu_ ids pass unchanged.
export function safeId(id) {
  if (typeof id !== 'string' || !id) throw new ClaudeRequestError('Every tool call and tool result needs an id.');
  return ID.test(id) ? id : `${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}_${hash64(id)}`;
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter(part => TEXT_PARTS.has(part?.type)).map(part => (typeof part.text === 'string' ? part.text : '')).join('')
    : '';
}

function imageBlock(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url;
  const data = typeof url === 'string' ? DATA_URL.exec(url) : null;
  if (data) {
    if (!IMAGE_TYPES.has(data[1])) throw new ClaudeRequestError('Images must be PNG, JPEG, GIF or WebP.');
    return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2].replace(/\s+/g, '') } };
  }
  if (typeof url === 'string' && url.startsWith('https://')) return { type: 'image', source: { type: 'url', url } };
  throw new ClaudeRequestError('Images must be https URLs or base64 data URLs.');
}

function contentBlocks(content) {
  if (typeof content === 'string') return hasText(content) ? [{ type: 'text', text: content }] : [];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }];
  return content.flatMap(part => {
    if (TEXT_PARTS.has(part?.type)) return hasText(part.text) ? [{ type: 'text', text: part.text }] : [];
    if (IMAGE_PARTS.has(part?.type)) return [imageBlock(part)];
    const kind = String(part?.type ?? '').replace(/[^a-z_]/gi, '').slice(0, 32) || 'unknown';
    throw new ClaudeRequestError(`Content parts of type ${kind} are not supported by this model.`);
  });
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw === null || raw === undefined || raw === '' ? '{}' : raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function assistantBlocks(message) {
  const blocks = [];
  const text = textOf(message.content);
  if (hasText(text)) blocks.push({ type: 'text', text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    blocks.push({ type: 'tool_use', id: safeId(call?.id), name: safeName(call?.function?.name ?? ''),
      input: parseArguments(call?.function?.arguments) });
  }
  // An empty assistant turn (for example after an earlier pre-output refusal).
  return blocks.length ? blocks : [{ type: 'text', text: '(no response)' }];
}

// normalizeProviderRequest is not used for Claude: it strips is_error and prefixes "Error:".
function toolResult(message) {
  const blocks = contentBlocks(message.content);
  const content = !blocks.length ? '(no output)' : blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks;
  return { type: 'tool_result', tool_use_id: safeId(message.tool_call_id), content,
    ...(message.is_error === true ? { is_error: true } : {}) };
}

// The record's leading run of thinking blocks: the ones before its first text or tool_use.
function leadingThinking(blocks) {
  const leading = [];
  for (const block of blocks) {
    if (!THINKING_BLOCKS.has(block?.type)) break;
    leading.push(block);
  }
  return leading;
}

// Restored blocks are used only when they start with thinking and their tool_use ids are exactly
// the echoed message's calls, in order; anything else is rebuilt from the message.
function usableRestore(blocks, message) {
  if (!Array.isArray(blocks) || !leadingThinking(blocks).length) return false;
  const restoredIds = blocks.filter(block => block?.type === 'tool_use').map(block => block.id);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (restoredIds.length !== calls.length) return false;
  return calls.every((call, index) => typeof call?.id === 'string' && ID.test(call.id) && call.id === restoredIds[index]);
}

/**
 * A restored assistant turn: the record's leading thinking blocks, then the turn rebuilt from the
 * echoed message. Text and tool_use always come from the echo (Neuron folds the reasoning summary
 * into its text and re-serializes tool input), so the turn without its thinking blocks is
 * byte-identical to the turn rebuilt on a miss, and whether this isolate holds the record changes
 * the thinking blocks only: never the content later turns' thinking signatures are bound to
 * (system, tools and every earlier message).
 *
 * Only the leading run is replayed. A thinking block written later in the turn (the progress
 * updates 5.5 models write between tool calls) was minted after Claude's own text and tool_use,
 * which the echo does not reproduce exactly; if its binding covers the earlier blocks of its own
 * message, replaying it would fail the check and drop_block would remove it and every later block,
 * on every request. Leaving it out the same way on every request keeps the chain valid either way:
 * the next turn's thinking is minted with this turn's last leading block as its predecessor, and
 * a leading block's prefix ends where its message starts. (input_transformations on message_start
 * is logged, so drops show up.)
 *
 * This keeps the thinking binding independent of the isolate, not the prompt cache: the cache
 * matches exact bytes, thinking included, so it hits only on what the same isolate sent before
 * (src/anthropic-turns.js).
 */
function splicedTurn(record, message) {
  return [...leadingThinking(record), ...assistantBlocks(message)];
}

/**
 * OpenAI messages to Claude `system` blocks and `messages`.
 * `restore(message)` returns the cached Claude blocks of an assistant turn (thinking with
 * signatures included) or null; only their thinking blocks are used (splicedTurn).
 * `systemMessages` allows native mid-conversation system turns.
 */
export function mapMessages(input, { restore = null, systemMessages = true } = {}) {
  if (!Array.isArray(input)) throw new ClaudeRequestError('Provide at least one message.');
  const system = [];
  let index = 0;
  for (; index < input.length && isSystem(input[index]); index++) {
    const text = textOf(input[index].content);
    if (hasText(text)) system.push({ type: 'text', text });
  }
  const turns = [];
  let user = null; // the open user turn: tool results first, then everything else
  const openUser = () => (user ||= { results: [], other: [] });
  const closeUser = () => {
    if (!user) return;
    turns.push({ role: 'user', content: [...user.results, ...user.other] });
    user = null;
  };
  for (; index < input.length; index++) {
    const message = input[index];
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') {
      openUser().other.push(...contentBlocks(message.content));
    } else if (message.role === 'tool') {
      openUser().results.push(toolResult(message));
    } else if (message.role === 'assistant') {
      closeUser();
      const previous = turns.at(-1);
      if (previous?.role === 'assistant') {
        // Consecutive assistant messages merge into one turn, which is never replayed.
        if (previous.restored) {
          previous.content = assistantBlocks(previous.source);
          previous.restored = false;
        }
        previous.content.push(...assistantBlocks(message));
      } else {
        const restored = restore ? restore(message) : null;
        turns.push(usableRestore(restored, message)
          ? { role: 'assistant', content: splicedTurn(restored, message), restored: true, source: message }
          : { role: 'assistant', content: assistantBlocks(message), restored: false, source: message });
      }
    } else if (isSystem(message)) {
      const text = textOf(message.content);
      if (!hasText(text)) continue;
      // Native only where the API allows it: after a user turn, and either last or followed by
      // an assistant turn. Elsewhere it is folded into the adjacent user turn.
      const afterUser = user !== null || turns.at(-1)?.role === 'user';
      const next = input[index + 1];
      if (systemMessages && afterUser && (!next || next.role === 'assistant')) {
        closeUser();
        turns.push({ role: 'system', content: text });
      } else {
        openUser().other.push({ type: 'text', text: reminder(text) });
      }
    }
  }
  closeUser();
  pairToolResults(turns);
  if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue the conversation.' }] });
  if (turns.at(-1).role === 'assistant') {
    // Assistant prefill: rejected by these models, so never sent.
    throw new ClaudeRequestError('This model does not accept a conversation that ends with an assistant message.');
  }
  for (const turn of turns) {
    if (turn.role === 'user' && !turn.content.length) turn.content.push({ type: 'text', text: '(empty)' });
  }
  const replayed = turns.filter(turn => turn.restored).length;
  return { system, messages: turns.map(({ role, content }) => ({ role, content })), replayed };
}

// Every tool_use needs a tool_result in the next user turn, in tool_use order; results with no
// matching tool_use become text.
function pairToolResults(turns) {
  for (let position = 0; position < turns.length; position++) {
    const turn = turns[position];
    if (turn.role === 'assistant') {
      const calls = turn.content.some(block => block.type === 'tool_use');
      if (calls && turns[position + 1]?.role !== 'user') turns.splice(position + 1, 0, { role: 'user', content: [] });
      continue;
    }
    if (turn.role !== 'user') continue;
    const previous = turns[position - 1];
    const ids = previous?.role === 'assistant'
      ? previous.content.filter(block => block.type === 'tool_use').map(block => block.id) : [];
    const results = turn.content.filter(block => block.type === 'tool_result');
    const others = turn.content.filter(block => block.type !== 'tool_result');
    const byId = new Map(results.map(result => [result.tool_use_id, result]));
    const ordered = ids.map(id => byId.get(id) ??
      { type: 'tool_result', tool_use_id: id, is_error: true, content: 'No result was returned for this tool call.' });
    const orphans = results.filter(result => !ids.includes(result.tool_use_id)).map(result => ({ type: 'text',
      text: `Tool result (${result.tool_use_id}): ${typeof result.content === 'string' ? result.content : textOf(result.content)}` }));
    turn.content = [...ordered, ...orphans, ...others];
  }
}

function mapTools(tools, stream) {
  if (!Array.isArray(tools) || !tools.length) return { tools: null, names: new Map() };
  const names = new Map(); // upstream name -> client name
  const out = tools.map(tool => {
    const fn = tool?.function ?? {};
    const name = safeName(fn.name);
    names.set(name, fn.name);
    const schema = fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters) ? fn.parameters : {};
    if (schema.type !== undefined && schema.type !== 'object') {
      throw new ClaudeRequestError('Tool parameters must be a JSON object schema.');
    }
    // OpenAI `strict` is dropped: Claude's strict mode has stricter schema rules.
    const definition = { name, ...(fn.description ? { description: String(fn.description) } : {}),
      input_schema: { type: 'object', ...schema } };
    // Streamed tool input arrives as generated instead of buffered per parameter, which would
    // otherwise leave a large file-body argument silent past the gateway's idle timeout.
    if (stream) definition.eager_input_streaming = true;
    return definition;
  });
  out[out.length - 1] = { ...out.at(-1), cache_control: EPHEMERAL };
  return { tools: out, names };
}

// Forced tool use ({type:'any'} / {type:'tool'}) is a 400 on both 5.5 models: it becomes auto
// plus an instruction. 'any' and 'tool' are never sent.
function mapToolChoice(choice, parallel) {
  let mapped = { type: 'auto' };
  let note = null;
  const type = typeof choice === 'string' ? choice : choice?.type;
  if (type === 'none') mapped = { type: 'none' };
  else if (type === 'required' || type === 'any') note = 'You must call at least one of the provided tools in this response.';
  else if (type === 'function' && choice.function?.name) note = `You must call the ${safeName(choice.function.name)} tool in this response.`;
  else if (type === 'tool' && choice.name) note = `You must call the ${safeName(choice.name)} tool in this response.`;
  if (parallel === false && mapped.type === 'auto') mapped.disable_parallel_tool_use = true;
  return { mapped, note };
}

/**
 * Effort and thinking for one request. Effort is always explicit on the 5.5 models (default
 * 'medium'); 'minimal' is 'low'; 'none' is Sonnet's between_tools at 'low', and 'low' on Opus,
 * where thinking cannot be turned off. `disabled` and `budget_tokens` are never produced.
 */
export function claudeEffort(traits, value) {
  if (!traits.adaptive) return { effort: null, thinkingOff: false };
  if (value === 'none') return { effort: 'low', thinkingOff: traits.thinkingOff === 'between_tools' };
  if (value === 'minimal') return { effort: 'low', thinkingOff: false };
  return { effort: EFFORTS.has(value) ? value : traits.defaultEffort, thinkingOff: false };
}

/**
 * The Claude Messages body for one attempt. The body is built from a whitelist, so sampling
 * parameters (temperature, top_p, top_k, seed, penalties), user, n, logprobs and stream_options
 * are never sent. Options:
 * - restore(message): the cached blocks of an assistant turn, whose thinking blocks are spliced
 *   into the turn rebuilt from the message (preserved thinking);
 * - metadataUserId: the pseudonymous user id for metadata.user_id;
 * - bindingBeta: send thinking.block_binding drop_block under BINDING_BETA.
 * Returns { body, betas, toolNames, replay, replayed, rememberTurns }.
 */
export function toClaudeRequest(entry, payload, { restore = null, metadataUserId = null, bindingBeta = true } = {}) {
  const model = entry?.upstream_model || entry?.upstream;
  if (typeof model !== 'string' || !UPSTREAM_MODEL.test(model)) throw new ClaudeRequestError('This model id is not a Claude model.');
  if (!Number.isSafeInteger(payload?.max_tokens) || payload.max_tokens < 1) throw new ClaudeRequestError('max_tokens must be a positive integer.');
  const traits = claudeTraits(model);
  const stream = payload.stream === true;
  const { effort, thinkingOff } = claudeEffort(traits, payload.reasoning_effort);
  const binding = traits.adaptive && !thinkingOff && bindingBeta === true;
  const replay = binding && traits.replay && typeof restore === 'function';
  const { tools, names } = mapTools(payload.tools, stream);
  const { system, messages, replayed } = mapMessages(payload.messages,
    { restore: replay ? restore : null, systemMessages: traits.systemMessages });
  const toolChoice = tools ? mapToolChoice(payload.tool_choice, payload.parallel_tool_calls) : null;
  const responseFormat = payload.response_format;
  const format = responseFormat?.type === 'json_schema' && responseFormat.json_schema?.schema &&
    typeof responseFormat.json_schema.schema === 'object'
    ? { type: 'json_schema', schema: responseFormat.json_schema.schema } : null;
  const notes = [];
  if (toolChoice?.note) notes.push(toolChoice.note);
  if (responseFormat?.type === 'json_object') notes.push('Respond with a single JSON object and no other text.');
  const betas = [];
  const body = { model, max_tokens: payload.max_tokens };
  if (system.length) system[system.length - 1] = { ...system.at(-1), cache_control: EPHEMERAL };
  // Gateway notes (a forced tool_choice, json_object) are one more top-level system block, after
  // the client's system and its breakpoint. They stay put while the client keeps the same
  // tool_choice, like the tool_choice setting itself. A note appended after the last user turn
  // was an edit to the conversation that the next request, rebuilt from the client's history
  // without it, undid: that moved every later message and invalidated the replayed thinking.
  if (notes.length) system.push({ type: 'text', text: notes.join('\n') });
  if (system.length) body.system = system;
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice.mapped;
  }
  const stops = (typeof payload.stop === 'string' ? [payload.stop] : Array.isArray(payload.stop) ? payload.stop : []).filter(hasText);
  if (stops.length) body.stop_sequences = stops;
  if (traits.adaptive) {
    if (thinkingOff) {
      body.thinking = { type: 'between_tools' }; // Sonnet 5.5 only; no other field is allowed with it
    } else {
      body.thinking = { type: 'adaptive', display: traits.display };
      if (binding) {
        // A replayed block whose prefix changed is dropped (with every later one) instead of
        // failing the request. Sent on every request of the route so the thinking settings,
        // which are part of the cache key, never change between turns.
        body.thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
        betas.push(BINDING_BETA);
      }
    }
    body.output_config = { effort, ...(format ? { format } : {}) };
  } else if (format) {
    body.output_config = { format };
  }
  if (metadataUserId) body.metadata = { user_id: metadataUserId };
  body.messages = messages;
  body.cache_control = EPHEMERAL; // automatic breakpoint on the growing conversation tail
  body.stream = true;             // always streamed upstream; non-streaming callers get an aggregate
  return { body, betas, toolNames: names, replay, replayed,
    rememberTurns: traits.replay && traits.adaptive && !thinkingOff };
}

// ── Turn fingerprints (preserved-thinking replay) ──

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Tool arguments compared by value: a client that re-serializes them still matches.
export function canonicalArguments(raw) {
  if (raw && typeof raw === 'object') return sortedJson(raw);
  if (typeof raw !== 'string' || !raw.trim()) return '{}';
  try {
    return sortedJson(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

// calls: [{ id, name, arguments }] with client tool names.
export function turnFingerprint(text, calls = []) {
  return hash64(JSON.stringify([String(text ?? '').trim(),
    calls.map(call => [String(call.id ?? ''), String(call.name ?? ''), canonicalArguments(call.arguments)])]));
}

// The fingerprint of an assistant message as a client echoes it back in the history.
export function messageFingerprint(message) {
  const calls = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map(call => ({ id: call?.id, name: call?.function?.name, arguments: call?.function?.arguments }));
  return turnFingerprint(textOf(message?.content), calls);
}
