/**
 * Request limits shared by both runtimes (security audit 2026-11-05, F2, F5 and F16): body size
 * per route, the client address for per-IP limits, fixed-window limiters per isolate, and the
 * slots for the anonymous /v1/models/stream. Every limit is an environment variable with a default
 * (GATEWAY_SETUP.md, "Gateway limits"); a value that is not a positive integer keeps the default.
 *
 * Both runtimes count bytes: server.js (declared Content-Length first, then the bytes read) and the
 * app (declared length first, then readBodyWithin for a chunked body or an understated length), so
 * a Worker body sent without Content-Length is also bounded before auth.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

// Hono serves the API at the root and under the legacy mount (src/index.js API_MOUNT).
const API_MOUNT = '/neuroncli/auth-server';
const CHAT_ROUTE = '/v1/chat/completions';
// The chat handler's legacy aliases (src/index.js) and the Anthropic-shaped route, when it exists.
const CHAT_SIZED = new Set([CHAT_ROUTE, '/v1/messages', '/auth/azure/proxy', '/auth/azure/chat/completions']);

export const positiveInt = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

/**
 * The body limits in bytes: BODY_LIMIT_BYTES (64 KiB) for every route, CHAT_BODY_LIMIT_BYTES
 * (2 MiB) for the chat routes and the relay. 2 MiB is the limit production enforced before this
 * module existed, so no released client loses a request: Neuron alpha 4 sends 15-20 KB per
 * turn (measured with the a4-compat harness), and its own preflight caps a conversation at the
 * model's context window (131,072 tokens on the Groq routes, about 0.5-0.6 MB of JSON), so 2 MiB
 * leaves three times that. The chat limit is never below the default.
 */
export function bodyLimits(env = {}) {
  const fallback = positiveInt(env.BODY_LIMIT_BYTES, 64 * KIB);
  return { default: fallback, chat: Math.max(fallback, positiveInt(env.CHAT_BODY_LIMIT_BYTES, 2 * MIB)) };
}

// The Razorpay webhook route keeps its own 256 KiB cap (src/routes/webhooks.js MAX_WEBHOOK_BYTES).
const WEBHOOK_LIMIT = 256 * KIB;
export const isWebhookPath = pathname => {
  let path = String(pathname || '');
  if (path.startsWith(API_MOUNT + '/')) path = path.slice(API_MOUNT.length);
  return path.startsWith('/webhooks/');
};

export const isChatSizedPath = pathname => {
  let path = String(pathname || '');
  if (path.startsWith(API_MOUNT + '/')) path = path.slice(API_MOUNT.length);
  return CHAT_SIZED.has(path) || path.startsWith('/relay/') || path === '/v1/relay';
};

export function bodyLimitFor(pathname, env = {}) {
  const limits = bodyLimits(env);
  if (isChatSizedPath(pathname)) return limits.chat;
  return isWebhookPath(pathname) ? Math.max(limits.default, WEBHOOK_LIMIT) : limits.default;
}

/**
 * The declared Content-Length when it is above `limit`, otherwise null. A header that is not a
 * non-negative integer is left to the runtime (Node's parser refuses it with a 400).
 */
export function declaredBodyOver(headers, limit) {
  const raw = typeof headers?.get === 'function' ? headers.get('content-length') : headers?.['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{1,20}$/.test(text)) return null;
  const length = Number(text);
  return length > limit ? length : null;
}

/**
 * Reads a request body while counting its bytes, and stops at the first byte over `limit` (the
 * stream is cancelled, so nothing more is buffered). Returns { bytes } with the whole body,
 * { bytes: null } when the request has no body, or { tooLarge: true }. Used for bodies sent
 * without a usable Content-Length (chunked) and for a declared length that understates the body.
 */
export async function readBodyWithin(request, limit, { timeoutMs = 0 } = {}) {
  if (!request.body) return { bytes: null };
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  let timer;
  const deadline = timeoutMs > 0 ? new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); }) : null;
  try {
    for (;;) {
      const step = reader.read();
      const result = deadline ? await Promise.race([step, deadline]) : await step;
      if (result.timedOut) {
        step.catch(() => {});
        reader.cancel().catch(() => {});
        return { timedOut: true };
      }
      const { done, value } = result;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      parts.push(value);
    }
  } catch {
    // The connection broke or the stream errored mid-body.
    return { failed: true };
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock?.(); } catch { /* a read is still pending after a timeout */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return { bytes };
}

/** Longest a client may take to deliver a body the gateway buffers (BODY_READ_TIMEOUT_MS, default 30 s). */
export const bodyReadTimeoutMs = env => positiveInt(env?.BODY_READ_TIMEOUT_MS, 30000);

export const newRequestId = () => 'req_' + crypto.randomUUID().replace(/-/g, '');

/**
 * The gateway's 413 (docs/PLATFORM_CONTRACT.md §3.3, code request_too_large), built without Hono so
 * the Worker's proxy switch and the Node server can answer before the app runs. The limit is named
 * in the message so a client knows what to shorten.
 */
export function bodyTooLargeBody(limit, requestId = newRequestId()) {
  return { error: { message: `The request body is larger than this route allows (${limit} bytes). Shorten it and retry.`,
    type: 'invalid_request_error', code: 'request_too_large', param: null, request_id: requestId } };
}

export function bodyTooLargeResponse(limit, { headers = {} } = {}) {
  const body = bodyTooLargeBody(limit);
  return new Response(JSON.stringify(body), { status: 413, headers: { 'Content-Type': 'application/json',
    'Cache-Control': 'no-store', 'X-Request-Id': body.error.request_id, ...headers } });
}

/**
 * The visitor's address for per-IP limits: server.js sets x-neuron-client-ip from the socket (or
 * CF-Connecting-IP behind the tunnel, TRUST_CLOUDFLARE) and drops any client copy; Cloudflare sets
 * cf-connecting-ip on the Worker. Unknown addresses share one bucket.
 */
export function clientAddress(c) {
  const header = c.env?.NEURON_RUNTIME === 'node' ? 'x-neuron-client-ip' : 'cf-connecting-ip';
  return (c.req.header(header) || 'unknown').slice(0, 64);
}

/**
 * Fixed-window limiter per key, per isolate, as src/routes/device.js uses: returns the seconds to
 * wait, or 0 when the request may proceed. At most `max` keys are kept (the oldest goes first).
 */
export function windowLimiter(limit, windowMs, { max = 10000 } = {}) {
  const windows = new Map();
  const take = (key, now = Date.now()) => {
    const entry = windows.get(key);
    if (!entry || entry.reset <= now) {
      if (windows.size >= max) windows.delete(windows.keys().next().value);
      windows.set(key, { count: 1, reset: now + windowMs });
      return 0;
    }
    if (entry.count >= limit) return Math.ceil((entry.reset - now) / 1000);
    entry.count++;
    return 0;
  };
  // The wait the key would get now, without counting a request.
  take.peek = (key, now = Date.now()) => {
    const entry = windows.get(key);
    return entry && entry.reset > now && entry.count >= limit ? Math.ceil((entry.reset - now) / 1000) : 0;
  };
  take.reset = () => windows.clear();
  take.size = () => windows.size;
  return take;
}

/**
 * Slots for the catalog stream (/v1/models/stream): at most MODELS_STREAM_PER_IP (4) anonymous
 * streams per address and MODELS_STREAM_MAX (500) streams per process, credentialed ones included.
 * take() returns null and holds a slot, or the seconds a client should wait (Retry-After); the
 * returned release() frees the slot once (idempotent).
 */
export function streamSlots({ perIp = 4, max = 500 } = {}) {
  const perAddress = new Map();
  let total = 0;
  return {
    take(address, { anonymous = true } = {}) {
      if (total >= max) return { retryAfterSeconds: 30 };
      const held = perAddress.get(address) || 0;
      if (anonymous && held >= perIp) return { retryAfterSeconds: 15 };
      total += 1;
      perAddress.set(address, held + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const left = (perAddress.get(address) || 1) - 1;
          if (left <= 0) perAddress.delete(address); else perAddress.set(address, left);
        },
      };
    },
    count: () => total,
    heldBy: address => perAddress.get(address) || 0,
    reset() { perAddress.clear(); total = 0; },
  };
}

export function streamLimits(env = {}) {
  return { perIp: positiveInt(env.MODELS_STREAM_PER_IP, 4), max: positiveInt(env.MODELS_STREAM_MAX, 500) };
}

// The slots of this isolate (audit F2): MODELS_STREAM_PER_IP anonymous streams per address and
// MODELS_STREAM_MAX in all, then 429 with Retry-After. The limits are read once per isolate.
let streamSlotsOfIsolate = null;
export const modelStreamSlots = env => (streamSlotsOfIsolate ||= streamSlots(streamLimits(env)));
export const resetModelStreamSlots = () => { streamSlotsOfIsolate = null; };

/**
 * True when `value` (parsed JSON) nests objects or arrays deeper than `limit` levels. Iterative: the
 * recursive JSON.stringify of the prompt estimate throws on a body that nests tens of thousands of
 * levels (a 1 MiB body can), which used to answer 503 (audit 3b). Real tool schemas nest a few levels;
 * the limit is MAX_JSON_DEPTH (128).
 */
export function jsonNestingExceeds(value, limit = 128) {
  if (value === null || typeof value !== 'object') return false;
  let level = [value];
  for (let depth = 1; level.length; depth++) {
    if (depth > limit) return true;
    const next = [];
    for (const item of level) {
      for (const child of Array.isArray(item) ? item : Object.values(item)) {
        if (child !== null && typeof child === 'object') next.push(child);
      }
    }
    level = next;
  }
  return false;
}
