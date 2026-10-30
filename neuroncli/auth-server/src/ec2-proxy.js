// Worker -> EC2 proxy switch (C0). While the gateway moves to the Node server on EC2 (server.js
// behind Cloudflare Tunnel at EC2_PROXY_ORIGIN), the Worker keeps every Custom Domain and decides
// per request, before Hono and any middleware (src/index.js), whether it serves the request itself
// or forwards it. No DNS record changes, and taking one path back is a Worker secret away.
//
//   EC2_PROXY_PREFIXES  Worker secret  comma list of host + path prefixes, e.g.
//                                      "zero-x.live/v1/,dashboard.zero-x.live/". Empty or unset:
//                                      nothing is forwarded (the Worker as before). A secret, not a
//                                      var, so `wrangler secret put` switches a path in seconds
//                                      without a commit, and deploy.yml never overwrites it.
//   EC2_PROXY_SECRET    Worker secret  sent as x-zerox-proxy-secret; without it nothing is forwarded.
//   EC2_PROXY_ORIGIN    var            https only, default https://aws.zero-x.live.
//
// A forward returns the upstream fetch's Response as it is: the Worker never reads or transforms
// either body, and waiting on the network is not CPU time, so a 90 s token stream (or a WebSocket,
// which passes through the same way) costs the Worker far less than its 10 ms CPU cap. Redirects
// are not followed: EC2's own 301s and 308s reach the client.
//
// The Node server trusts the x-zerox-* headers only when x-zerox-proxy-secret matches its own
// EC2_PROXY_SECRET, so whatever a client sent under that prefix is dropped first and the trusted
// values come from Cloudflare: the visitor's CF-Connecting-IP and request.cf (country, city, ASN).
// The city is percent-encoded UTF-8 (encodeURIComponent): a header value cannot carry "Łódź".
import { errorResponse } from './errors.js';

const DEFAULT_ORIGIN = 'https://aws.zero-x.live';
const TRUSTED_PREFIX = 'x-zerox-';
// Header values that need no encoding: visible ASCII, no control characters.
const PLAIN_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

// A prefix is host + path as written, compared with startsWith, so "zero-x.live/v1/" covers
// /v1/models but not /v1 itself. An entry without a path covers its whole host. Hosts are compared
// lowercased (request URLs carry them so); paths keep their case.
export function parseProxyPrefixes(value) {
  return String(value ?? '').split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const slash = entry.indexOf('/');
    return slash < 0 ? `${entry.toLowerCase()}/` : entry.slice(0, slash).toLowerCase() + entry.slice(slash);
  });
}

// Parsed once per secret value, not per request.
let parsed = { value: undefined, prefixes: [] };
function proxyPrefixes(value) {
  if (value !== parsed.value) parsed = { value, prefixes: parseProxyPrefixes(value) };
  return parsed.prefixes;
}

// Misconfigurations are logged once per isolate, not once per request.
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function proxyOrigin(value) {
  try {
    const url = new URL(String(value ?? '').trim() || DEFAULT_ORIGIN);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function setTrusted(headers, name, value) {
  const text = value == null ? '' : String(value);
  if (PLAIN_VALUE.test(text)) headers.set(name, text);
}

/**
 * Forwards `request` to the Node server on EC2 when its host + path matches EC2_PROXY_PREFIXES.
 * Returns the upstream fetch's promise (a JSON 503 if the fetch itself fails), or null when the
 * Worker serves the request: no prefix matches, the switch is off or misconfigured, or this is the
 * Node server, which runs the same app and never forwards.
 */
export function forwardToEc2(request, env) {
  const configured = env?.EC2_PROXY_PREFIXES;
  if (!configured || env.NEURON_RUNTIME === 'node') return null;
  const prefixes = proxyPrefixes(configured);
  if (!prefixes.length) return null;
  const url = new URL(request.url);
  const where = url.host + url.pathname;
  if (!prefixes.some(prefix => where.startsWith(prefix))) return null;

  const secret = env.EC2_PROXY_SECRET;
  if (!secret) {
    warnOnce('secret', 'EC2_PROXY_PREFIXES is set without EC2_PROXY_SECRET: the Worker serves every request itself');
    return null;
  }
  const origin = proxyOrigin(env.EC2_PROXY_ORIGIN);
  if (!origin) {
    warnOnce('origin', 'EC2_PROXY_ORIGIN is not an https URL: the Worker serves every request itself');
    return null;
  }
  // Pointed at a host this Worker answers, the forward would come straight back here.
  if (origin.host === url.host) {
    warnOnce('loop', 'EC2_PROXY_ORIGIN names a host the Worker serves: the Worker serves every request itself');
    return null;
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith(TRUSTED_PREFIX)) headers.delete(name);
  }
  // The target URL names EC2's host; the one the visitor asked for travels as x-zerox-host.
  headers.delete('host');
  const cf = request.cf || {};
  headers.set('x-zerox-host', url.host);
  headers.set('x-zerox-proto', url.protocol === 'http:' ? 'http' : 'https');
  setTrusted(headers, 'x-zerox-client-ip', request.headers.get('cf-connecting-ip'));
  setTrusted(headers, 'x-zerox-country', cf.country);
  setTrusted(headers, 'x-zerox-city', typeof cf.city === 'string' && cf.city ? encodeURIComponent(cf.city) : null);
  setTrusted(headers, 'x-zerox-asn', cf.asn);
  headers.set('x-zerox-proxy-secret', secret);

  // Method, body (a stream, handed on unread), signal and the rest come from the client's request.
  const forward = new Request(origin.origin + url.pathname + url.search, new Request(request, { headers, redirect: 'manual' }));
  return fetch(forward).catch(error => {
    console.warn('EC2 proxy request failed', { name: error?.name, host: url.host });
    return errorResponse('service_unavailable', { retryAfterSeconds: 5 });
  });
}

// Test hook.
export function resetEc2ProxyState() {
  warned.clear();
  parsed = { value: undefined, prefixes: [] };
}
