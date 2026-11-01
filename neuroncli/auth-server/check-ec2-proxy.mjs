// Worker -> EC2 proxy switch (C0, src/ec2-proxy.js), offline: the Worker entry (src/index.js)
// with a fake fetch standing in for the Node server on EC2. Prefix matching (host + path, hosts
// without a path, whitespace, entries that cannot match refused as invalid), unset = the Worker as
// before (the only way back), every chat alias Hono serves forwarded once chat is routed, client
// x-zerox-* headers dropped and the trusted ones set from request.cf, CF-Connecting-IP and cf-ray,
// fail closed (a missing or bad secret, a bad origin, a loop, a split session store, an invalid
// entry or a throw answers the JSON 503 with Retry-After and never runs the Worker app), method,
// body, query, signal and streams passed through, origin-down pages replaced, redirects not
// followed, WebSocket upgrades passed through, which runtime answered (x-zerox-runtime), and the
// CPU shape of a forward: the body is never read and the upstream Response is returned as is.
//   node check-ec2-proxy.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import app from './src/index.js';
import {
  WORKER_HOSTS, chatRoutedToEc2, forwardToEc2, parseProxyPrefixes, proxyStatus, resetEc2ProxyState, routeKey,
} from './src/ec2-proxy.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const SECRET = 'proxy-secret-0123456789abcdef0123456789';
const RAY = '8f00aa11bb22cc33-BOM';
const PROXY = { EC2_PROXY_PREFIXES: 'zero-x.live/v1/,dashboard.zero-x.live/', EC2_PROXY_SECRET: SECRET };
const ASSETS = { fetch: request => new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/plain' } }) };
const base = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ASSETS };
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// The Node server on EC2: records what reached it and answers with `answer` (a fresh Response by
// default, marked as EC2's the way the app marks it there).
const realFetch = globalThis.fetch;
let forwarded = [];
let answer = null;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  forwarded.push(request);
  return answer ? answer(request) : new Response('from ec2', { status: 200, headers: { 'X-Served-By': 'ec2', 'X-Zerox-Runtime': 'node' } });
};
const reset = () => { forwarded = []; answer = null; };

// A Workers request: Node's Request has no `cf`, so it is attached the way the runtime exposes it.
function workerRequest(url, init = {}, cf = undefined) {
  const request = new Request(url, init);
  if (cf !== undefined) Object.defineProperty(request, 'cf', { value: cf });
  return request;
}
const dump = async response => ({ status: response.status, headers: [...response.headers].sort(), body: await response.text() });

// The Worker app reads its env (CSP_ENFORCE in the first middleware, the chat handler's keys);
// the switch reads only its own. An env that records every other key it is asked for shows
// whether Hono ran at all.
const SWITCH_KEYS = new Set(['EC2_PROXY_PREFIXES', 'EC2_PROXY_SECRET', 'EC2_PROXY_ORIGIN', 'NEURON_RUNTIME', 'SESSIONS_KV']);
function watched(env) {
  const touched = new Set();
  return {
    touched,
    env: new Proxy(env, { get(target, key) { if (typeof key === 'string' && !SWITCH_KEYS.has(key)) touched.add(key); return target[key]; } }),
  };
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };

// A refusal: the gateway's JSON 503 with Retry-After 30, a request id in the body, x-request-id
// and one log line with the reason and the ray, marked as the Worker's, nothing forwarded, and
// the Worker app never ran (no env read, no middleware header, no chat handler 401).
async function assertRefused(response, touched, reason, why) {
  assert.equal(response.status, 503, why);
  assert.equal(response.headers.get('content-type'), 'application/json', why);
  assert.equal(response.headers.get('retry-after'), '30', why);
  assert.equal(response.headers.get('cache-control'), 'no-store', why);
  assert.equal(response.headers.get('x-zerox-runtime'), 'worker', why);
  assert.equal(response.headers.get('x-content-type-options'), null, `${why}: no Hono middleware ran`);
  const body = await response.json();
  assert.equal(body.error.code, 'service_unavailable', why);
  assert.equal(body.error.retry_after_seconds, 30, why);
  assert.match(body.error.request_id, /^req_[0-9a-f]{32}$/, why);
  assert.equal(response.headers.get('x-request-id'), body.error.request_id, why);
  assert.equal(forwarded.length, 0, `${why}: nothing forwarded`);
  if (touched) assert.deepEqual([...touched], [], `${why}: the Worker app never read its env`);
  const line = warnings.find(each => each.startsWith('EC2 proxy refused') && each.includes(body.error.request_id));
  assert.ok(line, `${why}: one refusal line with the request id the client got`);
  assert.ok(line.includes(`"reason":"${reason}"`), `${why}: ${line}`);
  return { body, line };
}

try {
  // ── Prefixes: host + path as written, a bare host covers the whole host, whitespace and blanks ignored ──
  {
    for (const value of ['', undefined, ' , ,']) assert.deepEqual(parseProxyPrefixes(value), { prefixes: [], invalid: [], positions: [] });
    assert.deepEqual(parseProxyPrefixes(' zero-x.live/v1/ , ,Dashboard.Zero-X.live,  zero-x.live/Assets/ ').prefixes,
      ['zero-x.live/v1/', 'dashboard.zero-x.live/', 'zero-x.live/Assets/']);
    // An entry written as a URL means its host + path: the scheme is not part of the match.
    assert.deepEqual(parseProxyPrefixes('https://zero-x.live/v1/, HTTP://Dashboard.zero-x.live'),
      { prefixes: ['zero-x.live/v1/', 'dashboard.zero-x.live/'], invalid: [], positions: [1, 2] });
    // Every value the runbook sets parses whole.
    const cutover = read('../../deploy/aws/CUTOVER.md');
    const documented = [...cutover.matchAll(/printf '%s' '([^']+)' \| npx wrangler@[\d.]+ secret put EC2_PROXY_PREFIXES/g)].map(match => match[1])
      .concat([...cutover.matchAll(/^\s+\d\. `([^`]+)`:/gm)].map(match => match[1]));
    assert.ok(documented.length >= 5);
    for (const value of documented) assert.deepEqual(parseProxyPrefixes(value).invalid, [], `CUTOVER.md: ${value}`);
    reset();
    await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'https://zero-x.live/v1/' });
    assert.equal(forwarded.length, 1, 'a prefix written as a URL forwards its path');
    const env = { ...base, ...PROXY, EC2_PROXY_PREFIXES: ' zero-x.live/v1/ , , Dashboard.Zero-X.live ,neuron.zero-x.live/device' };
    const cases = [
      ['https://zero-x.live/v1/models', true], ['https://zero-x.live/v1/chat/completions?stream=1', true],
      ['https://zero-x.live/v1', false, 'the trailing slash is part of the prefix'], ['https://zero-x.live/v1models', false],
      ['https://zero-x.live/about', false], ['https://zero-x.live/', false], ['https://www.zero-x.live/v1/models', false, 'another host'],
      ['https://dashboard.zero-x.live/', true], ['https://dashboard.zero-x.live/api/account', true],
      ['https://neuron.zero-x.live/device', true], ['https://neuron.zero-x.live/device/', true],
      ['https://neuron.zero-x.live/devices', true, 'a prefix without a trailing slash matches longer paths too'],
      ['https://neuron.zero-x.live/', false],
    ];
    for (const [url, expected, why] of cases) {
      reset();
      const response = await app.request(url, {}, env);
      assert.equal(forwarded.length, expected ? 1 : 0, `${url}${why ? ` (${why})` : ''}`);
      if (expected) {
        assert.equal(response.headers.get('x-served-by'), 'ec2', url);
        const target = new URL(url);
        assert.equal(forwarded[0].url, `https://aws.zero-x.live${target.pathname}${target.search}`, url);
      } else assert.equal(response.headers.get('x-served-by'), null, url);
    }
    // Another spelling of a routed host is the same host: Cloudflare's other HTTPS ports and a
    // fully-qualified name with its trailing dot are forwarded, with the host as server.js knows it.
    for (const url of ['https://zero-x.live:8443/v1/models', 'https://zero-x.live:2053/v1/models/status', 'https://zero-x.live./v1/models',
      'https://ZERO-X.live.:2096/v1/chat/completions', 'https://dashboard.zero-x.live.:8443/']) {
      reset();
      const { env: proxied, touched } = watched(env);
      const response = await app.request(url, { method: url.includes('chat') ? 'POST' : 'GET', ...(url.includes('chat') ? { body: '{}' } : {}) }, proxied);
      assert.equal(forwarded.length, 1, url);
      assert.equal(response.headers.get('x-served-by'), 'ec2', url);
      assert.deepEqual([...touched], [], `${url}: the Worker app never ran`);
      assert.equal(forwarded[0].headers.get('x-zerox-host'), new URL(url).hostname.replace(/\.$/, ''), `${url}: no port, no trailing dot`);
      assert.equal(forwarded[0].url, `https://aws.zero-x.live${new URL(url).pathname}`, url);
    }
    reset();
    await app.request('https://www.zero-x.live:8443/v1/models', {}, env);
    assert.equal(forwarded.length, 0, 'a port does not make another host match');
    ok('prefixes: host + path as written (trailing slash included), any port and a trailing dot on the request host ignored, a bare host covers the host, case-insensitive hosts, blanks and spaces ignored, a URL entry means its host + path, every CUTOVER.md value valid');
  }

  // ── Unset or empty: the Worker exactly as before, whatever else is set (the explicit rollback) ──
  {
    const urls = ['https://zero-x.live/health', 'https://zero-x.live/v1/models', 'https://zero-x.live/about',
      'https://zero-x.live/about.html?x=1', 'https://dashboard.zero-x.live/', 'https://www.zero-x.live/pricing'];
    for (const url of urls) {
      const reference = await dump(await app.request(url, {}, base));
      for (const prefixes of [undefined, '', '  ', ' , ']) {
        // A bad secret, a bad origin or a KV binding mean nothing while the switch is off.
        for (const extra of [{ EC2_PROXY_SECRET: SECRET }, {}, { EC2_PROXY_SECRET: 'pässwörd' }, { EC2_PROXY_ORIGIN: 'http://x.example' }]) {
          reset();
          const env = { ...base, ...extra, ...(prefixes === undefined ? {} : { EC2_PROXY_PREFIXES: prefixes }) };
          assert.deepEqual(await dump(await app.request(url, {}, env)), reference, `${url} with ${JSON.stringify(prefixes)}`);
          assert.equal(forwarded.length, 0);
        }
      }
    }
    assert.equal(forwardToEc2(new Request('https://zero-x.live/v1/models'), base), null);
    // The chat handler itself runs on the Worker (no credential: its own 401), marked as the Worker's.
    reset();
    const chat = await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      { ...base, EC2_PROXY_SECRET: SECRET });
    assert.equal(chat.status, 401);
    assert.equal((await chat.json()).error.code, 'invalid_session', 'the Worker app ran the chat handler');
    assert.equal(chat.headers.get('x-zerox-runtime'), 'worker');
    assert.equal(chatRoutedToEc2(base), false);
    ok('EC2_PROXY_PREFIXES unset, empty or blank: nothing is forwarded and every answer is the same as without it, a bad secret or origin included; the Worker app serves chat');
  }

  // ── Which runtime answered ──
  {
    reset();
    const health = await app.request('https://zero-x.live/health', {}, base);
    assert.equal(health.headers.get('x-zerox-runtime'), 'worker');
    const status = await health.json();
    assert.equal(status.runtime, 'worker');
    assert.deepEqual(Object.keys(status).sort(), ['commit', 'runtime', 'service', 'status', 'version'], 'nothing else for anonymous callers');
    // The same app on Node (server.js sets NEURON_RUNTIME=node) says node; a Worker given
    // NEURON_RUNTIME=node by mistake still says worker.
    assert.equal((await (await app.request('https://zero-x.live/health', {}, { ...base, NEURON_RUNTIME: 'node' })).json()).runtime, 'node');
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
    try {
      const worker = await app.request('https://zero-x.live/health', {}, { ...base, NEURON_RUNTIME: 'node' });
      assert.equal(worker.headers.get('x-zerox-runtime'), 'worker');
    } finally {
      Object.defineProperty(globalThis, 'navigator', navigator);
    }
    // Readable by browsers on the open-CORS paths.
    const cors = await app.request('https://zero-x.live/v1/models', { headers: { Origin: 'https://example.com' } }, base);
    assert.match(cors.headers.get('access-control-expose-headers'), /X-Zerox-Runtime/);
    // A forwarded answer keeps EC2's mark: the Response is EC2's own.
    reset();
    const forwardedAnswer = await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY });
    assert.equal(forwardedAnswer.headers.get('x-zerox-runtime'), 'node');
    ok('x-zerox-runtime: worker on the Worker\'s answers (a stray NEURON_RUNTIME=node on Workers included), node from the same app on Node, EC2\'s own value on forwarded answers; /health reports runtime; CORS exposes it');
  }

  // ── Headers: client x-zerox-* dropped, the trusted ones set from request.cf, CF-Connecting-IP and cf-ray ──
  {
    reset();
    const request = workerRequest('https://zero-x.live/v1/models?limit=5', {
      headers: {
        Authorization: 'Bearer ses_client', 'X-Neuron-Conversation': 'conv-1', 'CF-Connecting-IP': '198.51.100.7', 'CF-Ray': RAY,
        'X-Zerox-Host': 'admin.evil.example', 'x-zerox-proxy-secret': 'guessed', 'X-ZEROX-CLIENT-IP': '127.0.0.1',
        'x-zerox-country': 'US', 'x-zerox-anything': 'dropped', 'X-Zerox-Ray': 'ffffffffffffffff-XXX', Host: 'zero-x.live',
      },
    }, { country: 'IN', city: 'São Paulo', asn: 13335, region: 'Karnataka', asOrganization: 'Example Net' });
    const response = await app.fetch(request, { ...base, ...PROXY });
    assert.equal(response.headers.get('x-served-by'), 'ec2');
    const sent = Object.fromEntries(forwarded[0].headers);
    assert.deepEqual(Object.keys(sent).filter(name => name.startsWith('x-zerox-')).sort(),
      ['x-zerox-as-org', 'x-zerox-asn', 'x-zerox-city', 'x-zerox-client-ip', 'x-zerox-country', 'x-zerox-host', 'x-zerox-proto',
        'x-zerox-proxy-secret', 'x-zerox-ray', 'x-zerox-region']);
    assert.equal(sent['x-zerox-host'], 'zero-x.live');
    assert.equal(sent['x-zerox-proto'], 'https');
    assert.equal(sent['x-zerox-client-ip'], '198.51.100.7');
    assert.equal(sent['x-zerox-ray'], RAY, 'the visitor\'s cf-ray, not the client\'s x-zerox-ray');
    assert.equal(sent['x-zerox-country'], 'IN');
    assert.equal(sent['x-zerox-city'], 'S%C3%A3o%20Paulo', 'percent-encoded UTF-8 (a header value cannot carry it raw)');
    assert.equal(decodeURIComponent(sent['x-zerox-city']), 'São Paulo');
    assert.equal(sent['x-zerox-asn'], '13335');
    // The device sign-in shows the requester's region and network too (src/routes/device.js).
    assert.equal(sent['x-zerox-region'], 'Karnataka');
    assert.equal(sent['x-zerox-as-org'], 'Example%20Net', 'percent-encoded like the city');
    assert.equal(sent['x-zerox-proxy-secret'], SECRET);
    assert.equal(sent.authorization, 'Bearer ses_client');
    assert.equal(sent['x-neuron-conversation'], 'conv-1');
    assert.equal(sent['cf-connecting-ip'], '198.51.100.7');
    assert.equal(sent.host, undefined, 'the target URL names the host; the original travels as x-zerox-host');

    // A city outside Latin-1 would make the header throw; absent request.cf fields are left out,
    // and so is a cf-ray that is not one.
    reset();
    await app.fetch(workerRequest('http://dashboard.zero-x.live/api/account', { headers: { 'cf-ray': '<script>alert(1)</script>' } },
      { city: 'Łódź', country: 'PL', region: 'Łódź Voivodeship' }), { ...base, ...PROXY });
    let headers = forwarded[0].headers;
    assert.equal(headers.get('x-zerox-city'), encodeURIComponent('Łódź'));
    assert.equal(headers.get('x-zerox-region'), encodeURIComponent('Łódź Voivodeship'));
    assert.equal(headers.get('x-zerox-proto'), 'http');
    assert.equal(headers.get('x-zerox-host'), 'dashboard.zero-x.live');
    assert.equal(headers.get('x-zerox-asn'), null);
    assert.equal(headers.get('x-zerox-as-org'), null);
    assert.equal(headers.get('x-zerox-client-ip'), null, 'no CF-Connecting-IP, no header');
    assert.equal(headers.get('x-zerox-ray'), null, 'a forged cf-ray is not passed on');
    reset();
    await app.fetch(workerRequest('https://zero-x.live/v1/models', { headers: { 'X-Zerox-Country': 'US', 'X-Zerox-Region': 'Texas', 'X-Zerox-Ray': RAY } }),
      { ...base, ...PROXY });
    headers = forwarded[0].headers;
    assert.deepEqual(['country', 'city', 'asn', 'region', 'as-org', 'ray'].map(name => headers.get(`x-zerox-${name}`)), [null, null, null, null, null, null],
      'no request.cf or cf-ray: no such headers, and the client copy is gone');
    ok('headers: every client x-zerox-* removed; host, proto, client IP, ray, country, city and region (percent-encoded), ASN, network (percent-encoded) and the secret set; absent or forged values omitted; Host not forwarded; other headers kept');
  }

  // ── Fail closed: a routed path with a bad secret, a bad origin, a loop or a split session store
  // answers the JSON 503 and never runs the Worker app ──
  {
    const chat = (env, url = 'https://zero-x.live/v1/chat/completions') => {
      const { env: proxied, touched } = watched(env);
      const request = workerRequest(url, { method: 'POST', body: '{"model":"auto","messages":[]}',
        headers: { 'Content-Type': 'application/json', 'cf-ray': RAY, Authorization: 'Bearer ses_x' } });
      return Promise.resolve(app.fetch(request, proxied)).then(response => ({ response, touched }));
    };
    resetEc2ProxyState();
    warnings.length = 0;
    for (const secret of [undefined, '', 'abc\ndef', 'pässwörd€', 'pässwörd', ' padded\n', 'trailing ', '\tleading', 'inner\ttab', 'nul\0byte', ' x']) {
      reset();
      const env = { ...base, EC2_PROXY_PREFIXES: PROXY.EC2_PROXY_PREFIXES, ...(secret === undefined ? {} : { EC2_PROXY_SECRET: secret }) };
      const reason = secret ? 'secret_invalid' : 'secret_missing';
      const { response, touched } = await chat(env);
      const { line } = await assertRefused(response, touched, reason, JSON.stringify(secret));
      assert.ok(line.includes(RAY) && line.includes('"prefix":"zero-x.live/v1/"'), line);
      if (secret?.trim().length >= 5) assert.ok(!line.includes(secret.trim()), 'the secret itself is never logged');
      // Every routed path, not only chat; and the forwarding call alone gives the same.
      reset();
      const { env: watchedEnv, touched: other } = watched(env);
      await assertRefused(await app.request('https://dashboard.zero-x.live/api/account', {}, watchedEnv), other, reason, 'dashboard host');
      reset();
      await assertRefused(await forwardToEc2(workerRequest('https://zero-x.live/v1/models'), env), null, reason, 'forwardToEc2');
    }
    assert.ok(!warnings.some(line => /pässwörd|padded|trailing|leading|inner/.test(line)), 'no secret in any log line');
    reset();
    await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, EC2_PROXY_SECRET: 'with inner space ok' });
    assert.equal(forwarded[0].headers.get('x-zerox-proxy-secret'), 'with inner space ok', 'inner spaces are sent as they are');

    // A target that is not https, or one of the Worker's own hosts (the request's or another).
    for (const [origin, reason] of [['http://aws.zero-x.live', 'origin_invalid'], ['not a url', 'origin_invalid'], ['ftp://aws.zero-x.live', 'origin_invalid'],
      ['https://zero-x.live', 'origin_loop'], ['https://www.zero-x.live/', 'origin_loop'], ['https://Dashboard.zero-x.live:8443', 'origin_loop']]) {
      reset();
      const { response, touched } = await chat({ ...base, ...PROXY, EC2_PROXY_ORIGIN: origin });
      await assertRefused(response, touched, reason, origin);
    }
    // The Worker's Custom Domains are the loop list.
    const routed = [...read('wrangler.toml').split(/^\[\[routes\]\]$/m).slice(1)].map(block => /pattern = "([^"]+)"/.exec(block)?.[1]).filter(Boolean);
    assert.deepEqual([...WORKER_HOSTS].sort(), routed.sort(), 'WORKER_HOSTS lists wrangler.toml\'s routes');

    // Sessions still in KV on the Worker: sessions it mints would be unknown on EC2 (CUTOVER.md step 1).
    reset();
    const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
    const split = await chat({ ...base, ...PROXY, SESSIONS_KV: kv });
    await assertRefused(split.response, split.touched, 'session_store_split', 'SESSIONS_KV bound');
    reset();
    await chat({ ...base, ...PROXY });
    assert.equal(forwarded.length, 1, 'without SESSIONS_KV the request is forwarded');

    // The Node server runs the same app and never forwards, whatever its environment holds; a
    // Worker given NEURON_RUNTIME=node by mistake still forwards.
    reset();
    await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, NEURON_RUNTIME: 'node' });
    assert.equal(forwarded.length, 0);
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
    try {
      reset();
      await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, NEURON_RUNTIME: 'node' });
      assert.equal(forwarded.length, 1, 'NEURON_RUNTIME=node on Workers is ignored');
      assert.ok(warnings.some(line => line.includes('NEURON_RUNTIME=node is set on the Worker')));
    } finally {
      Object.defineProperty(globalThis, 'navigator', navigator);
    }

    // A throw while building the forward (a header, the runtime): the JSON 503, not error 1101.
    const RealHeaders = globalThis.Headers;
    const request = workerRequest('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'cf-ray': RAY } });
    let thrown = false;
    globalThis.Headers = class extends RealHeaders {
      constructor(...args) {
        if (!thrown) { thrown = true; throw new TypeError('Headers broke'); }
        super(...args);
      }
    };
    reset();
    let broken;
    try { broken = forwardToEc2(request, { ...base, ...PROXY }); } finally { globalThis.Headers = RealHeaders; }
    assert.ok(thrown);
    const { line } = await assertRefused(await broken, null, 'forward_failed', 'Headers threw');
    assert.ok(line.includes('"name":"TypeError"') && !line.includes('Headers broke'), 'the error\'s name only');
    ok('fail closed: no EC2_PROXY_SECRET or one a header cannot carry exactly, a non-https or self-pointing EC2_PROXY_ORIGIN, SESSIONS_KV still bound, or a throw: every routed path answers the JSON 503 (Retry-After 30, request id, runtime worker) with one sanitized line (reason, ray, prefix), and the Worker app never runs; only the Node runtime does not forward');
  }

  // ── Entries that cannot match: refused for chat and inference (and /v1 when they name it), warned once ──
  {
    const malformed = ['/v1/', 'zero-x.live:443/v1/', '*.zero-x.live/v1/', 'zero-x.live./v1/', 'zero-x.live/V1/', 'zero-x.live /v1/',
      '"zero-x.live/v1/"', 'zero-x.live/v1/;www.zero-x.live/v1/', 'zero-x.live\t/v1/', 'zero-x.live/V1/chat/'];
    for (const value of malformed) {
      const { prefixes, invalid } = parseProxyPrefixes(value);
      assert.deepEqual(prefixes, [], JSON.stringify(value));
      assert.equal(invalid.length, 1, JSON.stringify(value));
    }
    resetEc2ProxyState();
    warnings.length = 0;
    for (const value of malformed) {
      for (const url of ['https://zero-x.live/v1/chat/completions', 'https://www.zero-x.live/v1/models/health', 'https://zero-x.live/v1/models']) {
        reset();
        const { env, touched } = watched({ ...base, EC2_PROXY_SECRET: SECRET, EC2_PROXY_PREFIXES: value });
        const response = await app.fetch(workerRequest(url, { method: 'POST', body: '{}', headers: { 'cf-ray': RAY } }), env);
        const { line } = await assertRefused(response, touched, 'prefixes_invalid', `${JSON.stringify(value)} ${url}`);
        assert.ok(line.includes('"entries":[1]') && line.includes(RAY), line);
        assert.ok(!line.includes('zero-x.live/V1') && !line.includes(':443'), 'the entry itself is not logged');
      }
      assert.equal(chatRoutedToEc2({ EC2_PROXY_PREFIXES: value }), true, 'the chat handler refuses too');
    }
    // An invalid entry that names no /v1 path holds chat and inference only; the rest is served by
    // the Worker, with one warning per value.
    warnings.length = 0;
    for (let i = 0; i < 3; i++) {
      reset();
      const env = { ...base, EC2_PROXY_SECRET: SECRET, EC2_PROXY_PREFIXES: 'zero-x.live:443' };
      assert.equal((await app.request('https://zero-x.live/v1/models', {}, env)).status, 200);
      assert.equal((await app.request('https://zero-x.live/about', {}, env)).status, 200);
      assert.equal((await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}' }, env)).status, 503);
      assert.equal(forwarded.length, 0);
    }
    assert.equal(warnings.filter(line => line.startsWith('EC2_PROXY_PREFIXES has entries')).length, 1, 'warned once');
    assert.ok(warnings.find(line => line.startsWith('EC2_PROXY_PREFIXES has entries')).includes('"entries":[1]'));
    // Valid entries keep working beside an invalid one.
    reset();
    const mixed = { ...base, EC2_PROXY_SECRET: SECRET, EC2_PROXY_PREFIXES: 'zero-x.live/v1/,zero-x.live:443/,*.zero-x.live/' };
    assert.deepEqual(parseProxyPrefixes(mixed.EC2_PROXY_PREFIXES).invalid.map(each => each.entry), [2, 3]);
    await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}' }, mixed);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(proxyStatus(mixed), { entries: 3, invalid: [2, 3], chat_routed: true, chat_routed_by: [1], refusal: 'prefixes_invalid' });
    assert.deepEqual(proxyStatus({ ...PROXY }), { entries: 2, invalid: [], chat_routed: true, chat_routed_by: [1], refusal: null });
    assert.deepEqual(proxyStatus({ EC2_PROXY_PREFIXES: 'neuron.zero-x.live/device' }),
      { entries: 1, invalid: [], chat_routed: false, chat_routed_by: [], refusal: 'secret_missing' });
    assert.equal(proxyStatus({ ...PROXY, SESSIONS_KV: {} }).refusal, 'session_store_split');
    assert.deepEqual(proxyStatus({}), { entries: 0, invalid: [], chat_routed: false, chat_routed_by: [], refusal: null });
    // The operator sees which entries keep chat on EC2 (CUTOVER.md step 4's last value).
    assert.deepEqual(proxyStatus({ ...PROXY, EC2_PROXY_PREFIXES: 'zero-x.live/,www.zero-x.live/,dashboard.zero-x.live/,neuron.zero-x.live/' }).chat_routed_by, [1]);
    assert.deepEqual(proxyStatus({ ...PROXY, EC2_PROXY_PREFIXES: 'dashboard.zero-x.live/,zero-x.live/v1/chat/,www.zero-x.live/v1/' }).chat_routed_by, [2, 3]);
    ok('entries with a port, wildcard, trailing dot, quotes, whitespace, no host, ";" or a miscased API path are invalid: chat and inference (and /v1 when they name it) answer the JSON 503 naming the entry by position, other paths stay on the Worker with one warning; the operator /health reports the switch');
  }

  // ── Chat aliases: once chat is routed, every spelling Hono serves it under goes to EC2 ──
  {
    const env = { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'zero-x.live/v1/' };
    const aliases = ['https://zero-x.live/auth/azure/chat/completions', 'https://zero-x.live/auth/azure/proxy',
      'https://zero-x.live/neuroncli/auth-server/v1/chat/completions', 'https://zero-x.live/neuroncli/auth-server/auth/azure/proxy',
      'https://www.zero-x.live/v1/chat/completions', 'https://neuron.zero-x.live/v1/chat/completions',
      'https://dashboard.zero-x.live/v1/chat/completions', 'https://zero-x.live/%761/chat/completions',
      'https://zero-x.live/v1/chat/%63ompletions?x=1', 'https://www.zero-x.live/neuroncli/auth-server/auth/azure/chat/completions',
      'https://zero-x.live/v1/models/health', 'https://www.zero-x.live/neuroncli/auth-server/v1/models/health'];
    for (const url of aliases) {
      reset();
      const { env: proxied, touched } = watched(env);
      const response = await app.request(url, { method: 'POST', body: '{"model":"auto"}', headers: { 'Content-Type': 'application/json' } }, proxied);
      assert.equal(forwarded.length, 1, url);
      const target = new URL(url);
      assert.equal(forwarded[0].url, `https://aws.zero-x.live${target.pathname}${target.search}`, `${url}: the path as it came`);
      assert.equal(forwarded[0].headers.get('x-zerox-host'), target.host);
      assert.equal(response.headers.get('x-served-by'), 'ec2', url);
      assert.deepEqual([...touched], [], `${url}: the Worker app never ran`);
    }
    assert.equal(routeKey('/neuroncli/auth-server/auth/azure/proxy'), '/v1/chat/completions');
    assert.equal(routeKey('/%761/chat/completions'), '/v1/chat/completions');
    assert.equal(routeKey('/v1/a%2Fb'), '/v1/a%2Fb', '%2F stays encoded, as in Hono');
    // What is not chat stays where the prefixes say: another host's /v1/models is the Worker's,
    // the mount's /v1/models follows the root's.
    reset();
    assert.equal((await app.request('https://www.zero-x.live/v1/models', {}, env)).headers.get('x-served-by'), null);
    assert.equal(forwarded.length, 0);
    await app.request('https://zero-x.live/neuroncli/auth-server/v1/models', {}, env);
    assert.equal(forwarded.length, 1);
    // An entry whose path covers chat, or the API host whole, routes chat on every host; a
    // whole-host entry for another host, or a path that does not cover chat, leaves it alone.
    for (const [prefixes, routedChat] of [['zero-x.live/v1/chat/', true], ['zero-x.live/', true], ['www.zero-x.live/v1/', true],
      ['dashboard.zero-x.live/', false], ['www.zero-x.live/', false], ['neuron.zero-x.live/', false],
      ['www.zero-x.live/,dashboard.zero-x.live/,neuron.zero-x.live/', false],
      ['zero-x.live/v1/models', false], ['neuron.zero-x.live/device', false], ['zero-x.live/v1/chat/completions/x', false]]) {
      assert.equal(chatRoutedToEc2({ EC2_PROXY_PREFIXES: prefixes }), routedChat, prefixes);
      // Asked on a host no entry names, so only the chat rule can forward it.
      const other = WORKER_HOSTS.find(host => !prefixes.split(',').some(prefix => prefix.startsWith(`${host}/`)));
      reset();
      await app.request(`https://${other}/v1/chat/completions`, { method: 'POST', body: '{}' }, { ...env, EC2_PROXY_PREFIXES: prefixes });
      assert.equal(forwarded.length, routedChat ? 1 : 0, `${prefixes} on ${other}`);
    }
    assert.equal(chatRoutedToEc2({ EC2_PROXY_PREFIXES: 'zero-x.live/v1/', NEURON_RUNTIME: 'node' }), false, 'the Node server runs chat');
    // A partial rollback (CUTOVER.md's rollback table): from step 4's value, taking out the apex
    // entry brings chat on the apex back to the Worker app; the hosts still routed keep their own
    // paths, chat on them included.
    {
      const partial = { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'www.zero-x.live/,dashboard.zero-x.live/' };
      assert.equal(chatRoutedToEc2(partial), false);
      reset();
      const chat = await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, partial);
      assert.equal(forwarded.length, 0, 'apex chat back on the Worker');
      assert.equal(chat.status, 401);
      assert.equal(chat.headers.get('x-zerox-runtime'), 'worker');
      reset();
      await app.request('https://dashboard.zero-x.live/v1/chat/completions', { method: 'POST', body: '{}' }, partial);
      assert.equal(forwarded.length, 1, 'a routed host keeps its own chat path on EC2');
    }

    // The backstop: the chat handler on the Worker refuses while chat is routed, under every route
    // Hono registered for it.
    const chatRoutes = app.routes.filter(route => route.method === 'POST' && /\/(v1\/chat\/completions|auth\/azure\/(proxy|chat\/completions))$/.test(route.path));
    assert.equal(chatRoutes.length, 6, 'three paths, two mounts');
    warnings.length = 0;
    for (const route of chatRoutes) {
      reset();
      const request = workerRequest(`https://zero-x.live${route.path}`, { method: 'POST', body: '{}', headers: { 'cf-ray': RAY } });
      const response = await route.handler({ env, req: { raw: request } });
      const { line } = await assertRefused(response, null, 'chat_on_worker', route.path);
      assert.ok(line.includes(RAY));
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
    }
    ok('chat routed by an entry covering /v1/chat/completions or the apex whole (never by a whole-host entry for another host, so a partial rollback brings chat back): the legacy /auth/azure aliases, the /neuroncli/auth-server mount, percent-encoded spellings, every host and /v1/models/health are forwarded with their path as it came; the chat handler refuses on the Worker under every route while chat is routed');
  }

  // ── Method, body, query, signal and streams pass through; redirects are not followed ──
  {
    reset();
    let pulls = 0;
    const chunks = ['{"model":"auto",', '"messages":[{"role":"user",', '"content":"hi"}]}'];
    // highWaterMark 0: the stream is only pulled when someone reads it.
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(chunks[pulls++]));
        if (pulls === chunks.length) controller.close();
      },
    }, { highWaterMark: 0 });
    let pullsWhenForwarded = null;
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: one\n\n')); controller.enqueue(new TextEncoder().encode('data: two\n\n')); controller.close(); },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Request-Id': 'req_upstream' } });
    answer = () => { pullsWhenForwarded = pulls; return upstream; };
    const request = workerRequest('https://zero-x.live/v1/chat/completions?trace=1&x=%20y', {
      method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ses_x' },
    }, { country: 'DE' });
    const response = await app.fetch(request, { ...base, ...PROXY, EC2_PROXY_ORIGIN: 'https://origin.example.test/ignored/path' });
    assert.equal(response, upstream, 'the upstream Response itself: no wrapper, no transform');
    assert.equal(response.bodyUsed, false, 'its stream unread by the Worker');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    // Counted when the request reaches fetch, which is where the Worker's code ends. Later pulls
    // are the transport's (Node's Request also pipes such a body through an identity stream).
    assert.equal(pullsWhenForwarded, 0, 'the Worker never read the request body');
    const sent = forwarded[0];
    assert.equal(sent.url, 'https://origin.example.test/v1/chat/completions?trace=1&x=%20y', 'EC2_PROXY_ORIGIN (origin only), path and query');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.redirect, 'manual');
    assert.equal(await sent.text(), chunks.join(''), 'the body arrives byte for byte');
    assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');

    // The client's signal goes with the forward: a client that leaves cancels it, and that is no
    // origin failure (no warning, no 503 for nobody).
    reset();
    warnings.length = 0;
    const client = new AbortController();
    let reached;
    const atFetch = new Promise(resolve => { reached = resolve; });
    answer = forward => new Promise((resolve, reject) => {
      forward.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      reached();
    });
    const leaving = app.fetch(workerRequest('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', signal: client.signal,
      headers: { 'cf-ray': RAY } }), { ...base, ...PROXY });
    await atFetch;
    assert.equal(forwarded[0].signal.aborted, false);
    client.abort();
    assert.equal(forwarded[0].signal.aborted, true, 'the forward\'s signal follows the client\'s');
    assert.equal((await leaving).status, 499);
    assert.ok(!warnings.some(line => line.includes('EC2 proxy request failed')), 'a client that left is not an origin failure');

    // The same where the runtime does not copy `signal` from a Request used as the init (Node's
    // undici does; workerd is not proven to): a Request class that drops it. Only the signal given
    // to fetch itself carries the client's leaving then.
    reset();
    const RealRequest = globalThis.Request;
    class DroppingRequest extends RealRequest {
      constructor(input, init) {
        if (init instanceof RealRequest) {
          super(input, { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect, duplex: 'half' });
        } else super(input, init);
      }
    }
    const client2 = new AbortController();
    let reached2;
    const atFetch2 = new Promise(resolve => { reached2 = resolve; });
    answer = forward => new Promise((resolve, reject) => {
      forward.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      reached2();
    });
    const workerdLike = workerRequest('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', signal: client2.signal,
      headers: { 'cf-ray': RAY } });
    let leaving2;
    globalThis.Request = DroppingRequest;
    try { leaving2 = forwardToEc2(workerdLike, { ...base, ...PROXY }); } finally { globalThis.Request = RealRequest; }
    await atFetch2;
    assert.equal(forwarded[0].signal.aborted, false);
    client2.abort();
    assert.equal(forwarded[0].signal.aborted, true, 'the client signal reaches fetch even when the Request constructor drops it');
    assert.equal((await leaving2).status, 499);

    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      reset();
      await app.request('https://dashboard.zero-x.live/api/sessions/1', { method }, { ...base, ...PROXY });
      assert.equal(forwarded[0].method, method);
    }
    // A redirect from EC2 reaches the client as it is.
    reset();
    answer = () => new Response(null, { status: 301, headers: { Location: 'https://zero-x.live/neuron-cli' } });
    const redirect = await app.request('https://dashboard.zero-x.live/neuron', {}, { ...base, ...PROXY });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), 'https://zero-x.live/neuron-cli');
    ok('method, body (never read by the Worker), path, query and the client\'s abort signal pass through; the upstream stream (status, event-stream, cache-control) and redirects are returned as they are');
  }

  // ── WebSocket upgrades pass through the same way ──
  {
    reset();
    // Node cannot build a 101 Response; the Workers runtime hands back one with a webSocket.
    const upgraded = { status: 101, webSocket: { accepted: false }, headers: new Headers({ Upgrade: 'websocket' }) };
    answer = () => upgraded;
    const env = { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'zero-x.live/relay/,zero-x.live/v1/' };
    const response = await app.request('https://zero-x.live/v1/relay', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': 'neuron-relay.1' },
    }, env);
    assert.equal(response, upgraded, 'the 101 and its WebSocket are returned untouched');
    const sent = forwarded[0];
    assert.equal(sent.method, 'GET');
    for (const [name, value] of [['upgrade', 'websocket'], ['sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
      ['sec-websocket-version', '13'], ['sec-websocket-protocol', 'neuron-relay.1']]) {
      assert.equal(sent.headers.get(name), value, name);
    }
    assert.equal(sent.headers.get('x-zerox-proxy-secret'), SECRET);
    ok('WebSocket upgrades are forwarded with their handshake headers and the 101 comes back untouched');
  }

  // ── A failed forward, or an origin that is down, answers a JSON 503 with Retry-After ──
  {
    reset();
    warnings.length = 0;
    answer = () => { throw new TypeError('network connection lost'); };
    const response = await app.request('https://zero-x.live/v1/models', { headers: { 'cf-ray': RAY, Origin: 'https://example.com' } }, { ...base, ...PROXY });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(response.headers.get('x-zerox-runtime'), 'worker');
    assert.equal(response.headers.get('access-control-allow-origin'), '*', 'a browser caller can read it, as the app\'s /v1 answers');
    assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
    const body = await response.json();
    assert.equal(body.error.code, 'service_unavailable');
    assert.equal(body.error.type, 'server_error');
    assert.equal(response.headers.get('x-request-id'), body.error.request_id);
    const failed = warnings.find(line => line.includes('EC2 proxy request failed'));
    assert.ok(failed.includes(RAY) && failed.includes(body.error.request_id) && failed.includes('"name":"TypeError"'), failed);
    assert.ok(!failed.includes('network connection lost'), 'the error\'s name only');
    // A site path gets no CORS headers it would not have had.
    reset();
    answer = () => { throw new TypeError('network connection lost'); };
    const page = await app.request('https://dashboard.zero-x.live/', { headers: { Origin: 'https://example.com' } }, { ...base, ...PROXY });
    assert.equal(page.status, 503);
    assert.equal(page.headers.get('access-control-allow-origin'), null);

    // The tunnel without a connector (530, error 1033), the edge's other 52x pages (524: no answer
    // in time), cloudflared with nothing on 127.0.0.1:8787 (its 502), or any 5xx that is not the
    // gateway's own JSON or event stream: the JSON 503, and the page is cancelled unread.
    const pages = [...[520, 521, 522, 523, 524, 525, 526, 527, 530].map(status => [status, 'text/html; charset=UTF-8']),
      [530, 'text/plain'], [530, 'application/json'], [502, 'text/html'], [502, 'TEXT/HTML; charset=utf-8'], [503, 'text/html'], [504, 'text/html'],
      [502, null], [500, 'text/plain']];
    for (const [status, type] of pages) {
      reset();
      warnings.length = 0;
      let cancelled = false;
      const errorPage = new ReadableStream({ cancel() { cancelled = true; } });
      answer = () => new Response(errorPage, { status, headers: type ? { 'Content-Type': type } : {} });
      const down = await app.request('https://zero-x.live/v1/chat/completions', { method: 'POST', body: '{}', headers: { 'cf-ray': RAY } },
        { ...base, ...PROXY });
      assert.equal(down.status, 503, `${status} ${type}`);
      assert.equal(down.headers.get('retry-after'), '5');
      assert.equal(down.headers.get('content-type'), 'application/json');
      const downBody = await down.json();
      assert.equal(downBody.error.code, 'service_unavailable');
      assert.ok(cancelled, 'the page is cancelled, never read');
      const line = warnings.find(each => each.includes('EC2 origin unreachable'));
      assert.ok(line.includes(`"status":${status}`) && line.includes(RAY) && line.includes(downBody.error.request_id), line);
    }
    // The gateway's own errors pass through as they are.
    for (const [status, type] of [[502, 'application/json'], [503, 'application/json; charset=utf-8'], [504, 'application/json'], [500, 'text/event-stream'],
      [429, 'application/json'], [404, 'text/html']]) {
      reset();
      const gatewayError = new Response('{}', { status, headers: { 'Content-Type': type } });
      answer = () => gatewayError;
      assert.equal(await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY }), gatewayError, `${status} ${type} is returned untouched`);
    }

    // POST /v1/models/health runs the chat pipeline: once chat is routed, it is forwarded too.
    reset();
    await app.request('https://zero-x.live/v1/models/health', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'auto' }),
    }, { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'zero-x.live/v1/chat/' });
    assert.equal(forwarded.length, 1, 'the probe ran on EC2');
    assert.equal(forwarded[0].url, 'https://aws.zero-x.live/v1/models/health');
    ok('a forward that fails, or reaches a tunnel, an edge or a VM that is down (52x, 530, any 5xx page that is not JSON or an event stream), answers 503 service_unavailable (JSON, Retry-After, request id, CORS on /v1) logged with the ray; the gateway\'s own errors pass; the /v1/models/health probe follows chat to EC2');
  }

  // ── CPU shape: the forward is a header copy and one fetch call, whatever the body holds ──
  {
    const env = { ...base, ...PROXY };
    const ready = new Response('x');
    globalThis.fetch = async () => ready;
    // Streamed bodies that never produce a byte: the forward must not wait for or touch them.
    const silentBody = () => new ReadableStream({ pull: () => new Promise(() => {}) }, { highWaterMark: 0 });
    const run = count => {
      const requests = Array.from({ length: count }, () => workerRequest('https://zero-x.live/v1/chat/completions', {
        method: 'POST', body: silentBody(), duplex: 'half',
        headers: { Authorization: 'Bearer ses_x', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', 'CF-Ray': RAY },
      }, { country: 'IN', city: 'Chennai', asn: 9829 }));
      const started = process.cpuUsage();
      for (const request of requests) assert.ok(forwardToEc2(request, env));
      const used = process.cpuUsage(started);
      return (used.user + used.system) / 1000 / count;
    };
    run(200);
    const perForwardMs = run(1000);
    assert.ok(perForwardMs < 1, `a forward costs ${perForwardMs.toFixed(3)} ms of CPU, far under the Worker's 10 ms`);
    ok(`CPU shape: ${perForwardMs.toFixed(3)} ms of CPU per forward of a streamed body (never read)`);
  }
} finally {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
}

console.log(`PASS: EC2 proxy switch (${passed.length} groups): prefixes, unset = unchanged, runtime marks, trusted headers, fail closed, invalid entries, chat aliases, pass-through of bodies, signals, streams, redirects and WebSockets, origin down, CPU shape`);
