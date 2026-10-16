require('dotenv').config();

const http = require('node:http');
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
  if (env.DEV_AUTH_ENABLED === 'true' && !LOOPBACK_HOSTS.includes(host)) {
    console.warn('DEV_AUTH_ENABLED ignored: the dev identity requires AUTH_HOST to be a loopback address');
    delete env.DEV_AUTH_ENABLED;
  } else if (env.DEV_AUTH_ENABLED === 'true') {
    console.warn('DEV_AUTH_ENABLED: dev_<base64url(email)> tokens are accepted from loopback hosts. Never use in production.');
  }
  return env;
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'x-neuron-client-ip' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // Trusted client address for per-IP limits; any client-supplied value was dropped above.
  if (req.socket.remoteAddress) headers.set('x-neuron-client-ip', req.socket.remoteAddress);
  return headers;
}

async function start() {
  const { default: app } = await import('./src/index.js');
  const port = Number(process.env.AUTH_PORT || 8787);
  const host = process.env.AUTH_HOST || '127.0.0.1';
  const env = runtimeEnv(host);
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
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
        method: req.method, headers: requestHeaders(req),
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
        body.pipe(res);
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gateway request failed' }));
      } else res.destroy();
    }
  });
  // Logs the bound port, so AUTH_PORT=0 (any free port) can be discovered from stdout.
  server.listen(port, host, () => console.log(`Neuron gateway listening on ${host}:${server.address().port}`));
  return server;
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { start, asset, runtimeEnv };
