// Worker -> EC2 proxy switch (C0). While the gateway moves to the Node server on EC2 (server.js
// behind Cloudflare Tunnel at EC2_PROXY_ORIGIN), the Worker keeps every Custom Domain and decides
// per request, before Hono and any middleware (src/index.js), whether it serves the request itself
// or forwards it. No DNS record changes, and taking one path back is a Worker secret away.
//
//   EC2_PROXY_PREFIXES  Worker secret  comma list of host + path prefixes, e.g.
//                                      "zero-x.live/v1/,dashboard.zero-x.live/". Empty or unset:
//                                      nothing is forwarded (the Worker as before), and that is the
//                                      only way back to the Worker. A secret, not a var, so
//                                      `wrangler secret put` switches a path in seconds without a
//                                      commit, and deploy.yml never overwrites it.
//   EC2_PROXY_SECRET    Worker secret  sent as x-zerox-proxy-secret. Missing, or a value a header
//                                      cannot carry exactly (visible ASCII only, no surrounding
//                                      whitespace): every routed path answers 503.
//   EC2_PROXY_ORIGIN    var            https only, default https://aws.zero-x.live. Anything else,
//                                      or a host this Worker serves (a loop): routed paths answer 503.
//
// Fail closed. A path the switch routes to EC2 is never served by the Worker for any other reason:
// a misconfiguration (above), an entry that is not a host + path, a Worker that still binds
// SESSIONS_KV (sessions it mints would be invisible to EC2, CUTOVER.md step 1) or an unexpected
// error answers the gateway's JSON 503 service_unavailable with Retry-After, and one sanitized log
// line with the visitor's cf-ray, the reason and the matched prefix (never the secret). The chat
// pipeline is what exceeds the Worker's 10 ms CPU cap (error 1102), so once any entry covers
// /v1/chat/completions, every alias Hono serves it under (the legacy /auth/azure/* paths, the
// /neuroncli/auth-server mount, percent-encoded spellings, every host) and /v1/models/health (which
// runs it) go to EC2 too, and the chat handler itself refuses on the Worker (chatRoutedToEc2).
//
// A forward returns the upstream fetch's Response as it is: the Worker never reads or transforms
// either body, and waiting on the network is not CPU time, so a 90 s token stream (or a WebSocket,
// which passes through the same way) costs the Worker far less than its 10 ms CPU cap. Redirects
// are not followed: EC2's own 301s and 308s reach the client. The one exception is an origin that
// is down (the edge's 52x and 530 pages, cloudflared's 502, any 5xx that is not the gateway's own
// JSON or event stream): told so by the status and Content-Type alone, the Worker answers the
// gateway's JSON 503 with Retry-After instead of an HTML page. The client's request.signal goes
// with the forward (wrangler.toml enable_request_signal), so a client that leaves cancels the
// forward, and server.js on EC2 aborts the provider call and settles the reservation.
//
// The Node server trusts the x-zerox-* headers only when x-zerox-proxy-secret matches its own
// EC2_PROXY_SECRET, so whatever a client sent under that prefix is dropped first and the trusted
// values come from Cloudflare: the visitor's CF-Connecting-IP, cf-ray (x-zerox-ray, which matches
// the two runtimes' logs) and request.cf (country, city, region, ASN and its organisation, which
// the device sign-in shows). The city, region and organisation are percent-encoded UTF-8
// (encodeURIComponent): a header value cannot carry "Łódź".
//
// Every response says which runtime made it (x-zerox-runtime): the app sets it (src/index.js),
// "node" on EC2, which the Worker passes on untouched, and the Worker's own 503s here say "worker".
//
// Every forward fetches EC2_PROXY_ORIGIN + path, so in Cloudflare's cache all visitor hosts and
// schemes share one key per path. The app keeps what depends on them out of shared caches
// (src/index.js); a cache-everything rule on the EC2_PROXY_ORIGIN host would undo that.
import { tryDecodeURI } from 'hono/utils/url';
import { isWorkersRuntime } from './auth-context.js';
import { errorResponse, newRequestId } from './errors.js';

const DEFAULT_ORIGIN = 'https://aws.zero-x.live';
const TRUSTED_PREFIX = 'x-zerox-';
// Header values that need no encoding: visible ASCII, no control characters.
const PLAIN_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
// The Worker's Custom Domains (wrangler.toml [[routes]]): a forward to one of them comes back here.
export const WORKER_HOSTS = Object.freeze(['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live']);
// Seconds a client waits before retrying: an operator fixes a misconfiguration, while a tunnel or
// a VM comes back by itself.
const RETRY_MISCONFIGURED = 30;
const RETRY_ORIGIN_DOWN = 5;

// ── Routes, as Hono sees them ──
// Hono serves the API at the root and under the legacy mount, decodes percent-encoded paths, and
// serves the chat handler under two legacy aliases too (src/index.js). The switch matches the raw
// host + path and this route as well, so no spelling of a routed path stays on the Worker.
const API_MOUNT = '/neuroncli/auth-server';
const CHAT_ROUTE = '/v1/chat/completions';
const CHAT_ALIASES = new Set(['/auth/azure/proxy', '/auth/azure/chat/completions']);
// What runs the chat pipeline: the route itself, and the inference probe (POST /v1/models/health
// calls it through Hono).
const INFERENCE_ROUTES = new Set([CHAT_ROUTE, '/v1/models/health']);
// API paths are lowercase; an entry naming one in another case is a typo that would never match.
const API_SEGMENTS = ['v1', 'auth', 'api', 'admin', 'webhooks', 'relay', 'oiop', 'health', 'ready'];

export function routeKey(pathname) {
  // As Hono's getPath decodes it (hono/dist/utils/url.js): decodeURI, with %25 kept as it is.
  let path = pathname.includes('%') ? tryDecodeURI(pathname.replace(/%25/g, '%2525')) : pathname;
  if (path.startsWith(API_MOUNT + '/')) path = path.slice(API_MOUNT.length);
  return CHAT_ALIASES.has(path) ? CHAT_ROUTE : path;
}

// ── EC2_PROXY_PREFIXES ──
// A prefix is host + path as written, compared with startsWith, so "zero-x.live/v1/" covers
// /v1/models but not /v1 itself. An entry without a path covers its whole host. Hosts are compared
// lowercased (request URLs carry them so); paths keep their case. An entry written as a URL
// ("https://zero-x.live/v1/") means the same: the scheme is not part of the match.
// An entry that can never match a request URL is invalid, not ignored, so a switch that looks on
// is never quietly off: a port, a wildcard, a trailing dot, quotes, whitespace inside, a missing
// host, a ";" or "*" in the path, or an API path in another case ("/V1/").
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const PATH = /^\/[^\s"'`;,*?#\\]*$/;
export function parseProxyPrefixes(value) {
  const prefixes = [];
  const invalid = [];
  const entries = String(value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    const bare = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = bare.indexOf('/');
    const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase();
    const path = slash < 0 ? '/' : bare.slice(slash);
    const segment = path.split('/')[1] || '';
    const miscased = API_SEGMENTS.includes(segment.toLowerCase()) && !API_SEGMENTS.includes(segment);
    if (HOST.test(host) && PATH.test(path) && !miscased) prefixes.push(host + path);
    // Kept for the refusal rule only: its 1-based position and the path it seems to mean.
    else invalid.push({ entry: index + 1, path: path.toLowerCase() });
  });
  return { prefixes, invalid };
}

// Parsed once per secret value, not per request.
let parsed = { value: undefined };
function proxyConfig(value) {
  if (value !== parsed.value) {
    const { prefixes, invalid } = parseProxyPrefixes(value);
    parsed = {
      value, prefixes, invalid,
      // An entry whose path covers the chat route moves chat off the Worker on every host.
      chatRouted: prefixes.some(prefix => CHAT_ROUTE.startsWith(prefix.slice(prefix.indexOf('/')))),
      // An invalid entry that seems to be about /v1 holds every /v1 path.
      invalidV1: invalid.some(each => each.path.startsWith('/v1')),
    };
  }
  return parsed;
}

// Configuration warnings are logged once per isolate, not once per request.
const warned = new Set();
function warnOnce(key, message, details) {
  if (warned.has(key)) return;
  warned.add(key);
  if (details) console.warn(message, details);
  else console.warn(message);
}

// Cloudflare's ray id ("8f00aa11bb22cc33-BOM"), or null: a client-sent value never reaches a log
// or EC2 unchecked.
const RAY = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/i;
export const rayId = request => RAY.exec(request.headers.get('cf-ray') || '')?.[0] || null;

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

// The runtime this code runs on: "node" only for server.js (NEURON_RUNTIME=node off Workers); a
// Worker given NEURON_RUNTIME=node by mistake is still the Worker.
export const servingRuntime = env => (env?.NEURON_RUNTIME === 'node' && !isWorkersRuntime() ? 'node' : 'worker');

// The Worker's own answers on forwarded paths: the gateway's JSON 503 with Retry-After and a
// request id (body, x-request-id and the log line), marked as the Worker's, with the open CORS
// headers the /v1 and health paths have when the app answers them (src/index.js openCors), so a
// browser caller can read the error.
function unavailable(route, { retryAfterSeconds, requestId }) {
  const headers = { 'x-zerox-runtime': 'worker' };
  if (route.startsWith('/v1/') || route === '/health' || route === '/ready') {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Expose-Headers'] = 'Retry-After, X-Request-Id, X-Zerox-Runtime';
  }
  return errorResponse('service_unavailable', { retryAfterSeconds, requestId, headers });
}

// A routed request the Worker will not serve: logged with what an operator needs (the reason, the
// visitor's ray, the request id the client got, the host and the matched prefix), never a header,
// the query or the secret.
function refuse(reason, request, url, route, details = {}) {
  const requestId = newRequestId();
  console.warn('EC2 proxy refused', { reason, ray: rayId(request), request_id: requestId, host: url.host, ...details });
  return unavailable(route, { retryAfterSeconds: RETRY_MISCONFIGURED, requestId });
}

/**
 * Forwards `request` to the Node server on EC2 when its host + path (or its Hono route) matches
 * EC2_PROXY_PREFIXES. Returns null when the Worker serves the request: the switch is unset or
 * empty, nothing matches, or this is the Node server, which runs the same app and never forwards.
 * Otherwise a Response or a promise of one: the upstream fetch's own Response, or the gateway's
 * JSON 503 when the switch is misconfigured, the origin is down or the forward fails.
 */
export function forwardToEc2(request, env) {
  const configured = env?.EC2_PROXY_PREFIXES;
  if (!configured) return null;
  if (env.NEURON_RUNTIME === 'node') {
    if (!isWorkersRuntime()) return null;
    warnOnce('runtime', 'NEURON_RUNTIME=node is set on the Worker: ignored, the proxy switch stays on');
  }
  const config = proxyConfig(configured);
  if (!config.prefixes.length && !config.invalid.length) return null;
  const url = new URL(request.url);
  const route = routeKey(url.pathname);
  const where = url.host + url.pathname;
  const routeWhere = url.host + route;
  const inference = INFERENCE_ROUTES.has(route);
  let prefix = config.prefixes.find(each => where.startsWith(each) || routeWhere.startsWith(each));
  if (!prefix && inference && config.chatRouted) prefix = 'chat routes';

  if (config.invalid.length) {
    const entries = config.invalid.map(each => each.entry);
    if (!prefix && (inference || (config.invalidV1 && route.startsWith('/v1/')))) {
      return refuse('prefixes_invalid', request, url, route, { entries });
    }
    warnOnce(`invalid:${configured}`, 'EC2_PROXY_PREFIXES has entries that are not host + path prefixes (a host and a path, ' +
      'with no port, wildcard, quotes or spaces): they match nothing, and chat and inference answer 503 until they are fixed', { entries });
  }
  if (!prefix) return null;

  try {
    const secret = env.EC2_PROXY_SECRET;
    if (!secret) return refuse('secret_missing', request, url, route, { prefix });
    // Headers would throw on a control character or a character outside Latin-1 (error 1101 on
    // every forwarded path) and silently trim surrounding whitespace (another value than EC2 holds,
    // so EC2 refuses every forward). Such a secret is a misconfiguration like a missing one; its
    // value is never logged.
    if (!PLAIN_VALUE.test(String(secret))) return refuse('secret_invalid', request, url, route, { prefix });
    const origin = proxyOrigin(env.EC2_PROXY_ORIGIN);
    if (!origin) return refuse('origin_invalid', request, url, route, { prefix });
    // Pointed at a host this Worker answers, the forward would come straight back here.
    if (origin.host === url.host || WORKER_HOSTS.includes(origin.hostname)) return refuse('origin_loop', request, url, route, { prefix });
    // A Worker that still keeps sessions in KV mints sessions EC2 cannot see: every forwarded call
    // would answer 401 (CUTOVER.md, step 1 before step 2).
    if (env.SESSIONS_KV) return refuse('session_store_split', request, url, route, { prefix });

    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith(TRUSTED_PREFIX)) headers.delete(name);
    }
    // The target URL names EC2's host; the one the visitor asked for travels as x-zerox-host.
    headers.delete('host');
    const cf = request.cf || {};
    const ray = rayId(request);
    headers.set('x-zerox-host', url.host);
    headers.set('x-zerox-proto', url.protocol === 'http:' ? 'http' : 'https');
    setTrusted(headers, 'x-zerox-client-ip', request.headers.get('cf-connecting-ip'));
    setTrusted(headers, 'x-zerox-ray', ray);
    setTrusted(headers, 'x-zerox-country', cf.country);
    setTrusted(headers, 'x-zerox-city', encodedText(cf.city));
    setTrusted(headers, 'x-zerox-region', encodedText(cf.region));
    setTrusted(headers, 'x-zerox-asn', cf.asn);
    setTrusted(headers, 'x-zerox-as-org', encodedText(cf.asOrganization));
    headers.set('x-zerox-proxy-secret', String(secret));

    // Method, body (a stream, handed on unread) and the rest come from the client's request; its
    // signal is passed explicitly, so a client that leaves cancels the forward.
    const forward = new Request(origin.origin + url.pathname + url.search,
      new Request(request, { headers, redirect: 'manual', signal: request.signal }));
    return fetch(forward).then(response => {
      if (!originDown(response)) return response;
      // Only the status and a header were read; the error page is dropped unread.
      response.body?.cancel().catch(() => {});
      const requestId = newRequestId();
      console.warn('EC2 origin unreachable', { status: response.status, ray, request_id: requestId, host: url.host, prefix });
      return unavailable(route, { retryAfterSeconds: RETRY_ORIGIN_DOWN, requestId });
    }, error => {
      // The client left: nobody reads this answer, and it is not the origin's failure.
      if (request.signal?.aborted) return new Response(null, { status: 499 });
      const requestId = newRequestId();
      console.warn('EC2 proxy request failed', { name: error?.name, ray, request_id: requestId, host: url.host, prefix });
      return unavailable(route, { retryAfterSeconds: RETRY_ORIGIN_DOWN, requestId });
    });
  } catch (error) {
    // Building the forward threw (a header, the runtime): still the JSON 503, never error 1101's
    // HTML page or the Worker's own handler.
    return refuse('forward_failed', request, url, route, { prefix, name: error?.name });
  }
}

// The VM or its tunnel is down, as Cloudflare and cloudflared say it: 530 (error 1033, no
// connector for the tunnel) and the other 52x pages from the edge (524: no answer in time), or
// cloudflared's own 502 when nothing listens on 127.0.0.1:8787. Those are HTML or plain pages;
// passed on, the CLI would get a body that is none of errors.js's shapes, with no Retry-After.
// The gateway itself never answers 52x, and its own 5xx are JSON (errors.js) or an event stream.
function originDown(response) {
  const status = response.status;
  if (status >= 520 && status <= 530) return true;
  return status >= 500 && !/^(?:application\/json|text\/event-stream)\b/i.test(response.headers.get('content-type') || '');
}

/**
 * True on the Worker while the switch sends the chat route to EC2 (or holds an invalid entry):
 * the chat handler then refuses with the same JSON 503 instead of running (src/index.js), so a
 * spelling the switch did not recognise still never runs the chat pipeline on the Worker.
 */
export function chatRoutedToEc2(env) {
  const configured = env?.EC2_PROXY_PREFIXES;
  if (!configured || servingRuntime(env) === 'node') return false;
  const config = proxyConfig(configured);
  return config.chatRouted || config.invalid.length > 0;
}

// The chat handler's refusal on the Worker (chatRoutedToEc2).
export function chatRefusal(request) {
  const url = new URL(request.url);
  return refuse('chat_on_worker', request, url, routeKey(url.pathname));
}

// The switch as the operator's /health reports it (src/index.js): how many entries, which are
// invalid (1-based positions), whether chat is routed, and the reason every routed path is refused
// for, if any (the loop through the request's own host aside). No values.
export function proxyStatus(env) {
  const configured = env?.EC2_PROXY_PREFIXES;
  if (!configured) return { entries: 0, invalid: [], chat_routed: false, refusal: null };
  const config = proxyConfig(configured);
  const secret = env.EC2_PROXY_SECRET;
  const origin = proxyOrigin(env.EC2_PROXY_ORIGIN);
  const refusal = !secret ? 'secret_missing' : !PLAIN_VALUE.test(String(secret)) ? 'secret_invalid' : !origin ? 'origin_invalid'
    : WORKER_HOSTS.includes(origin.hostname) ? 'origin_loop' : env.SESSIONS_KV ? 'session_store_split'
      : config.invalid.length ? 'prefixes_invalid' : null;
  return { entries: config.prefixes.length + config.invalid.length, invalid: config.invalid.map(each => each.entry),
    chat_routed: config.chatRouted, refusal };
}

// Test hook.
export function resetEc2ProxyState() {
  warned.clear();
  parsed = { value: undefined };
}
