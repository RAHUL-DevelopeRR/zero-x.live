import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import { estimatePromptTokens, modelCatalog } from './src/providers.js';
import { FailureKind, globalHealthTracker } from './src/provider-health.js';
import { CATALOG, poolKey } from './src/catalog.js';
import { RESERVED_OUTPUT_TOKENS } from './src/capacity.js';
import { planPolicyRows } from './contract-rows.mjs';

const B1_POLICY_ROWS = await planPolicyRows();

const store = new Map();
const day = new Date().toISOString().slice(0, 10);
const env = {
  ALLOW_ANONYMOUS_SESSIONS: 'true',
  AI: { run: async () => { throw new Error('Wrong provider'); } },
  OPENROUTER_MODELS: 'meta-llama/llama-3.3-70b-instruct:free',
  OPENROUTER_API_KEY: 'shared-key',
  GROQ_API_KEY: 'groq-test', GROQ_MODELS: 'openai/gpt-oss-120b,llama-3.3-70b-versatile',
  GEMINI_API_KEY: 'gemini-test', GEMINI_MODELS: 'gemini-2.5-flash',
  NVIDIA_API_KEY: 'nvidia-test', NVIDIA_MODELS: 'openai/gpt-oss-20b', NVIDIA_HOSTED: 'true',
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
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
assert.equal(estimatePromptTokens(messages, tools), Math.ceil(bytes(messages) / 3.5) + Math.ceil(bytes(tools) / 3.5));
const originalFetch = globalThis.fetch;
try {
  assert.equal((await request('/v1/chat/completions', { model: 'auto', messages }, 'pkce_bad')).status, 401);
  // Contract §3.2: /v1/models lists every offered model (plus `auto`) with availability for the
  // caller, so an unconfigured gateway lists them as not_configured rather than returning [].
  // (The old expectation of an empty list predates the contract.)
  const empty = (await (await app.request('https://zero-x.live/v1/models', {}, {})).json()).data;
  assert.equal(empty[0].id, 'auto');
  assert.ok(empty.length > 1 && empty.every(model => model.available === false && model.unavailable_reason === 'not_configured'));
  const models = (await (await request('/v1/models')).json()).data;
  assert.ok(models.some(model => model.id === '@cf/meta/llama-3.3-70b-instruct-fp8-fast' && model.capabilities.tools && model.available));
  assert.ok(models.some(model => model.id === 'groq/openai/gpt-oss-120b' && model.owned_by === 'groq' && model.available));
  assert.ok(!models.some(model => model.owned_by === 'openrouter'), 'the operator OpenRouter key is not resold');
  assert.ok(!models.some(model => model.id.includes('llama-3.3-70b-versatile')), 'unverified *_MODELS ids are ignored');
  assert.ok(!models.some(model => model.id === 'gpt-5.4-pro'));
  assert.deepEqual(modelCatalog(env, { ...session, openrouter_key: 'owned-key', owned_provider_only: true }).map(model => model.provider), ['openrouter']);
  assert.equal((await request('/v1/chat/completions', { model: 'auto', messages }, 'ses_test', { ...env, ALLOW_ANONYMOUS_SESSIONS: 'false' })).status, 401);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer groq-test');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.tools, tools);
    assert.equal(payload.temperature, 0);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.js"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 13 } });
  };
  let response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages, tools, temperature: 0 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.tool_calls[0].id, 'tool-1');
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 13);
  assert.equal(JSON.parse(store.get('ses_test')).requests, 1);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer owned-key');
    assert.deepEqual(JSON.parse(options.body).provider, { data_collection: 'deny' });
    return Response.json({ choices: [], usage: { total_tokens: 2 } });
  };
  assert.equal((await request('/v1/chat/completions', { model: 'meta-llama/llama-3.3-70b-instruct:free', messages }, 'ses_owned')).status, 200);
  assert.equal((await request('/v1/chat/completions', { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages }, 'ses_owned')).status, 404);
  assert.equal((await request('/v1/chat/completions', { model: 'meta-llama/llama-3.3-70b-instruct:free', messages })).status, 404);
  assert.equal((await request('/v1/chat/completions', { model: 'gpt-5.4-pro', messages })).status, 404);
  assert.equal((await request('/v1/chat/completions', { model: '@cf/meta/llama-3.1-8b-instruct', messages, tools })).status, 404);

  env.AI.run = async (model, payload) => {
    assert.equal(model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.deepEqual(payload.tools, tools.map(tool => tool.function));
    return { response: '', tool_calls: [{ name: 'read_file', arguments: { path: 'hello.js' } }], usage: { total_tokens: 21 } };
  };
  response = await request('/v1/chat/completions', { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages, tools });
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
  response = await request('/v1/chat/completions', { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages, tools, stream: true });
  const stream = await response.text();
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.ok(stream.includes('héllo'));
  assert.ok(stream.includes('"finish_reason":"tool_calls"'));
  assert.ok(stream.includes('"index":0'), 'Workers AI tool calls carry an index');
  assert.equal(stream.match(/data: \[DONE\]/g).length, 1);
  const chunks = stream.split('\n\n').filter(event => event.startsWith('data: {')).map(event => JSON.parse(event.slice(6)));
  assert.equal(new Set(chunks.filter(chunk => chunk.choices).map(chunk => chunk.id)).size, 1);
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 64);

  // Production (28 Oct, CPU-3): with Gemini and Groq parked, every `auto` request with tool
  // history spent an attempt on Workers AI llama-3.3, which answered 400 (5006). auto now goes
  // straight to the next candidate (NVIDIA) without calling the binding.
  globalHealthTracker.reset();
  for (const entry of CATALOG.filter(item => item.provider === 'gemini' || item.provider === 'groq')) {
    for (const pool of entry.pools) globalHealthTracker.recordFailure(poolKey(entry, pool), { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 60 });
  }
  const bindingRuns = [];
  const parkedEnv = { ...env, ALLOW_UNKNOWN_COUNTRY: 'true',
    AI: { run: async model => { bindingRuns.push(model); throw new Error('5006: Invalid input'); } } };
  const parkedUpstreams = [];
  globalThis.fetch = async url => {
    parkedUpstreams.push(url);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } });
  };
  store.set('ses_parked', JSON.stringify(session));
  const toolHistory = [...messages,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"hello.js"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'console.log(1)', is_error: false }];
  response = await request('/v1/chat/completions', { model: 'auto', messages: toolHistory, tools }, 'ses_parked', parkedEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(bindingRuns, [], 'auto makes no Workers AI binding call');
  assert.deepEqual(parkedUpstreams, ['https://integrate.api.nvidia.com/v1/chat/completions']);
  globalHealthTracker.reset();

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'openai/gpt-oss-120b');
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"total_tokens":19}}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages, tools, stream: true });
  assert.ok((await response.text()).includes('"arguments":"{}"'));
  assert.equal(JSON.parse(store.get('ses_test')).tokens_used, 83);
  for (const [model, url, upstream] of [
    ['gemini/gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'gemini-2.5-flash'],
    ['nvidia/openai/gpt-oss-20b', 'https://integrate.api.nvidia.com/v1/chat/completions', 'openai/gpt-oss-20b'],
  ]) {
    globalThis.fetch = async (actualUrl, options) => { assert.equal(actualUrl, url); assert.equal(JSON.parse(options.body).model, upstream); return Response.json({ choices: [], usage: { total_tokens: 2 } }); };
    // app.request carries no caller country: free Gemini fails closed unless local
    // development opts in with ALLOW_UNKNOWN_COUNTRY (Groq/NVIDIA are not geo-restricted).
    assert.equal((await request('/v1/chat/completions', { model, messages }, 'ses_test', { ...env, ALLOW_UNKNOWN_COUNTRY: 'true' })).status, 200);
  }
  assert.equal((await request('/v1/chat/completions', { model: 'gemini/gemini-2.5-flash', messages })).status, 403,
    'an unknown caller country never reaches the geo-restricted free Gemini pool');
  globalThis.fetch = async () => new Response('sensitive provider diagnostic owned-key', { status: 429, headers: { 'Retry-After': '15' } });
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '15');
  const limited = await response.json();
  assert.equal(limited.error.code, 'capacity_exhausted');
  assert.equal(limited.error.retry_after_seconds, 15);
  assert.ok(!JSON.stringify(limited).includes('owned-key'));
  globalHealthTracker.reset();
  globalThis.fetch = async () => new Response('invalid credential sensitive diagnostics', { status: 401 });
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages });
  assert.equal(response.status, 502);
  const serviceError = await response.json();
  assert.equal(serviceError.error.message, 'Generation is temporarily unavailable. Retry shortly.');
  assert.equal(serviceError.error.code, 'upstream_error');
  assert.equal(serviceError.error.provider, undefined);
  assert.equal(serviceError.error.upstream_status, undefined);
  assert.ok(!JSON.stringify(serviceError).includes('credential'));
  globalHealthTracker.reset();
  store.set('ses_exhausted', JSON.stringify({ ...session, tokens_used: 256000 }));
  response = await request('/v1/chat/completions', { model: 'auto', messages }, 'ses_exhausted');
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'insufficient_quota');
  store.set('ses_yesterday', JSON.stringify({ ...session, tokens_used: 256000, usage_day: '2000-01-01' }));
  globalThis.fetch = async () => Response.json({ choices: [], usage: { total_tokens: 2 } });
  assert.equal((await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages }, 'ses_yesterday')).status, 200);
  assert.equal(JSON.parse(store.get('ses_yesterday')).tokens_used, 2);
  const beforeInterrupted = JSON.parse(store.get('ses_test')).tokens_used;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages, stream: true });
  const interrupted = await response.text();
  assert.ok(interrupted.includes('Generation interrupted. Retry your request.'));
  assert.ok(!interrupted.includes('[DONE]'));
  const afterInterrupted = JSON.parse(store.get('ses_test')).tokens_used;
  assert.ok(afterInterrupted > beforeInterrupted && afterInterrupted < beforeInterrupted + 4096, 'interrupted streams bill the estimate, not the reservation');

  // Account-backed requests reserve through zerox_reserve_v2 before any provider call and
  // never rewrite the session in KV.
  const accountId = '12345678-1234-4234-8234-123456789abc';
  const accountEnv = { ...env, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
  const accountSession = JSON.stringify({ ...session, user_id: accountId, account_backed: true });
  store.set('ses_account', accountSession);
  const rpcCalls = [];
  let allowReserve = true;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/rest/v1/rpc/')) {
      const rpc = url.split('/').at(-1); const args = JSON.parse(options.body); rpcCalls.push([rpc, args]);
      if (rpc === 'zerox_get_account') return Response.json([{ clerk_id: accountId, plan: 'free', daily_requests: 1, daily_tokens_used: 5000, last_usage_reset: day }]);
      if (rpc === 'zerox_plan_policies_v2') return Response.json(B1_POLICY_ROWS);
      if (rpc === 'zerox_reserve_v2') return Response.json([allowReserve
        ? { status: 'ok', reservation_id: 'res-1', plan: 'free', remaining_requests: 98, remaining_tokens: 490000 }
        : { status: 'user_daily_tokens', resets_at: `${day}T23:59:59Z` }]);
      if (rpc === 'zerox_settle_v2') return Response.json([{ status: 'settled' }]);
      throw new Error(`Unexpected RPC ${rpc}`);
    }
    assert.equal(rpcCalls.at(-1)[0], 'zerox_reserve_v2');
    return Response.json({ choices: [], usage: { total_tokens: 99 } });
  };
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages }, 'ses_account', accountEnv);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-neuron-quota-remaining-requests'), '98');
  const reserve = rpcCalls.find(([rpc]) => rpc === 'zerox_reserve_v2')[1];
  assert.equal(reserve.p_user_id, accountId);
  assert.equal(reserve.p_tokens, estimatePromptTokens(messages) + RESERVED_OUTPUT_TOKENS, 'the prompt plus a bounded output allowance');
  assert.equal(reserve.p_request_id, response.headers.get('x-request-id'));
  assert.equal(rpcCalls.at(-1)[0], 'zerox_settle_v2');
  assert.equal(rpcCalls.at(-1)[1].p_reservation_id, 'res-1');
  assert.equal(rpcCalls.at(-1)[1].p_prompt_tokens + rpcCalls.at(-1)[1].p_completion_tokens, 99);
  assert.equal(rpcCalls.at(-1)[1].p_status, 'ok');
  assert.equal(store.get('ses_account'), accountSession, 'account sessions are not rewritten after reserving');
  allowReserve = false;
  response = await request('/v1/chat/completions', { model: 'groq/openai/gpt-oss-120b', messages }, 'ses_account', accountEnv);
  assert.equal(response.status, 429);
  const quotaError = (await response.json()).error;
  assert.equal(quotaError.code, 'insufficient_quota');
  assert.ok(quotaError.resets_at);
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

  // Production (28 Oct, request #47): each candidate had 45 s to its first byte and the chain
  // had no overall deadline, so the request ran 91 s, past the CLI's 60 s retry, and its third
  // attempt started after the client had left. UPSTREAM_FAILOVER_BUDGET_MS bounds everything
  // before the stream is committed: no candidate starts once it is spent, and the request ends
  // as a 504 upstream_timeout.
  globalHealthTracker.reset();
  store.set('ses_budget', JSON.stringify(session));
  const budgetMs = 600;
  const budgetEnv = { ALLOW_ANONYMOUS_SESSIONS: 'true', SESSIONS_KV: env.SESSIONS_KV, ALLOW_UNKNOWN_COUNTRY: 'true',
    GROQ_API_KEY: 'groq-test', GEMINI_API_KEY: 'gemini-test', NVIDIA_API_KEY: 'nvidia-test', NVIDIA_HOSTED: 'true',
    ROUTER_MAX_ATTEMPTS: '8', UPSTREAM_TTFB_TIMEOUT_MS: '250', UPSTREAM_FAILOVER_BUDGET_MS: String(budgetMs) };
  // An upstream that never sends a byte (it only stops when the gateway aborts the attempt).
  const silent = options => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  let upstreamStarts = [];
  globalThis.fetch = async (url, options) => { upstreamStarts.push(Date.now()); return silent(options); };
  let budgetStart = Date.now();
  response = await request('/v1/chat/completions', { model: 'auto', messages, stream: true }, 'ses_budget', budgetEnv);
  let elapsed = Date.now() - budgetStart;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.ok(elapsed < budgetMs + 300, `the failover chain ended within its budget (${elapsed} ms)`);
  assert.ok(upstreamStarts.length >= 2 && upstreamStarts.length < 8,
    `failed over within the budget, then stopped (${upstreamStarts.length} candidates)`);
  assert.ok(upstreamStarts.every(at => at - budgetStart < budgetMs), 'no candidate started after the budget ran out');

  // Only an attempt's own first-byte timeout counts against its pool. With 400 ms to the first
  // byte, the first candidate times out on its own (marked slow) and the second is cut by the
  // 600 ms budget: that pool was not given its full time, so nothing is recorded for it.
  globalHealthTracker.reset();
  upstreamStarts = [];
  budgetStart = Date.now();
  response = await request('/v1/chat/completions', { model: 'auto', messages, stream: true }, 'ses_budget',
    { ...budgetEnv, UPSTREAM_TTFB_TIMEOUT_MS: '400' });
  elapsed = Date.now() - budgetStart;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.equal(upstreamStarts.length, 2);
  assert.ok(elapsed >= budgetMs - 20 && elapsed < budgetMs + 300, `the second attempt ended with the budget (${elapsed} ms)`);
  const recorded = [...globalHealthTracker.records.values()];
  assert.equal(recorded.length, 1, 'the budget cut is not recorded against the second pool');
  assert.equal(recorded[0].last_failure_kind, 'timeout');
  assert.ok(recorded[0].slow_until > Date.now(), "the first pool's own timeout marks it slow");

  // A non-streaming response may take longer than the budget to generate, so it is due by the
  // end of the budget plus the idle timeout instead (1000 + 600 ms here), not after its own
  // first-byte plus idle timeouts (1200 ms from a start at about 700 ms).
  globalHealthTracker.reset();
  upstreamStarts = [];
  globalThis.fetch = async (url, options) => {
    upstreamStarts.push(Date.now());
    if (upstreamStarts.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return new Response('overloaded', { status: 503 });
    }
    return silent(options);
  };
  budgetStart = Date.now();
  response = await request('/v1/chat/completions', { model: 'auto', messages }, 'ses_budget',
    { ...budgetEnv, UPSTREAM_FAILOVER_BUDGET_MS: '1000', UPSTREAM_TTFB_TIMEOUT_MS: '600', UPSTREAM_IDLE_TIMEOUT_MS: '600' });
  elapsed = Date.now() - budgetStart;
  assert.equal(response.status, 504, 'a 5xx, then the budget ran out');
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.equal(upstreamStarts.length, 2);
  assert.ok(elapsed >= 1550 && elapsed < 1850, `the non-streaming attempt ended at budget + idle (${elapsed} ms)`);
  assert.equal(globalHealthTracker.records.size, 1, 'only the 503 is recorded');

  // SSE comments before the first data event extend a candidate's wait (up to TTFB + idle),
  // but not past the budget.
  globalHealthTracker.reset();
  upstreamStarts = [];
  globalThis.fetch = async (url, options) => {
    upstreamStarts.push(Date.now());
    let timer;
    const stop = () => clearInterval(timer);
    options.signal.addEventListener('abort', stop, { once: true });
    return new Response(new ReadableStream({
      start(controller) {
        timer = setInterval(() => {
          try { controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')); } catch { stop(); }
        }, 50);
      },
      cancel: stop,
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  budgetStart = Date.now();
  response = await request('/v1/chat/completions', { model: 'auto', messages, stream: true }, 'ses_budget',
    { ...budgetEnv, UPSTREAM_IDLE_TIMEOUT_MS: '1500' });
  elapsed = Date.now() - budgetStart;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.ok(elapsed < budgetMs + 300, `keep-alives do not extend the budget (${elapsed} ms)`);
  assert.equal(upstreamStarts.length, 1);
  // Keep-alives are not a data event: the pool had the whole budget and sent none, so it is
  // marked slow (on any plan), and nothing else, since it did not get its own timeout.
  const keptAlive = [...globalHealthTracker.records.values()];
  assert.deepEqual(keptAlive.map(rec => [rec.failed_attempts, rec.status, rec.slow_until > Date.now()]), [[0, 'HEALTHY', true]],
    'a pool that sent only keep-alives for the whole budget is slow, not failed');

  // A client that leaves while the first candidate waits for its first byte ends the request:
  // no other candidate is tried and the reservation is settled as client_disconnected, so the
  // abandoned request does not hold the user's concurrency slot. Workers only fire
  // request.signal on a disconnect with the enable_request_signal compatibility flag, and may
  // cancel work outside waitUntil once the client is gone, so the settlement goes through it.
  for (const config of ['wrangler.toml', 'wrangler.api.toml']) {
    assert.match(readFileSync(new URL(config, import.meta.url), 'utf8'),
      /^compatibility_flags\s*=\s*\[[^\]]*"enable_request_signal"/m, `${config} fires request.signal on disconnect`);
  }
  globalHealthTracker.reset();
  upstreamStarts = [];
  const leaverRpc = [];
  let leaverSettled = false;
  store.set('ses_leaver', JSON.stringify({ ...session, user_id: accountId, account_backed: true }));
  globalThis.fetch = async (url, options) => {
    if (url.includes('/rest/v1/rpc/')) {
      const rpc = url.split('/').at(-1); leaverRpc.push([rpc, JSON.parse(options.body)]);
      if (rpc === 'zerox_get_account') return Response.json([{ clerk_id: accountId, plan: 'free', daily_requests: 3, daily_tokens_used: 5000, last_usage_reset: day }]);
      if (rpc === 'zerox_plan_policies_v2') return Response.json(B1_POLICY_ROWS);
      if (rpc === 'zerox_reserve_v2') return Response.json([{ status: 'ok', reservation_id: `res-leaver-${leaverRpc.length}`, plan: 'free', remaining_requests: 96, remaining_tokens: 470000 }]);
      if (rpc === 'zerox_settle_v2') {
        await new Promise(resolve => setTimeout(resolve, 150));
        leaverSettled = true;
        return Response.json([{ status: 'settled' }]);
      }
      return Response.json(null);
    }
    upstreamStarts.push(Date.now());
    return silent(options);
  };
  const leaver = new AbortController();
  setTimeout(() => leaver.abort(), 100);
  const waited = [];
  const executionCtx = { waitUntil: promise => waited.push(promise), passThroughOnException() {} };
  budgetStart = Date.now();
  response = await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', signal: leaver.signal,
    headers: { Authorization: 'Bearer ses_leaver', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages, stream: true }) },
  { ...budgetEnv, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test',
    UPSTREAM_TTFB_TIMEOUT_MS: '2000', UPSTREAM_FAILOVER_BUDGET_MS: '10000' }, executionCtx);
  elapsed = Date.now() - budgetStart;
  assert.ok(elapsed < 1000, `the request ended when the client left (${elapsed} ms)`);
  assert.equal(upstreamStarts.length, 1, 'no candidate is tried after the client left');
  assert.equal(leaverSettled, false, 'the answer did not wait for the settlement');
  assert.ok(waited.length >= 1, 'the settlement was handed to waitUntil');
  await Promise.all(waited);
  assert.equal(leaverSettled, true);
  const leaverReserves = leaverRpc.filter(([rpc]) => rpc === 'zerox_reserve_v2');
  const leaverSettles = leaverRpc.filter(([rpc]) => rpc === 'zerox_settle_v2').map(([, args]) => args);
  assert.equal(leaverReserves.length, 1);
  assert.equal(leaverSettles.length, 1);
  assert.equal(leaverSettles[0].p_reservation_id, `res-leaver-${leaverRpc.indexOf(leaverReserves[0]) + 1}`);
  assert.equal(leaverSettles[0].p_status, 'error');
  assert.equal(leaverSettles[0].p_error_code, 'client_disconnected');
  assert.equal(globalHealthTracker.records.size, 0, 'a client abort says nothing about the pool');
  globalHealthTracker.reset();
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: verified catalogs, explicit provider routing, owned keys, tool round trips, split SSE, streamed quota, daily reset, rate-limit errors, ledger reservations, failover budget, client aborts');
