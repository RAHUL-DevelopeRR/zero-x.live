// Offline regression tests for provider-specific request shaping (src/provider-request.js),
// sanitized upstream diagnostics and 429 backoff. No network: every upstream is a fake.
//
// fixtures/neuron-chat-request.json is a real Neuron CLI request (neuron 6.2.5, captured
// 2026-10-16 against a local capture server): 22 tool schemas, the user prompt, an assistant
// turn with two parallel tool calls and both tool results, exactly as sent, except that the
// system prompt is shortened and the workspace path in the tool results is replaced. Sent to
// the live upstreams, that body was rejected by gemini-3.5-flash ("Function call is missing a
// thought_signature") and by Groq ("property 'is_error' is unsupported"). The fake validators
// below reject the same things (and, stricter than Gemini, every non-OpenAI field).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createChatHandler } from './src/chat-handler.js';
import { RoutingEngine, fitMaxTokens } from './src/router.js';
import { FailureKind, HealthState, ProviderHealthTracker } from './src/provider-health.js';
import { POOL_LIMITS, catalogEntry } from './src/catalog.js';
import { reservationArgs } from './src/capacity.js';
import { estimatePromptTokens } from './src/pricing.js';
import {
  ADAPTERS, buildUpstreamPayload, classifyUpstreamFailure, parseTruncatedJson, redactProviderMessage, upstreamErrorSummary,
  UPSTREAM_MESSAGE_LIMIT,
} from './src/providers.js';
import {
  GEMINI_SIGNATURE_PLACEHOLDER, ThoughtSignatureCache, errorToolContent, normalizeProviderRequest,
} from './src/provider-request.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/neuron-chat-request.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(name);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

// ── Strict fake upstream validators (what the live upstreams rejected, plus the OpenAI subset) ──
const OPENAI_MESSAGE_FIELDS = {
  system: ['role', 'content', 'name'], user: ['role', 'content', 'name'],
  assistant: ['role', 'content', 'name', 'tool_calls'], tool: ['role', 'content', 'tool_call_id', 'name'],
};
const GEMINI_PARAMS = new Set(['model', 'messages', 'max_tokens', 'stream', 'stream_options', 'tools', 'tool_choice',
  'stop', 'temperature', 'top_p', 'seed', 'response_format', 'reasoning_effort']);
const GROQ_PARAMS = new Set([...GEMINI_PARAMS, 'parallel_tool_calls', 'presence_penalty', 'frequency_penalty', 'user']);
const PLACEHOLDERS = new Set([GEMINI_SIGNATURE_PLACEHOLDER, 'context_engineering_is_the_way_to_go']);

function validateTools(tools = []) {
  for (const tool of tools) {
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') return 'Invalid tool definition';
    const parameters = tool.function.parameters;
    if (parameters !== undefined && (typeof parameters !== 'object' || parameters.type !== 'object')) {
      return `Invalid function parameters for ${tool.function.name}`;
    }
  }
  return null;
}

// `issued`: signature -> upstream model that issued it.
function geminiProblem(body, issued = new Map()) {
  for (const name of Object.keys(body)) {
    if (!GEMINI_PARAMS.has(name)) return `Invalid JSON payload received. Unknown name "${name}": Cannot find field.`;
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return '* GenerateContentRequest.contents: contents is not specified';
  const gemini3 = /^gemini-3/.test(body.model);
  const callIds = new Set();
  for (const [position, message] of body.messages.entries()) {
    const allowed = OPENAI_MESSAGE_FIELDS[message.role];
    if (!allowed) return `Invalid value at 'messages[${position}].role'`;
    if (message.role === 'assistant' && message.tool_calls) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) return `messages[${position}].tool_calls must not be empty`;
      for (const [index, call] of message.tool_calls.entries()) {
        const extra = Object.keys(call).find(name => !['id', 'type', 'function', 'extra_content'].includes(name));
        if (extra) return `Invalid JSON payload received. Unknown name "${extra}" at 'messages[${position}].tool_calls[${index}]'`;
        if (call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') {
          return `Invalid function call at 'messages[${position}].tool_calls[${index}]'`;
        }
        try { JSON.parse(call.function.arguments); } catch { return 'Function call arguments are not valid JSON'; }
        if (call.extra_content !== undefined) {
          const signature = call.extra_content?.google?.thought_signature;
          if (Object.keys(call.extra_content).join() !== 'google' || Object.keys(call.extra_content.google || {}).join() !== 'thought_signature' ||
              typeof signature !== 'string') return 'Invalid extra_content';
          if (!PLACEHOLDERS.has(signature) && issued.get(signature) !== body.model) return 'Corrupted thought signature.';
        }
        callIds.add(call.id);
      }
      const first = message.tool_calls[0];
      if (gemini3 && !first.extra_content?.google?.thought_signature) {
        return 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, ' +
          `and missing thought_signature may lead to degraded model performance. Additional data, function call \`default_api:${first.function.name}\` , ` +
          `position ${position}. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.`;
      }
    }
    const unknown = Object.keys(message).find(name => !allowed.includes(name));
    if (unknown) return `Invalid JSON payload received. Unknown name "${unknown}" at 'messages[${position}]': Cannot find field.`;
    if (message.role === 'assistant' && (message.content === null || message.content === undefined) && !message.tool_calls) {
      return `messages[${position}]: content is required`;
    }
    if (message.role === 'tool' && !callIds.has(message.tool_call_id)) return `messages[${position}]: no function call matches tool_call_id`;
  }
  return validateTools(body.tools);
}

function groqProblem(body) {
  for (const name of Object.keys(body)) if (!GROQ_PARAMS.has(name)) return `property '${name}' is unsupported`;
  for (const [position, message] of body.messages.entries()) {
    const allowed = OPENAI_MESSAGE_FIELDS[message.role] || [];
    const unknown = Object.keys(message).find(name => !allowed.includes(name));
    if (unknown) {
      return `'messages.${position}' : for 'role:${message.role}' the following must be satisfied[('messages.${position}' : property '${unknown}' is unsupported)]`;
    }
    for (const [index, call] of (message.tool_calls || []).entries()) {
      const extra = Object.keys(call).find(name => !['id', 'type', 'function'].includes(name));
      if (extra) return `'messages.${position}.tool_calls.${index}' : property '${extra}' is unsupported`;
      if (typeof call.function?.arguments !== 'string') return `'messages.${position}.tool_calls.${index}.function.arguments' : value must be a string`;
    }
  }
  return validateTools(body.tools);
}

const geminiError = (message, code = 400, status = 'INVALID_ARGUMENT', details) =>
  Response.json([{ error: { code, message, status, ...(details ? { details } : {}) } }], { status: code });
const groqError = message => Response.json({ error: { message, type: 'invalid_request_error' } }, { status: 400 });

// ── Fake network ──
const originalFetch = globalThis.fetch;
let handlers = {};
const upstream = [];
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const target = url.startsWith('https://generativelanguage.googleapis.com/') ? 'gemini'
    : url.startsWith('https://api.groq.com/') ? 'groq' : 'unknown';
  const body = options.body ? JSON.parse(options.body) : null;
  const call = { target, url, body, headers: options.headers || {} };
  upstream.push(call);
  if (!handlers[target]) throw new Error(`Unexpected fetch to ${url}`);
  return handlers[target](call);
};
const reset = next => { upstream.length = 0; handlers = { ...next }; };

const encoder = new TextEncoder();
const sse = events => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
    controller.close();
  },
}), { headers: { 'Content-Type': 'text/event-stream' } });
const parseSse = text => text.split('\n\n').filter(Boolean).map(event => event.slice(6)).map(data => data === '[DONE]' ? data : JSON.parse(data));
const USAGE = { prompt_tokens: 5200, completion_tokens: 20, total_tokens: 5220 };
const textReply = body => body.stream
  ? sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'The fixture says hello.' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE }, '[DONE]'])
  : Response.json({ id: 'up', object: 'chat.completion', choices: [{ index: 0,
    message: { role: 'assistant', content: 'The fixture says hello.' }, finish_reason: 'stop' }], usage: USAGE });

// A Gemini 3 streamed tool call as the live upstream sends it (whole call, own id, signature).
const geminiToolStream = calls => sse([
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE },
  '[DONE]',
]);

// ── Gateway under test (session-KV sessions, as anonymous/dev callers use) ──
const KEYS = { GEMINI_API_KEY: 'AIzaSyFAKE-gemini-free-key-0123456789abcd', GROQ_API_KEY: 'gsk_fakegroqfreekey0123456789abcdef' };
const DEV_PLANS = { free: { name: 'Free', daily_tokens: 5000000, daily_requests: 2000, price_usd: 0 } };
const today = () => new Date().toISOString().slice(0, 10);
function gateway({ tracker = new ProviderHealthTracker(), cache = new ThoughtSignatureCache() } = {}) {
  const store = new Map();
  const app = new Hono();
  app.post('/v1/chat/completions', createChatHandler({
    validateSession: async c => {
      const token = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
      const raw = store.get(token);
      return raw ? { token, session: JSON.parse(raw) } : null;
    },
    setSession: async (c, token, value) => { store.set(token, JSON.stringify(value)); },
    getSession: async (c, token) => JSON.parse(store.get(token) || 'null'),
    planLimits: async () => DEV_PLANS,
    router: new RoutingEngine(tracker),
    healthTracker: tracker,
    signatureCache: cache,
  }));
  const addSession = token => store.set(token, JSON.stringify({ created: Date.now(), plan: 'free', requests: 0,
    tokens_used: 0, usage_day: today() }));
  const call = (body, { token = 'ses_alice_0000000000000000' } = {}) => {
    const request = new Request('https://zero-x.live/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    Object.defineProperty(request, 'cf', { value: { country: 'US' } });
    return app.fetch(request, { ...KEYS });
  };
  return { tracker, cache, addSession, call };
}

async function captureLogs(fn) {
  const logs = { warn: [], error: [] };
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => logs.warn.push(args);
  console.error = (...args) => logs.error.push(args);
  try {
    return { result: await fn(), logs };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

const entry = id => catalogEntry(id);
const upstreamBody = (id, body, normalize = true) => {
  const catalog = entry(id);
  const payload = buildUpstreamPayload(catalog, body, 8192);
  const shaped = normalize ? normalizeProviderRequest(catalog.provider, payload) : payload;
  return { ...shaped, model: catalog.upstream_model };
};

try {
  // ── The captured request against the strict fakes ──
  await test('the captured Neuron request reproduces both live rejections without the normalizer', () => {
    assert.equal(FIXTURE.tools.length, 22);
    assert.deepEqual(FIXTURE.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'tool']);
    assert.ok(FIXTURE.messages.filter(message => message.role === 'tool').every(message => message.is_error === false));
    for (const stream of [true, false]) {
      const raw = upstreamBody('gemini/gemini-3.5-flash', { ...FIXTURE, stream }, false);
      assert.match(geminiProblem(raw), /missing a thought_signature.*default_api:read_file` , position 2/);
      const groq = upstreamBody('groq/openai/gpt-oss-120b', { ...FIXTURE, stream }, false);
      assert.equal(groqProblem(groq), "'messages.3' : for 'role:tool' the following must be satisfied[('messages.3' : property 'is_error' is unsupported)]");
    }
  });

  await test('normalized Neuron requests pass the strict Gemini and Groq validators without changing their meaning', () => {
    const variants = {
      captured: FIXTURE,
      // Neuron sends `content: null` when an assistant turn has only tool calls.
      'null assistant content': { ...FIXTURE, messages: FIXTURE.messages.map(message => message.role === 'assistant' ? { ...message, content: null } : message) },
      'failed tool result': { ...FIXTURE, messages: FIXTURE.messages.map((message, index) => index === 4 ? { ...message, is_error: true } : message) },
    };
    for (const [name, body] of Object.entries(variants)) {
      for (const stream of [true, false]) {
        const input = deepFreeze(clone({ ...body, stream }));
        for (const id of ['gemini/gemini-3.5-flash', 'gemini/gemini-2.5-flash']) {
          const shaped = upstreamBody(id, input);
          assert.equal(geminiProblem(shaped), null, `${name} → ${id} (stream ${stream})`);
          assert.deepEqual(shaped.tools, FIXTURE.tools, 'tool schemas are forwarded unchanged');
          const calls = shaped.messages[2].tool_calls;
          assert.deepEqual(calls.map(call => call.extra_content.google.thought_signature), [GEMINI_SIGNATURE_PLACEHOLDER, GEMINI_SIGNATURE_PLACEHOLDER]);
        }
        for (const id of ['groq/openai/gpt-oss-120b', 'groq/qwen/qwen3.8-27b']) {
          const shaped = upstreamBody(id, input);
          assert.equal(groqProblem(shaped), null, `${name} → ${id} (stream ${stream})`);
          assert.deepEqual(shaped.tools, FIXTURE.tools);
          assert.ok(!JSON.stringify(shaped).includes('extra_content'));
        }
        // Same conversation: every message, role, text, call id, name and argument survives.
        const shaped = upstreamBody('gemini/gemini-3.5-flash', input);
        assert.equal(shaped.messages.length, input.messages.length);
        shaped.messages.forEach((message, index) => {
          const original = input.messages[index];
          assert.equal(message.role, original.role);
          if (original.role === 'tool') {
            assert.equal(message.tool_call_id, original.tool_call_id);
            assert.equal(message.content, original.is_error ? `Error: ${original.content}` : original.content);
          } else {
            assert.equal(message.content, original.content);
          }
          if (original.tool_calls) {
            assert.deepEqual(message.tool_calls.map(call => [call.id, call.type, call.function.name, call.function.arguments]),
              original.tool_calls.map(call => [call.id, call.type, call.function.name, call.function.arguments]));
          }
        });
        assert.equal(shaped.tool_choice, 'auto');
        assert.equal(shaped.max_tokens, 8192);
      }
    }
  });

  // ── Unit: each transformation ──
  await test('tool results: is_error is dropped everywhere and a failure keeps its meaning', () => {
    const body = { messages: [{ role: 'tool', tool_call_id: 'c', content: 'permission denied', is_error: true }] };
    for (const provider of ['gemini', 'groq', 'openrouter', 'nvidia', 'cloudflare']) {
      const [message] = normalizeProviderRequest(provider, body).messages;
      assert.equal(Object.hasOwn(message, 'is_error'), false, provider);
      assert.equal(message.content, 'Error: permission denied', provider);
    }
    assert.equal(normalizeProviderRequest('groq', { messages: [{ role: 'tool', tool_call_id: 'c', content: 'ok', is_error: false }] }).messages[0].content, 'ok');
    assert.equal(errorToolContent('Error: no such file'), 'Error: no such file');
    assert.equal(errorToolContent('failed to spawn'), 'failed to spawn');
    assert.equal(errorToolContent(null), 'Error');
    assert.deepEqual(errorToolContent([{ type: 'text', text: 'boom' }]), [{ type: 'text', text: 'Error:' }, { type: 'text', text: 'boom' }]);
    assert.equal(ADAPTERS.cloudflare.requestBody({ messages: body.messages, max_tokens: 9 }).messages[0].is_error, undefined, 'Workers AI too');
  });

  await test('strict providers get the OpenAI message subset; others keep unknown fields', () => {
    const body = deepFreeze({ messages: [
      { role: 'user', content: 'hi', name: 'alice', cache_hint: 1 },
      { role: 'assistant', content: 'thinking', reasoning_content: 'plan', tool_calls: [
        { index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: { path: 'a' } }, extra_content: { google: { thought_signature: 'client' } } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'x' },
    ] });
    const groq = normalizeProviderRequest('groq', body).messages;
    assert.deepEqual(groq[0], { role: 'user', content: 'hi', name: 'alice' });
    assert.deepEqual(groq[1], { role: 'assistant', content: 'thinking',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
    assert.deepEqual(groq[2], { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'x' });
    const openrouter = normalizeProviderRequest('openrouter', body).messages;
    assert.equal(openrouter[0].cache_hint, 1, 'non-strict providers keep fields they may understand');
    assert.equal(openrouter[1].reasoning_content, 'plan');
    assert.equal(openrouter[1].tool_calls[0].index, 0);
    assert.equal(openrouter[1].tool_calls[0].extra_content, undefined, 'Gemini-only field');
    assert.equal(openrouter[1].tool_calls[0].function.arguments, '{"path":"a"}', 'arguments are always a JSON string');
    assert.equal(body.messages[1].tool_calls[0].function.arguments.path, 'a', 'the input is not mutated');
  });

  await test('assistant turns: empty tool_calls are removed and a lone null content becomes empty text', () => {
    const [empty, nullOnly, withCalls] = normalizeProviderRequest('nvidia', { messages: [
      { role: 'assistant', content: 'a', tool_calls: [] },
      { role: 'assistant', content: null },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ] }).messages;
    assert.equal(Object.hasOwn(empty, 'tool_calls'), false);
    assert.equal(nullOnly.content, '');
    assert.equal(withCalls.content, null, 'null next to tool calls is valid OpenAI');
  });

  await test('Gemini thought signatures: restored when issued for this model, placeholder otherwise', () => {
    const calls = [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' }, extra_content: { google: { thought_signature: 'from-client' } } },
      { id: 'call_2', type: 'function', function: { name: 'glob_search', arguments: '{}' } },
    ];
    const body = { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: calls }] };
    const signatures = shaped => shaped.messages[1].tool_calls.map(call => call.extra_content?.google?.thought_signature ?? null);
    assert.deepEqual(signatures(normalizeProviderRequest('gemini', body)), [GEMINI_SIGNATURE_PLACEHOLDER, GEMINI_SIGNATURE_PLACEHOLDER],
      'client-supplied signatures are never forwarded (their issuing model is unknown)');
    const known = { call_1: 'real-1' };
    assert.deepEqual(signatures(normalizeProviderRequest('gemini', body, { signatureFor: call => known[call.id] })), ['real-1', null],
      'Gemini puts the signature on the first parallel call only');
    assert.deepEqual(signatures(normalizeProviderRequest('gemini', body, { signatureFor: call => ({ call_2: 'real-2' })[call.id] })),
      [GEMINI_SIGNATURE_PLACEHOLDER, 'real-2'], 'the first call of a step always carries one');
    assert.deepEqual(signatures(normalizeProviderRequest('groq', body)), [null, null]);
  });

  await test('the signature cache is scoped by caller, upstream model and function, bounded and expiring', () => {
    const cache = new ThoughtSignatureCache({ maxEntries: 2, ttlMs: 1000 });
    const scope = { caller: 'user-a', model: 'gemini-3.5-flash', id: 'call_1', name: 'read_file' };
    assert.equal(cache.remember({ ...scope, signature: 'sig-a' }, 0), true);
    assert.equal(cache.lookup(scope, 10), 'sig-a');
    assert.equal(cache.lookup({ ...scope, caller: 'user-b' }, 10), null, 'another caller never gets it');
    assert.equal(cache.lookup({ ...scope, model: 'gemini-2.5-flash' }, 10), null, 'another model never gets it');
    assert.equal(cache.lookup({ ...scope, name: 'bash' }, 10), null, 'a reused call id of another function misses');
    assert.equal(cache.lookup(scope, 1000), null, 'expired');
    assert.equal(cache.remember({ ...scope, signature: GEMINI_SIGNATURE_PLACEHOLDER }), false, 'placeholders are not stored');
    assert.equal(cache.remember({ ...scope, caller: null, signature: 'x' }), false);
    assert.equal(cache.remember({ ...scope, signature: 'x'.repeat(40000) }), false, 'oversized signatures are not stored');
    for (const id of ['a', 'b', 'c']) cache.remember({ ...scope, id, signature: id }, 0);
    assert.equal(cache.size, 2);
    assert.equal(cache.lookup({ ...scope, id: 'a' }, 1), null, 'least recently stored entry evicted');
    assert.equal(cache.lookup({ ...scope, id: 'c' }, 1), 'c');
  });

  // ── Through the chat handler ──
  await test('a two-turn Gemini 3 tool conversation keeps the real signature without exposing it', async () => {
    const gw = gateway();
    gw.addSession('ses_alice_0000000000000000');
    gw.addSession('ses_bob_000000000000000000');
    const issued = new Map([['sig-issued-read', 'gemini-3.5-flash']]);
    let turn = 0;
    reset({ gemini: call => {
      const problem = geminiProblem(call.body, issued);
      if (problem) return geminiError(problem);
      turn++;
      if (turn === 1) {
        return geminiToolStream([
          { extra_content: { google: { thought_signature: 'sig-issued-read' } }, function: { arguments: '{"path":"fixture.txt"}', name: 'read_file' }, id: 'call_read', type: 'function' },
          { function: { arguments: '{"pattern":"*.txt"}', name: 'glob_search' }, id: 'call_glob', type: 'function' },
        ]);
      }
      return textReply(call.body);
    } });
    const first = { ...FIXTURE, model: 'gemini/gemini-3.5-flash', stream: true, messages: FIXTURE.messages.slice(0, 2) };
    const response = await gw.call(first);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('sig-issued-read') && !text.includes('extra_content'), 'signatures stay in the gateway');
    const deltas = parseSse(text).filter(event => event !== '[DONE]').flatMap(item => item.choices.flatMap(choice => choice.delta.tool_calls || []));
    assert.deepEqual(deltas.map(delta => [delta.index, delta.id, delta.function.name]), [[0, 'call_read', 'read_file'], [1, 'call_glob', 'glob_search']]);
    assert.equal(gw.cache.size, 1);

    // Turn 2: the client (like Neuron) echoes the calls without signatures.
    const second = await gw.call({ ...FIXTURE, model: 'gemini/gemini-3.5-flash', stream: false });
    assert.equal(second.status, 200, await second.clone().text());
    assert.deepEqual(upstream.at(-1).body.messages[2].tool_calls.map(call => call.extra_content?.google?.thought_signature ?? null),
      ['sig-issued-read', null]);
    assert.equal((await second.json()).choices[0].message.content, 'The fixture says hello.');

    // Another caller replaying the same ids gets the placeholder, never alice's signature.
    const other = await gw.call({ ...FIXTURE, model: 'gemini/gemini-3.5-flash', stream: true }, { token: 'ses_bob_000000000000000000' });
    assert.equal(other.status, 200);
    await other.text();
    assert.deepEqual(upstream.at(-1).body.messages[2].tool_calls.map(call => call.extra_content.google.thought_signature),
      [GEMINI_SIGNATURE_PLACEHOLDER, GEMINI_SIGNATURE_PLACEHOLDER]);

    // Non-streamed responses are recorded too, and never carry extra_content to the client.
    reset({ gemini: () => Response.json({ id: 'up', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null,
      extra_content: { google: { thought_signature: 'sig-text' } },
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig-9' } } }] } }],
    usage: USAGE }) });
    const plain = await gw.call({ ...first, stream: false });
    const json = await plain.json();
    assert.ok(!JSON.stringify(json).includes('extra_content'));
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(gw.cache.lookup({ caller: 'ses_alice_000000', model: 'gemini-3.5-flash', id: 'call_9', name: 'bash' }), 'sig-9');
  });

  await test('the live incident: 2.5 Flash 429 fails over to 3.5 Flash, which now accepts the Neuron history', async () => {
    const gw = gateway();
    gw.addSession('ses_alice_0000000000000000');
    const quota = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
      quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier', quotaValue: '250000' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '14s' }];
    reset({ gemini: call => {
      if (call.body.model === 'gemini-2.5-flash') {
        return geminiError('You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: ' +
          'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-2.5-flash ' +
          'Please retry in 14.2s.', 429, 'RESOURCE_EXHAUSTED', quota);
      }
      const problem = geminiProblem(call.body);
      return problem ? geminiError(problem) : textReply(call.body);
    } });
    const { result: response, logs } = await captureLogs(() => gw.call({ ...FIXTURE, model: 'auto', stream: true }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-neuron-model'), 'gemini/gemini-3.5-flash');
    assert.ok((await response.text()).includes('The fixture says hello.'));
    assert.deepEqual(upstream.map(call => call.body.model), ['gemini-2.5-flash', 'gemini-3.5-flash']);
    const record = gw.tracker.getRecord('gemini:gemini-2.5-flash:free');
    assert.equal(record.status, HealthState.RATE_LIMITED);
    const cooldown = gw.tracker.cooldownRemainingMs('gemini:gemini-2.5-flash:free');
    assert.ok(cooldown > 12000 && cooldown <= 14000, `RetryInfo honoured (${cooldown} ms)`);
    const [message, detail] = logs.warn.find(([text]) => text === 'Neuron upstream error detail');
    assert.equal(message, 'Neuron upstream error detail');
    assert.equal(detail.kind, FailureKind.RATE_LIMITED);
    assert.deepEqual(detail.upstream.quotas, [{ id: 'GenerateContentInputTokensPerModelPerMinute-FreeTier', value: '250000' }]);
    assert.equal(detail.upstream.retry_delay_seconds, 14);
    assert.equal(detail.upstream.provider_status, 'RESOURCE_EXHAUSTED');
    assert.ok(logs.error.some(([text, fields]) => text === 'Neuron upstream rejected request' && fields.status === 429));
  });

  await test('upstream errors are logged sanitized at warn level and stay masked for the client', async () => {
    const gw = gateway();
    gw.addSession('ses_alice_0000000000000000');
    const echoed = 'Invalid value at \'messages[1].content\' (TYPE_STRING), "Read fixture.txt and tell me what it says" ' +
      `for key ${KEYS.GEMINI_API_KEY} from dev@neuron.test; see https://example.test/x?key=${KEYS.GEMINI_API_KEY}&a=1 ` +
      'unknown field `default_api:read_file` signature Q2lRQlZLaGdlYmFkMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A= ' + 'x'.repeat(400);
    reset({ gemini: () => geminiError(echoed) });
    const { result: response, logs } = await captureLogs(() => gw.call({ ...FIXTURE, model: 'gemini/gemini-3.5-flash', stream: true }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'invalid_request');
    assert.equal(body.error.message, 'The model rejected the request. Check the messages, tools and parameters.');
    const serialized = JSON.stringify(logs);
    for (const secret of [KEYS.GEMINI_API_KEY, 'Read fixture.txt', 'dev@neuron.test', 'Q2lRQlZLaGdlYmFk', 'You are an interactive agent']) {
      assert.ok(!serialized.includes(secret), `logs never contain ${secret.slice(0, 12)}`);
    }
    const [, detail] = logs.warn.find(([text]) => text === 'Neuron upstream error detail');
    assert.deepEqual([detail.provider, detail.model, detail.tier, detail.kind, detail.upstream.status, detail.upstream.provider_code,
      detail.upstream.provider_status], ['gemini', 'gemini-3.5-flash', 'free', FailureKind.INVALID, 400, 400, 'INVALID_ARGUMENT']);
    assert.match(detail.request_id, /^req_/);
    assert.ok(detail.upstream.message.startsWith("Invalid value at 'messages[1].content' (TYPE_STRING), \"[redacted]\" for key [redacted] from [email]"));
    assert.ok(detail.upstream.message.includes('?key=[redacted]&a=1') && detail.upstream.message.includes('`default_api:read_file`'));
    assert.ok(detail.upstream.message.length <= UPSTREAM_MESSAGE_LIMIT);
  });

  await test('in-stream upstream errors are summarized too', async () => {
    const gw = gateway();
    gw.addSession('ses_alice_0000000000000000');
    reset({ groq: () => sse([{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me' } }] },
      { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code: 'tool_use_failed',
        failed_generation: 'SECRET MODEL OUTPUT' } }]) });
    const small = { ...FIXTURE, model: 'groq/openai/gpt-oss-120b', stream: true, max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }], tools: FIXTURE.tools.slice(0, 2) };
    const { result: response, logs } = await captureLogs(async () => {
      const reply = await gw.call(small);
      await reply.text();
      return reply;
    });
    assert.equal(response.status, 200);
    const [, detail] = logs.warn.find(([text]) => text === 'Neuron upstream error detail');
    assert.equal(detail.kind, FailureKind.MODEL_ERROR);
    assert.equal(detail.upstream.provider_code, 'tool_use_failed');
    assert.equal(detail.upstream.status, null);
    assert.ok(!JSON.stringify(logs).includes('SECRET MODEL OUTPUT'));
  });

  await test('a >16 KB rejection (Groq tool_use_failed writing a large file) never logs the cut-off model output', async () => {
    const gw = gateway();
    gw.addSession('ses_alice_0000000000000000');
    const file = 'DB_PASSWORD=Sup3r-S3cret-Value and the private notes of the user: ' + 'lorem ipsum dolor sit amet '.repeat(900);
    const body = JSON.stringify({ error: { message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
      type: 'invalid_request_error', code: 'tool_use_failed',
      failed_generation: '<function=write_file>{"path":"notes.txt","content":"' + file + '"}</function>' } });
    assert.ok(body.length > 16384, 'the body is cut by readBounded');
    reset({ groq: () => new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } }) });
    const request = { model: 'groq/openai/gpt-oss-120b', stream: false, max_tokens: 1024, messages: [{ role: 'user', content: 'write notes' }],
      tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } } } } }] };
    const { result: response, logs } = await captureLogs(() => gw.call(request));
    const serialized = JSON.stringify(logs);
    for (const leaked of ['Sup3r-S3cret-Value', 'private notes', 'lorem ipsum', 'notes.txt', '<function=write_file>']) {
      assert.ok(!serialized.includes(leaked), 'logs never contain ' + leaked);
    }
    const [, detail] = logs.warn.find(([text]) => text === 'Neuron upstream error detail');
    // The complete fields before the cut still classify it: a model-side failure, not the caller's.
    assert.equal(detail.kind, FailureKind.MODEL_ERROR);
    assert.deepEqual(detail.upstream, { status: 400, provider_code: 'tool_use_failed', provider_type: 'invalid_request_error',
      message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.", truncated: true });
    assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.equal(error.code, 'upstream_error');
    assert.ok(!JSON.stringify(error).includes('Sup3r'));

    // Streamed requests read the same bounded body when the upstream rejects before streaming.
    const streamed = await captureLogs(async () => (await gw.call({ ...request, stream: true })).text());
    assert.ok(!JSON.stringify(streamed.logs).includes('Sup3r-S3cret-Value'));
    assert.equal(streamed.logs.warn.find(([text]) => text === 'Neuron upstream error detail')[1].upstream.truncated, true);
  });

  // ── Diagnostics helpers ──
  await test('cut-off JSON error bodies keep only their complete fields; raw JSON text is never the message', () => {
    assert.deepEqual(parseTruncatedJson('{"error":{"message":"m","code":"tool_use_failed","failed_generation":"secret, \\"quoted\\" and cut'),
      { error: { message: 'm', code: 'tool_use_failed' } });
    assert.deepEqual(parseTruncatedJson('[{"error":{"code":400,"message":"a, b","status":"INVALID_ARGUMENT","details":[{"reason":"X"},{"rea'),
      [{ error: { code: 400, message: 'a, b', status: 'INVALID_ARGUMENT', details: [{ reason: 'X' }] } }]);
    assert.deepEqual(parseTruncatedJson('{"error":{"code":400,"message":"cut'), { error: { code: 400 } });
    assert.equal(parseTruncatedJson('{"error":{"message":"Some prompt words here and more'), undefined);
    assert.equal(parseTruncatedJson('{"a":1]'), undefined);
    assert.equal(parseTruncatedJson('not json'), undefined);
    // A cut-off message is dropped rather than logged (the prompt words were in it).
    assert.deepEqual(upstreamErrorSummary(400, '{"error":{"message":"Some prompt words here and more'), { status: 400, truncated: true });
    assert.deepEqual(upstreamErrorSummary(400, '{"error":{"code":"context_length_exceeded","message":"Please reduce the length, the user said'),
      { status: 400, provider_code: 'context_length_exceeded', truncated: true });
    assert.equal(classifyUpstreamFailure(400, '{"error":{"message":"x","code":"tool_use_failed","failed_generation":"cut').kind, FailureKind.MODEL_ERROR);
    // A JSON body that is complete but not an error object is not echoed either.
    assert.deepEqual(upstreamErrorSummary(400, '["the user prompt"]'), { status: 400 });
  });

  await test('diagnostics read FastAPI, RFC 7807, string and Workers AI error bodies', () => {
    assert.deepEqual(upstreamErrorSummary(422, '{"detail":"Input should be a valid string for messages.3.content"}'),
      { status: 422, message: 'Input should be a valid string for messages.3.content' });
    assert.deepEqual(upstreamErrorSummary(422, JSON.stringify({ detail: [{ type: 'string_type', loc: ['body', 'messages', 3, 'content'],
      msg: 'Input should be a valid string', input: { secret: 'the user prompt' } }] })),
    { status: 422, message: 'body.messages.3.content: Input should be a valid string' });
    assert.deepEqual(upstreamErrorSummary(422, JSON.stringify({ detail: [{ loc: ['body', 'the user prompt'], msg: 'Field required' }] })),
      { status: 422, message: 'Field required' }, 'a location that is not a field path is left out');
    assert.deepEqual(upstreamErrorSummary(422, JSON.stringify({ type: 'about:blank', title: 'Unprocessable Entity', status: 422 })),
      { status: 422, provider_type: 'about:blank', message: 'Unprocessable Entity' });
    assert.deepEqual(upstreamErrorSummary(404, '{"error":"model not found"}'), { status: 404, message: 'model not found' });
    assert.deepEqual(upstreamErrorSummary(429, '{"errors":[{"code":3036,"message":"You have used up your daily free allocation"}],"success":false}'),
      { status: 429, provider_code: 3036, message: 'You have used up your daily free allocation' });
    assert.deepEqual(upstreamErrorSummary(502, '<html><head><title>502 Bad Gateway</title></head></html>'),
      { status: 502, message: '<html><head><title>502 Bad Gateway</title></head></html>' });
  });

  await test('redaction keeps field paths and identifiers, removes keys, e-mails, blobs and quoted prompt text', () => {
    assert.equal(redactProviderMessage("'messages.3' : for 'role:tool' the following must be satisfied[('messages.3' : property 'is_error' is unsupported)]"),
      "'messages.3' : for 'role:tool' the following must be satisfied[('messages.3' : property 'is_error' is unsupported)]");
    assert.equal(redactProviderMessage("can't find 'Some user words here'"), "can't find '[redacted]'");
    assert.equal(redactProviderMessage('Bearer abc.def-123 sk-or-v1-0123456789abcdef0123 gsk_0123456789abcdefghijk ses_0123456789abcdef0123'),
      '[redacted] [redacted] [redacted] [redacted]');
    assert.equal(redactProviderMessage('key oops-0123456789', { secrets: ['oops-0123456789'] }), 'key [redacted]');
    assert.equal(redactProviderMessage('metric generativelanguage.googleapis.com/generate_content_free_tier_input_token_count'),
      'metric generativelanguage.googleapis.com/generate_content_free_tier_input_token_count');
    assert.equal(redactProviderMessage(' a \n\n b '), 'a b');
    assert.equal(redactProviderMessage('y'.repeat(1000)).length, UPSTREAM_MESSAGE_LIMIT);
    assert.equal(redactProviderMessage(undefined), '');
    // Quotes that are never closed (a cut-off body) are redacted to the end of the text.
    assert.equal(redactProviderMessage("Unterminated quote: 'this is a very long prompt fragment that never closes"), "Unterminated quote: '[redacted]");
    assert.equal(redactProviderMessage('bad "a b" then "the user prompt, cut'), 'bad "[redacted]" then "[redacted]');
    assert.equal(redactProviderMessage('field "messages.3" then `run the deploy'), 'field "messages.3" then `[redacted]');
    assert.equal(redactProviderMessage('value "cut with an escaped quote \\"'), 'value "[redacted]');
    assert.equal(redactProviderMessage('{"error":{"message":"Some prompt words'), '{"error":{"message":"[redacted]');
    assert.equal(redactProviderMessage("can't and won't stay"), "can't and won't stay");
    assert.deepEqual(upstreamErrorSummary(401, '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}'),
      { status: 401, provider_code: 'invalid_api_key', provider_type: 'invalid_request_error', message: 'Invalid API Key' });
    assert.deepEqual(upstreamErrorSummary(500, 'not json'), { status: 500, message: 'not json' });
    assert.deepEqual(upstreamErrorSummary(503, ''), { status: 503 });
    const reasons = upstreamErrorSummary(400, JSON.stringify([{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'USER_LOCATION_INVALID' }] } }]));
    assert.deepEqual(reasons.reasons, ['USER_LOCATION_INVALID']);
  });

  // ── 429 learning and budgets ──
  await test('repeated 429s back off further; the upstream delay is honoured; a success resets', () => {
    const tracker = new ProviderHealthTracker({ cooldownMs: 30000, rateLimitMaxBackoffMs: 100000 });
    const key = 'gemini:gemini-2.5-flash:free';
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const strike = (retryAfterSeconds = 0) => {
        tracker.recordFailure(key, { kind: FailureKind.RATE_LIMITED, retryAfterSeconds });
        const ms = tracker.cooldownRemainingMs(key, now);
        now += ms + 1;
        return ms;
      };
      assert.equal(strike(), 30000, 'no delay given: default cooldown');
      assert.equal(strike(), 60000, 'still limited right after the cooldown: doubled');
      assert.equal(strike(), 100000, 'capped');
      tracker.recordSuccess(key);
      assert.equal(strike(14), 14000, 'after a success the upstream delay is honoured as given');
      assert.equal(strike(14), 30000, 'a second strike waits at least half the escalated backoff (60 s)');
      now += 600000;
      assert.equal(strike(14), 14000, 'strikes are forgotten after the window');
      // 429s from requests already in flight while the circuit is open do not escalate.
      tracker.recordFailure(key, { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 14 });
      tracker.recordFailure(key, { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 2 });
      assert.equal(tracker.getRecord(key).rate_limit_strikes, 2);
      assert.equal(tracker.cooldownRemainingMs(key, now), 30000, 'a shorter delay never shortens an open circuit');
      tracker.reset(key);
      assert.equal(strike(3600), 3600000, 'per-day quota delays are kept');
    } finally {
      Date.now = realNow;
    }
  });

  await test('free Gemini budgets stay below the observed upstream limit and still fit a Neuron request', () => {
    assert.deepEqual({ ...POOL_LIMITS.gemini_free }, { rpm: 5, rpd: 250, tpm: 100000, tpd: 5000000 });
    for (const id of ['gemini/gemini-2.5-flash', 'gemini/gemini-3.5-flash']) {
      const free = entry(id).pools.find(pool => pool.tier === 'free');
      assert.equal(free.limits, POOL_LIMITS.gemini_free);
      // The captured request with its full 71,891-character system prompt is ~23K tokens upstream.
      assert.equal(fitMaxTokens(entry(id), free, 23500, 8192), 8192);
      assert.equal(fitMaxTokens(entry(id), free, 99500, 8192), 0, 'no room for a useful answer in the per-minute budget');
      assert.deepEqual(reservationArgs({ session: { user_id: 'u' }, requestId: 'r', entry: entry(id), pool: free, promptTokens: 23500,
        maxTokens: 8192 }).p_pool, { rpm: 5, rpd: 250, tpm: 100000, tpd: 5000000 });
    }
    assert.ok(estimatePromptTokens(FIXTURE.messages, FIXTURE.tools) < 100000);
  });

  console.log(`PASS: ${results.length} provider request checks (Neuron fixture vs strict Gemini/Groq validators, normalizer transforms, thought signatures, sanitized diagnostics, 429 backoff, Gemini budgets)`);
} finally {
  globalThis.fetch = originalFetch;
}
