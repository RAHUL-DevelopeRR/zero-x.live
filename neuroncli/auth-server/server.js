require('dotenv').config();

const http = require('node:http');
const net = require('node:net');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

async function asset(request) {
  const url = new URL(request.url);
  let filename;
  try { filename = decodeURIComponent(url.pathname); }
  catch { return new Response('Invalid path', { status: 400 }); }
  const relative = filename.replace(/^\/+/, '');
  const parts = relative.split(/[\\/]/);
  // Never serve server source, secrets or hidden files through the development adapter.
  if (parts.some(part => part.startsWith('.') || part === 'node_modules') ||
      parts[0] === 'neuroncli' && parts[1] === 'auth-server') {
    return new Response('Not found', { status: 404 });
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
  try {
    const info = await fs.stat(resolved);
    const file = info.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    const type = mime[path.extname(file)];
    if (!type) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : await fs.readFile(file), {
      headers: { 'Content-Type': type },
    });
  } catch { return new Response('Not found', { status: 404 }); }
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

// Builds the bindings object shared by every request. process.env passes through unchanged
// (including DATABASE_DRIVER=pglite and its settings for the account store).
function runtimeEnv(host) {
  const env = { ...process.env, ...(process.env.NEURON_API_ONLY === 'true' ? {} : { ASSETS: { fetch: asset } }) };
  // Marks the Node runtime: the local dev identity is never honoured by the Worker build.
  env.NEURON_RUNTIME = 'node';
  if (env.DEV_AUTH_ENABLED === 'true' && String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    console.warn('DEV_AUTH_ENABLED ignored: the dev identity is refused when NODE_ENV=production');
    delete env.DEV_AUTH_ENABLED;
  } else if (env.DEV_AUTH_ENABLED === 'true' && !LOOPBACK_HOSTS.includes(host)) {
    console.warn('DEV_AUTH_ENABLED ignored: the dev identity requires AUTH_HOST to be a loopback address');
    delete env.DEV_AUTH_ENABLED;
  } else if (env.DEV_AUTH_ENABLED === 'true' && env.TRUST_CLOUDFLARE === 'true') {
    // Behind Cloudflare Tunnel the loopback listener is the public origin.
    console.warn('DEV_AUTH_ENABLED ignored: the dev identity is refused when TRUST_CLOUDFLARE=true (public behind the tunnel)');
    delete env.DEV_AUTH_ENABLED;
  } else if (env.DEV_AUTH_ENABLED === 'true') {
    console.warn('DEV_AUTH_ENABLED: dev_<base64url(email)> tokens are accepted from loopback hosts. Never use in production.');
  }
  return env;
}

const positiveMs = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

// Behind Cloudflare Tunnel every request comes from cloudflared on loopback, so all visitors
// would share one per-IP bucket. With TRUST_CLOUDFLARE=true the visitor address is taken from
// CF-Connecting-IP (Cloudflare sets it on every proxied request), but only from a loopback peer
// and only when it is a single valid address; otherwise the socket address stands, so a client
// that reaches the port directly cannot choose its own bucket.
const isLoopback = address => address === '::1' || /^(::ffff:)?127\./.test(address || '');

function clientAddress(req, trustCloudflare) {
  const peer = req.socket.remoteAddress;
  if (trustCloudflare && isLoopback(peer)) {
    const visitor = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(visitor)) return visitor;
  }
  return peer;
}

function requestHeaders(req, { trustCloudflare = false } = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'x-neuron-client-ip' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Trusted client address for per-IP limits; any client-supplied value was dropped above.
  const address = clientAddress(req, trustCloudflare);
  if (address) headers.set('x-neuron-client-ip', address);
  return headers;
}

// Cloudflare ends a proxied response after 125 s without a byte from the origin (Tunnel
// included), while a token stream can stay quiet longer: Claude's thinking phase sends only
// pings, which the gateway does not forward. An event stream therefore gets an SSE comment
// (clients skip it) once heartbeatMs pass without output, only ever between whole events.
const endsEvent = chunk => {
  const n = chunk.length;
  return n >= 2 && chunk[n - 1] === 10 && (chunk[n - 2] === 10 || (n >= 4 && chunk[n - 2] === 13 && chunk[n - 3] === 10));
};

function keepAlive(res, body, heartbeatMs) {
  let last = Date.now();
  let boundary = true;
  body.on('data', chunk => {
    last = Date.now();
    boundary = endsEvent(chunk);
  });
  const timer = setInterval(() => {
    if (!boundary || res.writableEnded || res.destroyed || Date.now() - last < heartbeatMs) return;
    res.write(': keep-alive\n\n');
    last = Date.now();
  }, Math.ceil(heartbeatMs / 2));
  res.on('close', () => clearInterval(timer));
}

const IN_FLIGHT = Symbol('inFlight');
const DRAINING = Symbol('draining');

// Only a path that URL parsing leaves as it is gets served. cloudflared matches its ingress path
// rules on the path as received, and new URL() then resolves dot segments (literal or %2e),
// backslashes, a leading // and absolute forms, so /v1/%2e%2e/admin/overview would pass a ^/v1/
// rule and reach /admin/overview.
function canonicalPath(rawUrl) {
  const raw = String(rawUrl || '');
  if (!raw.startsWith('/')) return false;
  try {
    return new URL(raw, 'http://127.0.0.1').pathname === raw.split('?')[0];
  } catch {
    return false;
  }
}

async function start() {
  const { default: app } = await import('./src/index.js');
  const port = Number(process.env.AUTH_PORT || 8787);
  const host = process.env.AUTH_HOST || '127.0.0.1';
  const env = runtimeEnv(host);
  const trustCloudflare = process.env.TRUST_CLOUDFLARE === 'true';
  const heartbeatMs = positiveMs(process.env.SSE_HEARTBEAT_MS, 30000);
  const inFlight = new Set();
  const server = http.createServer(async (req, res) => {
    // A request that reaches a draining server (on a kept-alive connection) is turned away, so
    // the drain only waits for work that started before the stop.
    if (server[DRAINING]) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Gateway restarting' }));
      return;
    }
    if (!canonicalPath(req.url)) {
      res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Invalid request path' }));
      return;
    }
    inFlight.add(res);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
      inFlight.delete(res);
      // While draining, a connection whose response is done is closed, so server.close can finish.
      if (server[DRAINING]) setImmediate(() => server.closeIdleConnections());
    });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        chunks.push(chunk);
      }
      const request = new Request(new URL(req.url, 'http://127.0.0.1'), {
        method: req.method, headers: requestHeaders(req, { trustCloudflare }),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        signal: controller.signal,
      });
      const response = await app.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body || req.method === 'HEAD') res.end();
      else {
        const body = Readable.fromWeb(response.body);
        body.on('error', () => res.destroy());
        res.on('close', () => body.destroy());
        if (String(response.headers.get('content-type')).includes('text/event-stream')) keepAlive(res, body, heartbeatMs);
        body.pipe(res);
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway request failed' }));
      } else res.destroy();
    }
  });
  server[IN_FLIGHT] = inFlight;
  // Logs the bound port, so AUTH_PORT=0 (any free port) can be discovered from stdout.
  server.listen(port, host, () => console.log(`Neuron gateway listening on ${host}:${server.address().port}`));
  return server;
}

// Graceful stop: the listener closes at once and idle keep-alive connections are dropped, while
// requests in flight (token streams, whose settlement runs before their last byte) get up to
// graceMs to finish. Whatever still runs then is cut, which settles it as a client cancel.
// Resolves true when every request finished in time.
function drain(server, graceMs) {
  server[DRAINING] = true;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve(false);
    }, graceMs);
    server.close(() => {
      clearTimeout(timer);
      resolve(true);
    });
    server.closeIdleConnections();
  });
}

// systemd stops and restarts the service with SIGTERM (TimeoutStopSec must exceed the grace,
// SHUTDOWN_GRACE_MS, 110 s by default, plus cutTailMs). Work a response leaves behind gets a
// tail before the process exits: tailMs after a clean drain (a finished stream settled before
// its last byte; only session activity is left), cutTailMs when streams were cut, since each
// cut stream's settlement is a database round trip (a settlement still lost there leaves a
// reservation for the stale-reservation cron). A second signal exits at once.
function stopOnSignals(server, { graceMs = positiveMs(process.env.SHUTDOWN_GRACE_MS, 110000), tailMs = 1000,
  cutTailMs = 5000, exit = code => process.exit(code) } = {}) {
  let stopping = false;
  const stop = signal => {
    if (stopping) return exit(1);
    stopping = true;
    console.log(`${signal || 'Stop'}: draining ${server[IN_FLIGHT]?.size ?? 0} request(s) for up to ${Math.round(graceMs / 1000)} s`);
    drain(server, graceMs).then(clean => {
      if (!clean) console.warn(`Shutdown grace ended; requests still running were cut (${Math.round(cutTailMs / 1000)} s to settle them)`);
      setTimeout(() => exit(0), clean ? tailMs : cutTailMs);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return stop;
}

if (require.main === module) {
  start().then(server => stopOnSignals(server)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { start, asset, runtimeEnv, requestHeaders, drain, stopOnSignals };
