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
//   EC2_PROXY_SECRET    Worker secret  sent as x-zerox-proxy-secret; without it, or when a header
//                                      cannot carry it exactly (visible ASCII only, no surrounding
//                                      whitespace), nothing is forwarded.
//   EC2_PROXY_ORIGIN    var            https only, default https://aws.zero-x.live.
//
// A forward returns the upstream fetch's Response as it is: the Worker never reads or transforms
// either body, and waiting on the network is not CPU time, so a 90 s token stream (or a WebSocket,
// which passes through the same way) costs the Worker far less than its 10 ms CPU cap. Redirects
// are not followed: EC2's own 301s and 308s reach the client. The one exception is an origin that
// is down (the tunnel's 530, cloudflared's HTML 502): told so by the status and Content-Type
// alone, the Worker answers the gateway's JSON 503 with Retry-After instead of an HTML page.
//
// The Node server trusts the x-zerox-* headers only when x-zerox-proxy-secret matches its own
// EC2_PROXY_SECRET, so whatever a client sent under that prefix is dropped first and the trusted
// values come from Cloudflare: the visitor's CF-Connecting-IP and request.cf (country, city,
// region, ASN and its organisation, which the device sign-in shows). The city, region and
// organisation are percent-encoded UTF-8 (encodeURIComponent): a header value cannot carry "Łódź".
//
// Every forward fetches EC2_PROXY_ORIGIN + path, so in Cloudflare's cache all visitor hosts and
// schemes share one key per path. The app keeps what depends on them out of shared caches
// (src/index.js); a cache-everything rule on the EC2_PROXY_ORIGIN host would undo that.
import { errorResponse } from './errors.js';

const DEFAULT_ORIGIN = 'https://aws.zero-x.live';
const TRUSTED_PREFIX = 'x-zerox-';
// Header values that need no encoding: visible ASCII, no control characters.
const PLAIN_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

// A prefix is host + path as written, compared with startsWith, so "zero-x.live/v1/" covers
// /v1/models but not /v1 itself. An entry without a path covers its whole host. Hosts are compared
// lowercased (request URLs carry them so); paths keep their case. An entry written as a URL
// ("https://zero-x.live/v1/") means the same: the scheme is not part of the match, and an entry
// that would otherwise never match must not look like a working switch.
export function parseProxyPrefixes(value) {
  return String(value ?? '').split(',').map(entry => entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')).filter(Boolean).map(entry => {
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

// Free text from request.cf (a city, a region, a network's name), percent-encoded UTF-8.
const encodedText = value => (typeof value === 'string' && value ? encodeURIComponent(value) : null);

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
  // Headers would throw on a control character or a character outside Latin-1 (error 1101 on
  // every forwarded path) and silently trim surrounding whitespace (another value than EC2 holds,
  // so every forward 403s). Such a secret is a misconfiguration like a missing one; its value is
  // never logged.
  if (!PLAIN_VALUE.test(String(secret))) {
    warnOnce('secret-value', 'EC2_PROXY_SECRET is not visible ASCII without surrounding whitespace: the Worker serves every request itself');
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
  setTrusted(headers, 'x-zerox-city', encodedText(cf.city));
  setTrusted(headers, 'x-zerox-region', encodedText(cf.region));
  setTrusted(headers, 'x-zerox-asn', cf.asn);
  setTrusted(headers, 'x-zerox-as-org', encodedText(cf.asOrganization));
  headers.set('x-zerox-proxy-secret', String(secret));

  // Method, body (a stream, handed on unread), signal and the rest come from the client's request.
  const forward = new Request(origin.origin + url.pathname + url.search, new Request(request, { headers, redirect: 'manual' }));
  return fetch(forward).then(response => {
    if (!originDown(response)) return response;
    // Only the status and a header were read; the HTML page is dropped unread.
    response.body?.cancel().catch(() => {});
    console.warn('EC2 origin unreachable', { status: response.status, host: url.host });
    return errorResponse('service_unavailable', { retryAfterSeconds: 5 });
  }, error => {
    console.warn('EC2 proxy request failed', { name: error?.name, host: url.host });
    return errorResponse('service_unavailable', { retryAfterSeconds: 5 });
  });
}

// The VM or its tunnel is down, as Cloudflare and cloudflared say it: 530 (error 1033, no
// connector for the tunnel) from the edge, or cloudflared's own HTML 502 when nothing listens on
// 127.0.0.1:8787. Both are HTML pages; passed on, the CLI would get a body that is none of
// errors.js's shapes, with no Retry-After. The gateway itself never answers 530, and its 502s
// (upstream_error) are JSON.
function originDown(response) {
  if (response.status === 530) return true;
  return response.status === 502 && /^text\/html\b/i.test(response.headers.get('content-type') || '');
}

// Test hook.
export function resetEc2ProxyState() {
  warned.clear();
  parsed = { value: undefined, prefixes: [] };
}
