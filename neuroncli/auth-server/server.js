require('dotenv').config();

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

// The repository root: the Worker's [assets] directory (wrangler.toml), and on EC2 the release
// root (/opt/zerox/releases/<sha>, from git archive) that holds REVISION.
const root = path.resolve(__dirname, '../..');
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

// ── Static site (C4): what the Worker's ASSETS binding serves, and nothing else ──
// The Worker uploads the repository root minus .assetsignore (gitignore syntax, plus wrangler's
// own /.assetsignore, /_headers and /_redirects), and serves it with html_handling and
// not_found_handling "none": a request names one file exactly, while src/index.js does the clean
// URLs, the host index pages and the 404 page. The Node server keeps an allow-list built once from
// the same directory and the same file, so a file the Worker would not serve (Assets/RahulCIT.png,
// notes, server source) is a 404 here as well, whatever its extension.
const WRANGLER_IGNORED = ['/.assetsignore', '/_headers', '/_redirects'];
// What the deploy adds to the release root (git archive plus these), which the Worker never
// uploads. They come after .assetsignore's own lines, so no negation there brings them back.
const RELEASE_FILES = ['/REVISION'];

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One .assetsignore line as a gitignore rule: ! negates, a trailing / matches directories only,
// a slash anywhere else anchors the pattern at the root (without one it matches at any depth),
// * and ? stay inside one path segment, and ** spans segments.
function ignoreRule(line) {
  let pattern = line.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\//, '');
  if (!pattern) return null;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const ownSegment = (i === 0 || pattern[i - 1] === '/') && (i + 2 === pattern.length || pattern[i + 2] === '/');
    if (char === '*' && pattern[i + 1] === '*' && ownSegment) {
      // A trailing ** is everything inside; **/ is zero or more directories.
      if (i + 2 === pattern.length) { source += '.*'; i += 1; } else { source += '(?:.*/)?'; i += 2; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '\\' && i + 1 < pattern.length) source += escapeRegExp(pattern[++i]);
    else if (char === '[' && pattern.indexOf(']', i + 2) !== -1) {
      const end = pattern.indexOf(']', i + 2);
      const set = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
      source += `[${set.startsWith('!') ? '^' + set.slice(1) : set}]`;
      i = end;
    } else source += escapeRegExp(char);
  }
  return { negate, dirOnly, regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`) };
}

// The last rule that matches decides, as in gitignore.
function ignoredBy(rules, relative, isDirectory) {
  let ignored = false;
  for (const rule of rules) {
    if ((!rule.dirOnly || isDirectory) && rule.regex.test(relative)) ignored = !rule.negate;
  }
  return ignored;
}

// Maps '/<relative path>' to the file for every file the Worker would upload. An ignored
// directory is not entered: as in gitignore, nothing inside it can be included again. Symbolic
// links, hidden names (other than .well-known), node_modules and the gateway's own directory stay
// out even if .assetsignore ever loses a line. Without .assetsignore nothing is served: a release
// is incomplete, and serving the whole tree instead would publish the server source.
function assetIndex(dir) {
  const files = new Map();
  let text;
  try { text = fs.readFileSync(path.join(dir, '.assetsignore'), 'utf8'); }
  catch {
    console.error(`Static files off: no .assetsignore in ${dir}`);
    return files;
  }
  const rules = [...WRANGLER_IGNORED, ...text.split('\n'), ...RELEASE_FILES].map(ignoreRule).filter(Boolean);
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (entry.name.startsWith('.') && entry.name !== '.well-known') ||
          entry.name === 'node_modules' || name === 'neuroncli/auth-server') continue;
      if (entry.isDirectory()) {
        if (!ignoredBy(rules, name, true)) walk(name);
      } else if (entry.isFile() && !ignoredBy(rules, name, false)) files.set(`/${name}`, path.join(dir, name));
    }
  };
  walk('');
  return files;
}

// /Assets/ files keep their names from release to release (no content hash in the name), so their
// long lifetime is a week rather than a year. Everything else, HTML included, revalidates every
// time like the Worker's own assets; the ETag makes that a 304 without a body.
const ASSET_CACHE = 'public, max-age=604800';
const REVALIDATE = 'public, max-age=0, must-revalidate';
const UNSATISFIABLE = Symbol('unsatisfiable');

// If-None-Match compares weakly (a W/ prefix, which Cloudflare adds when it compresses, is
// ignored); If-Range compares strongly.
const etagMatches = (header, etag) => !!header && (header.trim() === '*' ||
  header.split(',').some(value => value.trim().replace(/^W\//, '') === etag));

// One byte range (bytes=a-b, a- or -n) within size, UNSATISFIABLE, or null when the header is to
// be ignored (malformed, several ranges, or last before first) and the whole file is sent.
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix === 0 || size === 0 ? UNSATISFIABLE : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== '' && Number(match[2]) < start) return null;
  if (start >= size) return UNSATISFIABLE;
  return { start, end: match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1) };
}

const fileBody = (file, options) => Readable.toWeb(fs.createReadStream(file, options));

// The ASSETS binding for one directory: fetch(request) answers like the Worker's, with
// Cache-Control, a content ETag (conditional GET answers 304) and byte ranges for the videos
// (Safari will not play an mp4 without them). The allow-list is built on first use; start()
// builds it before listening.
function assetServer(dir) {
  let files = null;
  const etags = new Map();
  const load = () => (files ??= assetIndex(dir));
  // The hash is kept as a promise from the moment it starts, so simultaneous first requests for one
  // file (after a deploy: a page's images, a video's ranges) read it once between them. A failed
  // read is forgotten, so the next request tries again.
  function entityTag(file, info) {
    const known = etags.get(file);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.tag;
    const tag = (async () => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return `"${hash.digest('hex').slice(0, 32)}"`;
    })();
    etags.set(file, { size: info.size, mtimeMs: info.mtimeMs, tag });
    tag.catch(() => { if (etags.get(file)?.tag === tag) etags.delete(file); });
    return tag;
  }
  async function fetchAsset(request) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Invalid path', { status: 400 }); }
    const file = load().get(pathname);
    if (!file) return new Response('Not found', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let info;
    try { info = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
    const type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = pathname.startsWith('/Assets/') ? ASSET_CACHE : REVALIDATE;
    // HTML gets no validator: where src/index.js maps a clean URL (/about -> /about.html) or the
    // 404 page it accepts only a 200 from ASSETS, so a 304 would turn a revalidated page into the
    // 404 page. The Worker's pages reach browsers without an ETag today as well.
    let etag = null;
    if (!type.startsWith('text/html')) {
      try { etag = await entityTag(file, info); } catch { return new Response('Not found', { status: 404 }); }
    }
    if (etag && etagMatches(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cache } });
    }
    const headers = { 'Content-Type': type, 'Cache-Control': cache, ...(etag ? { ETag: etag } : {}) };
    const video = type === 'video/mp4';
    if (video) headers['Accept-Ranges'] = 'bytes';
    // Range is defined for GET only, and If-Range sends the whole file once it has changed.
    const ifRange = request.headers.get('if-range');
    const range = video && request.method === 'GET' && request.headers.has('range') && (!ifRange || ifRange.trim() === etag)
      ? byteRange(request.headers.get('range'), info.size) : null;
    if (range === UNSATISFIABLE) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': cache, ETag: etag } });
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      return new Response(fileBody(file, range), { status: 206, headers });
    }
    headers['Content-Length'] = String(info.size);
    return new Response(request.method === 'HEAD' ? null : fileBody(file), { headers });
  }
  return { fetch: fetchAsset, load };
}

const asset = assetServer(root).fetch;

// The release's commit for /health (C9): the deploy writes the short SHA to REVISION at the
// release root. GIT_COMMIT from the environment wins.
function releaseRevision(dir) {
  let value;
  try { value = fs.readFileSync(path.join(dir, 'REVISION'), 'utf8').trim(); } catch { return null; }
  if (/^[0-9a-f]{7,40}$/i.test(value)) return value;
  console.warn('REVISION ignored: it does not hold a commit SHA');
  return null;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const hostList = value => String(value || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);

// ASSETS_DIR resolved through links once, at start. On EC2 it names /opt/zerox/current, which the
// deploy points at the next release before it stops this instance: resolved, the draining instance
// keeps serving the release it started with (the allow-list it built, the REVISION it reported).
function releaseDirectory(dir) {
  try { return fs.realpathSync(dir); } catch { return dir; }
}

// Builds the bindings object shared by every request. process.env passes through unchanged
// (including DATABASE_DRIVER=pglite and its settings for the account store).
function runtimeEnv(host) {
  const assetsDir = releaseDirectory(path.resolve(process.env.ASSETS_DIR || root));
  const env = { ...process.env, ...(process.env.NEURON_API_ONLY === 'true' ? {} : { ASSETS: assetServer(assetsDir) }) };
  // Marks the Node runtime: the local dev identity is never honoured by the Worker build.
  env.NEURON_RUNTIME = 'node';
  // The Worker's proxy switch forwards to this server; given the switch here as well, the app
  // would forward EC2's own requests back to EC2.
  delete env.EC2_PROXY_PREFIXES;
  const commit = process.env.GIT_COMMIT || releaseRevision(assetsDir);
  if (commit) env.GIT_COMMIT = commit;
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
  } else if (env.DEV_AUTH_ENABLED === 'true' && (env.EC2_PROXY_SECRET || hostList(env.EXTRA_WEB_HOSTS).length)) {
    // A server the Worker forwards to, or one with a test host, is the public origin as well.
    console.warn('DEV_AUTH_ENABLED ignored: the dev identity is refused when EC2_PROXY_SECRET or EXTRA_WEB_HOSTS is set');
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

// The headers the app sees. x-neuron-client-ip is the server's own, and x-zerox-* only ever
// mean something from the Worker's proxy, which resolveOrigin has already checked: client copies
// of both are dropped on every request. A request the proxy forwarded carries the visitor's host,
// and the CF-* headers Cloudflare added for the proxy's own hop (its address, its country) go.
function requestHeaders(req, { trustCloudflare = false, address = clientAddress(req, trustCloudflare), host, proxied = false } = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'x-neuron-client-ip' || name.startsWith('x-zerox-') || value === undefined) continue;
    if (proxied && (name === 'cf-connecting-ip' || name === 'cf-ipcountry')) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (host) headers.set('host', host);
  // Trusted client address for per-IP limits; any client-supplied value was dropped above.
  if (address) headers.set('x-neuron-client-ip', address);
  return headers;
}

// ── Which host, for whom (C1-C3, C10) ──
// On EC2 the server is reached through Cloudflare Tunnel in two ways: from the Worker's proxy
// switch (C0) for the Worker's custom domains, which sends the visitor's host, scheme, address and
// location as x-zerox-* headers with the shared EC2_PROXY_SECRET, and directly on the tunnel's own
// hostnames (relay.zero-x.live, and aws.zero-x.live while it is a test host). Anyone can reach the
// tunnel hostnames, so x-zerox-* are believed only with the secret.
const WEB_HOSTS = ['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live', 'relay.zero-x.live'];
const RELAY_HOST = 'relay.zero-x.live';
// Answered without the secret on any host: the deploy's and the operator's health checks.
const OPEN_PATHS = ['/health', '/ready'];
// The request URL host for those health checks when the Host header is not one this server serves.
const UNNAMED_ORIGIN = 'https://origin.invalid';
// The relay host reaches this server without the Worker (and its EC2_PROXY_PREFIXES switch) in
// front, so it carries the relay only: the mobile app's WebSocket and the relay's own routes
// (tickets, hosts), plus the health checks. The site and the API are the Worker's hosts' alone.
const isRelayPath = pathname => pathname === '/v1/relay' || pathname.startsWith('/relay/');
// The secret is the only gate on the public tunnel host; anything shorter than this (openssl rand
// -hex 32 gives 64 characters) is refused at start.
const MIN_SECRET_LENGTH = 32;
// EXTRA_WEB_HOSTS as src/web-hosts.js reads it (check-ec2-e2e.mjs compares the two): plain
// hostnames only, and never a production host. Listed by mistake, a production host keeps its own
// routing in the app, so here it must not become a host served without the secret either.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const extraHostList = value => hostList(value).filter(host => HOSTNAME.test(host) && !WEB_HOSTS.includes(host));

// The posture, read once at start. Development (none of these set): every request URL stays
// http://127.0.0.1 as before, so src/ treats it as local. The EC2 origin (the proxy secret, a test
// host, the tunnel or NODE_ENV=production): the rules in resolveOrigin, which answer only the
// Worker's proxy, the test hosts, the relay on the relay host and the health checks.
function originSettings(source = process.env) {
  const extraHosts = extraHostList(source.EXTRA_WEB_HOSTS);
  const secret = String(source.EC2_PROXY_SECRET || '');
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`EC2_PROXY_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -hex 32); the server did not start`);
  }
  const trustCloudflare = source.TRUST_CLOUDFLARE === 'true';
  return {
    origin: !!secret || extraHosts.length > 0 || trustCloudflare || String(source.NODE_ENV || '').trim().toLowerCase() === 'production',
    secret, extraHosts, knownHosts: new Set([...WEB_HOSTS, ...extraHosts]),
    trustCloudflare, trustCountry: source.TRUST_CF_IPCOUNTRY === 'true',
    // Whether a forward with the wrong secret has been logged yet (once per server).
    mismatchLogged: false,
  };
}

// Both values are hashed first, so the comparison takes the same time whatever the length or the
// matching prefix of what a client sent.
function secretMatches(presented, secret) {
  if (!presented || !secret) return false;
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(presented), digest(secret));
}

const countryCode = value => {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(code) ? code : null;
};

// The request.cf the Worker saw ({country, city, region, asn, asOrganization}), from the proxy's
// headers: the geo rules read the country, the device sign-in shows the approver the rest. The free
// text arrives percent-encoded (a header value cannot carry every character of every place name).
const PROXY_TEXT = [['x-zerox-city', 'city'], ['x-zerox-region', 'region'], ['x-zerox-as-org', 'asOrganization']];
function proxyGeo(header) {
  const cf = {};
  const country = countryCode(header('x-zerox-country'));
  if (country) cf.country = country;
  for (const [name, key] of PROXY_TEXT) {
    let text = String(header(name) || '');
    try { text = decodeURIComponent(text); } catch { /* sent as it is */ }
    if (text.trim()) cf[key] = text.trim().slice(0, 128);
  }
  const asn = String(header('x-zerox-asn') || '').trim();
  if (/^\d{1,10}$/.test(asn)) cf.asn = Number(asn);
  return cf;
}

// One request on the main listener: { base, host, address, cf, proxied } for the app (base is the
// scheme and host its request URL is built on), or { status, code, message } when it is refused.
function resolveOrigin(req, settings) {
  const header = name => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (!settings.origin) return { base: 'http://127.0.0.1', address: clientAddress(req, settings.trustCloudflare) };
  const presented = header('x-zerox-proxy-secret');
  if (presented !== undefined) {
    if (secretMatches(presented, settings.secret)) {
      const host = String(header('x-zerox-host') || '').trim().toLowerCase();
      const proto = String(header('x-zerox-proto') || '').trim().toLowerCase();
      if (!settings.knownHosts.has(host)) return { status: 421, code: 'misdirected_request', message: 'This server does not serve that host.' };
      if (proto !== 'https' && proto !== 'http') return { status: 400, code: 'invalid_request', message: 'Invalid forwarded scheme.' };
      const visitor = String(header('x-zerox-client-ip') || '').trim();
      return { base: `${proto}://${host}`, host, proxied: true, cf: proxyGeo(header),
        address: net.isIP(visitor) ? visitor : req.socket.remoteAddress };
    }
    // The Worker sends the header with every forward, so a value that does not match is a Worker and
    // a server holding different secrets (one side rotated, or EC2_PROXY_SECRET missing here). Its
    // forwards arrive on the tunnel's own host, which may be a test host: served as that host they
    // would redirect visitors to it, lose the dashboard and neuron hosts and take the hop's country,
    // all without an error. A refusal on every host and path makes the mismatch visible instead.
    if (!settings.mismatchLogged) {
      settings.mismatchLogged = true;
      console.error('Refused a request the Worker forwarded: its x-zerox-proxy-secret does not match EC2_PROXY_SECRET' +
        (settings.secret ? '' : ' (EC2_PROXY_SECRET is not set here)') +
        '. Every forward gets 403 proxy_secret_mismatch until the Worker and this server hold the same secret (logged once).');
    }
    return { status: 403, code: 'proxy_secret_mismatch', message: 'The forwarded request was refused: its proxy secret does not match this server\'s.' };
  }
  const host = String(header('host') || '').trim().toLowerCase();
  const pathname = req.url.split('?')[0];
  const country = settings.trustCountry ? countryCode(header('cf-ipcountry')) : null;
  const direct = { address: clientAddress(req, settings.trustCloudflare), cf: country ? { country } : {} };
  const healthCheck = ['GET', 'HEAD'].includes(req.method) && OPEN_PATHS.includes(pathname);
  if (settings.extraHosts.includes(host)) return { ...direct, base: `https://${host}`, host };
  if (host === RELAY_HOST) {
    return isRelayPath(pathname) || healthCheck ? { ...direct, base: `https://${host}`, host }
      : { status: 404, code: 'not_found', message: 'relay.zero-x.live serves the relay only.' };
  }
  if (healthCheck) return { ...direct, base: UNNAMED_ORIGIN };
  return { status: 403, code: 'forbidden', message: 'This server only answers requests forwarded by https://zero-x.live.' };
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
const COMPANIONS = Symbol('companions');

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

const sendJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

// One HTTP listener in front of the app. The readiness listener (readyOnly) answers GET /ready
// and GET /health only, on loopback, so a deploy can ask one instance whether it is ready while
// both share the public port.
function gatewayServer(app, env, { settings, heartbeatMs, readyOnly = false }) {
  const inFlight = new Set();
  const server = http.createServer(async (req, res) => {
    // A request that reaches a draining server (on a kept-alive connection) is turned away, so
    // the drain only waits for work that started before the stop.
    if (server[DRAINING]) {
      sendJson(res, 503, { error: 'Gateway restarting' }, { 'Retry-After': '5', Connection: 'close' });
      return;
    }
    if (!canonicalPath(req.url)) {
      sendJson(res, 400, { error: 'Invalid request path' }, { Connection: 'close' });
      return;
    }
    let origin;
    if (!readyOnly) origin = resolveOrigin(req, settings);
    else if (['GET', 'HEAD'].includes(req.method) && OPEN_PATHS.includes(req.url.split('?')[0])) {
      origin = { base: 'http://127.0.0.1', address: req.socket.remoteAddress };
    } else {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (origin.status) {
      sendJson(res, origin.status, { error: { message: origin.message, type: origin.status === 403 ? 'permission_error' : 'invalid_request_error',
        code: origin.code, param: null } }, { 'Cache-Control': 'no-store', Connection: 'close' });
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
          sendJson(res, 413, { error: 'Request body too large' });
          return;
        }
        chunks.push(chunk);
      }
      const request = new Request(new URL(req.url, origin.base), {
        method: req.method, headers: requestHeaders(req, { address: origin.address, host: origin.host, proxied: origin.proxied }),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        signal: controller.signal,
      });
      // On Workers the app reads the visitor's location from request.cf; it gets the same here.
      if (origin.cf) request.cf = origin.cf;
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
      if (!res.headersSent) sendJson(res, 500, { error: 'Gateway request failed' });
      else res.destroy();
    }
  });
  server[IN_FLIGHT] = inFlight;
  return server;
}

// listen()'s reusePort arrived in Node 23.1 and 22.12; an older Node ignores it without a word, and
// the next release's instance then fails to bind the shared port in the middle of a deploy.
function supportsReusePort(version = process.version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 23 || (major === 23 && minor >= 1) || (major === 22 && minor >= 12);
}

async function start() {
  // The posture first: a setting that stops the server (a short EC2_PROXY_SECRET) stops it before
  // the app loads anything.
  const settings = originSettings();
  const reusePort = process.env.AUTH_REUSE_PORT === 'true';
  if (reusePort && !supportsReusePort()) {
    throw new Error(`AUTH_REUSE_PORT=true needs Node 22.12 or later (this is ${process.version}); the server did not start`);
  }
  const { default: app } = await import('./src/index.js');
  const port = Number(process.env.AUTH_PORT || 8787);
  const host = process.env.AUTH_HOST || '127.0.0.1';
  const env = runtimeEnv(host);
  env.ASSETS?.load();
  if (settings.origin && !settings.secret) {
    const direct = settings.extraHosts.length ? `${settings.extraHosts.join(', ')} (directly), ` : '';
    console.warn('EC2_PROXY_SECRET is not set: every request the Worker forwards (it carries x-zerox-proxy-secret) is refused with ' +
      `403 proxy_secret_mismatch; this server answers only ${direct}the relay on relay.zero-x.live and GET /health and /ready`);
  }
  const heartbeatMs = positiveMs(process.env.SSE_HEARTBEAT_MS, 30000);
  const server = gatewayServer(app, env, { settings, heartbeatMs });
  // Zero-downtime restarts (C6): the next release's instance binds the same port before the old
  // one drains (SO_REUSEPORT: Linux, Node 22.12+), and the kernel spreads new connections over both.
  // Logs the bound port, so AUTH_PORT=0 (any free port) can be discovered from stdout.
  server.listen({ port, host, ...(reusePort ? { reusePort } : {}) },
    () => console.log(`Neuron gateway listening on ${host}:${server.address().port}${reusePort ? ' (shared port)' : ''}`));
  if (process.env.READY_PORT) {
    const ready = gatewayServer(app, env, { settings, heartbeatMs, readyOnly: true });
    ready.listen(Number(process.env.READY_PORT), '127.0.0.1',
      () => console.log(`Neuron gateway readiness checks on 127.0.0.1:${ready.address().port}`));
    server[COMPANIONS] = [ready];
    server.on('close', () => ready.listening && ready.close());
  }
  return server;
}

// Graceful stop: the listeners close at once and idle keep-alive connections are dropped, while
// requests in flight (token streams, whose settlement runs before their last byte) get up to
// graceMs to finish. Whatever still runs then is cut, which settles it as a client cancel.
// Resolves true when every request finished in time.
//
// A response that has not started yet (its upstream has not answered) is sent with Connection:
// close. cloudflared pools keep-alive connections and reuses the one it used last: told nothing,
// it may send its next request on a connection this instance is about to close, which would get
// the draining 503, or a reset that it does not retry for a POST, while the next release's
// instance could have served it. A response already streaming has sent its headers; its
// connection is closed as soon as it ends (gatewayServer).
function drain(server, graceMs) {
  const servers = [server, ...(server[COMPANIONS] || [])];
  for (const each of servers) {
    each[DRAINING] = true;
    for (const res of each[IN_FLIGHT] || []) if (!res.headersSent) res.setHeader('Connection', 'close');
  }
  return new Promise(resolve => {
    let open = servers.length;
    const timer = setTimeout(() => {
      for (const each of servers) each.closeAllConnections();
      resolve(false);
    }, graceMs);
    for (const each of servers) {
      each.close(() => {
        if (--open > 0) return;
        clearTimeout(timer);
        resolve(true);
      });
      each.closeIdleConnections();
    }
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
module.exports = {
  start, asset, assetServer, ignoreRule, runtimeEnv, requestHeaders, resolveOrigin, originSettings, releaseRevision, drain, stopOnSignals,
  supportsReusePort,
};
