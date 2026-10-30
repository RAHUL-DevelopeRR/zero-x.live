// The Node server behind Cloudflare Tunnel (deploy/aws): the visitor address for per-IP
// limits (TRUST_CLOUDFLARE, spoof attempts included), SSE keep-alive comments while a stream is
// quiet, the dev identity refused behind the tunnel, and the graceful stop on SIGTERM (in-flight
// streams finish and settle, bounded by the grace; a longer tail after cut streams). Upstream
// calls go to a fake Groq server through e2e-upstream-shim.mjs.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { start, requestHeaders, runtimeEnv, stopOnSignals } = require('./server.js');

// server.js loads a developer .env: nothing here may reach a real database or provider.
for (const name of Object.keys(process.env)) {
  if (/^(SUPABASE_|DATABASE_|PGLITE_|DEV_AUTH)|_API_KEY$|_HOSTED$|_MODELS$|^(TRUST_CLOUDFLARE|SSE_HEARTBEAT_MS|SHUTDOWN_GRACE_MS)$/.test(name)) {
    delete process.env[name];
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const USAGE = { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 };

// Fake Groq: `lifecycle:<chunks>:<delay ms>[:pause=<ms>]` in the prompt shapes the stream (the
// pause replaces the delay before the second content chunk).
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const [, count, delay, pause] = /lifecycle:(\d+):(\d+)(?::pause=(\d+))?/.exec(raw) || [, '1', '0'];
  let closed = false;
  res.on('close', () => { closed = true; });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = value => res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  const chunk = (delta, finish = null) => ({ id: 'up', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  send(chunk({ role: 'assistant', content: '' }));
  for (let i = 0; i < Number(count); i++) {
    await sleep(i === 1 && pause ? Number(pause) : Number(delay));
    if (closed) return;
    send(chunk({ content: `t${i} ` }));
  }
  send(chunk({}, 'stop'));
  send({ id: 'up', object: 'chat.completion.chunk', choices: [], usage: USAGE });
  send('[DONE]');
  res.end();
});

const fakeRequest = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
const addressOf = (req, trustCloudflare) => requestHeaders(req, { trustCloudflare }).get('x-neuron-client-ip');

async function listening(server) {
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const closeServer = server => new Promise(resolve => (server.listening ? server.close(() => resolve()) : resolve()));

// A fresh TCP connection (no pooled socket), to see whether the listener still accepts.
const freshConnection = port => new Promise(resolve => {
  http.get({ host: '127.0.0.1', port, path: '/health', agent: false }, response => {
    response.resume();
    resolve(response.statusCode);
  }).on('error', error => resolve(error.code));
});

async function session(base) {
  const response = await fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_fingerprint: 'node-lifecycle-check' }) });
  assert.equal(response.status, 200);
  return (await response.json()).session_token;
}

async function openStream(base, token, prompt) {
  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', stream: true, max_tokens: 64, messages: [{ role: 'user', content: prompt }] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  return {
    async rest() {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return { text, complete: true };
          text += decoder.decode(value, { stream: true });
        }
      } catch { return { text, complete: false }; }
    },
  };
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

(async () => {
  // ── Visitor address: unit cases ──
  assert.equal(addressOf(fakeRequest('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), true), '203.0.113.7');
  assert.equal(addressOf(fakeRequest('::ffff:127.0.0.1', { 'cf-connecting-ip': '2001:db8::7' }), true), '2001:db8::7');
  assert.equal(addressOf(fakeRequest('::1', { 'cf-connecting-ip': '198.51.100.4' }), true), '198.51.100.4');
  assert.equal(addressOf(fakeRequest('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }), false), '127.0.0.1',
    'without TRUST_CLOUDFLARE the header is ignored');
  assert.equal(addressOf(fakeRequest('198.51.100.20', { 'cf-connecting-ip': '203.0.113.7' }), true), '198.51.100.20',
    'a peer that is not loopback cannot choose its address');
  for (const value of ['203.0.113.7, 198.51.100.1', 'not-an-ip', '', '203.0.113.7:443', '127.0.0.1/8']) {
    assert.equal(addressOf(fakeRequest('127.0.0.1', { 'cf-connecting-ip': value }), true), '127.0.0.1', `rejects ${JSON.stringify(value)}`);
  }
  assert.equal(addressOf(fakeRequest('198.51.100.20', { 'x-neuron-client-ip': '203.0.113.9' }), true), '198.51.100.20',
    'a client-supplied x-neuron-client-ip is dropped');

  // ── Behind the tunnel a loopback AUTH_HOST is public: the dev identity is refused ──
  const nodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  process.env.DEV_AUTH_ENABLED = 'true';
  process.env.TRUST_CLOUDFLARE = 'true';
  assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, undefined, 'TRUST_CLOUDFLARE=true refuses the dev identity');
  delete process.env.TRUST_CLOUDFLARE;
  assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, 'true', 'loopback without the tunnel keeps it (development)');
  delete process.env.DEV_AUTH_ENABLED;
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;

  const upstreamBase = await listening(upstream.listen(0, '127.0.0.1'));
  process.env.E2E_UPSTREAM_BASE = upstreamBase;
  await import('./e2e-upstream-shim.mjs');
  Object.assign(process.env, {
    AUTH_PORT: '0', NEURON_API_ONLY: 'true', ALLOW_ANONYMOUS_SESSIONS: 'true', ALLOW_UNKNOWN_COUNTRY: 'true',
    GROQ_API_KEY: 'e2e-groq-lifecycle', GROQ_MODELS: 'openai/gpt-oss-120b', SSE_HEARTBEAT_MS: '200',
  });
  const servers = [];
  const startServer = async () => {
    const server = await start();
    servers.push(server);
    return { server, base: await listening(server) };
  };
  const pkceStart = (base, headers = {}) => fetch(base + '/auth/openrouter/start', { redirect: 'manual', headers }).then(response => response.status);

  try {
    // ── Per-IP limit through the server (10 OAuth starts per address and window) ──
    // Without the flag every request counts against the socket address, whatever it claims.
    const plain = await startServer();
    for (let i = 1; i <= 10; i++) {
      assert.notEqual(await pkceStart(plain.base, { 'CF-Connecting-IP': `192.0.2.${i}` }), 429, `start ${i}`);
    }
    assert.equal(await pkceStart(plain.base, { 'CF-Connecting-IP': '192.0.2.99', 'x-neuron-client-ip': '192.0.2.98' }), 429,
      'spoofed CF-Connecting-IP and x-neuron-client-ip share the loopback bucket');

    process.env.TRUST_CLOUDFLARE = 'true';
    const tunnel = await startServer();
    for (let i = 1; i <= 10; i++) assert.notEqual(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '203.0.113.7' }), 429);
    assert.equal(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '203.0.113.7' }), 429, 'one visitor is limited');
    assert.notEqual(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '198.51.100.9' }), 429, 'another visitor has its own bucket');
    assert.equal(await pkceStart(tunnel.base, { 'CF-Connecting-IP': 'not-an-ip' }), 429, 'an invalid header falls back to the socket');
    assert.equal(await pkceStart(tunnel.base), 429, 'no header falls back to the socket');
    delete process.env.TRUST_CLOUDFLARE;

    // ── Only canonical paths: the tunnel's path rules see the raw path, so a path that URL parsing
    // would rewrite (/v1/%2e%2e/admin/overview passes ^/v1/ and resolves to /admin) is refused ──
    const rawStatus = path => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: Number(new URL(tunnel.base).port), path, agent: false }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    for (const path of ['/v1/%2e%2e/admin/overview', '/v1/../admin/overview', '/v1/x/%2E%2e/providers/health', '/v1/.%2e/admin/overview',
      '/v1/%2e/models', '/v1/./models', '/v1\\..\\admin/overview', '//evil.example/admin/overview', 'http://evil.example/admin/overview']) {
      assert.equal(await rawStatus(path), 400, `refuses ${path}`);
    }
    assert.notEqual(await rawStatus('/health'), 400, 'a canonical path is served');
    assert.notEqual(await rawStatus('/v1/models?next=../admin'), 400, 'dots in the query are not a path');

    // ── SSE keep-alive while the upstream is quiet ──
    const token = await session(tunnel.base);
    const quiet = await (await openStream(tunnel.base, token, 'lifecycle:3:20:pause=700')).rest();
    assert.ok(quiet.complete);
    const parts = quiet.text.split('\n\n').filter(Boolean);
    assert.ok(parts.includes(': keep-alive'), 'a quiet stream gets an SSE comment');
    assert.ok(parts.every(part => part === ': keep-alive' || part.startsWith('data: ')), 'comments only between whole events');
    const content = parts.filter(part => part.startsWith('data: {')).map(part => JSON.parse(part.slice(6)))
      .map(event => event.choices?.[0]?.delta?.content || '').join('');
    assert.equal(content, 't0 t1 t2 ');
    assert.equal(parts.filter(part => part === 'data: [DONE]').length, 1);
    const busy = await (await openStream(tunnel.base, token, 'lifecycle:5:20')).rest();
    assert.ok(!busy.text.includes(': keep-alive'), 'a stream with output gets no comment');

    // ── SIGTERM: the listener closes, the in-flight stream finishes and settles, then exit ──
    const { readRecord } = await import('./src/session-store.js');
    const drainToken = await session(tunnel.base);
    const exits = [];
    const exit = code => exits.push({ code, at: Date.now() });
    const stream = await openStream(tunnel.base, drainToken, 'lifecycle:12:100');
    const stop = stopOnSignals(tunnel.server, { graceMs: 5000, tailMs: 100, cutTailMs: 3000, exit });
    try {
      process.emit('SIGTERM', 'SIGTERM');
      assert.equal(await freshConnection(tunnel.server.address()?.port ?? Number(new URL(tunnel.base).port)), 'ECONNREFUSED',
        'no new connections while draining');
      const drained = await stream.rest();
      const finishedAt = Date.now();
      assert.ok(drained.complete && drained.text.includes('data: [DONE]'), 'the in-flight stream finished');
      assert.match(drained.text, /t11 /);
      await waitFor(() => exits.length, 3000);
      assert.equal(exits[0].code, 0);
      assert.ok(exits[0].at >= finishedAt - 5, 'exit only after the stream finished');
      assert.ok(exits[0].at - finishedAt < 1000, 'a clean drain exits after the short tail (its settlement already ran)');
      const settled = await readRecord({ ALLOW_ANONYMOUS_SESSIONS: 'true' }, drainToken);
      assert.equal(settled.tokens_used, USAGE.total_tokens, 'the allocation was settled with the real usage before exit');
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }

    // ── The grace bounds the drain: a longer stream is cut and the process still exits ──
    const bounded = await startServer();
    const longStream = await openStream(bounded.base, await session(bounded.base), 'lifecycle:40:100');
    const boundedExits = [];
    const stopBounded = stopOnSignals(bounded.server, { graceMs: 600, tailMs: 50, cutTailMs: 400,
      exit: code => boundedExits.push({ code, at: Date.now() }) });
    try {
      const stoppedAt = Date.now();
      stopBounded('SIGTERM');
      const cut = await longStream.rest();
      assert.ok(!cut.text.includes('[DONE]'), 'the stream past the grace was cut');
      await waitFor(() => boundedExits.length, 3000);
      const took = boundedExits[0].at - stoppedAt;
      // The cut stream's settlement (a database round trip in production) gets the longer tail.
      assert.ok(took >= 1000 && took < 2000, `exit after the grace and the cut tail (${took} ms)`);
    } finally {
      process.removeListener('SIGTERM', stopBounded);
      process.removeListener('SIGINT', stopBounded);
    }
  } finally {
    await Promise.all([...servers, upstream].map(closeServer));
  }
  console.log('PASS: Node server trusts CF-Connecting-IP only from loopback with TRUST_CLOUDFLARE (and then refuses the dev identity), keeps quiet streams alive and drains on SIGTERM');
})().catch(error => { console.error(error); process.exitCode = 1; });
