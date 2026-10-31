// The Node server as the EC2 origin behind the Worker's proxy switch (C1-C3, C10): x-zerox-* are
// believed only with EC2_PROXY_SECRET (compared in constant time), then the app sees the visitor's
// host and scheme (www -> apex, http -> https, HSTS, the dashboard and neuron hosts), address
// (per-IP limits) and location (request.cf, which the geo rules read). A forward whose secret does
// not match (rotated on one side, or EC2_PROXY_SECRET missing here) is refused, never served as the
// test host it arrives on. Without the secret header only the test hosts (EXTRA_WEB_HOSTS, under the
// TRUST_CLOUDFLARE / TRUST_CF_IPCOUNTRY rules), the relay paths on the relay host and the health
// checks are answered; client copies of x-zerox-* never reach the app. A development server (none
// of the settings) keeps the loopback URL it always had.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { originSettings, requestHeaders, resolveOrigin, runtimeEnv, start } = require('./server.js');

// server.js loads a developer .env: nothing here may reach a real database or provider.
for (const name of Object.keys(process.env)) {
  if (/^(SUPABASE_|DATABASE_|PGLITE_|DEV_AUTH)|_API_KEY$|_HOSTED$|_MODELS$|^(TRUST_CLOUDFLARE|TRUST_CF_IPCOUNTRY|NODE_ENV|NEURON_API_ONLY|EC2_PROXY_SECRET|EC2_PROXY_PREFIXES|EXTRA_WEB_HOSTS|ASSETS_DIR|READY_PORT|AUTH_REUSE_PORT|GIT_COMMIT|ALLOW_UNKNOWN_COUNTRY|SSE_HEARTBEAT_MS|SHUTDOWN_GRACE_MS)$/.test(name)) {
    delete process.env[name];
  }
}

const SECRET = 'proxy-secret-for-the-origin-check-0123456789';
const WEB_HOSTS = ['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live', 'relay.zero-x.live'];
const fakeRequest = (headers, { method = 'GET', url = '/v1/models', peer = '127.0.0.1' } = {}) =>
  ({ headers, method, url, socket: { remoteAddress: peer } });
const proxied = (host, extra = {}) => ({ 'x-zerox-proxy-secret': SECRET, 'x-zerox-host': host, 'x-zerox-proto': 'https', ...extra });

// A raw request, so the Host header is the test's own (fetch always sends the URL's).
const call = (port, { method = 'GET', path = '/v1/models', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end();
});

const geminiAvailable = async (port, headers) => {
  const response = await call(port, { headers });
  assert.equal(response.status, 200, response.text);
  return response.json().data.find(model => model.id === 'gemini/gemini-3.5-flash').available;
};

// Collects what console.error / console.warn print while fn runs (the once-only mismatch log, the
// start-up warning), so the check can read them and its own output stays clean.
async function capture(fn, logs = []) {
  const { error, warn } = console;
  console.error = (...args) => logs.push(['error', args.join(' ')]);
  console.warn = (...args) => logs.push(['warn', args.join(' ')]);
  try { return await fn(logs); } finally { Object.assign(console, { error, warn }); }
}

async function serverWith(settings, logs = []) {
  const saved = { ...process.env };
  Object.assign(process.env, settings);
  try {
    const server = await capture(() => start(), logs);
    if (!server.listening) await once(server, 'listening');
    return server;
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

(async () => {
  // ── The posture ──
  assert.equal(originSettings({}).origin, false, 'development: none of the settings');
  for (const source of [{ EC2_PROXY_SECRET: SECRET }, { EXTRA_WEB_HOSTS: 'aws.zero-x.live' }, { TRUST_CLOUDFLARE: 'true' },
    { NODE_ENV: ' Production ' }]) {
    assert.equal(originSettings(source).origin, true, JSON.stringify(source));
  }
  // The secret is the only gate on the public tunnel host: a short one stops the server at start.
  for (const weak of ['x', 'a'.repeat(31)]) {
    assert.throws(() => originSettings({ EC2_PROXY_SECRET: weak }), /EC2_PROXY_SECRET must be at least 32 characters/);
  }
  assert.equal(originSettings({ EC2_PROXY_SECRET: 'a'.repeat(32) }).secret.length, 32);
  assert.deepEqual(originSettings({ EXTRA_WEB_HOSTS: ' AWS.zero-x.live , ,qa.example.test' }).extraHosts, ['aws.zero-x.live', 'qa.example.test']);
  const production = originSettings({ EC2_PROXY_SECRET: SECRET, TRUST_CLOUDFLARE: 'true', TRUST_CF_IPCOUNTRY: 'true', NODE_ENV: 'production' });
  const testWindow = originSettings({ EC2_PROXY_SECRET: SECRET, EXTRA_WEB_HOSTS: 'aws.zero-x.live', TRUST_CLOUDFLARE: 'true', TRUST_CF_IPCOUNTRY: 'true' });

  // ── With the secret: host, scheme, address and location from the proxy ──
  const trusted = resolveOrigin(fakeRequest(proxied('Dashboard.Zero-X.live', { 'x-zerox-client-ip': ' 203.0.113.7 ', 'x-zerox-country': 'in',
    'x-zerox-city': 'S%C3%A3o%20Paulo', 'x-zerox-asn': '13335' })), production);
  assert.deepEqual(trusted, { base: 'https://dashboard.zero-x.live', host: 'dashboard.zero-x.live', proxied: true, address: '203.0.113.7',
    cf: { country: 'IN', city: 'São Paulo', asn: 13335 } });
  for (const host of WEB_HOSTS) assert.equal(resolveOrigin(fakeRequest(proxied(host)), production).host, host);
  assert.equal(resolveOrigin(fakeRequest(proxied('zero-x.live', { 'x-zerox-proto': 'http' })), production).base, 'http://zero-x.live');
  assert.deepEqual(resolveOrigin(fakeRequest(proxied('zero-x.live', { 'x-zerox-city': '%E0%A4%A', 'x-zerox-asn': 'AS13335',
    'x-zerox-country': 'India' })), production).cf, { city: '%E0%A4%A' }, 'malformed geo values are dropped or kept as sent');
  assert.equal(resolveOrigin(fakeRequest(proxied('zero-x.live', { 'x-zerox-client-ip': 'not-an-ip' })), production).address, '127.0.0.1',
    'an invalid forwarded address falls back to the socket');
  assert.equal(resolveOrigin(fakeRequest(proxied('evil.example')), production).status, 421, 'only hosts this server serves');
  assert.equal(resolveOrigin(fakeRequest(proxied('aws.zero-x.live')), production).status, 421, 'a test host only while it is listed');
  assert.equal(resolveOrigin(fakeRequest(proxied('aws.zero-x.live')), testWindow).host, 'aws.zero-x.live');
  for (const proto of ['ftp', '', 'https://']) {
    assert.equal(resolveOrigin(fakeRequest(proxied('zero-x.live', { 'x-zerox-proto': proto })), production).status, 400, proto);
  }

  // ── A wrong secret (empty, wrong, a prefix, the secret with more, twice): a forward from a Worker
  // that does not hold this server's secret is refused on every host and path, the test host and
  // the health checks included, so a mismatch is a visible 403 rather than visitors served as
  // aws.zero-x.live (redirects to the test host, no device page, the hop's country) ──
  const spoof = { 'x-zerox-host': 'zero-x.live', 'x-zerox-proto': 'https', 'x-zerox-client-ip': '203.0.113.9', 'x-zerox-country': 'US' };
  const mismatch = { status: 403, code: 'proxy_secret_mismatch',
    message: 'The forwarded request was refused: its proxy secret does not match this server\'s.' };
  const mismatchLogs = [];
  await capture(async () => {
    for (const presented of ['', 'wrong', SECRET.slice(0, -1), SECRET + 'x', SECRET.toUpperCase(), `${SECRET}, ${SECRET}`]) {
      const headers = { ...spoof, 'x-zerox-proxy-secret': presented };
      for (const [settings, host, url] of [[production, '127.0.0.1:8787', '/v1/models'], [production, '127.0.0.1:8787', '/health'],
        [production, 'relay.zero-x.live', '/relay/v1/host'], [testWindow, 'aws.zero-x.live', '/v1/models'], [testWindow, 'aws.zero-x.live', '/ready']]) {
        assert.deepEqual(resolveOrigin(fakeRequest({ ...headers, host }, { url }), settings), mismatch, `${host}${url}, ${JSON.stringify(presented)}`);
      }
    }
    // EC2 without EC2_PROXY_SECRET (missing from gateway.env) during the test window: the Worker's
    // forwards arrive on the test host, and are still refused.
    for (const settings of [originSettings({ TRUST_CLOUDFLARE: 'true' }), originSettings({ EXTRA_WEB_HOSTS: 'aws.zero-x.live', TRUST_CLOUDFLARE: 'true' })]) {
      for (const host of ['neuron.zero-x.live', 'dashboard.zero-x.live', 'zero-x.live']) {
        assert.deepEqual(resolveOrigin(fakeRequest({ ...proxied(host), host: 'aws.zero-x.live' }, { url: '/device' }), settings), mismatch,
          `no EC2_PROXY_SECRET here: ${host} forwarded to the test host`);
      }
    }
  }, mismatchLogs);
  // Logged once per server (journald shows it), never with the value presented.
  assert.deepEqual(mismatchLogs.map(([level]) => level), ['error', 'error', 'error', 'error'], 'one line for each of the four servers');
  for (const [, line] of mismatchLogs) {
    assert.match(line, /x-zerox-proxy-secret does not match EC2_PROXY_SECRET.*403 proxy_secret_mismatch/);
    assert.ok(!line.includes(SECRET), 'the presented value is never logged');
  }
  assert.match(mismatchLogs[2][1], /EC2_PROXY_SECRET is not set here/);

  // ── No secret header: a request straight to the test host, served under the tunnel rules (the
  // spoofed x-zerox-* mean nothing); anywhere else in production a 403 ──
  assert.equal(resolveOrigin(fakeRequest({ ...spoof, host: '127.0.0.1:8787' }), production).code, 'forbidden');
  const direct = resolveOrigin(fakeRequest({ ...spoof, host: 'aws.zero-x.live', 'cf-connecting-ip': '198.51.100.4', 'cf-ipcountry': 'DE' }), testWindow);
  assert.deepEqual(direct, { base: 'https://aws.zero-x.live', host: 'aws.zero-x.live', address: '198.51.100.4', cf: { country: 'DE' } },
    'test host: CF-Connecting-IP and CF-IPCountry under the tunnel rules');
  assert.equal(resolveOrigin(fakeRequest({ host: 'aws.zero-x.live', 'cf-connecting-ip': '198.51.100.4', 'cf-ipcountry': 'DE' }),
    originSettings({ EXTRA_WEB_HOSTS: 'aws.zero-x.live' })).address, '127.0.0.1', 'CF-Connecting-IP only with TRUST_CLOUDFLARE');
  assert.deepEqual(resolveOrigin(fakeRequest({ host: 'aws.zero-x.live', 'cf-ipcountry': 'DE' }),
    originSettings({ EXTRA_WEB_HOSTS: 'aws.zero-x.live' })).cf, {}, 'CF-IPCountry only with TRUST_CF_IPCOUNTRY');
  assert.equal(resolveOrigin(fakeRequest({ host: 'aws.zero-x.live', 'cf-connecting-ip': '198.51.100.4' }, { peer: '198.51.100.20' }), testWindow).address,
    '198.51.100.20', 'a peer that is not loopback cannot choose its address');

  // Production (no test host): only the health checks and the relay host without the secret.
  for (const [method, url, expected] of [['GET', '/health', undefined], ['HEAD', '/health', undefined], ['GET', '/ready', undefined],
    ['GET', '/health?full=1', undefined], ['POST', '/health', 403], ['GET', '/neuroncli/auth-server/health', 403], ['GET', '/v1/models', 403],
    ['GET', '/', 403]]) {
    assert.equal(resolveOrigin(fakeRequest({ host: '127.0.0.1:8787' }, { method, url }), production).status, expected, `${method} ${url}`);
  }
  // The relay host straight through the tunnel (no Worker in front): the relay and the health
  // checks only, not a second copy of the site and the API.
  for (const [method, url, expected] of [['GET', '/v1/relay', undefined], ['GET', '/v1/relay?room=1', undefined], ['GET', '/relay/v1/host', undefined],
    ['POST', '/relay/v1/ticket', undefined], ['GET', '/relay/v1/hosts', undefined], ['GET', '/health', undefined], ['HEAD', '/ready', undefined],
    ['GET', '/', 404], ['GET', '/index.html', 404], ['GET', '/robots.txt', 404], ['POST', '/v1/chat/completions', 404], ['GET', '/v1/models', 404],
    ['GET', '/v1/relayed', 404], ['GET', '/v1/relay/', 404], ['GET', '/relay', 404], ['GET', '/admin/overview', 404], ['GET', '/api/account', 404],
    ['POST', '/health', 404]]) {
    const relay = resolveOrigin(fakeRequest({ host: 'relay.zero-x.live' }, { method, url }), production);
    assert.equal(relay.status, expected, `relay ${method} ${url}`);
    if (expected) assert.equal(relay.code, 'not_found');
    else assert.equal(relay.base, 'https://relay.zero-x.live');
  }
  assert.equal(resolveOrigin(fakeRequest({ host: 'other.zero-x.live' }), testWindow).status, 403, 'a host that is not listed');
  assert.equal(resolveOrigin(fakeRequest({ host: 'zero-x.live' }), testWindow).status, 403, 'a Worker host without the secret');

  // Development: the loopback URL as before, and the socket or CF-Connecting-IP rules.
  assert.deepEqual(resolveOrigin(fakeRequest({ ...spoof, host: 'zero-x.live' }), originSettings({})), { base: 'http://127.0.0.1', address: '127.0.0.1' });

  // ── The headers the app sees ──
  const headers = requestHeaders(fakeRequest({ host: '127.0.0.1:8787', 'x-zerox-proxy-secret': SECRET, 'x-zerox-host': 'zero-x.live',
    'x-zerox-anything': 'x', 'x-neuron-client-ip': '192.0.2.1', 'cf-connecting-ip': '2a06:98c0:3600::103', 'cf-ipcountry': 'XX',
    'cf-ray': 'abc', accept: 'text/html' }), { address: '203.0.113.7', host: 'zero-x.live', proxied: true });
  assert.deepEqual([...headers.keys()].sort(), ['accept', 'cf-ray', 'host', 'x-neuron-client-ip']);
  assert.equal(headers.get('host'), 'zero-x.live');
  assert.equal(headers.get('x-neuron-client-ip'), '203.0.113.7');
  const plainHeaders = requestHeaders(fakeRequest({ host: 'aws.zero-x.live', 'x-zerox-host': 'zero-x.live', 'cf-ipcountry': 'DE' }), { address: '198.51.100.4' });
  assert.deepEqual([...plainHeaders.keys()].sort(), ['cf-ipcountry', 'host', 'x-neuron-client-ip'], 'x-zerox-* are dropped on every request');

  // ── The environment ──
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { DEV_AUTH_ENABLED: 'true', EC2_PROXY_PREFIXES: 'zero-x.live/v1/', EXTRA_WEB_HOSTS: 'aws.zero-x.live' });
    const env = runtimeEnv('127.0.0.1');
    assert.equal(env.DEV_AUTH_ENABLED, undefined, 'a test host makes this the public origin: no dev identity');
    assert.equal(env.EXTRA_WEB_HOSTS, 'aws.zero-x.live', 'the app gets the test hosts (identity CORS, device page origin)');
    assert.equal(env.EC2_PROXY_PREFIXES, undefined, 'the proxy switch never forwards from EC2 to itself');
    delete process.env.EXTRA_WEB_HOSTS;
    process.env.EC2_PROXY_SECRET = SECRET;
    assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, undefined, 'nor with the proxy secret');
    delete process.env.EC2_PROXY_SECRET;
    assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, 'true', 'development keeps it');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }

  // ── Through the server ──
  const common = { AUTH_PORT: '0', NEURON_API_ONLY: 'true', GEMINI_API_KEY: 'e2e-gemini-origin', TRUST_CLOUDFLARE: 'true', TRUST_CF_IPCOUNTRY: 'true' };
  const servers = [];
  try {
    // Production: the Worker's proxy only.
    const prod = await serverWith({ ...common, EC2_PROXY_SECRET: SECRET, NODE_ENV: 'production' });
    servers.push(prod);
    const port = prod.address().port;
    const refused = await call(port, { headers: spoof });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.json().error, { message: 'This server only answers requests forwarded by https://zero-x.live.',
      type: 'permission_error', code: 'forbidden', param: null });
    assert.equal(refused.headers['cache-control'], 'no-store');
    const wrong = await capture(() => call(port, { headers: { ...spoof, 'x-zerox-proxy-secret': 'wrong' } }));
    assert.equal(wrong.status, 403);
    assert.deepEqual(wrong.json().error, { message: mismatch.message, type: 'permission_error', code: 'proxy_secret_mismatch', param: null });
    assert.equal((await call(port, { path: '/health' })).status, 200);
    assert.equal((await call(port, { method: 'HEAD', path: '/health' })).status, 200);
    assert.notEqual((await call(port, { path: '/ready' })).status, 403, 'readiness answers (503 here: no session store)');
    assert.equal((await call(port, { method: 'POST', path: '/health' })).status, 403);
    // The relay host goes straight through the tunnel, for the relay only.
    const relayRoute = await call(port, { path: '/relay/v1/host', headers: { host: 'relay.zero-x.live' } });
    assert.notEqual(relayRoute.status, 403);
    assert.notEqual(relayRoute.json().error?.code, 'not_found', 'the app answers the relay route');
    for (const pathname of ['/v1/models', '/index.html', '/robots.txt']) {
      const other = await call(port, { path: pathname, headers: { host: 'relay.zero-x.live' } });
      assert.equal(other.status, 404, `relay host ${pathname}`);
      assert.equal(other.json().error.code, 'not_found');
    }

    // The visitor's host and scheme reach the app.
    const ok = await call(port, { headers: proxied('zero-x.live') });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['strict-transport-security'], /max-age=31536000/, 'https: HSTS');
    const www = await call(port, { path: '/pricing?ref=1', headers: proxied('www.zero-x.live') });
    assert.equal(www.status, 301);
    assert.equal(www.headers.location, 'https://zero-x.live/pricing?ref=1', 'www -> apex');
    const plain = await call(port, { path: '/pricing', headers: proxied('zero-x.live', { 'x-zerox-proto': 'http' }) });
    assert.equal(plain.status, 308);
    assert.equal(plain.headers.location, 'https://zero-x.live/pricing', 'http -> https');
    const robots = await call(port, { path: '/robots.txt', headers: proxied('dashboard.zero-x.live') });
    assert.equal(robots.text, 'User-agent: *\nDisallow: /\n', 'the dashboard host');
    const neuron = await call(port, { path: '/', headers: proxied('neuron.zero-x.live') });
    assert.equal(neuron.headers.location, 'https://zero-x.live/neuron-cli', 'the neuron host');
    assert.equal((await call(port, { headers: proxied('evil.example') })).status, 421);
    const preflight = await call(port, { method: 'OPTIONS', path: '/auth/cli/session', headers: proxied('zero-x.live',
      { origin: 'https://zero-x.live', 'access-control-request-method': 'POST' }) });
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://zero-x.live', 'Origin reaches the identity CORS policy');

    // The visitor's address: one bucket per forwarded address (10 OAuth starts per window).
    const oauthStart = extra => call(port, { path: '/auth/openrouter/start', headers: proxied('zero-x.live', extra) }).then(response => response.status);
    for (let i = 1; i <= 10; i++) assert.notEqual(await oauthStart({ 'x-zerox-client-ip': '203.0.113.7' }), 429, `start ${i}`);
    assert.equal(await oauthStart({ 'x-zerox-client-ip': '203.0.113.7' }), 429, 'one visitor is limited');
    assert.notEqual(await oauthStart({ 'x-zerox-client-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.7' }), 429,
      'another visitor has its own bucket (the hop\'s CF-Connecting-IP is not the visitor)');

    // The visitor's location: request.cf.country drives the geo rules (free Gemini is closed to the EEA).
    assert.equal(await geminiAvailable(port, proxied('zero-x.live', { 'x-zerox-country': 'US' })), true);
    assert.equal(await geminiAvailable(port, proxied('zero-x.live', { 'x-zerox-country': 'DE' })), false);
    assert.equal(await geminiAvailable(port, proxied('zero-x.live', { 'cf-ipcountry': 'US' })), false,
      'without x-zerox-country the hop\'s CF-IPCountry is not the visitor\'s: unknown country, closed');

    // The test window: aws.zero-x.live straight through the tunnel, as Cloudflare describes it.
    const qaLogs = [];
    const qa = await serverWith({ ...common, EC2_PROXY_SECRET: SECRET, EXTRA_WEB_HOSTS: 'aws.zero-x.live' }, qaLogs);
    servers.push(qa);
    assert.deepEqual(qaLogs, [], 'nothing to warn about');
    const qaPort = qa.address().port;
    const index = await call(qaPort, { path: '/index.html', headers: { host: 'aws.zero-x.live' } });
    assert.equal(index.status, 301);
    // The app sees https://aws.zero-x.live: a test host serves the whole site on its own origin, so
    // its redirects stay relative (src/index.js), and the scheme is https (HSTS).
    assert.equal(index.headers.location, '/', 'the test host is the app\'s host');
    assert.match(index.headers['strict-transport-security'], /max-age=31536000/, 'over https');
    assert.equal(await geminiAvailable(qaPort, { host: 'aws.zero-x.live', 'cf-ipcountry': 'US' }), true);
    assert.equal(await geminiAvailable(qaPort, { host: 'aws.zero-x.live', 'cf-ipcountry': 'DE', 'x-zerox-country': 'US' }), false,
      'a spoofed x-zerox-country is ignored');
    // A forward with a secret the server does not share is refused rather than served as the test host.
    const rotated = await capture(() => call(qaPort, { path: '/index.html', headers: { ...proxied('zero-x.live'), host: 'aws.zero-x.live',
      'x-zerox-proxy-secret': 'rotated-on-the-worker-only-0123456789' } }));
    assert.equal(rotated.status, 403);
    assert.equal(rotated.json().error.code, 'proxy_secret_mismatch');

    // The test window with EC2_PROXY_SECRET missing from gateway.env: the start-up warning says what
    // happens, and the Worker's forwards are refused, not served as aws.zero-x.live (no redirect to
    // the test host, no 404 for the device page).
    const unsetLogs = [];
    const unset = await serverWith({ ...common, EXTRA_WEB_HOSTS: 'aws.zero-x.live' }, unsetLogs);
    servers.push(unset);
    assert.equal(unsetLogs.length, 1);
    assert.equal(unsetLogs[0][0], 'warn');
    assert.match(unsetLogs[0][1], /EC2_PROXY_SECRET is not set: every request the Worker forwards .* is refused with 403 proxy_secret_mismatch; this server answers only aws\.zero-x\.live \(directly\), the relay on relay\.zero-x\.live and GET \/health and \/ready/);
    const unsetPort = unset.address().port;
    const forwarded = [];
    await capture(async () => {
      for (const [host, pathname] of [['zero-x.live', '/index.html'], ['neuron.zero-x.live', '/device'], ['dashboard.zero-x.live', '/']]) {
        forwarded.push(await call(unsetPort, { path: pathname, headers: { ...proxied(host), host: 'aws.zero-x.live' } }));
      }
    }, unsetLogs);
    assert.deepEqual(forwarded.map(response => [response.status, response.json().error.code]), Array(3).fill([403, 'proxy_secret_mismatch']));
    assert.equal(unsetLogs.filter(([level]) => level === 'error').length, 1, 'logged once');
    assert.equal((await call(unsetPort, { path: '/index.html', headers: { host: 'aws.zero-x.live' } })).status, 301, 'the test host itself is served');
    // Production with the secret missing: the warning lists what is still answered.
    const bareLogs = [];
    servers.push(await serverWith({ ...common, NODE_ENV: 'production' }, bareLogs));
    assert.match(bareLogs[0][1], /refused with 403 proxy_secret_mismatch; this server answers only the relay on relay\.zero-x\.live and GET \/health and \/ready/);
    assert.equal((await call(qaPort, { headers: { host: 'qa.other.test' } })).status, 403);
    assert.equal((await call(qaPort, { headers: proxied('aws.zero-x.live') })).status, 200, 'the proxy may forward to a test host');
    const qaStart = extra => call(qaPort, { path: '/auth/openrouter/start', headers: { host: 'aws.zero-x.live', ...extra } }).then(response => response.status);
    for (let i = 1; i <= 10; i++) assert.notEqual(await qaStart({ 'cf-connecting-ip': '192.0.2.44', 'x-zerox-client-ip': `192.0.2.${100 + i}` }), 429);
    assert.equal(await qaStart({ 'cf-connecting-ip': '192.0.2.44', 'x-zerox-client-ip': '192.0.2.200' }), 429,
      'without the secret CF-Connecting-IP is the address, x-zerox-client-ip is ignored');

    // Development: x-zerox-* sent to a local server change nothing.
    const dev = await serverWith({ AUTH_PORT: '0', NEURON_API_ONLY: 'true', GEMINI_API_KEY: 'e2e-gemini-origin' });
    servers.push(dev);
    const devIndex = await call(dev.address().port, { path: '/index.html', headers: proxied('zero-x.live', { host: 'zero-x.live' }) });
    assert.equal(devIndex.headers.location, '/', 'the loopback URL: a relative redirect');
    assert.equal(await geminiAvailable(dev.address().port, proxied('zero-x.live', { 'x-zerox-country': 'US' })), false,
      'no request.cf from client headers on a development server');
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
  }
  console.log('PASS: Node origin trusts x-zerox-* only with EC2_PROXY_SECRET (host, scheme, address, request.cf; 32+ characters), refuses a forward with a wrong secret on every host (logged once), refuses unproxied requests in production except /health, /ready and the relay paths of the relay host, serves EXTRA_WEB_HOSTS under the tunnel rules, strips x-zerox-*');
})().catch(error => { console.error(error); process.exitCode = 1; });
