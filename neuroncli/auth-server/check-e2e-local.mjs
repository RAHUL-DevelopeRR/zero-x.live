// End-to-end journey against the real Node server (server.js) on a random loopback port:
// PGlite account database in a fresh directory, the local dev identity, a fake
// OpenAI-compatible upstream and a fake Razorpay server (RAZORPAY_API_BASE). Then a static
// website smoke test with a CSP comparison on the same server.
//
//   node check-e2e-local.mjs          offline: every upstream and payment call is faked
//   node check-e2e-local.mjs --live   chat steps use the real Groq and Gemini free pools with
//                                     GROQ_API_KEY / GEMINI_API_KEY read from .dev.vars
//                                     (at most 10 real upstream calls; nothing else is real)
//
// Temporary files go to os.tmpdir() (set TMP/TEMP to choose the drive). The gateway process
// runs with e2e-upstream-shim.mjs preloaded, which refuses every non-loopback destination
// except, with --live, the two real upstreams.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { bootstrapPlans, planSql } from './scripts/razorpay-bootstrap.mjs';
import { devToken, devUserId } from './src/auth-context.js';
import { catalogEntry } from './src/catalog.js';
import { costMicrousd } from './src/pricing.js';

const LIVE = process.argv.includes('--live');
const MAX_REAL_CALLS = 10;
const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '../..');
const steps = [];
const step = (name, result) => { steps.push({ step: name, result }); console.log(`ok - ${name}: ${result}`); };
const random = (bytes = 24) => randomBytes(bytes).toString('base64url');
const hmac = (secret, message) => createHmac('sha256', secret).update(message).digest('hex');
const nextUtcMidnight = () => new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString();

// ── Secrets for this run (fake or test-only) ──
const RAZORPAY_KEY_ID = 'rzp_test_E2e' + randomBytes(6).toString('hex');
const RAZORPAY_KEY_SECRET = random();
const RAZORPAY_WEBHOOK_SECRET = random();
const ADMIN = random(36);
const FAKE_KEYS = { GROQ_API_KEY: 'e2e-groq-free', GEMINI_API_KEY: 'e2e-gemini-free',
  GROQ_PAID_API_KEY: 'e2e-groq-paid', GEMINI_PAID_API_KEY: 'e2e-gemini-paid' };

// Real free-pool keys for --live, parsed from .dev.vars and never printed.
function liveKeys() {
  const file = join(here, '.dev.vars');
  if (!existsSync(file)) throw new Error('--live needs .dev.vars with GROQ_API_KEY and GEMINI_API_KEY');
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(GROQ_API_KEY|GEMINI_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!values.GROQ_API_KEY || !values.GEMINI_API_KEY) throw new Error('.dev.vars lacks GROQ_API_KEY or GEMINI_API_KEY');
  return values;
}
const upstreamKeys = LIVE ? { ...FAKE_KEYS, ...liveKeys() } : FAKE_KEYS;
const secretValues = Object.values(upstreamKeys).filter(value => !value.startsWith('e2e-'));
const redact = text => secretValues.reduce((out, value) => out.split(value).join('<redacted>'), String(text));

const readBody = request => new Promise((done, fail) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk)).on('end', () => done(Buffer.concat(chunks).toString('utf8'))).on('error', fail);
});
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };

// ── Fake OpenAI-compatible upstream (Groq and Gemini paths) ──
const upstream = { calls: [] };
const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
const upstreamServer = createServer(async (request, response) => {
  const body = JSON.parse((await readBody(request)) || '{}');
  const provider = request.url.startsWith('/openai/v1/') ? 'groq' : request.url.startsWith('/v1beta/openai/') ? 'gemini' : null;
  upstream.calls.push({ provider, key: String(request.headers.authorization || '').replace(/^Bearer /, ''), model: body.model,
    stream: body.stream === true, tools: Array.isArray(body.tools) ? body.tools.length : 0, streamOptions: body.stream_options ?? null });
  if (!provider || !request.url.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
  if (JSON.stringify(body.messages || []).includes('E2E_TOOL_USE_FAILED')) {
    // Groq's answer when the generated tool call does not match the schema (after generation).
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error',
      code: 'tool_use_failed' } }));
    return;
  }
  if (!body.stream) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'up-1', object: 'chat.completion', choices: [{ index: 0,
      message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: USAGE }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = value => response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  const chunk = (delta, finish = null, extra = {}) => ({ id: 'up', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  send(chunk({ role: 'assistant', content: '' }));
  if (body.tools?.length) {
    // Gemini style: each call whole, with its own id and no index.
    const name = body.tools[0].function.name;
    send(chunk({ tool_calls: [{ id: 'call_a', type: 'function', function: { name, arguments: '{"path":"a.js"}' } }] }));
    send(chunk({ tool_calls: [{ id: 'call_b', type: 'function', function: { name, arguments: '{"path":"b.js"}' } }] }));
    send(chunk({}, 'stop', { usage: USAGE }));
  } else {
    send(chunk({ content: 'pong' }));
    send(chunk({}, 'stop'));
    send({ id: 'up', object: 'chat.completion.chunk', choices: [], usage: USAGE });
  }
  send('[DONE]');
  response.end();
});

// ── Fake Razorpay (the REST calls src/billing/razorpay.js and the bootstrap script make) ──
const rzp = { plans: [], subscriptions: new Map(), orders: new Map(), payments: new Map(), refunds: [], requests: [] };
const rid = prefix => `${prefix}_${randomBytes(7).toString('hex')}`;
const razorpayServer = createServer(async (request, response) => {
  const raw = await readBody(request);
  const body = raw ? JSON.parse(raw) : undefined;
  const url = new URL(request.url, 'http://razorpay.test');
  rzp.requests.push({ method: request.method, path: url.pathname, body });
  const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.headers.authorization !== 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')) {
    return reply(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
  }
  const parts = url.pathname.split('/').filter(Boolean); // v1, resource, id?, action?
  const [, resource, id, action] = parts;
  const notFound = () => reply(404, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
  if (resource === 'plans' && request.method === 'GET') return reply(200, { entity: 'collection', count: rzp.plans.length, items: rzp.plans });
  if (resource === 'plans' && request.method === 'POST') {
    const plan = { id: rid('plan'), entity: 'plan', ...body };
    rzp.plans.push(plan);
    return reply(200, plan);
  }
  if (resource === 'subscriptions' && request.method === 'POST' && !id) {
    const subscription = { id: rid('sub'), entity: 'subscription', plan_id: body.plan_id, status: 'created', notes: body.notes,
      total_count: body.total_count, quantity: body.quantity, customer_notify: body.customer_notify, current_start: null, current_end: null,
      created_at: Math.floor(Date.now() / 1000) };
    rzp.subscriptions.set(subscription.id, subscription);
    return reply(200, subscription);
  }
  if (resource === 'subscriptions' && id) {
    const subscription = rzp.subscriptions.get(id);
    if (!subscription) return notFound();
    if (request.method === 'POST' && action === 'cancel') {
      if (['cancelled', 'completed', 'expired'].includes(subscription.status)) {
        return reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Subscription is not cancellable in cancelled status.' } });
      }
      subscription.cancel_requested = body;
      if (body.cancel_at_cycle_end !== 1) subscription.status = 'cancelled';
    }
    return reply(200, subscription);
  }
  if (resource === 'orders' && request.method === 'POST') {
    const order = { id: rid('order'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt,
      notes: body.notes, status: 'created', created_at: Math.floor(Date.now() / 1000) };
    rzp.orders.set(order.id, order);
    return reply(200, order);
  }
  if (resource === 'orders' && id) return rzp.orders.has(id) ? reply(200, rzp.orders.get(id)) : notFound();
  if (resource === 'payments' && id && action === 'refund' && request.method === 'POST') {
    const payment = rzp.payments.get(id);
    if (!payment) return notFound();
    const amount = body.amount ?? payment.amount - (payment.amount_refunded || 0);
    if (payment.status !== 'captured' || amount <= 0) {
      return reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has been fully refunded already' } });
    }
    payment.amount_refunded = (payment.amount_refunded || 0) + amount;
    if (payment.amount_refunded >= payment.amount) payment.status = 'refunded';
    const refund = { id: rid('rfnd'), entity: 'refund', amount, currency: payment.currency, payment_id: id, notes: body.notes, status: 'processed' };
    rzp.refunds.push(refund);
    return reply(200, refund);
  }
  if (resource === 'payments' && id) return rzp.payments.has(id) ? reply(200, rzp.payments.get(id)) : notFound();
  return notFound();
});
// The buyer completes payment in the Razorpay window.
function paySubscription(subscriptionId) {
  const subscription = rzp.subscriptions.get(subscriptionId);
  const now = Math.floor(Date.now() / 1000);
  Object.assign(subscription, { status: 'active', current_start: now, current_end: now + 30 * 86400, paid_count: 1 });
  const payment = { id: rid('pay'), entity: 'payment', amount: 89900, currency: 'INR', status: 'captured', method: 'card',
    invoice_id: rid('inv'), captured: true, created_at: now };
  rzp.payments.set(payment.id, payment);
  return payment;
}
function payOrder(orderId) {
  const order = rzp.orders.get(orderId);
  order.status = 'paid';
  const payment = { id: rid('pay'), entity: 'payment', amount: order.amount, currency: order.currency, order_id: order.id,
    status: 'captured', method: 'upi', captured: true, created_at: Math.floor(Date.now() / 1000) };
  rzp.payments.set(payment.id, payment);
  return payment;
}

// ── Gateway process ──
let server = null;
let serverLog = '';
let dataRoot = null;
const realCallsFile = () => join(dataRoot, 'real-calls.txt');
const realCalls = () => existsSync(realCallsFile()) ? readFileSync(realCallsFile(), 'utf8').split('\n').filter(Boolean).length : 0;

async function startGateway(env) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(here, 'e2e-upstream-shim.mjs')).href, join(here, 'server.js')], {
    cwd: dataRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.on('data', chunk => { serverLog += chunk; });
  const port = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('gateway did not start within 60 s')), 60000);
    child.stdout.on('data', chunk => {
      serverLog += chunk;
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(serverLog);
      if (match) { clearTimeout(timer); done(Number(match[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); fail(new Error(`gateway exited with ${code}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stopGateway() {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill();
  await exited;
}

let base = '';
async function call(path, { method = 'GET', token, body, headers = {}, raw } = {}) {
  const response = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, body: json };
}
const sseEvents = text => text.split('\n\n').map(part => part.trim()).filter(part => part.startsWith('data: '))
  .map(part => part.slice(6)).map(data => data === '[DONE]' ? data : JSON.parse(data));
function expectError(result, status, code) {
  assert.equal(result.status, status, `expected ${status} ${code}, got ${result.status} ${redact(result.text).slice(0, 300)}`);
  assert.equal(result.body?.error?.code, code);
  assert.match(result.body.error.request_id, /^req_[0-9a-f]{32}$/);
  // OpenAI shape: param is null or names the offending field (e.g. razorpay_signature).
  assert.ok(result.body.error.param === null || typeof result.body.error.param === 'string');
  return result.body.error;
}
const webhook = (event, eventId, signature) => {
  const raw = JSON.stringify(event);
  return call('/webhooks/razorpay', { method: 'POST', raw,
    headers: { 'X-Razorpay-Signature': signature ?? hmac(RAZORPAY_WEBHOOK_SECRET, raw), 'X-Razorpay-Event-Id': eventId } });
};

const messages = [{ role: 'user', content: 'Use the read_file tool to read a.js and b.js. Do not answer without calling the tool.' }];
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file from the workspace',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } } }];

let failed = null;
try {
  dataRoot = await mkdtemp(join(tmpdir(), 'zerox-e2e-'));
  const dataDir = join(dataRoot, 'pglite');
  const upstreamBase = await listen(upstreamServer);
  const razorpayBase = `${await listen(razorpayServer)}/v1`;

  // ── Database: migrations, Razorpay plans (bootstrap script against the fake) and fixtures ──
  const dbEnv = { DATABASE_DRIVER: 'pglite', PGLITE_DATA_DIR: dataDir };
  const handle = await getPgliteHandle(dbEnv);
  const razorpayEnv = { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_API_BASE: razorpayBase };
  const plans = await bootstrapPlans({ env: razorpayEnv, apply: true });
  assert.equal(plans.filter(row => row.action === 'created').length, 4, 'bootstrap creates Pro/Max in INR and USD');
  await handle.db.exec(planSql(plans));
  // Cap fixture: a small free-plan token allocation so the daily cap is reached without
  // spending upstream calls (a 60K-token reservation exceeds it).
  await handle.db.query("UPDATE public.zerox_plan_policy SET daily_tokens = 50000 WHERE plan = 'free'");
  await closeAllPglite();
  step('database prepared', `${handle.applied.length} migrations applied in a fresh PGlite directory; scripts/razorpay-bootstrap.mjs created 4 plans on the fake Razorpay and their ids were stored`);

  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    AUTH_HOST: '127.0.0.1', AUTH_PORT: '0', DATABASE_DRIVER: 'pglite', PGLITE_DATA_DIR: dataDir,
    DEV_AUTH_ENABLED: 'true', ALLOW_UNKNOWN_COUNTRY: 'true', GATEWAY_ADMIN_TOKEN: ADMIN,
    SESSION_ENCRYPTION_KEY: random(36), RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_API_BASE: razorpayBase,
    ...upstreamKeys, E2E_UPSTREAM_BASE: upstreamBase, E2E_LIVE: LIVE ? 'true' : 'false', E2E_REAL_CALLS_FILE: realCallsFile(),
    ...(LIVE ? { ROUTER_MAX_ATTEMPTS: '2' } : {}),
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  server = await startGateway(env);
  base = server.base;
  step('gateway started', `node server.js on ${base} (DATABASE_DRIVER=pglite, DEV_AUTH_ENABLED=true, ${LIVE ? 'live Groq/Gemini free pools' : 'fake upstream'}, fake Razorpay)`);

  // ── 1. /auth/config reports the dev identity ──
  assert.deepEqual((await call('/auth/config')).body, { provider: 'dev', configured: true, dev: true, providers: ['dev'] });
  step('/auth/config', 'provider dev on the loopback Node server');

  // ── 2. dev token → CLI session ──
  const email = 'e2e.user@example.test';
  const dev = devToken(email);
  const userId = await devUserId(email);
  const session = await call('/auth/cli/session', { method: 'POST', token: dev, body: { machine_fingerprint: 'e2e', version: 'e2e' } });
  assert.equal(session.status, 200, redact(session.text));
  const ses = session.body.session_token;
  assert.match(ses, /^ses_[A-Za-z0-9_-]{32}$/);
  assert.equal(session.body.user_id, userId);
  assert.equal(session.body.plan, 'free');
  assert.equal(session.body.ttl_seconds, 720 * 3600);
  const sessionInfo = await call('/auth/session', { token: ses });
  assert.equal(sessionInfo.status, 200);
  assert.equal(sessionInfo.body.expires_at, session.body.expires_at);
  step('dev token -> POST /auth/cli/session', `ses_ session for the dev identity ${userId} (auth.users row provisioned on PGlite), 720 h TTL`);

  // ── 3. /v1/models with plan-aware availability ──
  const modelKeys = ['available', 'available_again_at', 'capabilities', 'checked_at', 'context_length', 'context_window',
    'created', 'display_name', 'id', 'max_output_tokens', 'object', 'owned_by', 'pricing', 'reasoning_efforts', 'status',
    'tiers', 'unavailable_reason'];
  const models = async token => {
    const listed = await call('/v1/models', { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.object, 'list');
    assert.equal(listed.body.data[0].id, 'auto');
    for (const model of listed.body.data) assert.deepEqual(Object.keys(model).sort(), modelKeys, model.id);
    return Object.fromEntries(listed.body.data.map(model => [model.id, model]));
  };
  const anonymous = await models();
  const free = await models(ses);
  for (const view of [anonymous, free]) {
    assert.equal(view.auto.available, true);
    assert.equal(view['groq/openai/gpt-oss-120b'].available, true);
    assert.equal(view['gemini/gemini-2.5-flash'].available, true);
    assert.equal(view['gemini/gemini-2.5-pro'].available, false);
    assert.equal(view['gemini/gemini-2.5-pro'].unavailable_reason, 'upgrade_required');
  }
  assert.ok(!Object.values(free).some(model => ['nvidia', 'openrouter'].includes(model.owned_by)), 'non-hosted providers are not listed');
  assert.ok(Object.values(free).every(model => model.status === 'available'), 'no failures yet: every model is available');
  const status = await call('/v1/models/status', { token: ses });
  assert.equal(status.status, 200);
  assert.equal(status.body.poll_interval_seconds, 30);
  assert.equal(status.body.data.length, Object.keys(free).length);
  const etag = status.headers.get('etag');
  assert.match(etag, /^W\/"[0-9a-f]{24}"$/);
  const unchanged = await call('/v1/models/status', { token: ses, headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304, 'an unchanged status list answers 304');
  step('GET /v1/models', `${Object.keys(free).length} entries; Free (anonymous and ses_): free pools available, gemini-2.5-pro upgrade_required; /v1/models/status ETag ${etag} -> 304`);

  // ── 4. Streaming chat with tools on 'auto' ──
  const upstreamBefore = upstream.calls.length;
  const streamed = await call('/v1/chat/completions', { method: 'POST', token: ses,
    body: { model: 'auto', stream: true, messages, tools, tool_choice: 'auto', max_tokens: 1024 } });
  assert.equal(streamed.status, 200, redact(streamed.text).slice(0, 400));
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const requestId = streamed.headers.get('x-request-id');
  assert.match(requestId, /^req_[0-9a-f]{32}$/);
  assert.equal(streamed.headers.get('x-neuron-plan'), 'free');
  assert.ok(Number(streamed.headers.get('x-neuron-quota-remaining-requests')) >= 0);
  assert.ok(streamed.headers.get('x-neuron-quota-remaining-tokens'));
  const streamModel = streamed.headers.get('x-neuron-model');
  const events = sseEvents(streamed.text);
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(events.filter(event => event === '[DONE]').length, 1);
  assert.ok(!events.some(event => event?.error), 'no error event');
  const chunks = events.filter(event => event !== '[DONE]');
  const toolDeltas = chunks.flatMap(item => (item.choices || []).flatMap(choice => choice.delta?.tool_calls || []));
  assert.ok(toolDeltas.every(delta => Number.isInteger(delta.index)), 'every tool_calls delta carries index');
  if (!LIVE) {
    assert.equal(streamModel, 'gemini/gemini-2.5-flash');
    const upstreamCall = upstream.calls[upstreamBefore];
    assert.deepEqual([upstreamCall.provider, upstreamCall.key, upstreamCall.model, upstreamCall.tools], ['gemini', 'e2e-gemini-free', 'gemini-2.5-flash', 1]);
    assert.deepEqual(upstreamCall.streamOptions, { include_usage: true });
    assert.deepEqual(toolDeltas.map(delta => [delta.index, delta.id]), [[0, 'call_a'], [1, 'call_b']]);
    assert.ok(chunks.some(item => item.choices?.[0]?.finish_reason === 'tool_calls'));
  } else {
    assert.ok(['gemini', 'groq'].includes(streamModel.split('/')[0]), streamModel);
  }
  const usageEvents = await call('/api/usage/events?limit=5', { token: ses });
  const settled = usageEvents.body.events.find(event => event.request_id === requestId);
  assert.ok(settled, 'the request is recorded under its x-request-id');
  assert.equal(settled.status, 'ok');
  assert.equal(settled.model, streamModel);
  assert.equal(settled.tier, 'free');
  assert.ok(settled.prompt_tokens > 0);
  if (!LIVE) assert.deepEqual([settled.prompt_tokens, settled.completion_tokens], [120, 30]);
  step('streaming /v1/chat/completions (auto, tools)', `${streamModel}: ${toolDeltas.length} tool_call deltas all indexed, single [DONE], settled ok with ${settled.prompt_tokens}+${settled.completion_tokens} tokens`);

  // ── 5. /api/account and /api/usage reflect the request ──
  let account = (await call('/api/account', { token: ses })).body;
  assert.equal(account.user.id, userId);
  assert.equal(account.plan.id, 'free');
  assert.deepEqual(account.limits, { daily_requests: 100, daily_tokens: 50000, rpm: 10, concurrency: 2 });
  assert.equal(account.usage_today.requests, 1);
  assert.equal(account.usage_today.tokens, settled.prompt_tokens + settled.completion_tokens);
  assert.equal(account.usage_today.resets_at, nextUtcMidnight());
  const usage = (await call('/api/usage', { token: ses })).body;
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.series.length, 30);
  // A refunded failover attempt (live upstreams) can add a zero-request row for another model.
  assert.deepEqual(usage.by_model.filter(row => row.requests > 0).map(row => [row.model, row.requests]), [[streamModel, 1]]);
  step('GET /api/account and /api/usage', `requests 1, tokens ${account.usage_today.tokens}, by_model ${streamModel} x1`);

  // ── 6. API keys: nzx_ works for inference and cannot mint keys ──
  // Minting a key needs the website sign-in (the dev identity here), never a CLI session.
  expectError(await call('/api/keys', { method: 'POST', token: ses, body: { name: 'from cli' } }), 403, 'session_not_allowed');
  const created = await call('/api/keys', { method: 'POST', token: dev, body: { name: 'e2e CI' } });
  assert.equal(created.status, 201, redact(created.text));
  const apiKey = created.body.secret;
  assert.match(apiKey, /^nzx_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.body.key.prefix, apiKey.slice(0, 12));
  const keyChat = await call('/v1/chat/completions', { method: 'POST', token: apiKey,
    body: { model: 'groq/openai/gpt-oss-20b', messages: [{ role: 'user', content: 'Reply with the single word pong.' }], max_tokens: 64 } });
  assert.equal(keyChat.status, 200, redact(keyChat.text).slice(0, 400));
  assert.equal(keyChat.headers.get('x-neuron-model'), 'groq/openai/gpt-oss-20b');
  assert.equal(keyChat.body.object, 'chat.completion');
  if (!LIVE) assert.equal(upstream.calls.at(-1).key, 'e2e-groq-free');
  expectError(await call('/api/keys', { method: 'POST', token: apiKey, body: { name: 'nested' } }), 403, 'api_key_not_allowed');
  assert.equal((await call('/api/account', { token: apiKey })).status, 200);
  const listedKeys = (await call('/api/keys', { token: ses })).body.keys;
  assert.equal(listedKeys.length, 1);
  assert.ok(listedKeys[0].last_used_at, 'last_used_at is recorded');
  step('POST /api/keys + nzx_ chat', `key ${created.body.key.prefix}… served groq/openai/gpt-oss-20b; creating a key with the ses_ session -> 403 session_not_allowed, with the nzx_ key -> 403 api_key_not_allowed`);

  // ── 7. Daily cap → 429 insufficient_quota (no upstream call) ──
  const callsBeforeCap = upstream.calls.length;
  const realBeforeCap = realCalls();
  const cap = expectError(await call('/v1/chat/completions', { method: 'POST', token: ses,
    body: { model: 'gemini/gemini-2.5-flash', messages, max_tokens: 60000 } }), 429, 'insufficient_quota');
  assert.equal(cap.type, 'insufficient_quota');
  assert.equal(cap.resets_at, nextUtcMidnight());
  assert.equal(cap.upgrade_url, 'https://zero-x.live/pricing');
  assert.equal(upstream.calls.length, callsBeforeCap);
  assert.equal(realCalls(), realBeforeCap, 'the cap is enforced before any upstream call');
  step('daily cap', `429 insufficient_quota, resets_at ${cap.resets_at}, upgrade_url ${cap.upgrade_url}, no upstream call`);

  // ── 7b. A model-side failure is refunded to the caller but kept in the shared pool budget ──
  // (review P2, integration: tool_use_failed and timeouts drained the free pools unseen)
  if (!LIVE) {
    const poolOf = async () => (await call('/admin/overview', { token: ADMIN })).body.pools
      .find(pool => pool.model === 'groq/openai/gpt-oss-20b' && pool.tier === 'free')?.requests_today ?? 0;
    const requestsBefore = (await call('/api/account', { token: ses })).body.usage_today.requests;
    const poolBefore = await poolOf();
    const modelError = expectError(await call('/v1/chat/completions', { method: 'POST', token: ses, body: { model: 'groq/openai/gpt-oss-20b', tools,
      messages: [{ role: 'user', content: 'E2E_TOOL_USE_FAILED: call read_file with a number for path' }] } }), 502, 'upstream_error');
    assert.equal(modelError.type, 'server_error');
    assert.equal((await call('/api/account', { token: ses })).body.usage_today.requests, requestsBefore, 'the caller gets the request back');
    assert.equal(await poolOf(), poolBefore + 1, 'the shared pool keeps the attempt the upstream counted');
    const [refundedEvent] = (await call('/api/usage/events?limit=1', { token: ses })).body.events;
    assert.deepEqual([refundedEvent.status, refundedEvent.prompt_tokens, refundedEvent.model], ['refunded', 0, 'groq/openai/gpt-oss-20b']);
    step('model-side failure (tool_use_failed)', `502 upstream_error; usage_today.requests stays ${requestsBefore}; free pool requests_today ${poolBefore} -> ${poolBefore + 1}`);
  }

  // ── 8. Pro checkout → signed verify → plan pro ──
  const checkout = await call('/api/billing/checkout', { method: 'POST', token: ses, body: { plan: 'pro', currency: 'INR' } });
  assert.equal(checkout.status, 200, redact(checkout.text));
  assert.equal(checkout.body.provider, 'razorpay');
  assert.equal(checkout.body.key_id, RAZORPAY_KEY_ID);
  const subscriptionId = checkout.body.subscription_id;
  // A second tab reuses the unpaid checkout instead of creating a second subscription (review P2).
  const secondTab = await call('/api/billing/checkout', { method: 'POST', token: ses, body: { plan: 'pro', currency: 'INR' } });
  assert.equal(secondTab.status, 200, redact(secondTab.text));
  assert.equal(secondTab.body.subscription_id, subscriptionId, 'one payable subscription per account');
  assert.equal(rzp.requests.filter(entry => entry.method === 'POST' && entry.path === '/v1/subscriptions').length, 1);
  assert.equal(rzp.subscriptions.get(subscriptionId).notes.user_id, userId);
  assert.equal(rzp.subscriptions.get(subscriptionId).plan_id, plans.find(row => row.plan === 'pro' && row.currency === 'INR').id);
  const firstPayment = paySubscription(subscriptionId);
  const verifyBody = { razorpay_payment_id: firstPayment.id, razorpay_subscription_id: subscriptionId,
    razorpay_signature: hmac(RAZORPAY_KEY_SECRET, `${firstPayment.id}|${subscriptionId}`) };
  expectError(await call('/api/billing/verify', { method: 'POST', token: ses,
    body: { ...verifyBody, razorpay_signature: hmac('wrong-secret', `${firstPayment.id}|${subscriptionId}`) } }), 400, 'invalid_signature');
  const verified = await call('/api/billing/verify', { method: 'POST', token: ses, body: verifyBody });
  assert.equal(verified.status, 200, redact(verified.text));
  assert.equal(verified.body.status, 'ok');
  assert.equal(verified.body.account.plan.id, 'pro');
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(account.plan.id, 'pro');
  assert.equal(account.subscription.status, 'active');
  assert.equal((await models(ses))['gemini/gemini-2.5-pro'].available, true, 'Pro unlocks the paid pool');
  expectError(await call('/api/billing/checkout', { method: 'POST', token: ses, body: { plan: 'max', currency: 'USD' } }), 409, 'already_subscribed');
  step('Pro checkout -> verify', `subscription ${subscriptionId} (a second tab reuses it), bad signature -> 400, signed verify -> plan pro; gemini-2.5-pro now available; another checkout -> 409 already_subscribed`);

  // ── 9. subscription.charged grants the monthly credits exactly once ──
  const charged = { entity: 'event', event: 'subscription.charged', contains: ['subscription', 'payment'],
    payload: { subscription: { entity: rzp.subscriptions.get(subscriptionId) }, payment: { entity: firstPayment } },
    created_at: Math.floor(Date.now() / 1000) };
  expectError(await webhook(charged, 'evt_e2eForged', 'a'.repeat(64)), 400, 'invalid_signature');
  const delivered = await webhook(charged, 'evt_e2eCharged1');
  assert.equal(delivered.status, 200, redact(delivered.text));
  assert.deepEqual(delivered.body, { received: true });
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(account.credits.balance_usd, 8);
  assert.equal(account.credits.monthly_grant_usd, 8);
  assert.deepEqual((await webhook(charged, 'evt_e2eCharged1')).body, { received: true, duplicate: true });
  assert.deepEqual((await webhook(charged, 'evt_e2eCharged2')).body, { received: true }, 'a new delivery id is processed');
  assert.equal((await call('/api/account', { token: ses })).body.credits.balance_usd, 8, 'credits are granted once per payment');
  step('webhook subscription.charged', 'forged signature -> 400; valid HMAC -> $8 granted; replay -> duplicate; new event id for the same payment -> no second grant');

  // ── 9b. A second subscription paid in parallel is cancelled at once and refunded (review P2) ──
  const proInrPlan = plans.find(row => row.plan === 'pro' && row.currency === 'INR').id;
  const rogue = { id: rid('sub'), entity: 'subscription', plan_id: proInrPlan, status: 'created', notes: { user_id: userId, plan: 'pro' },
    current_start: null, current_end: null, created_at: Math.floor(Date.now() / 1000) };
  rzp.subscriptions.set(rogue.id, rogue); // e.g. two checkouts that raced past the guard
  const roguePayment = paySubscription(rogue.id);
  const rogueVerify = expectError(await call('/api/billing/verify', { method: 'POST', token: ses, body: { razorpay_payment_id: roguePayment.id,
    razorpay_subscription_id: rogue.id, razorpay_signature: hmac(RAZORPAY_KEY_SECRET, `${roguePayment.id}|${rogue.id}`) } }), 409, 'already_subscribed');
  assert.match(rogueVerify.message, /refunded/);
  assert.deepEqual(rzp.subscriptions.get(rogue.id).cancel_requested, { cancel_at_cycle_end: 0 }, 'cancelled now, not at the cycle end');
  assert.equal(rzp.subscriptions.get(rogue.id).status, 'cancelled');
  assert.deepEqual(rzp.refunds.map(refund => [refund.payment_id, refund.amount]), [[roguePayment.id, 89900]], 'refunded in full');
  let billingState = (await call('/api/billing', { token: ses })).body;
  assert.equal(billingState.subscription.id, subscriptionId, 'Billing shows the original subscription');
  assert.equal(billingState.payments.find(payment => payment.id === roguePayment.id).status, 'refunded');
  const rogueCharge = paySubscription(rogue.id);
  const rogueCharged = await webhook({ entity: 'event', event: 'subscription.charged', contains: ['subscription', 'payment'],
    payload: { subscription: { entity: rzp.subscriptions.get(rogue.id) }, payment: { entity: rogueCharge } }, created_at: Math.floor(Date.now() / 1000) },
  'evt_e2eRogueCharged');
  assert.equal(rogueCharged.status, 200, redact(rogueCharged.text));
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(account.plan.id, 'pro');
  assert.equal(account.credits.balance_usd, 8, 'the duplicate grants no credits');
  assert.equal(rzp.payments.get(rogueCharge.id).status, 'refunded', 'its renewal charge is refunded too');
  step('duplicate subscription', `second paid subscription ${rogue.id}: verify -> 409 already_subscribed, cancelled at once and refunded; its charge webhook grants nothing and is refunded; plan and credits unchanged`);

  // ── 10. A paid-pool request debits credits ──
  const paid = await call('/v1/chat/completions', { method: 'POST', token: ses,
    body: { model: 'gemini/gemini-2.5-pro', messages: [{ role: 'user', content: 'Reply with pong.' }], max_tokens: 256 } });
  assert.equal(paid.status, 200, redact(paid.text).slice(0, 400));
  assert.equal(paid.headers.get('x-neuron-model'), 'gemini/gemini-2.5-pro');
  assert.equal(paid.headers.get('x-neuron-plan'), 'pro');
  assert.equal(upstream.calls.at(-1).key, 'e2e-gemini-paid', 'the paid pool uses the paid key');
  const paidEvent = (await call('/api/usage/events?limit=1', { token: ses })).body.events[0];
  assert.equal(paidEvent.request_id, paid.headers.get('x-request-id'));
  assert.equal(paidEvent.tier, 'paid');
  const cost = costMicrousd(catalogEntry('gemini/gemini-2.5-pro').pools[0].price, 120, 30);
  assert.ok(cost > 0);
  assert.equal(paidEvent.cost_usd, cost / 1e6);
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(Math.round(account.credits.balance_usd * 1e6), 8000000 - cost);
  step('paid-pool request', `gemini/gemini-2.5-pro on the paid key cost ${cost} micro-USD; balance ${account.credits.balance_usd} USD`);

  // ── 11. Top-up order → verify → credits ──
  const topup = await call('/api/billing/topup', { method: 'POST', token: ses, body: { pack: 'credits_5', currency: 'INR' } });
  assert.equal(topup.status, 200, redact(topup.text));
  assert.equal(topup.body.amount_minor, 44900);
  const topupPayment = payOrder(topup.body.order_id);
  const topupVerified = await call('/api/billing/verify', { method: 'POST', token: ses, body: {
    razorpay_payment_id: topupPayment.id, razorpay_order_id: topup.body.order_id,
    razorpay_signature: hmac(RAZORPAY_KEY_SECRET, `${topup.body.order_id}|${topupPayment.id}`) } });
  assert.equal(topupVerified.status, 200, redact(topupVerified.text));
  assert.equal(topupVerified.body.status, 'ok');
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(Math.round(account.credits.balance_usd * 1e6), 13000000 - cost);
  const billing = (await call('/api/billing', { token: ses })).body;
  assert.deepEqual(billing.payments.map(payment => payment.id).sort(), [firstPayment.id, topupPayment.id, roguePayment.id, rogueCharge.id].sort());
  step('top-up', `credits_5 order ${topup.body.order_id} -> verify -> +$5 (balance ${account.credits.balance_usd} USD); every payment listed`);

  // ── 11b. refund.processed takes back the refunded credits (review P3, integration) ──
  Object.assign(rzp.payments.get(topupPayment.id), { amount_refunded: 44900, status: 'refunded' });
  const refundProcessed = { entity: 'event', event: 'refund.processed', contains: ['refund', 'payment'], payload: {
    refund: { entity: { id: rid('rfnd'), entity: 'refund', amount: 44900, currency: 'INR', payment_id: topupPayment.id, status: 'processed' } },
    payment: { entity: rzp.payments.get(topupPayment.id) } }, created_at: Math.floor(Date.now() / 1000) };
  assert.deepEqual((await webhook(refundProcessed, 'evt_e2eRefund1')).body, { received: true });
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(Math.round(account.credits.balance_usd * 1e6), 8000000 - cost, 'the $5 of the refunded top-up are taken back');
  assert.deepEqual((await webhook(refundProcessed, 'evt_e2eRefund2')).body, { received: true });
  assert.equal(Math.round((await call('/api/account', { token: ses })).body.credits.balance_usd * 1e6), 8000000 - cost, 'once');
  billingState = (await call('/api/billing', { token: ses })).body;
  assert.equal(billingState.payments.find(payment => payment.id === topupPayment.id).status, 'refunded');
  step('refund webhook', `refund.processed for ${topupPayment.id}: payment refunded, $5 credits taken back once (balance ${account.credits.balance_usd} USD)`);

  // ── 12. Cancel → cancel_at_period_end ──
  const cancelled = await call('/api/billing/cancel', { method: 'POST', token: ses, body: {} });
  assert.equal(cancelled.status, 200, redact(cancelled.text));
  assert.equal(cancelled.body.status, 'cancel_scheduled');
  assert.deepEqual(rzp.subscriptions.get(subscriptionId).cancel_requested, { cancel_at_cycle_end: 1 });
  assert.equal((await call('/api/billing/verify', { method: 'POST', token: ses, body: verifyBody })).status, 200, 'verify can be re-run');
  const afterCancel = (await call('/api/billing', { token: ses })).body.subscription;
  assert.equal(afterCancel.cancel_at_period_end, true, 'a re-run verify keeps the scheduled cancellation');
  account = (await call('/api/account', { token: ses })).body;
  assert.equal(account.subscription.cancel_at_period_end, true);
  assert.equal(account.plan.id, 'pro', 'access continues until the period ends');
  step('cancel', `cancel_scheduled until ${cancelled.body.current_period_end}; cancel_at_period_end true (also after a re-run verify); plan stays pro`);

  // ── 13. Revoke all CLI sessions ──
  const revoked = await call('/api/sessions/revoke-all', { method: 'POST', token: dev, body: {} });
  assert.equal(revoked.status, 200, redact(revoked.text));
  assert.ok(revoked.body.revoked >= 1);
  expectError(await call('/auth/session', { token: ses }), 401, 'invalid_session');
  expectError(await call('/v1/chat/completions', { method: 'POST', token: ses, body: { model: 'auto', messages } }), 401, 'invalid_session');
  assert.equal((await call('/api/account', { token: apiKey })).status, 200, 'API keys are not CLI sessions');
  step('POST /api/sessions/revoke-all', `revoked ${revoked.body.revoked}; the ses_ token now gets 401 invalid_session; the nzx_ key keeps working`);

  // ── 14. Operator views ──
  expectError(await call('/admin/overview'), 401, 'invalid_session');
  const overview = await call('/admin/overview', { token: ADMIN });
  assert.equal(overview.status, 200, redact(overview.text));
  assert.ok(overview.body.users.total >= 1);
  assert.ok(overview.body.users.by_plan.pro >= 1);
  assert.equal(overview.body.revenue.active_subscriptions, 1);
  assert.equal(Number(overview.body.revenue.mrr_usd_estimate), 10);
  const freeFlash = overview.body.pools.find(pool => pool.model === streamModel && pool.tier === 'free');
  assert.ok(freeFlash.requests_today >= 1);
  assert.ok(freeFlash.limits && freeFlash.health, 'pools carry limits and health');
  const paidPro = overview.body.pools.find(pool => pool.model === 'gemini/gemini-2.5-pro' && pool.tier === 'paid');
  assert.equal(paidPro.requests_today, 1);
  assert.equal(paidPro.limits, null);
  assert.deepEqual(Object.keys((await call('/health')).body).sort(), ['service', 'status', 'version']);
  assert.equal((await call('/health', { token: ADMIN })).body.database_configured, true);
  step('GET /admin/overview', `users ${overview.body.users.total}, active subscriptions 1, MRR $10, ${overview.body.pools.length} pools with limits and health`);

  if (LIVE) {
    // One more real call: a streamed Groq tool call, to check its deltas too.
    const fresh = await call('/auth/cli/session', { method: 'POST', token: dev, body: {} });
    const groq = await call('/v1/chat/completions', { method: 'POST', token: fresh.body.session_token,
      body: { model: 'groq/openai/gpt-oss-120b', stream: true, messages, tools, tool_choice: 'auto', max_tokens: 1024 } });
    assert.equal(groq.status, 200, redact(groq.text).slice(0, 400));
    const groqEvents = sseEvents(groq.text);
    assert.equal(groqEvents.at(-1), '[DONE]');
    const groqDeltas = groqEvents.filter(event => event !== '[DONE]').flatMap(item => (item.choices || []).flatMap(choice => choice.delta?.tool_calls || []));
    assert.ok(groqDeltas.every(delta => Number.isInteger(delta.index)));
    step('live Groq stream (tools)', `${groqDeltas.length} tool_call deltas, all indexed`);
    const used = realCalls();
    assert.ok(used >= 1 && used <= MAX_REAL_CALLS, `real upstream calls: ${used}`);
    step('live upstream budget', `${used} real upstream calls (limit ${MAX_REAL_CALLS})`);
  } else {
    assert.equal(realCalls(), 0, 'offline runs make no real upstream call');
  }

  // ── 15. Static website smoke on the same server (assets served, NEURON_API_ONLY unset) ──
  const csp = Object.fromEntries((await call('/')).headers.get('content-security-policy-report-only').split(';')
    .map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  const allows = (directive, origin) => {
    const sources = csp[directive] || csp['default-src'] || [];
    return sources.some(source => source === origin || (source.includes('*.') &&
      new RegExp('^' + source.replace(/[.]/g, '\\.').replace('*', '[^/]+') + '$').test(origin)));
  };
  const pageChecks = [];
  const externalOrigin = value => { try { const url = new URL(value, base); return url.origin === base ? null : url.origin; } catch { return null; } };
  // Same-origin scripts (and the modules they import) load more at runtime: an https literal
  // that names a script (.js or an npm CDN path) needs script-src; other external literals are
  // API endpoints (connect-src). Links to the Zero-X sites themselves are navigation.
  const siteOrigin = origin => /^https:\/\/([a-z0-9-]+\.)?zero-x\.live$/.test(origin);
  async function runtimeOrigins(entry, used, seen = new Set()) {
    if (seen.has(entry)) return;
    seen.add(entry);
    const script = await call(entry);
    if (script.status !== 200) return;
    for (const match of script.text.matchAll(/https:\/\/[A-Za-z0-9.-]+[^'"`\s)]*/g)) {
      const origin = new URL(match[0]).origin;
      if (siteOrigin(origin)) continue;
      used[/\.js\b|\/npm\//.test(match[0]) ? 'script-src' : 'connect-src'].add(origin);
    }
    for (const match of script.text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+\.js)['"]/g)) {
      await runtimeOrigins(new URL(match[1], base + entry).pathname, used, seen);
    }
  }
  for (const path of ['/', '/pricing', '/neuron-cli', '/docs', '/refund', '/contact', '/shipping', '/privacy', '/terms', '/dashboard']) {
    const page = await call(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get('content-type'), /text\/html/, path);
    const html = page.text;
    const used = { 'script-src': new Set(), 'style-src': new Set(), 'font-src': new Set(), 'frame-src': new Set(), 'connect-src': new Set() };
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      const origin = externalOrigin(match[1]);
      if (origin) used['script-src'].add(origin);
      else await runtimeOrigins(new URL(match[1], base + path).pathname, used);
    }
    for (const match of html.matchAll(/<link\b[^>]*\bas="font"[^>]*\bhref="([^"]+)"|<link\b[^>]*\bhref="([^"]+)"[^>]*\bas="font"/g)) {
      const origin = externalOrigin(match[1] || match[2]);
      if (origin) used['font-src'].add(origin);
    }
    for (const match of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"|<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"/g)) {
      const href = match[1] || match[2];
      const origin = externalOrigin(href);
      if (origin) used['style-src'].add(origin);
      else {
        const sheet = await call(new URL(href, base + path).pathname);
        for (const url of sheet.text.matchAll(/url\(\s*['"]?(https:\/\/[^'")]+)/g)) used['font-src'].add(new URL(url[1]).origin);
        for (const imported of sheet.text.matchAll(/@import\s+(?:url\()?['"](https:\/\/[^'"]+)/g)) used['style-src'].add(new URL(imported[1]).origin);
      }
    }
    if ([...used['style-src']].includes('https://fonts.googleapis.com')) used['font-src'].add('https://fonts.gstatic.com');
    if ([...used['style-src']].includes('https://api.fontshare.com')) used['font-src'].add('https://cdn.fontshare.com');
    for (const match of html.matchAll(/<iframe\b[^>]*\bsrc="([^"]+)"/g)) { const origin = externalOrigin(match[1]); if (origin) used['frame-src'].add(origin); }
    if (/<script>(?!\s*<\/script>)/.test(html)) assert.ok(csp['script-src'].includes("'unsafe-inline'"), `${path}: inline scripts`);
    if (/<style>|\sstyle="/.test(html)) assert.ok(csp['style-src'].includes("'unsafe-inline'"), `${path}: inline styles`);
    for (const [directive, origins] of Object.entries(used)) {
      for (const origin of origins) assert.ok(allows(directive, origin), `${path}: ${directive} must allow ${origin}`);
    }
    pageChecks.push(`${path} [${Object.entries(used).filter(([, set]) => set.size).map(([name, set]) => `${name}: ${[...set].join(' ')}`).join('; ') || 'same-origin only'}]`);
  }
  // Runtime connections: supabase-js (Supabase project), Razorpay Checkout (api + lumberjack).
  for (const origin of ['https://norrtosjwcossxrhhtvd.supabase.co', 'https://api.razorpay.com', 'https://lumberjack.razorpay.com']) {
    assert.ok(allows('connect-src', origin), `connect-src must allow ${origin}`);
  }
  assert.ok(allows('frame-src', 'https://api.razorpay.com') && allows('frame-src', 'https://checkout.razorpay.com'), 'Razorpay frames');
  const redirected = await call('/dashboard.html');
  assert.equal(redirected.status, 301);
  assert.equal(redirected.headers.get('location'), '/dashboard', 'loopback redirects stay local');
  const missing = await call('/404-test');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /text\/html/);
  assert.equal(missing.text, readFileSync(join(siteRoot, '404.html'), 'utf8'), 'the branded 404.html is the body');
  step('static website smoke', `10 pages 200 with CSP origins allowed (${pageChecks.join(', ')}); /dashboard.html -> 301 /dashboard; /404-test -> branded 404`);
} catch (error) {
  failed = error;
} finally {
  await stopGateway().catch(() => {});
  await closeAllPglite().catch(() => {});
  upstreamServer.close();
  razorpayServer.close();
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
}

if (failed) {
  console.error(`FAIL: ${redact(failed.stack || failed.message)}`);
  console.error('--- gateway log (last 40 lines) ---');
  console.error(redact(serverLog).split('\n').slice(-40).join('\n'));
  process.exit(1);
}
await writeFile(join(tmpdir(), `zerox-e2e-${LIVE ? 'live' : 'offline'}-steps.json`), JSON.stringify(steps, null, 2)).catch(() => {});
console.log(`PASS: end-to-end ${LIVE ? '(live Groq/Gemini free pools)' : '(offline)'}: ${steps.length} steps — dev sign-in, CLI session, plan-aware ` +
  'models, streamed tool calls, usage, API keys, daily cap, pool-kept model failures, Pro checkout (reused across tabs), charged webhook once, ' +
  'duplicate subscription cancelled and refunded, paid-pool credits, top-up, refund clawback, cancel, revoke-all, admin overview, static site and CSP');
