// Security audit 2026-11-05, F2, F5 and F16 (offline): body limits on both runtimes, request
// timeouts and the connection cap on the Node server, the negative cache and rejection window for
// bad credentials, and the caps and shared payload of /v1/models/stream.
//   node check-request-limits.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import app from './src/index.js';
import { bodyLimitFor, bodyLimits, declaredBodyOver, resetModelStreamSlots, streamLimits, streamSlots, windowLimiter } from './src/request-limits.js';
import { authCacheSize, noteRejected, rejectedRecently, rejectionsExceeded, resetAuthCache } from './src/auth-cache.js';
import { resetSharedStatusFrames, sharedStatusFrame } from './src/routes/plans.js';

const require = createRequire(import.meta.url);
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const BASE = 'https://zero-x.live';
const SUPABASE = 'https://limits.supabase.test';
const env = { SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEY: 'sb_secret_limits_test', ALLOW_UNKNOWN_COUNTRY: 'true' };
const realFetch = globalThis.fetch;
const POLICIES = JSON.stringify({ policies: { free: { name: 'Free', daily_tokens: 1000000, daily_requests: 100, price_usd: 0 } } });
let databaseCalls = 0;
globalThis.fetch = async input => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(SUPABASE)) throw new Error(`Unexpected outbound request: ${url}`);
  databaseCalls++;
  if (url.endsWith('/zerox_plan_policies')) return new Response(POLICIES, { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const call = (path, init = {}, bindings = env) => app.request(BASE + path, init, bindings);
const post = (path, body, headers = {}, bindings = env) => call(path, { method: 'POST', body,
  headers: { 'Content-Type': 'application/json', ...headers } }, bindings);

try {
  // ── Pure helpers ──
  assert.deepEqual(bodyLimits({}), { default: 65536, chat: 2097152 });
  assert.deepEqual(bodyLimits({ BODY_LIMIT_BYTES: '1000', CHAT_BODY_LIMIT_BYTES: '10' }), { default: 1000, chat: 1000 }, 'chat is never below the default');
  assert.deepEqual(bodyLimits({ BODY_LIMIT_BYTES: 'abc', CHAT_BODY_LIMIT_BYTES: '-5' }), { default: 65536, chat: 2097152 }, 'bad values keep the defaults');
  for (const path of ['/v1/chat/completions', '/neuroncli/auth-server/v1/chat/completions', '/v1/messages', '/auth/azure/proxy',
    '/relay/frames', '/v1/relay']) assert.equal(bodyLimitFor(path, {}), 2097152, `${path} is a chat-sized route`);
  assert.equal(bodyLimitFor('/webhooks/razorpay', {}), 262144, 'the webhook keeps its 256 KiB cap');
  for (const path of ['/auth/device/code', '/api/keys', '/admin/providers/keys', '/auth/cli/session']) assert.equal(bodyLimitFor(path, {}), 65536, path);
  assert.equal(declaredBodyOver({ 'content-length': '65537' }, 65536), 65537);
  assert.equal(declaredBodyOver({ 'content-length': '65536' }, 65536), null);
  assert.equal(declaredBodyOver(new Headers({ 'content-length': '999999' }), 65536), 999999);
  assert.equal(declaredBodyOver({}, 65536), null);
  assert.equal(declaredBodyOver({ 'content-length': 'abc' }, 65536), null);
  const limiter = windowLimiter(2, 60000);
  assert.deepEqual([limiter('a', 0), limiter('a', 1), limiter('a', 2) > 0, limiter('b', 3), limiter('a', 60001)], [0, 0, true, 0, 0]);
  ok('request limits: byte limits per route, declared Content-Length, fixed windows');

  // ── The app (Worker runtime and the Node server share it): declared length first ──
  resetAuthCache();
  const big = 'x'.repeat(70000);
  for (const path of ['/auth/device/code', '/auth/device/token', '/api/keys', '/auth/cli/session']) {
    const calls = databaseCalls;
    const response = await post(path, big, { 'Content-Length': '70000' });
    assert.equal(response.status, 413, path);
    const body = await response.json();
    assert.equal(body.error.code, 'request_too_large');
    assert.match(body.error.message, /65536/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(databaseCalls, calls, `${path}: refused before any database call`);
  }
  const chat = await post('/v1/chat/completions', JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(100000) }] }),
    { Authorization: 'Bearer ses_nobody' });
  assert.equal(chat.status, 401, 'the chat endpoint is exempt from the 64 KiB limit (it answers for its credential)');
  const chatHuge = await post('/v1/chat/completions', 'x', { 'Content-Length': String(3 * 1024 * 1024) });
  assert.equal(chatHuge.status, 413, 'and still has its own ceiling');
  const small = await post('/auth/device/token', '{}', {});
  assert.equal(small.status, 400, 'a small body reaches the route');
  const tuned = await post('/auth/device/code', big, { 'Content-Length': '70000' }, { ...env, BODY_LIMIT_BYTES: '100000' });
  assert.notEqual(tuned.status, 413, 'BODY_LIMIT_BYTES raises the limit');
  assert.equal((await call('/health', { method: 'GET' })).status, 200);
  ok('app: 413 request_too_large from the declared length before any database call, chat exempt, limits configurable');

  // The asset server decodes percent-encoding after the app's path guards: the operator pages' files
  // stay hidden under every spelling (audit 3b).
  const assetHits = [];
  const withAssets = { ...env, ASSETS: { fetch: async input => { assetHits.push(new URL(input.url).pathname); return new Response('asset', { status: 200 }); } } };
  for (const path of ['/neuroncli/admin/keys/index.html', '/neuroncli/%61dmin/keys/index.html', '/neuroncli/%41DMIN/keys/keys.js', '/NEURONCLI/admin/keys/keys.js'.toLowerCase(),
    '/neuroncli/admin%2Fkeys/keys.js']) {
    assetHits.length = 0;
    const hidden = await call(path, {}, withAssets);
    assert.equal(hidden.status, 404, path);
    assert.deepEqual(assetHits.filter(hit => /\/admin\//i.test(decodeURIComponent(hit))), [], `${path}: the asset binding is never asked for an operator file`);
  }
  assert.equal((await call('/neuroncli/login/', {}, withAssets)).status, 200, 'other neuroncli pages are unaffected');
  assert.equal((await call('/%E0%A4%A.html', {}, withAssets)).status, 400, 'an undecodable path is refused');

  // ── Negative cache (F5) ──
  const ses = `ses_${'A'.repeat(32)}`;
  const calls0 = databaseCalls;
  const first = await call('/api/account', { headers: { Authorization: `Bearer ${ses}` } });
  assert.equal(first.status, 401);
  const used = databaseCalls - calls0;
  assert.ok(used > 0, 'the first bad session reads the store');
  const again = await call('/api/account', { headers: { Authorization: `Bearer ${ses}` } });
  assert.equal(again.status, 401);
  assert.equal(databaseCalls - calls0, used, 'the same bad session is answered from memory');
  assert.equal(await rejectedRecently(env, ses), true);
  const nzx = `nzx_${'B'.repeat(43)}`;
  const k0 = databaseCalls;
  assert.equal((await call('/api/account', { headers: { Authorization: `Bearer ${nzx}` } })).status, 401);
  const keyCalls = databaseCalls - k0;
  assert.ok(keyCalls > 0);
  assert.equal((await call('/api/account', { headers: { Authorization: `Bearer ${nzx}` } })).status, 401);
  assert.equal(databaseCalls - k0, keyCalls, 'a rejected API key is not verified again');
  const zdc = `zdc_${'C'.repeat(43)}`;
  const d0 = databaseCalls;
  const poll = () => post('/auth/device/token', JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: zdc }));
  assert.equal((await poll()).status, 400);
  const pollCalls = databaseCalls - d0;
  assert.ok(pollCalls > 0);
  const repeated = await poll();
  assert.equal(repeated.status, 400);
  assert.equal((await repeated.json()).error.code, 'invalid_grant', 'same answer, from memory');
  assert.equal(databaseCalls - d0, pollCalls, 'an unknown device code is not polled again');
  // A store that is down rejects nothing: the failure is not remembered.
  resetAuthCache();
  const downFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const outage = await call('/api/account', { headers: { Authorization: `Bearer ${ses}` } });
  assert.equal(outage.status, 503);
  globalThis.fetch = downFetch;
  assert.equal(await rejectedRecently(env, ses), false, 'an outage is not cached as a rejection');
  ok('auth cache: bad sessions, API keys and device codes are answered from memory; an outage caches nothing');

  // /ready reads the database for anyone: a ready answer is held for a few seconds, a failure never.
  const ready = { ...env, GROQ_API_KEY: 'groq-key' };
  const r0 = databaseCalls;
  assert.equal((await call('/ready', {}, ready)).status, 200);
  const readyCalls = databaseCalls - r0;
  assert.ok(readyCalls > 0);
  assert.equal((await call('/ready', {}, ready)).status, 200);
  assert.equal(databaseCalls - r0, readyCalls, '/ready is answered from memory for a few seconds');
  assert.equal((await call('/ready', {}, env)).status, 503, 'not ready is never remembered');
  assert.equal((await call('/ready', {}, env)).status, 503);

  // ── Cache mechanics ──
  resetAuthCache();
  const tiny = { AUTH_NEGATIVE_CACHE_MAX: '3', AUTH_NEGATIVE_CACHE_SECONDS: '1' };
  for (const token of ['t1', 't2', 't3', 't4']) await noteRejected(tiny, token);
  assert.equal(authCacheSize(), 3, 'bounded');
  assert.equal(await rejectedRecently(tiny, 't1'), false, 'oldest out first');
  assert.equal(await rejectedRecently(tiny, 't4'), true);
  assert.equal(await rejectedRecently(tiny, ''), false);
  const realNow = Date.now;
  Date.now = () => realNow() + 1500;
  assert.equal(await rejectedRecently(tiny, 't4'), false, 'a rejection expires');
  Date.now = realNow;
  ok('auth cache: bounded, oldest out first, expires');

  // ── A visitor with many rejections is refused before the database is read (F5) ──
  resetAuthCache();
  const strict = { ...env, AUTH_REJECTIONS_PER_MINUTE: '3' };
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < 3; i++) {
    const response = await call('/api/account', { headers: { Authorization: `Bearer ses_${String(i).repeat(24)}`, ...ip } }, strict);
    assert.equal(response.status, 401, `rejection ${i + 1}`);
  }
  const before = databaseCalls;
  const limited = await call('/api/account', { headers: { Authorization: `Bearer ses_${'9'.repeat(24)}`, ...ip } }, strict);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After');
  assert.equal((await limited.json()).error.code, 'rate_limited');
  assert.equal(databaseCalls, before, 'the fourth bad token never reached the database');
  const other = await call('/api/account', { headers: { Authorization: `Bearer ses_${'8'.repeat(24)}`, 'cf-connecting-ip': '203.0.113.10' } }, strict);
  assert.equal(other.status, 401, 'another visitor is not affected');
  assert.ok(rejectionsExceeded(strict, '203.0.113.9') > 0);
  assert.equal(rejectionsExceeded(strict, '203.0.113.77'), 0);
  const modelList = await call('/v1/models', { headers: { Authorization: `Bearer ses_${'7'.repeat(24)}`, ...ip } }, strict);
  assert.equal(modelList.status, 429, '/v1/models with a credential is covered too');
  const anonymousList = await call('/v1/models', { headers: ip }, strict);
  assert.equal(anonymousList.status, 200, 'an anonymous model list is never refused for rejections');
  const chatLimited = await post('/v1/chat/completions', '{}', { Authorization: `Bearer ses_${'6'.repeat(24)}`, ...ip }, strict);
  assert.notEqual(chatLimited.status, 429, 'the chat endpoint is never rate limited by this window (released clients keep working)');
  ok('auth cache: a visitor over AUTH_REJECTIONS_PER_MINUTE gets 429 before any read; anonymous lists and chat are exempt');

  // ── Model stream caps and the shared payload (F2) ──
  resetModelStreamSlots();
  resetSharedStatusFrames();
  const slow = { ...env, MODELS_STREAM_INTERVAL_MS: '5000', MODELS_STREAM_LIFETIME_MS: '60000', MODELS_STREAM_PER_IP: '2', MODELS_STREAM_MAX: '3' };
  const opened = [];
  const open = async address => { const response = await call('/v1/models/stream', { headers: { 'cf-connecting-ip': address } }, slow); opened.push(response); return response; };
  const streams = [await open('198.51.100.1'), await open('198.51.100.1')];
  assert.deepEqual(streams.map(s => s.status), [200, 200]);
  const third = await open('198.51.100.1');
  assert.equal(third.status, 429, 'per address');
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal((await third.json()).error.code, 'rate_limited');
  streams.push(await open('198.51.100.2'));
  assert.equal(streams[2].status, 200);
  assert.equal((await open('198.51.100.3')).status, 429, 'in total');
  const withCredential = await call('/v1/models/stream', { headers: { 'cf-connecting-ip': '198.51.100.4', Authorization: 'Bearer ses_none' } }, slow);
  assert.equal(withCredential.status, 401, 'a bad credential is refused before it takes a slot');
  await streams[0].body.cancel();
  assert.equal((await open('198.51.100.1')).status, 200, 'cancelling frees the slot');
  resetModelStreamSlots();
  const caps = streamLimits({ MODELS_STREAM_PER_IP: '0', MODELS_STREAM_MAX: 'x' });
  assert.deepEqual(caps, { perIp: 4, max: 500 }, 'defaults');
  const slots = streamSlots({ perIp: 1, max: 5 });
  const held = slots.take('a');
  assert.ok(held.release);
  assert.ok(slots.take('a').retryAfterSeconds > 0);
  assert.ok(slots.take('a', { anonymous: false }).release, 'credentialed callers are limited only in total');
  held.release(); held.release();
  assert.equal(slots.count(), 1, 'release is idempotent');

  // One computation and one serialised frame for callers with the same view.
  resetSharedStatusFrames();
  const context = () => ({ env: { ...env }, req: { raw: new Request(BASE + '/v1/models/stream'), header: () => undefined, query: () => undefined, url: BASE + '/v1/models/stream' } });
  const [a, b] = await Promise.all([sharedStatusFrame(context(), {}, 5000), sharedStatusFrame(context(), {}, 5000)]);
  assert.equal(a.frame, b.frame);
  assert.equal(a, b, 'the same object: one computation');
  assert.match(a.frame, /^id: .+\nevent: catalog\.updated\ndata: \{/);
  const paid = await sharedStatusFrame(context(), { plan: 'pro' }, 5000);
  assert.notEqual(paid, a, 'another plan is another view');
  for (const response of opened) await response.body?.cancel().catch(() => {});
  ok('model stream: per-address and total caps with 429 and Retry-After, slots released, one shared frame per view');

  // ── The Node server (F16) ──
  process.env.AUTH_PORT = '0';
  process.env.NEURON_API_ONLY = 'true';
  process.env.REQUEST_TIMEOUT_MS = '45000';
  process.env.MAX_CONNECTIONS = '321';
  globalThis.fetch = realFetch;
  const { start } = require('./server.js');
  const server = await start();
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.ok(server.requestTimeout >= server.headersTimeout, 'requestTimeout is never below headersTimeout');
    assert.equal(server.requestTimeout, server.headersTimeout + 1000, 'the whole request must arrive within the timeout (a short REQUEST_TIMEOUT_MS is raised to headersTimeout + 1 s)');
    assert.equal(server.maxConnections, 321);
    const over = await fetch(base + '/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(70000) });
    assert.equal(over.status, 413);
    assert.equal((await over.json()).error.code, 'request_too_large');
    const chatBody = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":"' + 'y'.repeat(100000) + '"}' });
    assert.notEqual(chatBody.status, 413, 'chat takes a 100 KB body');
    const hook = await fetch(base + '/webhooks/razorpay', { method: 'POST', body: 'z'.repeat(200000) });
    assert.notEqual(hook.status, 413, 'the webhook keeps its 256 KiB cap');
    const hookBig = await fetch(base + '/webhooks/razorpay', { method: 'POST', body: 'z'.repeat(270000) });
    assert.equal(hookBig.status, 413);
    // No Content-Length (chunked): counted as it arrives.
    const stream = new ReadableStream({ start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('q'.repeat(10000)));
      controller.close();
    } });
    const chunked = await fetch(base + '/auth/cli/session', { method: 'POST', body: stream, duplex: 'half' });
    assert.equal(chunked.status, 413, 'a chunked body is counted as it arrives');
    assert.equal((await fetch(base + '/health')).status, 200, 'the server keeps serving');
  } finally { await new Promise(resolve => server.close(resolve)); }
  ok('node server: declared and counted body limits, chat and webhook ceilings, requestTimeout, maxConnections');

  console.log(`PASS: request limits, auth cache and stream caps (${passed.length} groups)`);
} finally {
  globalThis.fetch = realFetch;
}
