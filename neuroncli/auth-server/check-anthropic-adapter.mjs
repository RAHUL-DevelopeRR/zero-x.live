// Offline tests for the native Claude adapter: src/anthropic-request.js (mapping),
// src/anthropic-stream.js (translation), src/anthropic-turns.js (preserved-thinking replay) and
// src/anthropic-adapter.js (transport). No network: the real @anthropic-ai/sdk runs against a
// stubbed globalThis.fetch serving canned Claude SSE streams and error responses, and the
// adapter's output goes through the gateway's own startCompletion / createCompletionStream.
//
// The adapter is not registered in providers.js yet (the integration step does that); this
// script registers it in ADAPTERS for its own run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ADAPTERS, buildUpstreamPayload, classifyUpstreamFailure, createCompletionStream, normalizeCompletion, startCompletion,
} from './src/providers.js';
import { FailureKind } from './src/provider-health.js';
import { AnthropicAdapter, anthropicFetch, isAnthropicUrl, metadataUserId } from './src/anthropic-adapter.js';
import {
  ANTHROPIC, BINDING_BETA, ClaudeRequestError, claudeEffort, claudeTraits, mapMessages, messageFingerprint, safeName,
  toClaudeRequest, turnFingerprint,
} from './src/anthropic-request.js';
import { ClaudeStreamTranslator, openaiUsage, refusalNote, streamErrorBody } from './src/anthropic-stream.js';
import { ClaudeTurnCache, claudeTurnHooks } from './src/anthropic-turns.js';

const KEY = 'sk-ant-api03-offline-test-key-0123456789abcdefghij';
const ENV = Object.freeze({ ANTHROPIC_API_KEY: KEY });
const POOL = Object.freeze({ tier: 'paid', key_var: 'ANTHROPIC_API_KEY' });
const SESSION = Object.freeze({ user_id: 'user-123', account_backed: true });
const OPUS = Object.freeze({ id: 'anthropic/claude-opus-5-5', provider: 'anthropic', upstream_model: 'claude-opus-5-5',
  max_output_tokens: 32000 });
const SONNET = Object.freeze({ ...OPUS, id: 'anthropic/claude-sonnet-5-5', upstream_model: 'claude-sonnet-5-5' });
const UNKNOWN = Object.freeze({ ...OPUS, id: 'anthropic/claude-future-9', upstream_model: 'claude-future-9' });
const TIMEOUTS = Object.freeze({ ttfbMs: 3000, idleMs: 3000 });
const NEVER = ['temperature', 'top_p', 'top_k', 'seed', 'presence_penalty', 'frequency_penalty', 'user', 'logprobs',
  'n', 'stream_options', 'speed', 'inference_geo', 'fallbacks'];
const BODY_KEYS = new Set(['model', 'max_tokens', 'system', 'tools', 'tool_choice', 'stop_sequences', 'thinking',
  'output_config', 'metadata', 'messages', 'cache_control', 'stream']);

// ── Harness ──

const logged = [];
const consoleOriginal = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  consoleOriginal[level] = console[level];
  console[level] = (...args) => {
    logged.push(args.map(arg => (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })())).join(' '));
    if (level === 'error') consoleOriginal.error(...args);
  };
}
const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(name);
  } catch (error) {
    consoleOriginal.error(`FAIL: ${name}`);
    throw error;
  }
}

const realFetch = globalThis.fetch;
const calls = [];
let upstream = null; // call => Response
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const call = { url, init, headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    signal: init.signal };
  calls.push(call);
  if (!upstream) throw new Error('Unexpected fetch in the Claude adapter checks');
  return upstream(call);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = item => (item.raw !== undefined ? item.raw : `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);

// A streaming Claude response. Items are events, { raw }, { delay: ms } or { hang: true }; the
// body errors with an AbortError when the request signal aborts, as undici's does.
function sseResponse(items, call, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let position = 0;
  let closed = false;
  let timer = null;
  const stream = new ReadableStream({
    start(controller) {
      call?.signal?.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try { controller.error(new DOMException('This operation was aborted', 'AbortError')); } catch { /* closed */ }
      }, { once: true });
    },
    async pull(controller) {
      while (position < items.length) {
        if (closed) return;
        const item = items[position++];
        if (item.hang) return new Promise(() => {});
        if (item.delay) {
          await new Promise(resolve => { timer = setTimeout(resolve, item.delay); });
          continue;
        }
        if (closed) return;
        controller.enqueue(encoder.encode(frame(item)));
        return;
      }
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream' } });
}

const httpError = (status, type, message, headers = {}) => () => new Response(
  JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_err' }),
  { status, headers: { 'content-type': 'application/json', 'request-id': 'req_err', ...headers } });

// Claude stream events.
const E = {
  start: (usage = {}) => ({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant',
    model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, ...usage } } }),
  text: (index, pieces) => [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...pieces.map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index }],
  thinking: (index, pieces, signature) => [{ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...pieces.map(thinking => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })),
    { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
    { type: 'content_block_stop', index }],
  tool: (index, id, name, fragments) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...fragments.map(partial_json => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
    { type: 'content_block_stop', index }],
  delta: (stop_reason, usage = { output_tokens: 20 }, stop_details = null) => ({ type: 'message_delta',
    delta: { stop_reason, stop_sequence: null, stop_details }, usage }),
  stop: () => ({ type: 'message_stop' }),
  ping: () => ({ type: 'ping' }),
  error: (type, message) => ({ type: 'error', error: { type, message } }),
};

const AGENT_TURN = [
  E.start({ input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } }),
  E.ping(),
  ...E.thinking(0, ['Plan the', ' reads.'], 'sig-one'),
  ...E.text(1, ["I'll read ", 'both files.']),
  ...E.thinking(2, ['Reading now.'], 'sig-two'),
  ...E.tool(3, 'toolu_01A', safeName('a.b:c'), ['{"path":', '"a.txt"}']),
  ...E.tool(4, 'toolu_01B', 'read_file', ['{"path":"b.txt"}']),
  E.delta('tool_use', { output_tokens: 200 }),
  E.stop(),
];
const AGENT_USAGE = { prompt_tokens: 1150, completion_tokens: 200, total_tokens: 1350,
  prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50, cache_write_1h_tokens: 0 } };
const AGENT_TEXT = "I'll read both files.";
const AGENT_VISIBLE = "Plan the reads.\n\nI'll read both files.\n\nReading now.";
const SIMPLE_END = [E.start(), ...E.text(0, ['Done.']), E.delta('end_turn', { output_tokens: 5 }), E.stop()];

const fn = (name, properties = { path: { type: 'string' } }) => ({ type: 'function', function: { name,
  description: `Tool ${name}`, parameters: { type: 'object', properties, required: Object.keys(properties) } } });
const TOOLS = [fn('a.b:c'), fn('read_file')];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
const toolMessage = (id, content, extra = {}) => ({ role: 'tool', tool_call_id: id, content, ...extra });
const payloadFor = (messages, { entry = OPUS, stream = true, maxTokens = 16000, ...extra } = {}) =>
  buildUpstreamPayload(entry, { model: entry.id, messages, stream, ...extra }, maxTokens);
const stripCache = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'cache_control' ? undefined : item)));

async function readFrames(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let errored = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        frames.push({ raw: buffer.slice(0, boundary), at: Date.now() });
        buffer = buffer.slice(boundary + 2);
      }
    }
  } catch (error) {
    errored = error;
  }
  return { frames, errored };
}
const dataOf = frames => frames.filter(item => item.raw.startsWith('data: ')).map(item => item.raw.slice(6))
  .map(data => (data === '[DONE]' ? '[DONE]' : JSON.parse(data)));
const deltas = events => events.filter(event => event !== '[DONE]' && event.choices?.length).map(event => event.choices[0].delta);

// The adapter's own output for one call.
async function adapterRun(adapter, { entry = OPUS, payload, env = ENV, request = {}, signal = new AbortController().signal } = {}) {
  const response = await adapter.chatCompletion(env, SESSION, entry, payload, signal, POOL, request);
  if (!response.ok || !payload.stream) return { response };
  const { frames, errored } = await readFrames(response.body);
  return { response, frames, events: dataOf(frames), errored };
}

// The gateway path: startCompletion, then createCompletionStream for committed streams.
async function gatewayRun({ entry = OPUS, payload, env = ENV, request = {}, timeouts = TIMEOUTS, clientSignal } = {}) {
  const started = await startCompletion(env, SESSION, entry, POOL, payload, { clientSignal, timeouts, request });
  if (!started.ok || !payload.stream) return { started };
  let finish = null;
  const stream = createCompletionStream({ ...started.stream, model: entry.id, controller: started.controller, clientSignal,
    timeouts, requestId: 'req_test', env, onFinish: async outcome => { finish = outcome; } });
  const { frames, errored } = await readFrames(stream);
  return { started, frames, events: dataOf(frames), errored, finish };
}

const registered = Object.hasOwn(ADAPTERS, 'anthropic') ? ADAPTERS.anthropic : undefined;
const adapter = new AnthropicAdapter();
ADAPTERS.anthropic = adapter;

try {
  // ── Request mapping ──

  await test('system: leading system/developer messages become top-level blocks; later ones are native only where the API allows', () => {
    const input = [
      { role: 'system', content: 'Core rules.' },
      { role: 'developer', content: [{ type: 'text', text: 'Developer note.' }] },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'system', content: 'Mode: terse.' },     // after a user turn, followed by an assistant: native
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'system', content: 'Injected state.' },  // followed by a user message: folded into it
      { role: 'user', content: 'u4' },
      { role: 'system', content: 'Last word.' },       // last: native
    ];
    const { body } = toClaudeRequest(OPUS, payloadFor(input));
    assert.deepEqual(body.system, [{ type: 'text', text: 'Core rules.' },
      { type: 'text', text: 'Developer note.', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.messages, [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'system', content: 'Mode: terse.' },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: 'u3' },
        { type: 'text', text: '<system-reminder>\nInjected state.\n</system-reminder>' }, { type: 'text', text: 'u4' }] },
      { role: 'system', content: 'Last word.' },
    ]);
    // The placement rules hold for every native system turn, and user/assistant alternate.
    const roles = body.messages.map(message => message.role);
    roles.forEach((role, index) => {
      if (role !== 'system') return;
      assert.equal(roles[index - 1], 'user');
      assert.ok(index === roles.length - 1 || roles[index + 1] === 'assistant');
    });
    const spoken = roles.filter(role => role !== 'system');
    assert.equal(spoken[0], 'user');
    spoken.forEach((role, index) => index && assert.notEqual(role, spoken[index - 1]));
    // A Claude id without verified traits never gets a native mid-conversation system turn.
    const plain = toClaudeRequest(UNKNOWN, payloadFor(input)).body;
    assert.ok(!plain.messages.some(message => message.role === 'system'));
    assert.match(JSON.stringify(plain.messages.at(-1)), /Last word/);
  });

  await test('tools: separate, out-of-order tool messages become one user turn in tool_use order; is_error is native; gaps are synthesized', () => {
    const history = [
      { role: 'user', content: 'Read three files.' },
      { role: 'assistant', content: null, tool_calls: [call('toolu_A', 'read_file', '{"path":"a"}'),
        call('toolu_B', 'read_file', '{"path":"b"}'), call('call.1/x', 'read_file', '{"path":"c"}')] },
      toolMessage('call.1/x', 'C body'),
      toolMessage('toolu_A', 'A failed', { is_error: true }),
      toolMessage('call_zz', 'stray'),
      { role: 'user', content: 'Also check the README.' },
    ];
    const { body } = toClaudeRequest(OPUS, payloadFor(history, { tools: [fn('read_file')] }));
    const foreign = body.messages[1].content[2].id;
    assert.match(foreign, /^call_1_x_[0-9a-f]{16}$/, 'foreign ids are rewritten');
    assert.deepEqual(body.messages[2], { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_A', content: 'A failed', is_error: true },
      { type: 'tool_result', tool_use_id: 'toolu_B', is_error: true, content: 'No result was returned for this tool call.' },
      { type: 'tool_result', tool_use_id: foreign, content: 'C body' },
      { type: 'text', text: 'Tool result (call_zz): stray' },
      { type: 'text', text: 'Also check the README.' },
    ] });
    // A final assistant turn with calls gets synthesized results, not a 400.
    const pending = toClaudeRequest(OPUS, payloadFor(history.slice(0, 2), { tools: [fn('read_file')] })).body;
    assert.equal(pending.messages.at(-1).role, 'user');
    assert.equal(pending.messages.at(-1).content.length, 3);
    assert.ok(pending.messages.at(-1).content.every(block => block.type === 'tool_result' && block.is_error));
    // A final assistant turn without calls is prefill: refused before any upstream call.
    assert.throws(() => mapMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Sure, ' }]), ClaudeRequestError);
    // A conversation that starts with an assistant turn gets a leading user turn; empty turns get placeholders.
    const odd = mapMessages([{ role: 'assistant', content: '' }, { role: 'user', content: '   ' }]);
    assert.deepEqual(odd.messages, [
      { role: 'user', content: [{ type: 'text', text: 'Continue the conversation.' }] },
      { role: 'assistant', content: [{ type: 'text', text: '(no response)' }] },
      { role: 'user', content: [{ type: 'text', text: '(empty)' }] },
    ]);
  });

  await test('images: data URLs become base64 blocks, https URLs url sources; SVG and http:// are a synthesized 400 (INVALID, no upstream call)', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { messages } = mapMessages([{ role: 'user', content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'high' } },
      { type: 'image_url', image_url: 'https://example.com/chart.webp' },
    ] }]);
    assert.deepEqual(messages[0].content.slice(1), [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/chart.webp' } },
    ]);
    // Images inside tool results are mapped too.
    const inTool = mapMessages([{ role: 'user', content: 'shot' },
      { role: 'assistant', content: null, tool_calls: [call('toolu_S', 'screenshot', '{}')] },
      toolMessage('toolu_S', [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }])]);
    assert.equal(inTool.messages[2].content[0].content[0].type, 'image');
    for (const url of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'http://example.com/a.png']) {
      assert.throws(() => mapMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]), ClaudeRequestError);
      const before = calls.length;
      const started = await startCompletion(ENV, SESSION, OPUS, POOL,
        payloadFor([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]), { timeouts: TIMEOUTS });
      assert.equal(started.ok, false);
      assert.equal(started.status, 400);
      assert.equal(classifyUpstreamFailure(started.status, started.bodyText, started.headers).kind, FailureKind.INVALID);
      assert.equal(calls.length, before, 'no upstream call');
    }
  });

  await test('tools: object input_schema, eager_input_streaming only when streaming, strict dropped, one breakpoint on the last tool, names sanitized', () => {
    const tools = [{ type: 'function', function: { name: 'a.b:c', description: 'Odd name', strict: true,
      parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } } },
    { type: 'function', function: { name: 'read_file', parameters: { properties: { path: { type: 'string' } } } } }];
    const history = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok', tool_calls: [call('toolu_1', 'a.b:c', '{"q":"x"}')] },
      toolMessage('toolu_1', 'done')];
    const streamed = toClaudeRequest(OPUS, payloadFor(history, { tools }));
    const odd = safeName('a.b:c');
    assert.match(odd, /^a_b_c_[0-9a-f]{16}$/);
    assert.deepEqual(streamed.body.tools, [
      { name: odd, description: 'Odd name', input_schema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
        eager_input_streaming: true },
      { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } }, eager_input_streaming: true,
        cache_control: { type: 'ephemeral' } },
    ]);
    assert.equal(streamed.body.messages[1].content[1].name, odd, 'history uses the same upstream name');
    assert.equal(streamed.toolNames.get(odd), 'a.b:c');
    const buffered = toClaudeRequest(OPUS, payloadFor(history, { tools, stream: false }));
    assert.ok(buffered.body.tools.every(tool => !('eager_input_streaming' in tool)));
    assert.equal(buffered.body.stream, true, 'upstream is always streamed');
    assert.throws(() => toClaudeRequest(OPUS, payloadFor(history, { tools: [{ type: 'function',
      function: { name: 'bad', parameters: { type: 'array' } } }] })), ClaudeRequestError);
  });

  await test("tool_choice: forced choices become auto plus a trailing system note; 'any' and 'tool' are never sent", () => {
    const base = [{ role: 'user', content: 'Weather in Paris?' }];
    const tools = [fn('get_weather', { city: { type: 'string' } })];
    const note = choice => {
      const { body } = toClaudeRequest(OPUS, payloadFor(base, { tools, tool_choice: choice }));
      assert.ok(!/"type":"(any|tool)"/.test(JSON.stringify(body)), `${JSON.stringify(choice)} must not force a tool`);
      return body;
    };
    for (const choice of ['required', { type: 'any' }]) {
      const body = note(choice);
      assert.deepEqual(body.tool_choice, { type: 'auto' });
      assert.deepEqual(body.messages.at(-1), { role: 'system', content: 'You must call at least one of the provided tools in this response.' });
    }
    for (const choice of [{ type: 'function', function: { name: 'get_weather' } }, { type: 'tool', name: 'get_weather' }]) {
      const body = note(choice);
      assert.deepEqual(body.tool_choice, { type: 'auto' });
      assert.equal(body.messages.at(-1).content, 'You must call the get_weather tool in this response.');
    }
    assert.deepEqual(note('none').tool_choice, { type: 'none' });
    assert.equal(note('auto').messages.at(-1).role, 'user', 'no note for auto');
    assert.deepEqual(toClaudeRequest(OPUS, payloadFor(base, { tools, parallel_tool_calls: false })).body.tool_choice,
      { type: 'auto', disable_parallel_tool_use: true });
    // A trailing client system message absorbs the note (two system turns in a row are not allowed).
    const merged = toClaudeRequest(OPUS, payloadFor([...base, { role: 'system', content: 'Be brief.' }], { tools, tool_choice: 'required' })).body;
    assert.deepEqual(merged.messages.at(-1), { role: 'system',
      content: 'Be brief.\nYou must call at least one of the provided tools in this response.' });
    // json_object becomes a note; json_schema becomes output_config.format next to the effort.
    const jsonObject = toClaudeRequest(OPUS, payloadFor(base, { response_format: { type: 'json_object' } })).body;
    assert.equal(jsonObject.messages.at(-1).content, 'Respond with a single JSON object and no other text.');
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    const jsonSchema = toClaudeRequest(OPUS, payloadFor(base, { response_format: { type: 'json_schema', json_schema: { name: 'x', schema } } })).body;
    assert.deepEqual(jsonSchema.output_config, { effort: 'medium', format: { type: 'json_schema', schema } });
    // stop becomes stop_sequences without whitespace-only entries.
    assert.deepEqual(toClaudeRequest(OPUS, payloadFor(base, { stop: ['END', '  '] })).body.stop_sequences, ['END']);
  });

  await test('sampling: temperature, top_p, top_k, seed, penalties, user, n, logprobs and stream_options are never sent', () => {
    const raw = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true, temperature: 0.2, top_p: 0.9,
      top_k: 40, seed: 7, presence_penalty: 1, frequency_penalty: 1, user: 'someone', n: 1, logprobs: true,
      stream_options: { include_usage: true }, speed: 'fast', inference_geo: 'us', fallbacks: 'default' };
    for (const payload of [raw, buildUpstreamPayload(OPUS, { model: OPUS.id, ...raw }, 100)]) {
      for (const entry of [OPUS, SONNET, UNKNOWN]) {
        const { body } = toClaudeRequest(entry, payload);
        for (const key of Object.keys(body)) assert.ok(BODY_KEYS.has(key), `unexpected body key ${key}`);
        for (const key of NEVER) assert.ok(!(key in body), `${key} must not be sent`);
      }
    }
  });

  await test("effort and thinking: explicit 'medium' default, never 'disabled'; Sonnet 'none' is between_tools; unknown ids get plain requests", () => {
    const base = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true };
    const request = (entry, extra = {}, options = {}) => toClaudeRequest(entry, { ...base, ...extra }, options);
    for (const entry of [OPUS, SONNET]) {
      const { body, betas } = request(entry);
      assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
      assert.deepEqual(body.output_config, { effort: 'medium' });
      assert.deepEqual(betas, [BINDING_BETA]);
      assert.deepEqual(request(entry, { reasoning_effort: 'high' }).body.output_config, { effort: 'high' });
      assert.deepEqual(request(entry, { reasoning_effort: 'minimal' }).body.output_config, { effort: 'low' });
      assert.deepEqual(request(entry, { reasoning_effort: 'default' }).body.output_config, { effort: 'medium' });
    }
    const opusNone = request(OPUS, { reasoning_effort: 'none' });
    assert.equal(opusNone.body.thinking.type, 'adaptive', 'thinking cannot be turned off on Opus 5.5');
    assert.deepEqual(opusNone.body.output_config, { effort: 'low' });
    const sonnetNone = request(SONNET, { reasoning_effort: 'none' });
    assert.deepEqual(sonnetNone.body.thinking, { type: 'between_tools' }, 'no display or block_binding beside between_tools');
    assert.deepEqual(sonnetNone.body.output_config, { effort: 'low' });
    assert.deepEqual(sonnetNone.betas, []);
    assert.equal(sonnetNone.rememberTurns, false);
    const plain = request(UNKNOWN, { reasoning_effort: 'high' });
    assert.ok(!('thinking' in plain.body) && !('output_config' in plain.body));
    assert.deepEqual(plain.betas, []);
    const noBeta = request(OPUS, {}, { bindingBeta: false });
    assert.deepEqual(noBeta.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(noBeta.betas, []);
    for (const value of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'default', 'xhigh']) {
      for (const entry of [OPUS, SONNET, UNKNOWN]) {
        const text = JSON.stringify(request(entry, value === undefined ? {} : { reasoning_effort: value }).body);
        assert.ok(!/disabled|budget_tokens|"enabled"/.test(text), `${entry.upstream_model} ${value}`);
      }
    }
    assert.deepEqual(claudeEffort(claudeTraits('claude-opus-5-5'), 'xhigh'), { effort: 'medium', thinkingOff: false });
    assert.throws(() => request({ ...OPUS, upstream_model: 'gpt-5' }), ClaudeRequestError);
  });

  await test('caching: identical bodies serialize identically, the next turn extends the previous messages, at most 3 breakpoints', () => {
    const system = { role: 'system', content: 'You are Neuron, a coding agent. '.repeat(40) };
    const turnN = [system, { role: 'user', content: 'Read a.txt and b.txt' }];
    const assistantN = { role: 'assistant', content: AGENT_TEXT,
      tool_calls: [call('toolu_01A', 'a.b:c', '{"path":"a.txt"}'), call('toolu_01B', 'read_file', '{"path":"b.txt"}')] };
    const turnN1 = [...turnN, assistantN, toolMessage('toolu_01A', 'A'), toolMessage('toolu_01B', 'B')];
    const first = JSON.stringify(toClaudeRequest(OPUS, payloadFor(turnN, { tools: TOOLS }), { metadataUserId: 'abc' }).body);
    const second = JSON.stringify(toClaudeRequest(OPUS, payloadFor(structuredClone(turnN), { tools: structuredClone(TOOLS) }), { metadataUserId: 'abc' }).body);
    assert.equal(first, second);
    const bodyN = stripCache(JSON.parse(first));
    const bodyN1 = stripCache(toClaudeRequest(OPUS, payloadFor(turnN1, { tools: TOOLS }), { metadataUserId: 'abc' }).body);
    assert.deepEqual(bodyN1.tools, bodyN.tools);
    assert.deepEqual(bodyN1.system, bodyN.system);
    assert.deepEqual(bodyN1.thinking, bodyN.thinking);
    assert.deepEqual(bodyN1.output_config, bodyN.output_config);
    assert.deepEqual(bodyN1.messages.slice(0, bodyN.messages.length), bodyN.messages);
    for (const body of [JSON.parse(first), toClaudeRequest(OPUS, payloadFor(turnN1, { tools: TOOLS })).body]) {
      assert.equal(JSON.stringify(body).match(/"cache_control"/g).length, 3);
      assert.deepEqual(body.cache_control, { type: 'ephemeral' }, 'automatic 5-minute breakpoint; never a 1-hour TTL');
      assert.ok(!JSON.stringify(body).includes('"ttl"'));
    }
  });

  // ── Stream translation through the real SDK ──

  await test('stream: role chunk first, thinking as reasoning_content, parallel tool calls indexed 0 and 1, finish, usage with cache tokens, [DONE]', async () => {
    upstream = request => sseResponse(AGENT_TURN, request);
    const before = calls.length;
    const { events, frames } = await adapterRun(adapter, { payload: payloadFor([{ role: 'user', content: 'Read a and b' }], { tools: TOOLS }) });
    assert.equal(calls.length - before, 1);
    assert.ok(frames.every(item => item.raw.startsWith('data: ')), 'no keep-alive comments in a fast stream');
    assert.deepEqual(deltas(events), [
      { role: 'assistant', content: '' },
      { reasoning_content: 'Plan the' },
      { reasoning_content: ' reads.' },
      { reasoning_content: '\n\n' },
      { content: "I'll read " },
      { content: 'both files.' },
      { reasoning_content: '\n\nReading now.' },
      { tool_calls: [{ index: 0, id: 'toolu_01A', type: 'function', function: { name: 'a.b:c', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
      { tool_calls: [{ index: 1, id: 'toolu_01B', type: 'function', function: { name: 'read_file', arguments: '' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '{"path":"b.txt"}' } }] },
      {},
    ]);
    const finish = events.filter(event => event !== '[DONE]' && event.choices?.[0]?.finish_reason);
    assert.deepEqual(finish.map(event => event.choices[0].finish_reason), ['tool_calls']);
    const usage = events.find(event => event !== '[DONE]' && event.usage);
    assert.deepEqual(usage.choices, []);
    assert.deepEqual(usage.usage, AGENT_USAGE);
    assert.equal(events.at(-1), '[DONE]');
    // What Neuron shows (content and reasoning_content folded into one text block, in order).
    assert.equal(deltas(events).map(delta => delta.content || delta.reasoning_content || '').join(''), AGENT_VISIBLE);

    // The upstream request.
    const sent = calls.at(-1);
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(sent.init.redirect, 'manual');
    assert.equal(sent.init.method, 'POST');
    assert.equal(sent.headers.get('x-api-key'), KEY);
    assert.equal(sent.headers.get('authorization'), null);
    assert.equal(sent.headers.get('anthropic-beta'), BINDING_BETA);
    assert.ok(sent.headers.get('anthropic-version'));
    assert.equal(sent.body.model, 'claude-opus-5-5');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.max_tokens, 16000);
    const expectedUser = createHash('sha256').update('zx-user:user-123').digest('hex').slice(0, 32);
    assert.deepEqual(sent.body.metadata, { user_id: expectedUser });
    assert.equal(await metadataUserId('user-123'), expectedUser);
    assert.equal(await metadataUserId(''), null);
    assert.ok(!JSON.stringify(sent.body).includes('user-123'), 'the internal user id is never sent');

    // Through the gateway: the first data event commits, and onFinish gets the usage for settlement.
    const gateway = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'Read a and b' }], { tools: TOOLS }) });
    assert.equal(gateway.started.ok, true);
    assert.deepEqual(JSON.parse(gateway.started.stream.first).choices[0].delta, { role: 'assistant', content: '' });
    assert.equal(gateway.finish.status, 'ok');
    assert.deepEqual(gateway.finish.usage, AGENT_USAGE);
    const gatewayDeltas = deltas(gateway.events);
    assert.equal(gatewayDeltas.filter(delta => delta.reasoning_content).map(delta => delta.reasoning_content).join(''),
      'Plan the reads.\n\n\n\nReading now.');
    assert.equal(gatewayDeltas.filter(delta => delta.content).map(delta => delta.content).join(''), AGENT_TEXT);
    assert.deepEqual(gatewayDeltas.flatMap(delta => delta.tool_calls ?? []).filter(item => item.id).map(item => [item.index, item.id, item.function.name]),
      [[0, 'toolu_01A', 'a.b:c'], [1, 'toolu_01B', 'read_file']]);
    assert.equal(gateway.events.at(-1), '[DONE]');
  });

  await test('finish_reason: end_turn, stop_sequence, max_tokens, model_context_window_exceeded, refusal and pause_turn', async () => {
    const expected = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', model_context_window_exceeded: 'length',
      refusal: 'content_filter', pause_turn: 'stop', tool_use: 'tool_calls' };
    for (const [reason, finishReason] of Object.entries(expected)) {
      upstream = request => sseResponse([E.start(), ...E.text(0, ['ok']), E.delta(reason), E.stop()], request);
      const { events } = await adapterRun(adapter, { payload: payloadFor([{ role: 'user', content: 'hi' }]) });
      const finish = events.find(event => event !== '[DONE]' && event.choices?.[0]?.finish_reason);
      assert.equal(finish.choices[0].finish_reason, finishReason, reason);
    }
    // A refusal before any output still commits (role chunk) and carries only the fixed note.
    upstream = request => sseResponse([E.start(), E.delta('refusal', { output_tokens: 0 },
      { category: 'cyber', explanation: 'quoted secret prompt words' }), E.stop()], request);
    const refused = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'something' }]) });
    assert.equal(refused.finish.status, 'ok');
    const finish = refused.events.find(event => event !== '[DONE]' && event.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'content_filter');
    assert.equal(finish.choices[0].delta.refusal, refusalNote({ category: 'cyber' }));
    assert.match(finish.choices[0].delta.refusal, /safety category: cyber/);
    assert.ok(!JSON.stringify(refused.events).includes('quoted secret prompt words'));
    assert.ok(!deltas(refused.events).some(delta => delta.content), 'the note never becomes assistant content');
    assert.doesNotMatch(refusalNote({ category: 'weird<script>' }), /weird/);
    assert.match(refusalNote({ category: 'reasoning_extraction' }), /does not reproduce its internal reasoning/);
    assert.match(refusalNote(null), /^Claude declined this request\. /);
  });

  await test('usage: cache reads and writes count toward prompt_tokens; message_delta values override message_start', () => {
    assert.deepEqual(openaiUsage({ input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 80000,
      output_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 } }),
    { prompt_tokens: 84000, completion_tokens: 2000, total_tokens: 86000,
      prompt_tokens_details: { cached_tokens: 80000, cache_write_tokens: 2000, cache_write_1h_tokens: 1000 } });
    assert.deepEqual(openaiUsage({}), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 } });
    const translator = new ClaudeStreamTranslator({ model: OPUS.id });
    translator.translate(E.start({ input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 1 }));
    translator.translate({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_details: null },
      usage: { input_tokens: 7, cache_read_input_tokens: null, output_tokens: 42 } });
    assert.deepEqual(translator.completion().usage, { prompt_tokens: 17, completion_tokens: 42, total_tokens: 59,
      prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 0, cache_write_1h_tokens: 0 } });
    assert.deepEqual(adapter.extractUsage({ usage: AGENT_USAGE }), { ...AGENT_USAGE, cache_read_tokens: 1000, cache_write_tokens: 50 });
  });

  // ── Errors ──

  await test('errors: 429 (Retry-After), 529, 500, 401, 403, 402, 404, 413, context 400, other 400 and 302 classify for failover', async () => {
    const cases = [
      [httpError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '7' }),
        429, FailureKind.RATE_LIMITED],
      [httpError(529, 'overloaded_error', 'Overloaded'), 529, FailureKind.SERVER],
      [httpError(500, 'api_error', 'Internal server error'), 500, FailureKind.SERVER],
      [httpError(401, 'authentication_error', 'invalid x-api-key'), 401, FailureKind.AUTH],
      [httpError(403, 'permission_error', 'Not allowed'), 403, FailureKind.AUTH],
      [httpError(404, 'not_found_error', 'model: claude-opus-5-5'), 404, FailureKind.MODEL_UNAVAILABLE],
      [httpError(413, 'request_too_large', 'Request exceeds the maximum size'), 413, FailureKind.CONTEXT],
      [httpError(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'), 400, FailureKind.CONTEXT],
      [httpError(400, 'invalid_request_error', 'messages.0.content: field required'), 400, FailureKind.INVALID],
    ];
    for (const [response, status, kind] of cases) {
      upstream = response;
      const before = calls.length;
      const started = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS });
      assert.equal(calls.length - before, 1, `${status}: one call, no SDK retry`);
      assert.equal(started.ok, false);
      assert.equal(started.status, status);
      const failure = classifyUpstreamFailure(started.status, started.bodyText, started.headers);
      assert.equal(failure.kind, kind, `${status} ${started.bodyText}`);
      if (status === 429) {
        assert.equal(failure.retryAfterSeconds, 7);
        assert.equal(started.headers.get('retry-after'), '7');
      }
    }
    // 402 billing_error arrives with its status and Claude's body. provider-health.js maps 402 to
    // AUTH once the integration's one-line failureKindForStatus change lands; either way it is a
    // provider-side failure: refunded to the user and never "free capacity exhausted".
    upstream = httpError(402, 'billing_error', 'Your credit balance is too low');
    const billing = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS });
    assert.equal(billing.status, 402);
    assert.equal(JSON.parse(billing.bodyText).error.type, 'billing_error');
    assert.ok([FailureKind.AUTH, FailureKind.SERVER].includes(classifyUpstreamFailure(402, billing.bodyText, billing.headers).kind));
    // A redirect is never followed with the key: the 3xx fails the attempt as SERVER.
    upstream = () => new Response('moved', { status: 302, headers: { location: 'https://evil.example/v1/messages' } });
    const before = calls.length;
    const redirected = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS });
    assert.equal(calls.length - before, 1);
    assert.equal(calls.at(-1).init.redirect, 'manual');
    assert.equal(redirected.status, 302);
    assert.ok(!redirected.bodyText.includes('moved'), 'the redirect body is not forwarded');
    assert.equal(classifyUpstreamFailure(redirected.status, redirected.bodyText).kind, FailureKind.SERVER);
    // A connection failure is thrown with kind SERVER.
    upstream = () => { throw new TypeError('fetch failed'); };
    await assert.rejects(startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS }),
      error => error.kind === FailureKind.SERVER && !String(error.message).includes(KEY));
    // No key: a synthesized 401 parks the pool without an upstream call.
    const count = calls.length;
    const missing = await startCompletion({}, SESSION, OPUS, { tier: 'paid', key_var: 'ANTHROPIC_API_KEY' },
      payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS });
    assert.equal(missing.status, 401);
    assert.equal(classifyUpstreamFailure(missing.status, missing.bodyText).kind, FailureKind.AUTH);
    assert.equal(calls.length, count);
    assert.deepEqual(streamErrorBody({ error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }),
      { type: 'overloaded_error', code: 'overloaded_error', status_code: 529, message: 'Overloaded' });
    assert.equal(streamErrorBody(new Error('x')).status_code, 502);
  });

  await test('mid-stream errors: before the first content block they fail over; after it the client gets upstream_error', async () => {
    upstream = request => sseResponse([E.start(), E.ping(), E.error('overloaded_error', 'Overloaded')], request);
    await assert.rejects(startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS }),
      error => error.name === 'UpstreamStreamError' && error.kind === FailureKind.SERVER);
    upstream = request => sseResponse([E.start(), ...E.text(0, ['Hi']).slice(0, 2), E.error('overloaded_error', 'Overloaded')], request);
    const after = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]) });
    assert.deepEqual(deltas(after.events).map(delta => delta.content).filter(Boolean), ['Hi']);
    assert.equal(after.events.at(-1).error.code, 'upstream_error');
    assert.equal(after.finish.status, 'error');
    assert.equal(after.finish.kind, FailureKind.SERVER);
    // A rate-limit event mid-stream is RATE_LIMITED.
    upstream = request => sseResponse([E.start(), E.error('rate_limit_error', 'slow down')], request);
    await assert.rejects(startCompletion(ENV, SESSION, OPUS, POOL, payloadFor([{ role: 'user', content: 'hi' }]), { timeouts: TIMEOUTS }),
      error => error.kind === FailureKind.RATE_LIMITED);
    // The body ending before message_delta is an error (502), not a truncated success.
    upstream = request => sseResponse([E.start(), ...E.text(0, ['Hi']).slice(0, 2)], request);
    const raw = await adapterRun(adapter, { payload: payloadFor([{ role: 'user', content: 'hi' }]) });
    assert.equal(raw.events.at(-1).error.status_code, 502);
    const cut = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]) });
    assert.equal(cut.finish.status, 'error');
    assert.equal(cut.events.at(-1).error.code, 'upstream_error');
    // message_delta without message_stop still completes.
    upstream = request => sseResponse([E.start(), ...E.text(0, ['Hi']), E.delta('end_turn')], request);
    const noStop = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]) });
    assert.equal(noStop.finish.status, 'ok');
    assert.equal(noStop.events.at(-1), '[DONE]');
  });

  // ── Abort and liveness ──

  await test('abort: a client disconnect aborts the upstream fetch, closes without an error event and records ABORTED', async () => {
    upstream = request => sseResponse([E.start(), ...E.text(0, ['Hel']).slice(0, 2), { delay: 5000 }, ...E.text(0, ['lo']).slice(1),
      E.delta('end_turn'), E.stop()], request);
    const client = new AbortController();
    const payload = payloadFor([{ role: 'user', content: 'hi' }]);
    const started = await startCompletion(ENV, SESSION, OPUS, POOL, payload, { clientSignal: client.signal, timeouts: TIMEOUTS });
    const upstreamCall = calls.at(-1);
    let finish = null;
    const stream = createCompletionStream({ ...started.stream, model: OPUS.id, controller: started.controller, clientSignal: client.signal,
      timeouts: TIMEOUTS, requestId: 'req_abort', env: ENV, onFinish: async outcome => { finish = outcome; } });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('Hel')) seen += decoder.decode((await reader.read()).value);
    setTimeout(() => client.abort(), 20);
    const startedAt = Date.now();
    const outcome = await reader.read().then(value => ({ value }), error => ({ error }));
    assert.ok(Date.now() - startedAt < 2000, 'the abort ends the stream promptly');
    assert.ok(outcome.error, 'the client stream errors instead of carrying an error event');
    assert.equal(finish.status, 'error');
    assert.equal(finish.kind, FailureKind.ABORTED);
    assert.equal(upstreamCall.signal.aborted, true, 'the upstream request is aborted');
    // cancel() on the adapter's stream aborts the SDK stream (and with it the upstream fetch).
    upstream = request => sseResponse([E.start(), ...E.text(0, ['a']).slice(0, 2), { delay: 5000 }, E.stop()], request);
    const response = await adapter.chatCompletion(ENV, SESSION, OPUS, payload, new AbortController().signal, POOL, {});
    const direct = response.body.getReader();
    await direct.read();
    await direct.cancel();
    assert.equal(calls.at(-1).signal.aborted, true);
    // A signal aborted before the call rethrows its reason.
    const early = new AbortController();
    early.abort(new Error('client went away'));
    await assert.rejects(adapter.chatCompletion(ENV, SESSION, OPUS, payload, early.signal, POOL, {}), /client went away/);
    await sleep(20);
  });

  await test('liveness: upstream pings without events become keep-alive comments at most every keepAliveMs; a dead upstream still times out', async () => {
    const fast = new AnthropicAdapter({ keepAliveMs: 100 });
    const silentThinking = [E.start(), ...E.text(0, ['a']).slice(0, 2),
      ...Array.from({ length: 12 }, () => [{ delay: 50 }, E.ping()]).flat(),
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }, { type: 'content_block_stop', index: 0 },
      E.delta('end_turn'), E.stop()];
    upstream = request => sseResponse(silentThinking, request);
    const raw = await adapterRun(fast, { payload: payloadFor([{ role: 'user', content: 'hi' }]) });
    const keepAlives = raw.frames.filter(item => item.raw === ': keep-alive');
    assert.ok(keepAlives.length >= 3 && keepAlives.length <= 12, `keep-alives: ${keepAlives.length}`);
    for (let index = 1; index < keepAlives.length; index++) {
      assert.ok(keepAlives[index].at - keepAlives[index - 1].at >= 85, 'at most one keep-alive per keepAliveMs');
    }
    assert.equal(deltas(raw.events).map(delta => delta.content).filter(Boolean).join(''), 'ab');
    // Through the gateway with a 400 ms idle budget, the keep-alives carry the stream past 600 ms of silence...
    ADAPTERS.anthropic = fast;
    const short = { ttfbMs: 1000, idleMs: 400 };
    const alive = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]), timeouts: short });
    assert.equal(alive.finish.status, 'ok');
    // ...which without keep-alives (a 10 s interval) is an idle timeout.
    ADAPTERS.anthropic = adapter;
    const quiet = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]), timeouts: short });
    assert.equal(quiet.finish.kind, FailureKind.TIMEOUT);
    assert.equal(quiet.finish.phase, 'idle');
    // An upstream that sends nothing at all trips the idle timeout and is aborted.
    ADAPTERS.anthropic = fast;
    upstream = request => sseResponse([E.start(), ...E.text(0, ['a']).slice(0, 2), { hang: true }], request);
    const dead = await gatewayRun({ payload: payloadFor([{ role: 'user', content: 'hi' }]), timeouts: short });
    assert.equal(dead.finish.kind, FailureKind.TIMEOUT);
    assert.equal(dead.finish.phase, 'idle');
    assert.equal(dead.events.at(-1).error.code, 'upstream_timeout');
    assert.equal(calls.at(-1).signal.aborted, true);
    ADAPTERS.anthropic = adapter;
  });

  // ── Non-streaming ──

  await test('non-streaming: the same upstream stream aggregates into a chat.completion normalizeCompletion accepts', async () => {
    upstream = request => sseResponse(AGENT_TURN, request);
    const messages = [{ role: 'user', content: 'Read a and b' }];
    const started = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor(messages, { tools: TOOLS, stream: false }), { timeouts: TIMEOUTS });
    assert.equal(started.ok, true);
    assert.equal(calls.at(-1).body.stream, true, 'upstream is streamed');
    assert.ok(calls.at(-1).body.tools.every(tool => !('eager_input_streaming' in tool)), 'server-validated tool JSON when buffered');
    const completion = normalizeCompletion(started.json, OPUS.id, messages, TOOLS);
    const { message, finish_reason: finishReason } = completion.choices[0];
    assert.equal(message.content, AGENT_TEXT);
    assert.equal(message.reasoning_content, 'Plan the reads.\n\nReading now.');
    assert.deepEqual(message.tool_calls, [
      { id: 'toolu_01A', type: 'function', function: { name: 'a.b:c', arguments: '{"path":"a.txt"}' } },
      { id: 'toolu_01B', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
    ]);
    assert.equal(finishReason, 'tool_calls');
    assert.deepEqual(completion.usage, AGENT_USAGE);
    // A mid-stream error becomes an HTTP-shaped failure with the mapped status.
    upstream = request => sseResponse([E.start(), ...E.text(0, ['x']).slice(0, 2), E.error('overloaded_error', 'Overloaded')], request);
    const failed = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor(messages, { stream: false }), { timeouts: TIMEOUTS });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 529);
    assert.equal(classifyUpstreamFailure(failed.status, failed.bodyText).kind, FailureKind.SERVER);
    // Ending before message_delta is a 502.
    upstream = request => sseResponse([E.start(), ...E.text(0, ['x']).slice(0, 2)], request);
    const cut = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor(messages, { stream: false }), { timeouts: TIMEOUTS });
    assert.equal(cut.status, 502);
    // A refusal is a completed answer with content_filter and the note.
    upstream = request => sseResponse([E.start(), E.delta('refusal', { output_tokens: 0 }, { category: 'bio', explanation: 'x' }), E.stop()], request);
    const refused = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor(messages, { stream: false }), { timeouts: TIMEOUTS });
    const refusedChoice = normalizeCompletion(refused.json, OPUS.id, messages).choices[0];
    assert.equal(refusedChoice.finish_reason, 'content_filter');
    assert.match(refusedChoice.message.refusal, /safety category: bio/);
    assert.equal(refusedChoice.message.content, '');
  });

  // ── Preserved thinking ──

  await test('turn cache: LRU by entries and bytes, entry size cap, TTL, frozen values, caller isolation', () => {
    const blocks = n => [{ type: 'thinking', thinking: `t${n}`, signature: `s${n}` }, { type: 'text', text: `x${n}` }];
    const cache = new ClaudeTurnCache({ maxEntries: 2, ttlMs: 1000 });
    assert.equal(cache.remember({ caller: 'u', fingerprint: 'a', blocks: blocks(1) }, 0), true);
    cache.remember({ caller: 'u', fingerprint: 'b', blocks: blocks(2) }, 0);
    assert.ok(cache.lookup({ caller: 'u', fingerprint: 'a' }, 10), 'a hit makes it the most recent');
    cache.remember({ caller: 'u', fingerprint: 'c', blocks: blocks(3) }, 10);
    assert.equal(cache.lookup({ caller: 'u', fingerprint: 'b' }, 10), null, 'b was the least recent');
    assert.equal(cache.size, 2);
    assert.equal(cache.lookup({ caller: 'other', fingerprint: 'a' }, 10), null, 'scoped to the caller');
    const hit = cache.lookup({ caller: 'u', fingerprint: 'c' }, 20);
    assert.ok(Object.isFrozen(hit) && Object.isFrozen(hit[0]));
    assert.equal(cache.lookup({ caller: 'u', fingerprint: 'c' }, 2000), null, 'expired');
    const small = new ClaudeTurnCache({ maxEntryBytes: 200, maxBytes: 400 });
    assert.equal(small.remember({ caller: 'u', fingerprint: 'big', blocks: [{ type: 'text', text: 'x'.repeat(500) }] }), false);
    for (const name of ['p', 'q', 'r', 's']) small.remember({ caller: 'u', fingerprint: name, blocks: [{ type: 'text', text: 'y'.repeat(100) }] });
    assert.ok(small.bytes <= 400 && small.size < 4);
    assert.equal(small.remember({ caller: '', fingerprint: 'x', blocks: blocks(1) }), false);
    assert.equal(claudeTurnHooks(small, null), null);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });

  await test('replay: the next request restores the exact thinking blocks for the echoed turn (re-serialized args, or Neuron-style text)', async () => {
    const cache = new ClaudeTurnCache();
    const request = { caller: 'user-123', turns: claudeTurnHooks(cache, 'user-123') };
    const history1 = [{ role: 'system', content: 'You are Neuron.' }, { role: 'user', content: 'Read a.txt and b.txt' }];
    upstream = req => sseResponse(AGENT_TURN, req);
    const turn1 = await gatewayRun({ payload: payloadFor(history1, { tools: TOOLS }), request });
    assert.equal(turn1.finish.status, 'ok');
    assert.equal(cache.size, 2, 'kept under the content-only and the Neuron (reasoning + content) fingerprints');
    const restored = [
      { type: 'thinking', thinking: 'Plan the reads.', signature: 'sig-one' },
      { type: 'text', text: AGENT_TEXT },
      { type: 'thinking', thinking: 'Reading now.', signature: 'sig-two' },
      { type: 'tool_use', id: 'toolu_01A', name: safeName('a.b:c'), input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'toolu_01B', name: 'read_file', input: { path: 'b.txt' } },
    ];
    const echo = content => ({ role: 'assistant', content, tool_calls: [
      call('toolu_01A', 'a.b:c', '{ "path" : "a.txt" }'), call('toolu_01B', 'read_file', '{"path":   "b.txt"}')] });
    const results = [toolMessage('toolu_01A', 'A contents'), toolMessage('toolu_01B', 'B contents')];
    upstream = req => sseResponse(SIMPLE_END, req);
    for (const content of [AGENT_TEXT, AGENT_VISIBLE]) {
      const turn2 = await gatewayRun({ payload: payloadFor([...history1, echo(content), ...results], { tools: TOOLS }), request });
      assert.equal(turn2.finish.status, 'ok');
      const sent = calls.at(-1);
      assert.deepEqual(sent.body.messages[1], { role: 'assistant', content: restored });
      assert.deepEqual(sent.body.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' });
      assert.equal(sent.headers.get('anthropic-beta'), BINDING_BETA);
      assert.equal(sent.body.messages[2].content[0].tool_use_id, 'toolu_01A');
    }
    assert.equal(messageFingerprint(echo(AGENT_TEXT)), turnFingerprint(AGENT_TEXT,
      [{ id: 'toolu_01A', name: 'a.b:c', arguments: '{"path":"a.txt"}' }, { id: 'toolu_01B', name: 'read_file', arguments: '{"path":"b.txt"}' }]));
    // An edited assistant turn is rebuilt from the message, without thinking.
    await gatewayRun({ payload: payloadFor([...history1, echo('I will read both files.'), ...results], { tools: TOOLS }), request });
    assert.deepEqual(calls.at(-1).body.messages[1].content.map(block => block.type), ['text', 'tool_use', 'tool_use']);
    // Without a caller nothing is replayed or remembered.
    const size = cache.size;
    await gatewayRun({ payload: payloadFor([...history1, echo(AGENT_TEXT), ...results], { tools: TOOLS }) });
    assert.ok(!calls.at(-1).body.messages[1].content.some(block => block.type === 'thinking'));
    assert.equal(cache.size, size);
    // ANTHROPIC_THINKING_REPLAY=false: no beta, no block_binding, no replay.
    await gatewayRun({ payload: payloadFor([...history1, echo(AGENT_TEXT), ...results], { tools: TOOLS }), request,
      env: { ...ENV, ANTHROPIC_THINKING_REPLAY: 'false' } });
    const off = calls.at(-1);
    assert.equal(off.headers.get('anthropic-beta'), null);
    assert.ok(!('block_binding' in off.body.thinking));
    assert.ok(!off.body.messages[1].content.some(block => block.type === 'thinking'));
    // Turns that ended abnormally, carry unparseable tool JSON or no thinking are not kept.
    const translator = new ClaudeStreamTranslator({ model: OPUS.id });
    for (const event of [E.start(), ...E.thinking(0, ['t'], 'sig'), ...E.tool(1, 'toolu_X', 'read_file', ['{"path":']), E.delta('max_tokens')]) {
      translator.translate(event);
    }
    assert.equal(translator.turnRecord(), null);
    const noThinking = new ClaudeStreamTranslator({ model: OPUS.id });
    for (const event of SIMPLE_END) noThinking.translate(event);
    assert.equal(noThinking.turnRecord(), null);
  });

  await test('beta fallback: a rejected binding beta retries once without beta or replay and stays off; a rejected signature retries without replay', async () => {
    const cache = new ClaudeTurnCache();
    const request = { caller: 'user-9', turns: claudeTurnHooks(cache, 'user-9') };
    const history1 = [{ role: 'user', content: 'Read a.txt and b.txt' }];
    const isolate = new AnthropicAdapter();
    ADAPTERS.anthropic = isolate;
    upstream = req => sseResponse(AGENT_TURN, req);
    await gatewayRun({ payload: payloadFor(history1, { tools: TOOLS }), request });
    const history2 = [...history1, { role: 'assistant', content: AGENT_TEXT, tool_calls: [call('toolu_01A', 'a.b:c', '{"path":"a.txt"}'),
      call('toolu_01B', 'read_file', '{"path":"b.txt"}')] }, toolMessage('toolu_01A', 'A'), toolMessage('toolu_01B', 'B')];
    let attempts = 0;
    upstream = req => (attempts++ === 0
      ? httpError(400, 'invalid_request_error', `Unexpected value(s) \`${BINDING_BETA}\` for the \`anthropic-beta\` header.`)()
      : sseResponse(SIMPLE_END, req));
    const before = calls.length;
    const retried = await gatewayRun({ payload: payloadFor(history2, { tools: TOOLS }), request });
    assert.equal(retried.finish.status, 'ok');
    assert.equal(calls.length - before, 2, 'exactly one retry');
    const [first, second] = calls.slice(before);
    assert.equal(first.headers.get('anthropic-beta'), BINDING_BETA);
    assert.ok(first.body.messages[1].content.some(block => block.type === 'thinking'));
    assert.equal(second.headers.get('anthropic-beta'), null);
    assert.ok(!('block_binding' in second.body.thinking));
    assert.ok(!second.body.messages[1].content.some(block => block.type === 'thinking'));
    assert.ok(logged.some(line => line.includes('rejected the thinking-binding beta')));
    upstream = req => sseResponse(SIMPLE_END, req);
    await gatewayRun({ payload: payloadFor(history2, { tools: TOOLS }), request });
    assert.equal(calls.at(-1).headers.get('anthropic-beta'), null, 'the isolate stops sending the beta');

    // A tampered or foreign signature: one retry with the beta kept and nothing replayed.
    const fresh = new AnthropicAdapter();
    ADAPTERS.anthropic = fresh;
    attempts = 0;
    upstream = req => (attempts++ === 0
      ? httpError(400, 'invalid_request_error', 'messages.1.content.0: Invalid `signature` in `thinking` block.')()
      : sseResponse(SIMPLE_END, req));
    const mark = calls.length;
    const signed = await gatewayRun({ payload: payloadFor(history2, { tools: TOOLS }), request });
    assert.equal(signed.finish.status, 'ok');
    assert.equal(calls.length - mark, 2);
    const retry = calls.at(-1);
    assert.equal(retry.headers.get('anthropic-beta'), BINDING_BETA);
    assert.deepEqual(retry.body.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' });
    assert.ok(!retry.body.messages[1].content.some(block => block.type === 'thinking'));
    assert.ok(!logged.some(line => line.includes('Invalid `signature`')), 'warnings carry no upstream message text');
    // Any other 400 is not retried.
    upstream = httpError(400, 'invalid_request_error', 'tools.0.input_schema: invalid');
    const once = calls.length;
    const rejected = await startCompletion(ENV, SESSION, OPUS, POOL, payloadFor(history2, { tools: TOOLS }), { timeouts: TIMEOUTS, request });
    assert.equal(calls.length - once, 1);
    assert.equal(classifyUpstreamFailure(rejected.status, rejected.bodyText).kind, FailureKind.INVALID);
    ADAPTERS.anthropic = adapter;
  });

  // ── Adapter surface and security ──

  await test('security: only https://api.anthropic.com/v1/ is fetched, always with redirect manual; the key never reaches a log', async () => {
    for (const url of ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages?beta=true']) assert.ok(isAnthropicUrl(url));
    const refused = ['http://api.anthropic.com/v1/messages', 'https://api.anthropic.com.evil.example/v1/messages',
      'https://user@api.anthropic.com/v1/messages', 'https://api.anthropic.com:8443/v1/messages', 'https://evil.example/v1/messages',
      'https://api.anthropic.com/admin', 'not a url'];
    const guarded = anthropicFetch(null);
    for (const url of refused) {
      assert.equal(isAnthropicUrl(url), false, url);
      const before = calls.length;
      await assert.rejects(guarded(url, { headers: { 'x-api-key': KEY } }), /api\.anthropic\.com/);
      assert.equal(calls.length, before, `${url} was never fetched`);
    }
    upstream = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await guarded(new URL('https://api.anthropic.com/v1/models'), { redirect: 'follow' });
    assert.equal(calls.at(-1).init.redirect, 'manual');
    assert.equal(ANTHROPIC.baseURL, 'https://api.anthropic.com');
    assert.equal(adapter.getBaseUrl(), 'https://api.anthropic.com/v1');
    assert.ok(logged.every(line => !line.includes(KEY)), 'no log line contains the key');
  });

  await test('adapter surface: configuration, allowlist catalog without network, capabilities, vault and owned-only sessions', async () => {
    assert.equal(adapter.isConfigured(ENV), true);
    assert.equal(adapter.isConfigured({}), false);
    assert.equal(adapter.isConfigured({ ANTHROPIC_API_KEY: '  ' }), false);
    assert.equal(adapter.isConfigured(ENV, { owned_provider_only: true }), false);
    assert.equal(adapter.getApiKey({ ANTHROPIC_API_KEY: ` ${KEY}\n` }), KEY);
    assert.equal(adapter.getApiKey({ OTHER: 'sk-ant-other-key-000000000000' }, {}, { tier: 'paid', key_var: 'OTHER' }), 'sk-ant-other-key-000000000000');
    assert.equal(adapter.catalogSource(), 'allowlist');
    assert.deepEqual(adapter.capabilities(), { tools: true, streaming: true, parallel_tools: true, vision: true, reasoning: true });
    const before = calls.length;
    const discovery = await adapter.discoverModels(ENV);
    assert.equal(discovery.status, 'configured');
    assert.equal(discovery.discovery, false);
    assert.equal((await adapter.discoverModels({})).status, 'not_configured');
    assert.equal(calls.length, before, 'no network call');
    assert.ok(adapter.listStaticModels(ENV).every(entry => entry.provider === 'anthropic'));
  });

  assert.deepEqual(unhandled, [], 'no unhandled rejections');
  consoleOriginal.log(`PASS: ${results.length} Claude adapter checks (mapping, caching, stream translation, usage, refusal, errors, abort, liveness, non-streaming, replay, beta fallback, security)`);
} finally {
  globalThis.fetch = realFetch;
  Object.assign(console, consoleOriginal);
  if (registered === undefined) delete ADAPTERS.anthropic;
  else ADAPTERS.anthropic = registered;
}
