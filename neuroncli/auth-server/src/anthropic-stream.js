// Native Claude adapter, response side: Claude Messages stream events become OpenAI
// chat.completion chunks (streaming) or one chat.completion (non-streaming callers).
//
// Thinking summaries go out as `delta.reasoning_content`, the field normalizeReasoning yields
// for every other provider and the field Neuron reads. Neuron's OpenAI client folds
// reasoning_content into the same text block as content, so reasoning and answer text are
// separated by a blank line, and the replay record is also keyed by that combined text.
import Anthropic from '@anthropic-ai/sdk';
import { turnFingerprint } from './anthropic-request.js';

export const FINISH_REASONS = Object.freeze({ end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls',
  max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'content_filter', pause_turn: 'stop',
  compaction: 'stop' });
// Claude error type -> the HTTP status the gateway classifies by (classifyUpstreamFailure).
export const ERROR_STATUS = Object.freeze({ invalid_request_error: 400, authentication_error: 401,
  billing_error: 402, permission_error: 403, not_found_error: 404, request_too_large: 413,
  rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529 });
const REFUSAL_CATEGORIES = new Set(['cyber', 'bio', 'frontier_llm', 'reasoning_extraction', 'general_harms']);
const REPLAYABLE = new Set(['end_turn', 'tool_use', 'stop_sequence']);
const SEPARATOR = '\n\n';

// The fixed note sent with finish_reason 'content_filter'. Only a whitelisted category is named;
// stop_details.explanation is never forwarded (it may quote the prompt).
export function refusalNote(details) {
  const category = REFUSAL_CATEGORIES.has(details?.category) ? details.category : null;
  if (category === 'reasoning_extraction') {
    return 'Claude does not reproduce its internal reasoning. Ask for a short summary of the answer instead.';
  }
  return `Claude declined this request${category ? ` (safety category: ${category})` : ''}. Rephrase it or choose another model.`;
}

// The in-stream error body the gateway turns into UpstreamStreamError (by status_code).
export function streamErrorBody(error) {
  const body = error?.error?.error;
  const type = body?.type ?? error?.type;
  if (typeof type === 'string' && Object.hasOwn(ERROR_STATUS, type)) {
    return { type, code: type, status_code: ERROR_STATUS[type], message: String(body?.message ?? '').slice(0, 300) };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { type: 'api_connection_error', code: 'connection_error', status_code: 502, message: 'The connection to Claude was interrupted.' };
  }
  return { type: 'api_error', code: 'stream_error', status_code: 502, message: 'The Claude stream could not be read.' };
}

const count = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * Claude usage -> OpenAI usage. Total prompt = input + cache writes + cache reads (Claude's
 * input_tokens is only the uncached remainder); completion = output_tokens, thinking included.
 * prompt_tokens_details carries the cache split that billing prices separately.
 */
export function openaiUsage(usage = {}) {
  const input = count(usage.input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const output = count(usage.output_tokens);
  const write1h = Math.min(write, count(usage.cache_creation?.ephemeral_1h_input_tokens));
  const prompt = input + write + read;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write - write1h, cache_write_1h_tokens: write1h } };
}

// Resolved by the adapter's fetch tap on every upstream body chunk, pings included: the SDK
// drops `ping` events, so this is the only sign of life during a long silent thinking phase.
export class Liveness {
  next() {
    return (this.promise ||= new Promise(resolve => { this.resolve = resolve; }));
  }

  bytes() {
    const resolve = this.resolve;
    this.promise = null;
    this.resolve = null;
    resolve?.();
  }
}

export class ClaudeStreamTranslator {
  constructor({ model, toolNames = new Map(), now = Date.now }) {
    this.id = `chatcmpl-${crypto.randomUUID()}`;
    this.created = Math.floor(now() / 1000);
    this.model = model;
    this.toolNames = toolNames;
    this.blocks = [];
    this.nextTool = 0;
    this.started = false;
    this.lastKind = null; // 'reasoning' | 'content': the kind of the last emitted piece
    this.text = '';       // content only
    this.reasoning = '';  // reasoning_content pieces, separators included
    this.visible = '';    // every content and reasoning piece in order (what Neuron shows)
    this.usage = {};
    this.stopReason = null;
    this.stopDetails = null;
    this.finished = false;
    this.done = false;
    this.unknownBlocks = 0;
  }

  chunk(delta, finish = null) {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  // The role chunk is the commit point: nothing is emitted for message_start, so an error event
  // right after it can still fail over to another candidate.
  begin(out) {
    if (this.started) return;
    this.started = true;
    out.push(this.chunk({ role: 'assistant', content: '' }));
  }

  clientName(name) {
    return this.toolNames.get(name) ?? name;
  }

  takeUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
      if (Number.isFinite(usage[key])) this.usage[key] = usage[key];
    }
    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      this.usage.cache_creation = { ...this.usage.cache_creation, ...usage.cache_creation };
    }
  }

  emitReasoning(piece, out) {
    this.reasoning += piece;
    this.visible += piece;
    this.lastKind = 'reasoning';
    out.push(this.chunk({ reasoning_content: piece }));
  }

  addText(slot, text, out) {
    if (this.lastKind === 'reasoning') this.emitReasoning(SEPARATOR, out);
    slot.text += text;
    this.text += text;
    this.visible += text;
    this.lastKind = 'content';
    out.push(this.chunk({ content: text }));
  }

  addThinking(slot, text, out) {
    const piece = !slot.text && this.lastKind ? `${SEPARATOR}${text}` : text;
    slot.text += text;
    this.emitReasoning(piece, out);
  }

  translate(event) {
    const out = [];
    switch (event?.type) {
      case 'message_start':
        this.takeUsage(event.message?.usage);
        break;
      case 'content_block_start': {
        const block = event.content_block ?? {};
        const slot = { type: block.type };
        this.blocks[event.index] = slot;
        if (block.type === 'text') {
          this.begin(out);
          slot.text = '';
          if (block.text) this.addText(slot, block.text, out);
        } else if (block.type === 'thinking') {
          this.begin(out);
          slot.text = '';
          slot.signature = typeof block.signature === 'string' ? block.signature : '';
          if (block.thinking) this.addThinking(slot, block.thinking, out);
        } else if (block.type === 'tool_use') {
          this.begin(out);
          Object.assign(slot, { id: block.id, name: block.name, json: '', toolIndex: this.nextTool++ });
          out.push(this.chunk({ tool_calls: [{ index: slot.toolIndex, id: block.id, type: 'function',
            function: { name: this.clientName(block.name), arguments: '' } }] }));
        } else if (block.type === 'redacted_thinking') {
          slot.data = block.data;
        } else {
          this.unknownBlocks++; // kept out of the output; the turn is not replayable
        }
        break;
      }
      case 'content_block_delta': {
        const slot = this.blocks[event.index];
        const delta = event.delta ?? {};
        if (!slot) break;
        if (delta.type === 'text_delta' && delta.text && slot.type === 'text') this.addText(slot, delta.text, out);
        else if (delta.type === 'thinking_delta' && delta.thinking && slot.type === 'thinking') this.addThinking(slot, delta.thinking, out);
        else if (delta.type === 'signature_delta' && slot.type === 'thinking') slot.signature += delta.signature ?? '';
        else if (delta.type === 'input_json_delta' && delta.partial_json && slot.type === 'tool_use') {
          slot.json += delta.partial_json;
          out.push(this.chunk({ tool_calls: [{ index: slot.toolIndex, function: { arguments: delta.partial_json } }] }));
        }
        break;
      }
      case 'content_block_stop': {
        const slot = this.blocks[event.index];
        // A call without input fragments still hands the client valid JSON arguments.
        if (slot?.type === 'tool_use' && !slot.json) {
          slot.json = '{}';
          out.push(this.chunk({ tool_calls: [{ index: slot.toolIndex, function: { arguments: '{}' } }] }));
        }
        break;
      }
      case 'message_delta': {
        this.takeUsage(event.usage);
        if (this.finished) break;
        this.stopReason = event.delta?.stop_reason ?? null;
        this.stopDetails = event.delta?.stop_details ?? null;
        if (this.stopReason === 'pause_turn') console.warn('Claude paused a turn', { model: this.model });
        this.begin(out);
        const delta = this.stopReason === 'refusal' ? { refusal: refusalNote(this.stopDetails) } : {};
        out.push(this.chunk(delta, FINISH_REASONS[this.stopReason] ?? 'stop'));
        out.push({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
          choices: [], usage: openaiUsage(this.usage) });
        this.finished = true;
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
      default:
        break; // unknown event types: liveness only
    }
    return out;
  }

  toolCalls() {
    return this.blocks.filter(block => block?.type === 'tool_use')
      .map(block => ({ id: block.id, type: 'function', function: { name: this.clientName(block.name), arguments: block.json || '{}' } }));
  }

  // The exact content of this assistant turn, for replay into later requests. Null when the
  // turn ended abnormally, has no thinking, carries a block we do not understand, or a tool
  // input that is not valid JSON.
  turnRecord() {
    if (!REPLAYABLE.has(this.stopReason) || this.unknownBlocks) return null;
    const blocks = [];
    let thinking = false;
    for (const slot of this.blocks) {
      if (!slot) continue;
      if (slot.type === 'thinking') {
        if (!slot.signature) return null;
        blocks.push({ type: 'thinking', thinking: slot.text, signature: slot.signature });
        thinking = true;
      } else if (slot.type === 'redacted_thinking') {
        if (typeof slot.data !== 'string' || !slot.data) return null;
        blocks.push({ type: 'redacted_thinking', data: slot.data });
        thinking = true;
      } else if (slot.type === 'text') {
        if (/\S/.test(slot.text)) blocks.push({ type: 'text', text: slot.text });
      } else if (slot.type === 'tool_use') {
        let input;
        try {
          input = JSON.parse(slot.json || '{}');
        } catch {
          return null;
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
        blocks.push({ type: 'tool_use', id: slot.id, name: slot.name, input });
      } else {
        return null;
      }
    }
    if (!thinking) return null;
    const calls = this.toolCalls().map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
    const fingerprints = [turnFingerprint(this.text, calls)];
    // Clients that echo reasoning_content inside the assistant text (Neuron) match this one.
    if (this.reasoning) {
      const combined = turnFingerprint(this.visible, calls);
      if (combined !== fingerprints[0]) fingerprints.push(combined);
    }
    return { fingerprints, blocks };
  }

  // The aggregated chat.completion for non-streaming callers.
  completion() {
    const calls = this.toolCalls();
    const message = { role: 'assistant', content: calls.length && !this.text ? null : this.text };
    // One field here, so thinking blocks are joined without the separators the stream adds
    // between reasoning and answer text.
    const reasoning = this.blocks.filter(block => block?.type === 'thinking' && block.text).map(block => block.text).join(SEPARATOR);
    if (reasoning) message.reasoning_content = reasoning;
    if (calls.length) message.tool_calls = calls;
    if (this.stopReason === 'refusal') message.refusal = refusalNote(this.stopDetails);
    return { id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [{ index: 0, message, finish_reason: FINISH_REASONS[this.stopReason] ?? 'stop' }],
      usage: openaiUsage(this.usage) };
  }
}

const KEEPALIVE = Symbol('keepalive');
const DONE = 'data: [DONE]\n\n';
const KEEPALIVE_COMMENT = ': keep-alive\n\n';

class StreamEndedEarly extends Error {
  constructor() {
    super('The Claude stream ended before message_delta');
    this.name = 'StreamEndedEarly';
  }
}

/**
 * The OpenAI SSE body for a Claude stream. Pull-based: an SDK event is read only when the
 * consumer asks for data. Upstream bytes without an event (pings) produce a `: keep-alive`
 * comment at most every keepAliveMs, so SseEventReader.lastByteAt follows real upstream
 * liveness and a dead upstream still trips the gateway's idle timeout. A mid-stream failure
 * becomes one `{error:{...,status_code}}` event; an abort closes the stream quietly.
 */
export function openAIStream({ sdkStream, translator, liveness, signal = null, onTurn = null, keepAliveMs = 10_000, now = Date.now }) {
  const encoder = new TextEncoder();
  const iterator = sdkStream[Symbol.asyncIterator]();
  const queue = [];
  let pending = null;
  let lastOut = now();
  let closed = false;
  const frame = item => (typeof item === 'string' ? item : `data: ${JSON.stringify(item)}\n\n`);
  const close = controller => {
    closed = true;
    try { controller.close(); } catch { /* consumer gone */ }
  };
  return new ReadableStream({
    async pull(controller) {
      if (closed) return;
      try {
        while (!queue.length) {
          if (translator.done) {
            if (!translator.finished) throw new StreamEndedEarly();
            try { onTurn?.(); } catch { /* replay is best effort */ }
            queue.push(DONE);
            break;
          }
          // `pending` always has the race's handlers attached, so it never rejects unhandled.
          pending ||= iterator.next();
          const step = await Promise.race([pending, liveness ? liveness.next().then(() => KEEPALIVE) : pending]);
          if (closed) return;
          if (step === KEEPALIVE) {
            if (now() - lastOut >= keepAliveMs) queue.push(KEEPALIVE_COMMENT);
            continue;
          }
          pending = null;
          if (step.done) {
            if (signal?.aborted) {
              close(controller);
              return;
            }
            translator.done = true; // after message_delta this still completes with [DONE]
            continue;
          }
          queue.push(...translator.translate(step.value));
        }
        const item = queue.shift();
        controller.enqueue(encoder.encode(frame(item)));
        lastOut = now();
        if (item === DONE) close(controller);
      } catch (error) {
        if (closed) return;
        if (signal?.aborted) {
          close(controller);
          return;
        }
        closed = true;
        try {
          controller.enqueue(encoder.encode(frame({ error: streamErrorBody(error) })));
          controller.close();
        } catch { /* consumer gone */ }
      }
    },
    cancel() {
      closed = true;
      sdkStream.controller?.abort();
    },
  });
}
