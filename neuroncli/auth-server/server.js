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

async function start() {
  const { default: app } = await import('./src/index.js');
  const env = { ...process.env, ASSETS: { fetch: asset } };
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
        method: req.method, headers: req.headers,
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
  const port = Number(process.env.AUTH_PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`Neuron gateway: http://127.0.0.1:${port}`));
  return server;
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { start, asset };
