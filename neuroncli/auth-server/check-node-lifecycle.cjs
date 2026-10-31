// The Node server behind Cloudflare Tunnel (deploy/aws): the visitor address for per-IP
// limits (TRUST_CLOUDFLARE, spoof attempts included), SSE keep-alive comments while a stream is
// quiet, the dev identity refused behind the tunnel, and the graceful stop on SIGTERM (in-flight
// streams finish and settle, bounded by the grace; a longer tail after cut streams; a response not
// started when the drain begins closes its connection). Then the zero-downtime restart (C6): the
// loopback readiness listener (READY_PORT) draining with the main one, and two instances as their
// own processes handing over one port (AUTH_REUSE_PORT, Linux; elsewhere the same handover on two
// ports) while a stream on the old one runs to its end; and the release's commit (C9: REVISION,
// GIT_COMMIT wins). Upstream calls go to a fake Groq server through e2e-upstream-shim.mjs.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { drain, start, requestHeaders, runtimeEnv, stopOnSignals, supportsReusePort } = require('./server.js');

// server.js loads a developer .env: nothing here may reach a real database or provider.
for (const name of Object.keys(process.env)) {
  if (/^(SUPABASE_|DATABASE_|PGLITE_|DEV_AUTH)|_API_KEY$|_HOSTED$|_MODELS$|^(TRUST_CLOUDFLARE|TRUST_CF_IPCOUNTRY|SSE_HEARTBEAT_MS|SHUTDOWN_GRACE_MS|NODE_ENV|EC2_PROXY_SECRET|EXTRA_WEB_HOSTS|ASSETS_DIR|READY_PORT|AUTH_REUSE_PORT|GIT_COMMIT)$/.test(name)) {
    delete process.env[name];
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const USAGE = { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 };

// Responses the fake upstream holds until the check releases them by name.
const held = new Map();
const holdUntilReleased = name => new Promise(resolve => held.set(name, resolve));
const releaseHold = name => {
  held.get(name)();
  held.delete(name);
};

// Fake Groq: `lifecycle:<chunks>:<delay ms>[:pause=<ms>][:hold=<name>][:gate=<name>]` in the prompt
// shapes the stream (the pause replaces the delay before the second content chunk; hold keeps the
// response before its headers, gate after its first content chunk, until releaseHold(name)).
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const [, count, delay, pause, hold, gate] =
    /lifecycle:(\d+):(\d+)(?::pause=(\d+))?(?::hold=(\w+))?(?::gate=(\w+))?/.exec(raw) || [, '1', '0'];
  let closed = false;
  res.on('close', () => { closed = true; });
  if (hold) await holdUntilReleased(hold);
  if (closed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = value => res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  const chunk = (delta, finish = null) => ({ id: 'up', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  send(chunk({ role: 'assistant', content: '' }));
  for (let i = 0; i < Number(count); i++) {
    await (i === 1 && gate ? holdUntilReleased(gate) : sleep(i === 1 && pause ? Number(pause) : Number(delay)));
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
// Settles when the listener is bound, or with its error (ENOTSUP for reusePort off Linux).
const bound = server => server.listening ? Promise.resolve() : new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const freePort = () => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
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

// A streamed completion on a keep-alive agent, read raw so the Connection header is visible.
const rawStream = (port, token, prompt, agent) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ model: 'groq/openai/gpt-oss-120b', stream: true, max_tokens: 64, messages: [{ role: 'user', content: prompt }] });
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});

// One gateway instance as its own process, as systemd runs zerox-gateway@0 and @1: the real
// server.js (its own SIGTERM handling and exit) with the upstream shim and e2e-instance-probe.cjs
// preloaded, started in an empty directory so no developer .env is read.
const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerox-instance-'));
function spawnInstance(name, settings) {
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'e2e-instance-probe.cjs'),
    '--import', pathToFileURL(path.join(__dirname, 'e2e-upstream-shim.mjs')).href, path.join(__dirname, 'server.js')], {
    cwd: instanceDir, env: { ...process.env, ...settings }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const instance = { name, child, log: '', served: [] };
  child.stdout.on('data', chunk => { instance.log += chunk; });
  child.stderr.on('data', chunk => { instance.log += chunk; });
  child.on('message', message => { if (message?.served) instance.served.push(message); });
  instance.exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, at: Date.now() }));
  return instance;
}
const running = instance => instance.child.exitCode === null && instance.child.signalCode === null;
async function untilLogged(instance, pattern, ms = 60000) {
  const until = Date.now() + ms;
  while (!pattern.test(instance.log)) {
    assert.ok(running(instance), `${instance.name} exited:\n${instance.log}`);
    assert.ok(Date.now() < until, `${instance.name} did not log ${pattern}:\n${instance.log}`);
    await sleep(20);
  }
}
// systemd's stop. Windows has no SIGTERM to send, so the probe raises it from an IPC message there.
const terminate = instance => (process.platform === 'win32' ? instance.child.send('SIGTERM') : instance.child.kill('SIGTERM'));

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

    // Behind the tunnel the server is the public origin: without the Worker's proxy secret it
    // answers its test host only (check-node-origin.cjs), here the loopback address it listens on.
    const tunnelPort = await freePort();
    Object.assign(process.env, { TRUST_CLOUDFLARE: 'true', AUTH_PORT: String(tunnelPort), EXTRA_WEB_HOSTS: `127.0.0.1:${tunnelPort}` });
    const tunnel = await startServer();
    Object.assign(process.env, { AUTH_PORT: '0' });
    delete process.env.EXTRA_WEB_HOSTS;
    for (let i = 1; i <= 10; i++) assert.notEqual(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '203.0.113.7' }), 429);
    assert.equal(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '203.0.113.7' }), 429, 'one visitor is limited');
    assert.notEqual(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '198.51.100.9' }), 429, 'another visitor has its own bucket');
    assert.notEqual(await pkceStart(tunnel.base, { 'CF-Connecting-IP': '198.51.100.10', 'x-zerox-client-ip': '203.0.113.7' }), 429,
      'x-zerox-client-ip without the proxy secret is ignored');
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

    // ── A response that has not started when the drain begins (its upstream has not answered yet)
    // says Connection: close, so the proxy in front (cloudflared pools keep-alive connections) never
    // sends its next request on a connection the old instance is closing: that request would get
    // the draining 503, or a reset that a POST is not retried after ──
    const late = await startServer();
    const lateToken = await session(late.base);
    const keepAliveAgent = new http.Agent({ keepAlive: true });
    try {
      const pending = rawStream(Number(new URL(late.base).port), lateToken, 'lifecycle:2:10:hold=late', keepAliveAgent);
      await waitFor(() => held.has('late'), 5000);
      const lateDrain = drain(late.server, 5000);
      releaseHold('late');
      const answer = await pending;
      assert.equal(answer.status, 200);
      assert.match(answer.text, /data: \[DONE\]/, 'it is still served in full');
      assert.equal(answer.headers.connection, 'close', 'a response that starts during the drain closes its connection');
      assert.equal(await lateDrain, true);
    } finally { keepAliveAgent.destroy(); }

    // ── The readiness listener: GET /ready and /health of one instance on its own loopback port,
    // answered by the app as on the main port (which, as the EC2 origin, refuses the rest without
    // the proxy secret); nothing else; it closes with the main listener on SIGTERM ──
    const readyPort = await freePort();
    Object.assign(process.env, { READY_PORT: String(readyPort), EC2_PROXY_SECRET: 'lifecycle-proxy-secret-0123456789abcdef' });
    const instance = await startServer();
    delete process.env.READY_PORT;
    delete process.env.EC2_PROXY_SECRET;
    const readyBase = `http://127.0.0.1:${readyPort}`;
    for (let tries = 0; await freshConnection(readyPort) === 'ECONNREFUSED'; tries++) {
      assert.ok(tries < 100, 'the readiness listener is up');
      await sleep(20);
    }
    const answer = async url => {
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    };
    assert.deepEqual(await answer(readyBase + '/health'), await answer(instance.base + '/health'), 'GET /health, same handler');
    const readiness = await answer(readyBase + '/ready');
    assert.deepEqual(readiness, await answer(instance.base + '/ready'), 'GET /ready, same handler');
    assert.equal(readiness.status, 503, 'not ready here: no session store');
    assert.equal((await answer(instance.base + '/v1/models')).status, 403, 'the main port is the production origin');
    for (const pathname of ['/v1/models', '/', '/auth/session', '/neuroncli/auth-server/health', '/health/']) {
      assert.equal((await answer(readyBase + pathname)).status, 404, pathname);
    }
    assert.equal((await fetch(readyBase + '/health', { method: 'POST' })).status, 404, 'GET only');
    assert.equal((await fetch(readyBase + '/health', { method: 'HEAD' })).status, 200);
    assert.equal(await drain(instance.server, 2000), true);
    assert.equal(await freshConnection(readyPort), 'ECONNREFUSED', 'the readiness listener drains with the instance');
    assert.equal(await freshConnection(Number(new URL(instance.base).port)), 'ECONNREFUSED');

    // ── Two instances, each its own process as on the VM (C6): the next release starts on the port
    // the old one listens on (SO_REUSEPORT, Linux and Node 22.12+), both accept, then the old one
    // gets SIGTERM and drains a stream that began on it to its end while every new connection
    // reaches the new one. Off Linux libuv refuses SO_REUSEPORT (ENOTSUP), so there the same
    // handover runs on two ports: everything but the port sharing is still checked ──
    for (const [version, supported] of [['v22.11.0', false], ['v22.12.0', true], ['v23.0.0', false], ['v23.1.0', true], ['v24.12.0', true],
      ['v20.18.1', false], ['v25.0.0', true]]) {
      assert.equal(supportsReusePort(version), supported, version);
    }
    const sharing = process.platform === 'linux';
    if (!sharing) {
      Object.assign(process.env, { AUTH_PORT: String(await freePort()), AUTH_REUSE_PORT: 'true' });
      const refused = await start();
      servers.push(refused);
      await assert.rejects(bound(refused), { code: 'ENOTSUP' }, 'libuv refuses SO_REUSEPORT where it cannot balance (Windows, macOS)');
      Object.assign(process.env, { AUTH_PORT: '0' });
      delete process.env.AUTH_REUSE_PORT;
      console.log(`NOTE: reusePort is not supported on ${process.platform}; the handover below runs on two ports (one shared port on Linux only)`);
    }
    const ports = [await freePort(), await freePort()];
    while (ports[1] === ports[0]) ports[1] = await freePort();
    const [oldPort, nextPort] = sharing ? [ports[0], ports[0]] : ports;
    const readyPorts = [await freePort(), await freePort()];
    while (readyPorts[1] === readyPorts[0]) readyPorts[1] = await freePort();
    const launch = (name, port, readyPort) => spawnInstance(name, { AUTH_PORT: String(port), READY_PORT: String(readyPort),
      AUTH_REUSE_PORT: sharing ? 'true' : '' });
    const instances = [];
    try {
      const old = launch('old', oldPort, readyPorts[0]);
      instances.push(old);
      await untilLogged(old, /listening on 127\.0\.0\.1:\d+/);
      await untilLogged(old, /readiness checks on 127\.0\.0\.1:\d+/);
      if (sharing) assert.match(old.log, /\(shared port\)/);
      assert.equal(await freshConnection(readyPorts[0]), 200, 'the deploy checks one instance on its READY_PORT');
      // A stream that starts on the old release and outlives it: the upstream holds it after its first chunk.
      const oldBase = `http://127.0.0.1:${oldPort}`;
      const handover = await openStream(oldBase, await session(oldBase), 'lifecycle:3:10:gate=handover');
      await waitFor(() => old.served.some(entry => entry.path === '/v1/chat/completions'), 3000);

      const next = launch('next', nextPort, readyPorts[1]);
      instances.push(next);
      await untilLogged(next, /listening on 127\.0\.0\.1:\d+/);
      await untilLogged(next, /readiness checks on 127\.0\.0\.1:\d+/);
      assert.equal(await freshConnection(readyPorts[1]), 200);
      const healthChecks = (each, port) => each.served.filter(entry => entry.path === '/health' && entry.port === port).length;
      if (sharing) {
        // The kernel spreads new connections over both listeners (by address and port): 24 fresh
        // connections all reaching one of them would be a 1-in-8-million chance.
        for (let i = 0; i < 24; i++) assert.equal(await freshConnection(oldPort), 200, 'both instances accept on the shared port');
        await waitFor(() => healthChecks(old, oldPort) + healthChecks(next, oldPort) === 24, 3000);
        assert.ok(healthChecks(old, oldPort) > 0 && healthChecks(next, oldPort) > 0,
          `both pids served (old ${healthChecks(old, oldPort)}, next ${healthChecks(next, oldPort)})`);
      } else {
        assert.equal(await freshConnection(oldPort), 200);
        assert.equal(await freshConnection(nextPort), 200);
        await waitFor(() => healthChecks(old, oldPort) === 1 && healthChecks(next, nextPort) === 1, 3000);
      }

      // The deploy stops the old instance: its listeners close, its stream goes on.
      const oldServed = healthChecks(old, oldPort);
      const nextServed = healthChecks(next, nextPort);
      terminate(old);
      await untilLogged(old, /draining 1 request\(s\)/);
      for (let i = 0; i < 12; i++) assert.equal(await freshConnection(nextPort), 200, 'no connection refused while the old one drains');
      if (!sharing) assert.equal(await freshConnection(oldPort), 'ECONNREFUSED', 'the old instance accepts nothing new');
      await waitFor(() => healthChecks(next, nextPort) === nextServed + 12, 3000);
      assert.equal(healthChecks(old, oldPort), oldServed, 'every new connection reached the new instance');
      assert.ok(running(old), 'the old instance is still draining its stream');

      releaseHold('handover');
      const finished = await handover.rest();
      const finishedAt = Date.now();
      assert.ok(finished.complete && finished.text.includes('data: [DONE]'), 'the stream that began on the old release ended on it');
      const content = finished.text.split('\n\n').filter(part => part.startsWith('data: {')).map(part => JSON.parse(part.slice(6)))
        .map(event => event.choices?.[0]?.delta?.content || '').join('');
      assert.equal(content, 't0 t1 t2 ', 'nothing lost across the handover');
      const oldExit = await old.exited;
      assert.deepEqual([oldExit.code, oldExit.signal], [0, null], `the old instance exits cleanly:\n${old.log}`);
      assert.ok(oldExit.at >= finishedAt, 'only after its stream finished');
      assert.equal(await freshConnection(nextPort), 200, 'the new instance carries on alone');
      assert.equal(await freshConnection(readyPorts[0]), 'ECONNREFUSED', 'the old readiness listener is gone');
      terminate(next);
      const nextExit = await next.exited;
      assert.deepEqual([nextExit.code, nextExit.signal], [0, null], `the new instance stops the same way:\n${next.log}`);
    } finally {
      for (const each of instances) if (running(each)) each.child.kill();
      await Promise.all(instances.map(each => each.exited));
    }

    // ── The release's commit (C9): REVISION at the release root, GIT_COMMIT from the environment wins ──
    const release = fs.mkdtempSync(path.join(os.tmpdir(), 'zerox-release-'));
    try {
      process.env.ASSETS_DIR = release;
      assert.equal(runtimeEnv('127.0.0.1').GIT_COMMIT, undefined, 'no REVISION');
      fs.writeFileSync(path.join(release, 'REVISION'), 'ab12cd3\n');
      assert.equal(runtimeEnv('127.0.0.1').GIT_COMMIT, 'ab12cd3');
      process.env.GIT_COMMIT = '9f8e7d6';
      assert.equal(runtimeEnv('127.0.0.1').GIT_COMMIT, '9f8e7d6', 'the environment wins');
      delete process.env.GIT_COMMIT;
      const withRevision = await startServer();
      const health = await (await fetch(withRevision.base + '/health')).json();
      // /health names the commit through the app (src/index.js reads GIT_COMMIT, as on the Worker).
      assert.equal(health.commit, 'ab12cd3', '/health reports the release\'s commit');
      fs.writeFileSync(path.join(release, 'REVISION'), 'not a commit\n');
      assert.equal(runtimeEnv('127.0.0.1').GIT_COMMIT, undefined, 'anything but a SHA is ignored');
    } finally {
      delete process.env.ASSETS_DIR;
      fs.rmSync(release, { recursive: true, force: true });
    }
  } finally {
    await Promise.all([...servers, upstream].map(closeServer));
    fs.rmSync(instanceDir, { recursive: true, force: true });
  }
  console.log('PASS: Node server trusts CF-Connecting-IP only from loopback with TRUST_CLOUDFLARE (and then refuses the dev identity), keeps quiet streams alive, drains on SIGTERM (readiness listener included; responses not yet started close their connection), hands over to the next release\'s process (one shared port on Linux) while a stream on the old one finishes, and reports the release commit');
})().catch(error => { console.error(error); process.exitCode = 1; });
