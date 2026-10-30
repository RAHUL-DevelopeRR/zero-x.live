// Worker -> EC2 proxy switch (C0, src/ec2-proxy.js), offline: the Worker entry (src/index.js)
// with a fake fetch standing in for the Node server on EC2. Prefix matching (host + path, hosts
// without a path, whitespace), unset = the Worker as before, client x-zerox-* headers dropped and
// the trusted ones set from request.cf and CF-Connecting-IP, no secret = no forward, method, body,
// query and streams passed through, redirects not followed, WebSocket upgrades passed through, and
// the CPU shape of a forward: the body is never read and the upstream Response is returned as is.
//   node check-ec2-proxy.mjs
import assert from 'node:assert/strict';
import app from './src/index.js';
import { forwardToEc2, parseProxyPrefixes, resetEc2ProxyState } from './src/ec2-proxy.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const SECRET = 'proxy-secret-0123456789abcdef0123456789';
const PROXY = { EC2_PROXY_PREFIXES: 'zero-x.live/v1/,dashboard.zero-x.live/', EC2_PROXY_SECRET: SECRET };
const ASSETS = { fetch: request => new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/plain' } }) };
const base = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ASSETS };

// The Node server on EC2: records what reached it and answers with `answer` (a fresh Response by default).
const realFetch = globalThis.fetch;
let forwarded = [];
let answer = null;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  forwarded.push(request);
  return answer ? answer(request) : new Response('from ec2', { status: 200, headers: { 'X-Served-By': 'ec2' } });
};
const reset = () => { forwarded = []; answer = null; };

// A Workers request: Node's Request has no `cf`, so it is attached the way the runtime exposes it.
function workerRequest(url, init = {}, cf = undefined) {
  const request = new Request(url, init);
  if (cf !== undefined) Object.defineProperty(request, 'cf', { value: cf });
  return request;
}
const dump = async response => ({ status: response.status, headers: [...response.headers].sort(), body: await response.text() });

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

try {
  // ── Prefixes: host + path as written, a bare host covers the whole host, whitespace and blanks ignored ──
  {
    assert.deepEqual(parseProxyPrefixes(''), []);
    assert.deepEqual(parseProxyPrefixes(undefined), []);
    assert.deepEqual(parseProxyPrefixes(' , ,'), []);
    assert.deepEqual(parseProxyPrefixes(' zero-x.live/v1/ , ,Dashboard.Zero-X.live,  zero-x.live/Auth/azure/ '),
      ['zero-x.live/v1/', 'dashboard.zero-x.live/', 'zero-x.live/Auth/azure/']);
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
    ok('prefixes: host + path as written (trailing slash included), a bare host covers the host, case-insensitive hosts, blanks and spaces ignored');
  }

  // ── Unset or empty: the Worker exactly as before ──
  {
    const urls = ['https://zero-x.live/health', 'https://zero-x.live/v1/models', 'https://zero-x.live/about',
      'https://zero-x.live/about.html?x=1', 'https://dashboard.zero-x.live/', 'https://www.zero-x.live/pricing'];
    for (const url of urls) {
      const reference = await dump(await app.request(url, {}, base));
      for (const prefixes of [undefined, '', '  ', ' , ']) {
        reset();
        const env = { ...base, EC2_PROXY_SECRET: SECRET, ...(prefixes === undefined ? {} : { EC2_PROXY_PREFIXES: prefixes }) };
        assert.deepEqual(await dump(await app.request(url, {}, env)), reference, `${url} with ${JSON.stringify(prefixes)}`);
        assert.equal(forwarded.length, 0);
      }
    }
    assert.equal(forwardToEc2(new Request('https://zero-x.live/v1/models'), base), null);
    ok('EC2_PROXY_PREFIXES unset, empty or blank: nothing is forwarded and every answer is the same as without it');
  }

  // ── Headers: client x-zerox-* dropped, the trusted ones set from request.cf and CF-Connecting-IP ──
  {
    reset();
    const request = workerRequest('https://zero-x.live/v1/models?limit=5', {
      headers: {
        Authorization: 'Bearer ses_client', 'X-Neuron-Conversation': 'conv-1', 'CF-Connecting-IP': '198.51.100.7',
        'X-Zerox-Host': 'admin.evil.example', 'x-zerox-proxy-secret': 'guessed', 'X-ZEROX-CLIENT-IP': '127.0.0.1',
        'x-zerox-country': 'US', 'x-zerox-anything': 'dropped', Host: 'zero-x.live',
      },
    }, { country: 'IN', city: 'São Paulo', asn: 13335, region: 'Karnataka', asOrganization: 'Example Net' });
    const response = await app.fetch(request, { ...base, ...PROXY });
    assert.equal(response.headers.get('x-served-by'), 'ec2');
    const sent = Object.fromEntries(forwarded[0].headers);
    assert.deepEqual(Object.keys(sent).filter(name => name.startsWith('x-zerox-')).sort(),
      ['x-zerox-asn', 'x-zerox-city', 'x-zerox-client-ip', 'x-zerox-country', 'x-zerox-host', 'x-zerox-proto', 'x-zerox-proxy-secret']);
    assert.equal(sent['x-zerox-host'], 'zero-x.live');
    assert.equal(sent['x-zerox-proto'], 'https');
    assert.equal(sent['x-zerox-client-ip'], '198.51.100.7');
    assert.equal(sent['x-zerox-country'], 'IN');
    assert.equal(sent['x-zerox-city'], 'S%C3%A3o%20Paulo', 'percent-encoded UTF-8 (a header value cannot carry it raw)');
    assert.equal(decodeURIComponent(sent['x-zerox-city']), 'São Paulo');
    assert.equal(sent['x-zerox-asn'], '13335');
    assert.equal(sent['x-zerox-proxy-secret'], SECRET);
    assert.equal(sent.authorization, 'Bearer ses_client');
    assert.equal(sent['x-neuron-conversation'], 'conv-1');
    assert.equal(sent['cf-connecting-ip'], '198.51.100.7');
    assert.equal(sent.host, undefined, 'the target URL names the host; the original travels as x-zerox-host');

    // A city outside Latin-1 would make the header throw; absent request.cf fields are left out.
    reset();
    await app.fetch(workerRequest('http://dashboard.zero-x.live/api/account', {}, { city: 'Łódź', country: 'PL' }), { ...base, ...PROXY });
    let headers = forwarded[0].headers;
    assert.equal(headers.get('x-zerox-city'), encodeURIComponent('Łódź'));
    assert.equal(headers.get('x-zerox-proto'), 'http');
    assert.equal(headers.get('x-zerox-host'), 'dashboard.zero-x.live');
    assert.equal(headers.get('x-zerox-asn'), null);
    assert.equal(headers.get('x-zerox-client-ip'), null, 'no CF-Connecting-IP, no header');
    reset();
    await app.fetch(workerRequest('https://zero-x.live/v1/models', { headers: { 'X-Zerox-Country': 'US' } }), { ...base, ...PROXY });
    headers = forwarded[0].headers;
    assert.deepEqual([headers.get('x-zerox-country'), headers.get('x-zerox-city'), headers.get('x-zerox-asn')], [null, null, null],
      'no request.cf: no geo headers, and the client copy is gone');
    ok('headers: every client x-zerox-* removed; host, proto, client IP, country, city (percent-encoded), ASN and the secret set; absent values omitted; Host not forwarded; other headers kept');
  }

  // ── No secret: nothing is forwarded, logged once per isolate ──
  {
    resetEc2ProxyState();
    warnings.length = 0;
    for (const secret of [undefined, '']) {
      reset();
      const env = { ...base, EC2_PROXY_PREFIXES: PROXY.EC2_PROXY_PREFIXES, ...(secret === undefined ? {} : { EC2_PROXY_SECRET: secret }) };
      const response = await app.request('https://zero-x.live/v1/models', {}, env);
      assert.equal(forwarded.length, 0);
      assert.equal(response.headers.get('x-served-by'), null);
      assert.equal(response.status, 200, 'served by the Worker');
    }
    assert.equal(warnings.filter(line => line.includes('EC2_PROXY_SECRET')).length, 1, 'logged once');

    // A target that is not https, or is the requested host itself, is refused the same way.
    for (const origin of ['http://aws.zero-x.live', 'not a url', 'https://zero-x.live', 'ftp://aws.zero-x.live']) {
      reset();
      const response = await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, EC2_PROXY_ORIGIN: origin });
      assert.equal(forwarded.length, 0, origin);
      assert.equal(response.status, 200, origin);
    }
    // The Node server runs the same app and never forwards, whatever its environment holds.
    reset();
    await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY, NEURON_RUNTIME: 'node' });
    assert.equal(forwarded.length, 0);
    ok('no EC2_PROXY_SECRET, a non-https or self-pointing EC2_PROXY_ORIGIN, or the Node runtime: served locally (the missing secret logged once)');
  }

  // ── Method, body, query and streams pass through; redirects are not followed ──
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
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    answer = () => { pullsWhenForwarded = pulls; return upstream; };
    const request = workerRequest('https://zero-x.live/v1/chat/completions?trace=1&x=%20y', {
      method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ses_x' },
    }, { country: 'DE' });
    const response = await app.fetch(request, { ...base, ...PROXY, EC2_PROXY_ORIGIN: 'https://origin.example.test/ignored/path' });
    assert.equal(response, upstream, 'the upstream Response itself: no wrapper, no transform');
    // Counted when the request reaches fetch, which is where the Worker's code ends. Later pulls
    // are the transport's (Node's Request also pipes such a body through an identity stream).
    assert.equal(pullsWhenForwarded, 0, 'the Worker never read the request body');
    const sent = forwarded[0];
    assert.equal(sent.url, 'https://origin.example.test/v1/chat/completions?trace=1&x=%20y', 'EC2_PROXY_ORIGIN (origin only), path and query');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.redirect, 'manual');
    assert.equal(await sent.text(), chunks.join(''), 'the body arrives byte for byte');
    assert.equal(await response.text(), 'data: one\n\ndata: two\n\n');

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
    ok('method, body (never read by the Worker), path and query pass through; the upstream stream and redirects are returned as they are');
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

  // ── A failed forward answers a JSON 503; internal sub-requests are never forwarded ──
  {
    reset();
    answer = () => { throw new TypeError('network connection lost'); };
    const response = await app.request('https://zero-x.live/v1/models', {}, { ...base, ...PROXY });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'service_unavailable');
    assert.equal(body.error.type, 'server_error');
    assert.ok(warnings.some(line => line.includes('EC2 proxy request failed')));

    // POST /v1/models/health served by the Worker probes /v1/chat/completions through Hono itself,
    // even when a prefix covers that path: the probe never leaves the Worker.
    reset();
    const probe = await app.request('https://zero-x.live/v1/models/health', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'auto' }),
    }, { ...base, ...PROXY, EC2_PROXY_PREFIXES: 'zero-x.live/v1/chat/' });
    assert.equal(forwarded.length, 0, 'the internal completion was not forwarded');
    assert.equal((await probe.json()).error.code, 'invalid_session', 'it ran on the Worker (no credential)');
    ok('a forward that fails answers 503 service_unavailable (JSON); the /v1/models/health probe stays inside the Worker');
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
        headers: { Authorization: 'Bearer ses_x', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
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

console.log(`PASS: EC2 proxy switch (${passed.length} groups): prefixes, unset = unchanged, trusted headers, no secret = no forward, pass-through of bodies, streams, redirects and WebSockets, CPU shape`);
