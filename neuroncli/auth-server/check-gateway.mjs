import assert from 'node:assert/strict';
import app from './src/index.js';
import { estimatePromptTokens, modelCatalog } from './src/providers.js';

const store = new Map();
const day = new Date().toISOString().slice(0, 10);
const env = {
  ALLOW_ANONYMOUS_SESSIONS: 'true',
  AI: { run: async () => { throw new Error('Wrong provider'); } },
  OPENROUTER_MODELS: 'meta-llama/llama-3.3-70b-instruct:free',
  OPENROUTER_API_KEY: 'shared-key',
  GROQ_API_KEY: 'groq-test', GROQ_MODELS: 'llama-3.3-70b-versatile',
  GEMINI_API_KEY: 'gemini-test', GEMINI_MODELS: 'gemini-2.5-flash',
  NVIDIA_API_KEY: 'nvidia-test', NVIDIA_MODELS: 'nvidia/test',
  SESSIONS_KV: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) },
};
const session = { created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: day };
store.set('ses_test', JSON.stringify(session));
store.set('ses_owned', JSON.stringify({ ...session, openrouter_key: 'owned-key' }));
const request = (path, body, token = 'ses_test', bindings = env) => app.request(`https://zero-x.live${path}`, {
  method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
}, bindings);
const messages = [{ role: 'user', content: 'Read hello.js' }];
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
assert.equal(estimatePromptTokens(messages, tools), Math.ceil(new TextEncoder().encode(JSON.stringify({ messages, tools })).byteLength / 4));
const originalFetch = globalThis.fetch;
try {
  assert.equal((await request('/v1/chat/completions', { model: 'auto', messages }, 'pkce_bad')).status, 401);
  const empty = await app.request('https://zero-x.live/v1/models', {}, {});
  assert.deepEqual((await empty.json()).data, []);
  const models = (await (await request('/v1/models')).json()).data;
  assert.ok(models.some(model => model.id === 'meta-llama/llama-3.3-70b-instruct:free' && model.owned_by === 'openrouter'));
  assert.ok(models.some(model => model.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast' && model.capabilities.tools));
  assert.ok(!models.some(model => model.id === 'gpt-5.4-pro'));
  assert.deepEqual(modelCatalog(env, { ...session, openrouter_key: 'owned-key', owned_provider_only: true }).map(model => model.provider), ['openrouter']);
  assert.equal((await request('/v1/chat/completions', { model: 'auto', messages }, 'ses_test', { ...env, ALLOW_ANONYMOUS_SESSIONS: 'false' })).status, 401);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer shared-key');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.tools, tools);
    assert.equal(payload.temperature, 0);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.js"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 13 } });
  };
  let response = await request('/v1/chat/completions', { model: 'meta-llama/llama-3.3-70b-instruct:free', messages, tools, temperature: 0 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.tool_calls[0].id, 'tool-1');
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 13);
  assert.equal(JSON.parse(store.get('ses_test')).requests, 1);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer owned-key');
    return Response.json({ choices: [], usage: { total_tokens: 2 } });
  };
  assert.equal((await request('/v1/chat/completions', { model: 'meta-llama/llama-3.3-70b-instruct:free', messages }, 'ses_owned')).status, 200);
  assert.equal((await request('/v1/chat/completions', { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages }, 'ses_owned')).status, 404);
  assert.equal((await request('/v1/chat/completions', { model: 'gpt-5.4-pro', messages })).status, 404);
  assert.equal((await request('/v1/chat/completions', { model: '@cf/meta/llama-3.1-8b-instruct', messages, tools })).status, 400);

  env.AI.run = async (model, payload) => {
    assert.equal(model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.deepEqual(payload.tools, tools.map(tool => tool.function));
    return { response: '', tool_calls: [{ name: 'read_file', arguments: { path: 'hello.js' } }], usage: { total_tokens: 21 } };
  };
  response = await request('/v1/chat/completions', { model: 'auto', messages, tools });
  const completion = await response.json();
  assert.equal(response.status, 200);
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"path":"hello.js"}');
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 34);

  const encode = new TextEncoder();
  env.AI.run = async () => new ReadableStream({ start(controller) {
    const bytes = encode.encode('data: {"response":"héllo"}\r\n\r\ndata: {"tool_calls":[{"name":"read_file","arguments":{"path":"x"}}]}\n\ndata: {"usage":{"total_tokens":30}}\n\ndata: [DONE]');
    // Split through the UTF-8 character, JSON, CRLF, and final event without a delimiter.
    for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
    controller.close();
  } });
  response = await request('/v1/chat/completions', { model: 'auto', messages, tools, stream: true });
  const stream = await response.text();
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.ok(stream.includes('héllo'));
  assert.ok(stream.includes('"finish_reason":"tool_calls"'));
  assert.equal(stream.match(/data: \[DONE\]/g).length, 1);
  const chunks = stream.split('\n\n').filter(event => event.startsWith('data: {')).map(event => JSON.parse(event.slice(6)));
  assert.equal(new Set(chunks.filter(chunk => chunk.choices).map(chunk => chunk.id)).size, 1);
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 64);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'llama-3.3-70b-versatile');
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"total_tokens":19}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  response = await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages, tools, stream: true });
  assert.ok((await response.text()).includes('"arguments":"{}"'));
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 83);
  for (const [model, url, upstream] of [
    ['gemini/gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'gemini-2.5-flash'],
    ['nvidia/nvidia/test', 'https://integrate.api.nvidia.com/v1/chat/completions', 'nvidia/test'],
  ]) {
    globalThis.fetch = async (actualUrl, options) => { assert.equal(actualUrl, url); assert.equal(JSON.parse(options.body).model, upstream); return Response.json({ choices: [], usage: { total_tokens: 2 } }); };
    assert.equal((await request('/v1/chat/completions', { model, messages })).status, 200);
  }
  globalThis.fetch = async () => new Response('sensitive provider diagnostic owned-key', { status: 429, headers: { 'Retry-After': '15' } });
  response = await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '15');
  assert.ok(!(await response.text()).includes('owned-key'));
  globalThis.fetch = async () => new Response('invalid credential sensitive diagnostics', { status: 401 });
  response = await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages });
  assert.equal(response.status, 502);
  const serviceError = await response.json();
  assert.equal(serviceError.error.message, 'Generation is temporarily unavailable. Retry shortly.');
  assert.equal(serviceError.error.provider, undefined);
  assert.equal(serviceError.error.upstream_status, undefined);
  assert.ok(!JSON.stringify(serviceError).includes('credential'));
  store.set('ses_exhausted', JSON.stringify({ ...session, tokens_used: 256000 }));
  response = await request('/v1/chat/completions', { model: 'auto', messages }, 'ses_exhausted');
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'insufficient_quota');
  store.set('ses_yesterday', JSON.stringify({ ...session, tokens_used: 256000, usage_day: '2000-01-01' }));
  globalThis.fetch = async () => Response.json({ choices: [], usage: { total_tokens: 2 } });
  assert.equal((await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages }, 'ses_yesterday')).status, 200);
  assert.equal(JSON.parse(store.get('ses_yesterday')).tokens_used, 2);
  const beforeInterrupted = JSON.parse(store.get('ses_test')).tokens_used;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  response = await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages, stream: true });
  const interrupted = await response.text();
  assert.ok(interrupted.includes('Generation interrupted. Retry your request.'));
  assert.ok(!interrupted.includes('[DONE]'));
  assert.ok(JSON.parse(store.get('ses_test')).tokens_used > beforeInterrupted + 4096);

  // Account-backed requests reserve through database RPC before any provider call.
  const accountId = '12345678-1234-4234-8234-123456789abc';
  const accountEnv = { ...env, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
  store.set('ses_account', JSON.stringify({ ...session, user_id: accountId, account_backed: true }));
  const rpcCalls = [];
  let allowReserve = true;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/rest/v1/rpc/')) {
      const rpc = url.split('/').at(-1); const args = JSON.parse(options.body); rpcCalls.push([rpc, args]);
      if (rpc === 'zerox_reserve_usage' && !allowReserve) return Response.json([]);
      return Response.json([{ clerk_id: accountId, plan: 'free', daily_requests: 1, daily_tokens_used: 5000, last_usage_reset: day }]);
    }
    assert.equal(rpcCalls.at(-1)[0], 'zerox_reserve_usage');
    return Response.json({ choices: [], usage: { total_tokens: 99 } });
  };
  assert.equal((await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages }, 'ses_account', accountEnv)).status, 200);
  assert.equal(rpcCalls.at(-1)[0], 'zerox_settle_usage');
  assert.equal(rpcCalls.at(-1)[1].p_actual, 99);
  assert.equal(rpcCalls.at(-1)[1].p_reserved, estimatePromptTokens(messages) + 4096);
  assert.equal(rpcCalls.at(-1)[1].p_day, day);
  allowReserve = false;
  response = await request('/v1/chat/completions', { model: 'groq/llama-3.3-70b-versatile', messages }, 'ses_account', accountEnv);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'insufficient_quota');
  globalThis.fetch = async () => { throw new Error('database down'); };
  assert.equal((await app.request('https://zero-x.live/auth/session', { method: 'DELETE', headers: { Authorization: 'Bearer ses_account' } }, accountEnv)).status, 200);
  assert.equal(store.has('ses_account'), false);
  assert.equal((await app.request('https://zero-x.live/auth/session', { method: 'DELETE' }, env)).status, 401);
  assert.equal((await request('/v1/models', null, 'ses_account')).status, 401);

  const started = await (await app.request('https://zero-x.live/auth/openrouter/start', {}, env)).json();
  const authUrl = new URL(started.auth_url);
  assert.equal(authUrl.searchParams.get('callback_url'), 'https://zero-x.live/neuroncli/callback/');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('state'), started.state);
  assert.equal(authUrl.searchParams.has('client_id'), false);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(options.body);
    assert.equal(body.code_challenge_method, 'S256');
    assert.ok(body.code_verifier);
    return Response.json({ key: 'secret-owned-key' });
  };
  const callbackUrl = `https://zero-x.live/auth/openrouter/callback?code=test&state=${started.state}`;
  const exchange = await (await app.request(callbackUrl, {}, env)).json();
  assert.ok(exchange.session_token.startsWith('ses_'));
  assert.ok(!JSON.stringify(exchange).includes('secret-owned-key'));
  assert.deepEqual(exchange.models, ['meta-llama/llama-3.3-70b-instruct:free']);
  assert.equal((await app.request(callbackUrl, {}, env)).status, 400);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: configured catalogs, explicit provider routing, owned keys, tool round trips, split SSE, streamed quota, daily reset, rate-limit errors');
