// Worker -> EC2, end to end (the Phase 1 contract between the lanes): the Worker's own fetch
// (src/index.js with its proxy switch, src/ec2-proxy.js) in front of the real Node server
// (server.js as its own process, set up like a zerox-gateway@ instance: NODE_ENV=production,
// TRUST_CLOUDFLARE, the proxy secret, READY_PORT and a release directory with REVISION and the
// .assetsignore allow-list). A stand-in for Cloudflare's edge and the tunnel carries each forward
// to the server's loopback port the way cloudflared does: Host aws.zero-x.live, plus the
// CF-Connecting-IP and CF-IPCountry of the Worker's own hop. Checked:
//   - forwarded requests reach the app with the visitor's host and scheme (www -> apex, http ->
//     https, the dashboard host), address (per-IP limits) and location (request.cf geo rules);
//   - spoofed x-zerox-* sent to the Worker are replaced, and sent straight to the tunnel host
//     (no secret, a wrong one) are refused;
//   - a streamed /v1 answer is the very Response the tunnel returned, unread by the Worker, and its
//     first tokens reach the visitor while the upstream still holds the rest;
//   - the release's site files through the forward (allow-list, cache headers, 304, mp4 ranges);
//   - /health reports the same commit from the Worker (GIT_COMMIT) and from EC2 (REVISION), on
//     the public path and on READY_PORT in the form activate-release.sh matches;
//   - EXTRA_WEB_HOSTS reads the same in server.js and src/web-hosts.js.
// Nothing leaves this machine: the Worker's fetch reaches only the stand-in, and the server runs
// with e2e-upstream-shim.mjs (fake Groq and Gemini on loopback) in an empty directory (no .env).
//   node check-ec2-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import app from './src/index.js';
import { extraWebHosts } from './src/web-hosts.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '../..');
const SECRET = 'e2e-proxy-secret-0123456789abcdef0123456789abcdef';
const COMMIT = 'c0ffee1';
const ORIGIN = 'https://aws.zero-x.live';
// What Cloudflare adds to the Worker's own subrequest: the Worker's egress address and its colo's
// country, never the visitor's.
const WORKER_HOP = { 'cf-connecting-ip': '2a06:98c0:3600::103', 'cf-ipcountry': 'NL', 'cf-ray': '8f00e2e0e2e0e2e0-BOM' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── The release: REVISION, the repository's real .assetsignore, a page, assets, a video, and the
// deploy kit that package-release.sh puts in every release ──
const work = mkdtempSync(join(tmpdir(), 'zerox-ec2-e2e-'));
const release = join(work, 'release');
const cwd = join(work, 'cwd');
for (const dir of [release, join(release, 'Assets'), join(release, 'deploy/aws'), cwd]) mkdirSync(dir, { recursive: true });
writeFileSync(join(release, 'REVISION'), `${COMMIT}\n`);
copyFileSync(join(repo, '.assetsignore'), join(release, '.assetsignore'));
writeFileSync(join(release, 'index.html'), '<!doctype html><title>Zero-X</title><p>e2e home page</p>');
writeFileSync(join(release, 'robots.txt'), 'User-agent: *\nAllow: /\n');
writeFileSync(join(release, 'Assets', 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
writeFileSync(join(release, 'Assets', 'RahulCIT.png'), 'never served');
writeFileSync(join(release, 'showcase.mp4'), Buffer.alloc(1000, 7));
for (const name of ['activate-release.sh', 'zerox-deploy.sudoers', 'zerox-gateway@.service']) {
  copyFileSync(join(repo, 'deploy/aws', name), join(release, 'deploy/aws', name));
}

// ── The upstream: fake Groq. A prompt with "gate" holds the stream after its first token until
// the check releases it ──
let releaseGate = null;
const gate = () => new Promise(resolve => { releaseGate = resolve; });
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = value => res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  const chunk = (delta, finish = null) => ({ id: 'up', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  send(chunk({ role: 'assistant', content: '' }));
  send(chunk({ content: 't0 ' }));
  if (raw.includes('gate')) await gate();
  send(chunk({ content: 't1 ' }));
  send(chunk({}, 'stop'));
  send({ id: 'up', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
  send('[DONE]');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

// ── The EC2 instance: server.js as its own process, settings as zerox-gateway@.service gives them
// (reusePort only where the kernel has it) plus the test's fake keys. EC2_PROXY_PREFIXES leaked
// into its environment must not make it forward to itself. ──
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(SUPABASE_|DATABASE_|PGLITE_|DEV_AUTH|E2E_|EC2_|ALLOW_|TRUST_)|_API_KEY$|_HOSTED$|_MODELS$|_TOKEN$|_SECRET$|^(NODE_ENV|NODE_OPTIONS|NEURON_API_ONLY|EXTRA_WEB_HOSTS|ASSETS_DIR|READY_PORT|AUTH_REUSE_PORT|AUTH_PORT|AUTH_HOST|GIT_COMMIT)$/.test(name)));
const settings = {
  NODE_ENV: 'production', AUTH_HOST: '127.0.0.1', AUTH_PORT: '0', READY_PORT: '0', ASSETS_DIR: release,
  ...(process.platform === 'linux' ? { AUTH_REUSE_PORT: 'true' } : {}),
  TRUST_CLOUDFLARE: 'true', TRUST_CF_IPCOUNTRY: 'true', EC2_PROXY_SECRET: SECRET, EC2_PROXY_PREFIXES: 'zero-x.live/',
  ALLOW_ANONYMOUS_SESSIONS: 'true', GROQ_API_KEY: 'e2e-groq-ec2', GROQ_MODELS: 'openai/gpt-oss-120b', GEMINI_API_KEY: 'e2e-gemini-ec2',
  E2E_UPSTREAM_BASE: `http://127.0.0.1:${upstream.address().port}`,
};
const child = spawn(process.execPath, ['--import', pathToFileURL(join(here, 'e2e-upstream-shim.mjs')).href, join(here, 'server.js')],
  { cwd, env: { ...inherited, ...settings }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const exited = once(child, 'exit');
async function logged(pattern) {
  for (const until = Date.now() + 30000; !pattern.test(log);) {
    assert.ok(child.exitCode === null, `server.js exited:\n${log}`);
    assert.ok(Date.now() < until, `server.js did not log ${pattern}:\n${log}`);
    await sleep(20);
  }
  return pattern.exec(log);
}

// A raw request to the server's loopback port, as cloudflared sends it (fetch would not let the
// Host header differ from the URL). Answers a Response whose body streams as it arrives.
function toServer(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        for (const each of [value].flat()) responseHeaders.append(name, each);
      }
      const empty = method === 'HEAD' || [204, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: responseHeaders }));
    });
    req.on('error', reject);
    if (body) Readable.fromWeb(body).pipe(req);
    else req.end();
  });
}

let port;
const tunnelled = [];
try {
  port = Number((await logged(/listening on 127\.0\.0\.1:(\d+)/))[1]);
  const readyPort = Number((await logged(/readiness checks on 127\.0\.0\.1:(\d+)/))[1]);

  // ── Cloudflare's edge and the tunnel, for the Worker's subrequests: only EC2_PROXY_ORIGIN is
  // reachable. cloudflared sends Host aws.zero-x.live; Cloudflare adds the hop's CF-* headers. ──
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, ORIGIN, `the Worker reaches only EC2_PROXY_ORIGIN, not ${url.origin}`);
    const headers = { ...Object.fromEntries(request.headers), ...WORKER_HOP, host: url.host };
    const response = await toServer(port, { method: request.method, path: url.pathname + url.search, headers, body: request.body });
    tunnelled.push({ request, response });
    return response;
  };

  // The Worker as Cloudflare invokes it: request.cf and CF-Connecting-IP describe the visitor.
  const WORKER_ENV = { EC2_PROXY_PREFIXES: 'zero-x.live/,www.zero-x.live/,dashboard.zero-x.live/', EC2_PROXY_SECRET: SECRET, GIT_COMMIT: COMMIT };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const MUMBAI = { country: 'IN', city: 'Mumbai', region: 'Maharashtra', asn: 9498, asOrganization: 'Bharti Airtel Ltd.' };
  function visit(url, { method = 'GET', headers = {}, body, ip = '203.0.113.7', cf = MUMBAI } = {}) {
    const request = new Request(url, { method, headers: { ...headers, 'cf-connecting-ip': ip }, body,
      ...(body ? { duplex: 'half' } : {}) });
    Object.defineProperty(request, 'cf', { value: cf });
    return app.fetch(request, WORKER_ENV, ctx);
  }
  const lastForward = () => tunnelled.at(-1).request;

  // ── The visitor's host and scheme ──
  const before = tunnelled.length;
  const www = await visit('https://www.zero-x.live/pricing?ref=1', { headers: { 'x-zerox-host': 'dashboard.zero-x.live', 'x-zerox-proto': 'http' } });
  assert.equal(tunnelled.length, before + 1, 'forwarded');
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('location'), 'https://zero-x.live/pricing?ref=1', 'www -> apex: the visitor\'s host, not a spoofed one');
  assert.equal(lastForward().redirect, 'manual', 'redirects are not followed: the visitor gets them');
  assert.equal(lastForward().headers.get('x-zerox-host'), 'www.zero-x.live');
  assert.equal(lastForward().headers.get('x-zerox-proxy-secret'), SECRET);
  const plain = await visit('http://zero-x.live/pricing');
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get('location'), 'https://zero-x.live/pricing', 'http -> https');
  const robots = await visit('https://dashboard.zero-x.live/robots.txt');
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n', 'the dashboard host');
  const home = await visit('https://zero-x.live/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /e2e home page/, 'the release\'s site');
  assert.match(home.headers.get('strict-transport-security'), /max-age=31536000/, 'HSTS: the app saw https');

  // ── The visitor's address: 10 OAuth starts per address and window. The hop's CF-Connecting-IP
  // and a spoofed x-zerox-client-ip count for nothing ──
  const oauthStart = (ip, headers = {}) => visit('https://zero-x.live/auth/openrouter/start', { ip, headers }).then(response => response.status);
  for (let i = 1; i <= 10; i++) assert.notEqual(await oauthStart('198.51.100.7'), 429, `start ${i}`);
  assert.equal(await oauthStart('198.51.100.7'), 429, 'one visitor is limited');
  assert.notEqual(await oauthStart('198.51.100.8', { 'x-zerox-client-ip': '198.51.100.7' }), 429,
    'another visitor has its own bucket, whatever x-zerox-client-ip it sends');

  // ── The visitor's location: request.cf.country drives the geo rules (free Gemini is closed to the EEA) ──
  const geminiOpen = async (cf, headers = {}) => {
    const response = await visit('https://zero-x.live/v1/models', { cf, headers });
    assert.equal(response.status, 200);
    return (await response.json()).data.find(model => model.id === 'gemini/gemini-3.5-flash').available;
  };
  assert.equal(await geminiOpen({ country: 'US' }), true);
  assert.equal(await geminiOpen({ country: 'DE' }), false);
  assert.equal(await geminiOpen({ country: 'DE' }, { 'x-zerox-country': 'US', 'cf-ipcountry': 'US' }), false,
    'a spoofed country header changes nothing');
  assert.equal(await geminiOpen({}), false, 'no country from Cloudflare: unknown, closed (the hop\'s NL is not the visitor\'s)');

  // ── A streamed /v1 answer: the tunnel's Response itself, unread, and streaming ──
  const sessionResponse = await visit('https://zero-x.live/auth/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machine_fingerprint: 'ec2-e2e-check' }) });
  assert.equal(sessionResponse.status, 200, await sessionResponse.clone().text());
  const token = (await sessionResponse.json()).session_token;
  const held = new Promise(resolve => { const wait = () => (releaseGate ? resolve() : setTimeout(wait, 5)); wait(); });
  const stream = await visit('https://zero-x.live/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'gate' }] }) });
  assert.equal(stream, tunnelled.at(-1).response, 'the Worker returns the upstream fetch\'s Response as it is');
  assert.equal(stream.bodyUsed, false, 'and never reads its body');
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  await held;
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('t0 ')) {
    const { done, value } = await reader.read();
    assert.ok(!done, `the stream ended before its first token: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
  assert.ok(!text.includes('t1 '), 'the first token arrived while the upstream still held the rest');
  releaseGate();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const content = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .map(event => event.choices?.[0]?.delta?.content || '').join('');
  assert.equal(content, 't0 t1 ');
  assert.match(text, /data: \[DONE\]/);

  // ── The release's site files through the forward (C4) ──
  const logo = await visit('https://zero-x.live/Assets/logo.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('cache-control'), 'public, max-age=604800');
  const etag = logo.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal((await visit('https://zero-x.live/Assets/logo.png', { headers: { 'If-None-Match': `W/${etag}` } })).status, 304,
    'a revalidation answers 304 through the Worker');
  assert.equal((await visit('https://zero-x.live/Assets/RahulCIT.png')).status, 404, '.assetsignore holds on EC2 too');
  assert.equal((await visit('https://zero-x.live/REVISION')).status, 404, 'the release\'s own files are not site files');
  for (const name of ['activate-release.sh', 'zerox-deploy.sudoers', 'zerox-gateway@.service']) {
    assert.equal((await visit(`https://zero-x.live/deploy/aws/${name}`)).status, 404, `nor the deploy kit: ${name}`);
  }
  const part = await visit('https://zero-x.live/showcase.mp4', { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  // ── Straight to the tunnel host, without the Worker: production answers nothing but the health
  // checks without the secret, and a wrong secret is refused ──
  const spoof = { host: 'aws.zero-x.live', 'x-zerox-host': 'zero-x.live', 'x-zerox-proto': 'https', 'x-zerox-client-ip': '203.0.113.9',
    'x-zerox-country': 'US', 'cf-connecting-ip': '203.0.113.9' };
  const direct = await toServer(port, { path: '/v1/models', headers: spoof });
  assert.equal(direct.status, 403);
  assert.equal((await direct.json()).error.code, 'forbidden');
  const wrong = await toServer(port, { path: '/v1/models', headers: { ...spoof, 'x-zerox-proxy-secret': `${SECRET.slice(0, -1)}x` } });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, 'proxy_secret_mismatch');

  // ── One commit: the Worker's own /health (a host no prefix covers), EC2's through the forward,
  // through the tunnel host and on READY_PORT, in the form activate-release.sh matches ──
  const activate = readFileSync(join(repo, 'deploy/aws/activate-release.sh'), 'utf8');
  assert.ok(activate.includes('\\"commit\\":\\ ?\\"([0-9a-f]+)\\"'), 'activate-release.sh reads "commit" from /health');
  const tunnelledBefore = tunnelled.length;
  const workerHealth = await (await visit('https://neuron.zero-x.live/health')).json();
  assert.equal(tunnelled.length, tunnelledBefore, 'the Worker answered its own /health');
  assert.equal(workerHealth.commit, COMMIT, 'the Worker: GIT_COMMIT');
  const ec2Health = await visit('https://zero-x.live/health');
  assert.equal(tunnelled.length, tunnelledBefore + 1, 'EC2 answered the forwarded /health');
  assert.equal((await ec2Health.json()).commit, COMMIT, 'EC2: REVISION');
  assert.equal((await (await toServer(port, { path: '/health', headers: { host: 'aws.zero-x.live' } })).json()).commit, COMMIT,
    'the tunnel host\'s /health answers without the secret');
  const readyHealth = await (await toServer(readyPort, { path: '/health', headers: { host: `127.0.0.1:${readyPort}` } })).text();
  assert.equal(/"commit": ?"([0-9a-f]+)"/.exec(readyHealth)?.[1], COMMIT, 'READY_PORT, as activate-release.sh reads it');
  assert.notEqual((await toServer(readyPort, { path: '/ready', headers: { host: `127.0.0.1:${readyPort}` } })).status, 404, 'READY_PORT answers /ready');
  assert.equal((await toServer(readyPort, { path: '/v1/models', headers: { host: `127.0.0.1:${readyPort}` } })).status, 404, 'and nothing else');

  // ── EXTRA_WEB_HOSTS: server.js and src/ name the same test hosts ──
  const require = createRequire(import.meta.url);
  const previousCwd = process.cwd();
  process.chdir(cwd); // server.js loads ./.env with dotenv: an empty directory has none.
  const { originSettings } = require('./server.js');
  process.chdir(previousCwd);
  for (const value of [undefined, '', 'aws.zero-x.live', ' AWS.zero-x.live , ,qa.example.test', 'zero-x.live,www.zero-x.live,aws.zero-x.live',
    'aws.zero-x.live:443,https://qa.example.test,a b,-bad.example,aws.zero-x.live', 'relay.zero-x.live,Neuron.Zero-X.live']) {
    assert.deepEqual(originSettings({ EXTRA_WEB_HOSTS: value }).extraHosts, extraWebHosts({ EXTRA_WEB_HOSTS: value }),
      `EXTRA_WEB_HOSTS=${JSON.stringify(value)}`);
  }

  assert.ok(!/outbound request to aws\.zero-x\.live/.test(log), 'EC2 never forwarded to itself');
  console.log('PASS: Worker -> EC2 end to end: the Worker\'s forward reaches server.js with the visitor\'s host, scheme, address and location (spoofed x-zerox-* replaced; straight to the tunnel host refused without the secret or with a wrong one), redirects reach the visitor, a /v1 stream is the tunnel\'s Response unread and streams while the upstream holds, site files with the allow-list, cache headers, 304 and ranges, the same commit in /health on both runtimes and READY_PORT, and EXTRA_WEB_HOSTS read alike');
} catch (error) {
  console.error(`server.js log:\n${log}`);
  throw error;
} finally {
  releaseGate?.();
  child.kill();
  await exited;
  upstream.closeAllConnections();
  upstream.close();
  rmSync(work, { recursive: true, force: true });
}
