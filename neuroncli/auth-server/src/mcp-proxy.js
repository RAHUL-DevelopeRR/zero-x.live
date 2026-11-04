// Hosted connector endpoint https://zero-x.live/mcp/<connector_id> (docs/PLATFORM_CONTRACT.md
// section 14.4): a Streamable HTTP (MCP 2025-06-18) pass-through to the vendor's official remote
// MCP server, signed in as the user with the vendor tokens linked on the dashboard
// (src/routes/connectors.js). Served only with HOSTED_CONNECTORS=true; otherwise /mcp/* is 404.
//
// Per request: the Neuron credential (ses_ session or nzx_ key) → the plan's connector policy
// (policy.connectors.hosted) → the operator's vendor config → a per-user rate limit (shared by
// every runtime through zerox_connector_rate_take) → the user's link (403 needs_connect without
// one) → the tier of a tools/call (blocked tools are refused; destructive ones need
// `x-neuron-confirmed: 1`) → the vendor. The vendor's session id is never shown: the client gets a
// gateway session id mapped to it (and to the user and connector). tools/list answers lose blocked
// tools and carry each tool's tier as annotations and `_meta["live.zero-x/tier"]`: the catalog
// tier, made stricter (never looser) by the vendor's own destructiveHint/readOnlyHint
// (effectiveTier). Tools the vendor made stricter are remembered per user and connector, so a
// tools/call is checked against the same tier the client was shown. The gateway forwards the
// message it checked (re-serialized), never the raw body, so the vendor cannot read a different
// tool name out of the same bytes. Requests and answers are size-capped. Every JSON-RPC message the
// gateway handles writes one metadata-only audit row (zerox_connector_audit_add): method, tool
// name, tier, decision, status, duration, byte counts and the sha256 of the tool arguments, never
// argument or result text.
import { ApiError, backgroundRunner, resolveCaller } from './auth-context.js';
import { rpc } from './account-store.js';
import { TIERS, connectorConfig, effectiveTier, hostedConnector, stricterTier, toolTier } from './connector-catalog.js';
import { hostedConnectorsEnabled } from './connector-policy.js';
import {
  CONNECT_URL, ConnectorUnavailableError, connectorAccessToken, connectorsServing, planConnectorPolicy, policyAllowsHosted,
  revokeConnectorAccount,
} from './connector-accounts.js';
import { bytesToBase64 } from './provider-keys.js';
import { deleteRecord, readRecord, sha256Hex, writeRecord } from './session-store.js';

export const MCP_CREDENTIALS = Object.freeze(['session', 'api_key', 'dev']);
export const JSONRPC_CONFIRMATION_REQUIRED = -32010;
export const JSONRPC_TOOL_BLOCKED = -32011;
export const JSONRPC_TOO_LARGE = -32012;
export const TIER_META_KEY = 'live.zero-x/tier';
const SESSION_TTL_SECONDS = 24 * 3600;
const TOOL_TIERS_TTL_SECONDS = 7 * 24 * 3600;
const MAX_REMEMBERED_TOOLS = 1000;
const SESSION_PATTERN = /^zxs_[A-Za-z0-9_-]{43}$/;
const UPSTREAM_SESSION = /^[\x21-\x7e]{1,256}$/;
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RPM = 120;
const UPSTREAM_TIMEOUT_MS = 120_000;

const encoder = new TextEncoder();
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const boundedInt = (value, fallback, min, max) => {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
};
const maxRequestBytes = env => boundedInt(env?.HOSTED_CONNECTORS_MAX_REQUEST_BYTES, DEFAULT_MAX_REQUEST_BYTES, 1024, 16 * 1024 * 1024);
const maxResponseBytes = env => boundedInt(env?.HOSTED_CONNECTORS_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES, 1024, 64 * 1024 * 1024);
const requestsPerMinute = env => boundedInt(env?.HOSTED_CONNECTORS_RPM, DEFAULT_RPM, 1, 100_000);

// Flat JSON errors on /mcp/ (contract section 14.4): {"error": code, "message": ..., ...}.
function fail(status, error, message, extra = {}, headers = {}) {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
const needsConnect = connector => fail(403, 'needs_connect',
  `Connect ${connector.name} on the Zero-X dashboard first.`, { connect_url: CONNECT_URL });
const jsonRpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

// ── Per-user rate limit ──

// The shared limit: one counter per user in the database (zerox_connector_rate_take), so the
// Worker, the EC2 server and every isolate count together. Returns 0 (allowed) or the seconds to
// wait. When the database cannot answer, the per-isolate window below stands in for it.
export async function takeRateLimit(env, userId) {
  const limit = requestsPerMinute(env);
  try {
    const row = await rpc(env, 'zerox_connector_rate_take', { p_user_id: userId, p_limit: limit });
    if (row && typeof row.allowed === 'boolean') return row.allowed ? 0 : Math.max(1, Number(row.retry_after) || 1);
  } catch (error) {
    console.warn('Connector rate limit check failed', { message: String(error?.message).slice(0, 120) });
  }
  return takeLocalRateLimit(env, userId);
}

// Fixed one-minute window, per isolate (the fallback).
const windows = new Map(); // user id -> { start, count }
export function takeLocalRateLimit(env, userId, now = Date.now()) {
  const limit = requestsPerMinute(env);
  let entry = windows.get(userId);
  if (!entry || now - entry.start >= 60_000) {
    if (!entry && windows.size >= 10_000) windows.delete(windows.keys().next().value);
    entry = { start: now, count: 0 };
    windows.set(userId, entry);
  }
  if (entry.count >= limit) return Math.max(1, Math.ceil((entry.start + 60_000 - now) / 1000));
  entry.count += 1;
  return 0;
}
export function resetMcpRateLimits() {
  windows.clear();
}

// ── Audit (metadata only) ──

const pendingAudits = new Set();
function audit(c, row) {
  const promise = rpc(c.env, 'zerox_connector_audit_add', {
    p_user_id: row.userId, p_connector: row.connector, p_method: String(row.method || 'unknown').slice(0, 64),
    p_tool: row.tool ? String(row.tool).slice(0, 128) : null, p_tier: row.tier ?? null, p_decision: row.decision,
    p_status: row.status, p_duration_ms: Math.max(0, Math.round(row.durationMs ?? 0)), p_bytes_in: row.bytesIn ?? 0,
    p_bytes_out: row.bytesOut ?? 0, p_args_sha256: row.argsSha256 ?? null, p_error_class: row.errorClass ?? null,
  }).catch(error => {
    console.warn('Connector audit row failed', { message: String(error?.message).slice(0, 120) });
  }).finally(() => pendingAudits.delete(promise));
  pendingAudits.add(promise);
  backgroundRunner(c)?.(promise);
  return promise;
}
// Test hook: resolves once every audit write started so far has finished.
export async function mcpAuditSettled() {
  while (pendingAudits.size) await Promise.allSettled([...pendingAudits]);
}

// ── tools/list filtering ──

// Rewrites a tools/list result: blocked tools are left out and every other tool carries its tier
// (effectiveTier: the catalog tier, made stricter by the vendor's own hints) as annotations and
// _meta. Tools whose tier the vendor made stricter than the catalog's go into `stricter`
// (name -> tier) for the proxy to remember.
export function filterToolList(connector, result, stricter = new Map()) {
  if (!isObject(result) || !Array.isArray(result.tools)) return result;
  const tools = [];
  for (const tool of result.tools) {
    if (!isObject(tool) || typeof tool.name !== 'string') continue;
    const tier = effectiveTier(connector, tool);
    if (tier === 'blocked') continue;
    if (tier !== toolTier(connector, tool.name)) stricter.set(tool.name, tier);
    tools.push({
      ...tool,
      annotations: { ...(isObject(tool.annotations) ? tool.annotations : {}),
        readOnlyHint: tier === 'read', destructiveHint: tier === 'destructive', openWorldHint: true },
      _meta: { ...(isObject(tool._meta) ? tool._meta : {}), [TIER_META_KEY]: tier },
    });
  }
  return { ...result, tools };
}

// Tools the vendor marked stricter than the catalog, per user and connector (name -> tier).
const toolTiersKey = (userId, connectorId) => `mcp-tool-tiers:${userId}:${connectorId}`;
export async function rememberedToolTiers(env, userId, connectorId) {
  const record = await readRecord(env, toolTiersKey(userId, connectorId));
  const tools = isObject(record?.tools) ? record.tools : {};
  return Object.fromEntries(Object.entries(tools).filter(([, tier]) => TIERS.includes(tier)));
}
// Merges `stricter` into the remembered tiers (a remembered tier only ever gets stricter, so the
// pages of a paginated tools/list add up). Returns false when they could not be stored.
async function rememberToolTiers(env, userId, connectorId, stricter) {
  try {
    const tools = await rememberedToolTiers(env, userId, connectorId);
    let changed = false;
    for (const [name, tier] of stricter) {
      const next = stricterTier(tools[name] ?? tier, tier);
      if (tools[name] !== next) { tools[name] = next; changed = true; }
    }
    if (!changed) return true;
    const entries = Object.entries(tools);
    if (entries.length > MAX_REMEMBERED_TOOLS) return false;
    await writeRecord(env, toolTiersKey(userId, connectorId), { tools, updated: Date.now() }, TOOL_TIERS_TTL_SECONDS);
    return true;
  } catch (error) {
    console.warn('Connector tool tiers could not be stored', { connector: connectorId, name: error?.name });
    return false;
  }
}

// Rewrites one JSON-RPC message from the vendor (the answer to tools/list). The stricter tiers are
// stored before the answer goes out, so the client cannot call a tool before the gateway knows
// its tier; a tool whose stricter tier could not be stored is left out of the answer.
async function rewriteMessage(context, message) {
  const { connector, request } = context;
  if (request?.method === 'tools/list' && isObject(message) && message.id === request.id && isObject(message.result)) {
    const stricter = new Map();
    let result = filterToolList(connector, message.result, stricter);
    if (stricter.size && !await context.remember(stricter)) {
      result = { ...result, tools: result.tools.filter(tool => !stricter.has(tool.name)) };
    }
    return { ...message, result };
  }
  return message;
}

// ── Streams ──

// Relays a text/event-stream from the vendor, rewriting each event's JSON data and enforcing the
// size caps: `totalCap` (the answer to one POST) and `eventCap` (any single event, also on GET
// streams). Past a cap the stream ends, after a JSON-RPC error for the pending request if any.
function relayEvents(body, { connector, request, remember, totalCap, eventCap, onEnd }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytesIn = 0;
  let bytesOut = 0;
  let finished = false;
  let answered = false;
  const finish = reason => {
    if (finished) return;
    finished = true;
    onEnd({ reason, bytesOut });
  };
  const encodeEvent = async block => {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return block + '\n\n';
    let message;
    try { message = JSON.parse(data); } catch { return block + '\n\n'; }
    if (request?.id !== undefined && isObject(message) && message.id === request.id && !('method' in message)) answered = true;
    const rewritten = await rewriteMessage({ connector, request, remember }, message);
    if (rewritten === message) return block + '\n\n';
    return lines.filter(line => !line.startsWith('data:')).concat(`data: ${JSON.stringify(rewritten)}`).join('\n') + '\n\n';
  };
  const tooLarge = controller => {
    if (request?.id !== undefined && !answered) {
      const error = jsonRpcError(request.id, JSONRPC_TOO_LARGE, `The ${connector.name} answer was larger than Zero-X allows and was cut off.`);
      const chunk = encoder.encode(`event: message\ndata: ${JSON.stringify(error)}\n\n`);
      bytesOut += chunk.byteLength;
      controller.enqueue(chunk);
    }
    controller.close();
    reader.cancel().catch(() => {});
    finish('too_large');
  };
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch { controller.close(); finish('upstream_error'); return; }
        if (chunk.done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            const out = encoder.encode(await encodeEvent(buffer.replace(/(\r?\n)+$/, '')));
            bytesOut += out.byteLength;
            controller.enqueue(out);
          }
          controller.close();
          finish('end');
          return;
        }
        bytesIn += chunk.value.byteLength;
        if (totalCap && bytesIn > totalCap) return tooLarge(controller);
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        if (buffer.length > eventCap) return tooLarge(controller);
        if (!parts.length) continue;
        let text = '';
        for (const part of parts) text += await encodeEvent(part);
        const out = encoder.encode(text);
        bytesOut += out.byteLength;
        controller.enqueue(out);
        return;
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      finish('cancelled');
    },
  });
}

async function readCapped(body, cap) {
  if (!body) return { text: '', size: 0 };
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      reader.cancel().catch(() => {});
      return { tooLarge: true, size };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), size };
}

// ── Sessions: the client sees zxs_<random>, mapped to the vendor's session id ──

const randomId = () => 'zxs_' + bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function loadSession(env, id, userId, connectorId) {
  if (!SESSION_PATTERN.test(id)) return null;
  const record = await readRecord(env, `mcp-session:${id}`);
  if (!record || record.user_id !== userId || record.connector !== connectorId) return null;
  return typeof record.upstream === 'string' && UPSTREAM_SESSION.test(record.upstream) ? record : null;
}

// ── The endpoint ──

async function authenticate(c) {
  try {
    return { caller: await resolveCaller(c, { allow: MCP_CREDENTIALS }) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { response: fail(401, 'invalid_session', error.message, {}, { 'WWW-Authenticate': 'Bearer realm="zero-x", error="invalid_token"' }) };
    }
    if (error instanceof ApiError && error.status < 500) return { response: fail(error.status, error.code, error.message) };
    console.error('Hosted connector sign-in check failed', { name: error?.name });
    return { response: fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.') };
  }
}

function upstreamHeaders(c, token, upstreamSession, accept) {
  const headers = { Authorization: `Bearer ${token}`, Accept: accept };
  const version = c.req.header('MCP-Protocol-Version');
  if (version && PROTOCOL_VERSION.test(version)) headers['MCP-Protocol-Version'] = version;
  if (upstreamSession) headers['Mcp-Session-Id'] = upstreamSession;
  return headers;
}

async function handle(c) {
  const started = Date.now();
  const env = c.env;
  if (!hostedConnectorsEnabled(env)) return fail(404, 'not_found', 'Unknown API route.');
  const connector = hostedConnector(c.req.param('connector'));
  if (!connector) return fail(404, 'not_found', 'No such hosted connector.');
  if (!connectorsServing(env)) return fail(503, 'connectors_unavailable', 'Hosted connectors are not available on this gateway yet.');
  const method = c.req.method;
  if (!['GET', 'POST', 'DELETE'].includes(method)) return fail(405, 'method_not_allowed', 'Use POST, GET or DELETE.', {}, { Allow: 'GET, POST, DELETE' });

  const { caller, response } = await authenticate(c);
  if (response) return response;
  const userId = caller.user_id;
  if (caller.suspended) return fail(403, 'account_suspended', 'This account is suspended. Contact support@zero-x.live.');

  const base = { userId, connector: connector.id };
  let policy;
  try { policy = await planConnectorPolicy(env, caller.plan); }
  catch { return fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.'); }
  if (!policyAllowsHosted(policy, connector.id)) {
    audit(c, { ...base, method: method === 'POST' ? 'post' : method.toLowerCase(), decision: 'not_in_plan', status: 403, durationMs: Date.now() - started });
    return fail(403, 'not_in_plan', `${connector.name} is not included in your plan. Upgrade at https://zero-x.live/pricing.`,
      { upgrade_url: 'https://zero-x.live/pricing' });
  }
  const config = connectorConfig(env, connector);
  if (!config.configured) return fail(503, 'connector_not_configured', `${connector.name} is not available yet. Try again later.`);
  const retryAfter = await takeRateLimit(env, userId);
  if (retryAfter) {
    audit(c, { ...base, method: method.toLowerCase(), decision: 'rate_limited', status: 429, durationMs: Date.now() - started });
    return fail(429, 'rate_limited', 'Too many connector requests. Slow down and retry.',
      { retry_after_seconds: retryAfter }, { 'Retry-After': String(retryAfter) });
  }

  // The client's gateway session (required except to initialize).
  const clientSession = c.req.header('Mcp-Session-Id') || '';
  let session = null;
  if (clientSession) {
    try { session = await loadSession(env, clientSession, userId, connector.id); }
    catch { return fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.'); }
    if (!session) return fail(404, 'session_not_found', 'This connector session has ended. Initialize a new one.');
  }

  if (method === 'GET' || method === 'DELETE') {
    if (!session) return fail(400, 'session_required', 'Send the Mcp-Session-Id from initialize.');
    return forwardSessionRequest(c, { connector, config, base, session, clientSession, started });
  }
  return forwardPost(c, { connector, config, base, session, started });
}

const unreachable = connector => fail(502, 'upstream_unreachable', `${connector.name} could not be reached. Retry shortly.`);

// The user's vendor token: {current} ({token, link} or null when the link is gone for good) or
// {failure} when it is unavailable for now (the link is kept).
async function vendorToken(env, userId, connector, force = false) {
  try {
    return { current: await connectorAccessToken(env, userId, connector.id, { force }) };
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) return { failure: unreachable(connector) };
    console.error('Connector token lookup failed', { connector: connector.id, name: error?.name });
    return { failure: fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.') };
  }
}

// One fetch to the vendor; a 401 gets one retry with refreshed tokens. Returns {response} or
// {failure} (a Response to send as is). The link ends only when the vendor refuses it for good:
// the refresh grant refused, no refresh token (connectorAccessToken revokes those), or a freshly
// refreshed token answered 401 too. A token endpoint that is down answers 502 and keeps the link.
async function callVendor(c, { connector, config, base, init }) {
  let { current, failure } = await vendorToken(c.env, base.userId, connector);
  if (failure) return { failure };
  if (!current) return { failure: needsConnect(connector) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(config.mcpUrl, { ...init(current.token), redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch {
      return { failure: unreachable(connector) };
    }
    if (response.status !== 401) return { response };
    response.body?.cancel().catch(() => {});
    if (attempt === 0) {
      ({ current, failure } = await vendorToken(c.env, base.userId, connector, true));
      if (failure) return { failure };
      if (current) continue;
      return { failure: needsConnect(connector) };
    }
    // A freshly refreshed token refused as well: the vendor no longer accepts the link.
    await revokeConnectorAccount(c.env, base.userId, connector.id).catch(() => {});
    return { failure: needsConnect(connector) };
  }
  return { failure: needsConnect(connector) };
}

async function forwardPost(c, { connector, config, base, session, started }) {
  const env = c.env;
  const read = await readCapped(c.req.raw.body, maxRequestBytes(env));
  if (read.tooLarge) {
    audit(c, { ...base, method: 'post', decision: 'too_large', status: 413, bytesIn: read.size, durationMs: Date.now() - started });
    return fail(413, 'request_too_large', 'The MCP request is too large.');
  }
  let message;
  try { message = JSON.parse(read.text); } catch { message = null; }
  if (Array.isArray(message)) {
    return jsonResponse(jsonRpcError(null, -32600, 'JSON-RPC batches are not supported (MCP 2025-06-18).'), 400);
  }
  if (!isObject(message) || message.jsonrpc !== '2.0') {
    return jsonResponse(jsonRpcError(null, -32700, 'Send one JSON-RPC 2.0 message.'), 400);
  }
  const isRequest = typeof message.method === 'string' && message.id !== undefined && message.id !== null;
  const rpcMethod = typeof message.method === 'string' ? message.method : 'response';
  // A message outside a session (other than initialize) reaches the vendor without one; the vendor
  // decides whether it needs a session.
  const row = { ...base, method: rpcMethod, bytesIn: read.size };

  if (rpcMethod === 'tools/call') {
    const tool = typeof message.params?.name === 'string' ? message.params.name : '';
    // The catalog tier, made stricter by what the vendor's tools/list said about the tool.
    let tier = toolTier(connector, tool);
    if (tier !== 'blocked') {
      try { tier = stricterTier(tier, (await rememberedToolTiers(env, base.userId, connector.id))[tool]); }
      catch { return fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.'); }
    }
    row.tool = tool.slice(0, 128);
    row.tier = tier === 'blocked' ? null : tier;
    row.argsSha256 = await sha256Hex(JSON.stringify(message.params?.arguments ?? {}));
    if (tier === 'blocked') {
      audit(c, { ...row, decision: 'blocked', status: 200, durationMs: Date.now() - started });
      return jsonResponse(jsonRpcError(message.id, JSONRPC_TOOL_BLOCKED, `Zero-X does not allow ${tool} on hosted ${connector.name}.`,
        { reason: 'blocked', tool }));
    }
    if (tier === 'destructive' && c.req.header('x-neuron-confirmed') !== '1') {
      audit(c, { ...row, decision: 'needs_confirmation', status: 200, durationMs: Date.now() - started });
      return jsonResponse(jsonRpcError(message.id, JSONRPC_CONFIRMATION_REQUIRED,
        `${tool} can change or delete data in ${connector.name}. Approve the call in Neuron, then retry it with x-neuron-confirmed: 1.`,
        { reason: 'confirmation_required', tool, tier }));
    }
  }

  const { response: upstream, failure } = await callVendor(c, {
    connector, config, base,
    init: token => ({
      // The message that was checked, not the raw bytes (duplicate keys and other parser
      // differences cannot make the vendor read another tool than the one checked above).
      method: 'POST', body: JSON.stringify(message),
      headers: { ...upstreamHeaders(c, token, session?.upstream, 'application/json, text/event-stream'), 'Content-Type': 'application/json' },
    }),
  });
  if (failure) {
    audit(c, { ...row, decision: failure.status === 403 ? 'needs_connect' : 'upstream_error', status: failure.status,
      errorClass: failure.status === 403 ? null : 'unreachable', durationMs: Date.now() - started });
    return failure;
  }

  const headers = { 'Cache-Control': 'no-store' };
  // The vendor ended (or never had) the session: so does the gateway.
  if (upstream.status === 404 && session) {
    upstream.body?.cancel().catch(() => {});
    await deleteRecord(env, `mcp-session:${c.req.header('Mcp-Session-Id')}`).catch(() => {});
    audit(c, { ...row, decision: 'upstream_error', status: 404, errorClass: 'session_expired', durationMs: Date.now() - started });
    return fail(404, 'session_not_found', 'This connector session has ended. Initialize a new one.');
  }
  if (rpcMethod === 'initialize' && upstream.ok) {
    const upstreamSession = upstream.headers.get('Mcp-Session-Id');
    if (upstreamSession && UPSTREAM_SESSION.test(upstreamSession)) {
      const id = randomId();
      try {
        await writeRecord(env, `mcp-session:${id}`, { user_id: base.userId, connector: connector.id, upstream: upstreamSession,
          created: Date.now() }, SESSION_TTL_SECONDS);
      } catch {
        upstream.body?.cancel().catch(() => {});
        return fail(503, 'service_unavailable', 'Zero-X is temporarily unavailable. Please retry shortly.');
      }
      headers['Mcp-Session-Id'] = id;
    }
  } else if (session) {
    headers['Mcp-Session-Id'] = c.req.header('Mcp-Session-Id');
  }

  const contentType = (upstream.headers.get('Content-Type') || '').toLowerCase();
  const request = isRequest ? { id: message.id, method: rpcMethod } : null;
  const remember = stricter => rememberToolTiers(env, base.userId, connector.id, stricter);
  const cap = maxResponseBytes(env);
  const okDecision = upstream.ok ? 'allowed' : 'upstream_error';
  const errorClass = upstream.ok ? null : `http_${upstream.status}`;

  if (upstream.status === 202 || !upstream.body) {
    audit(c, { ...row, decision: okDecision, status: upstream.status, errorClass, durationMs: Date.now() - started });
    return new Response(null, { status: upstream.status === 202 ? 202 : upstream.status, headers });
  }
  if (contentType.startsWith('text/event-stream') && upstream.ok) {
    const stream = relayEvents(upstream.body, {
      connector, request, remember, totalCap: cap, eventCap: cap,
      onEnd: ({ reason, bytesOut }) => audit(c, { ...row, decision: reason === 'too_large' ? 'too_large' : 'allowed',
        status: upstream.status, bytesOut, errorClass: reason === 'upstream_error' ? 'stream_error' : null,
        durationMs: Date.now() - started }),
    });
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Type': 'text/event-stream' } });
  }
  const body = await readCapped(upstream.body, cap);
  if (body.tooLarge) {
    audit(c, { ...row, decision: 'too_large', status: 200, bytesOut: 0, durationMs: Date.now() - started });
    return jsonResponse(jsonRpcError(request?.id, JSONRPC_TOO_LARGE, `The ${connector.name} answer was larger than Zero-X allows.`), 200, headers);
  }
  let parsed = null;
  try { parsed = JSON.parse(body.text); } catch { /* not JSON */ }
  if (!contentType.startsWith('application/json') || !isObject(parsed) || parsed.jsonrpc !== '2.0') {
    // Anything but a JSON-RPC answer (an HTML error page, a vendor 5xx) is not passed on.
    audit(c, { ...row, decision: 'upstream_error', status: upstream.status, errorClass: errorClass ?? 'bad_response', durationMs: Date.now() - started });
    return fail(502, 'upstream_error', `${connector.name} answered with an error (${upstream.status}).`, { upstream_status: upstream.status });
  }
  const text = JSON.stringify(await rewriteMessage({ connector, request, remember }, parsed));
  audit(c, { ...row, decision: okDecision, status: upstream.status, errorClass, bytesOut: encoder.encode(text).byteLength,
    durationMs: Date.now() - started });
  return new Response(text, { status: upstream.status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// GET (the vendor's server-to-client stream) and DELETE (end the session).
async function forwardSessionRequest(c, { connector, config, base, session, clientSession, started }) {
  const method = c.req.method;
  const auditMethod = method === 'GET' ? 'stream' : 'session/delete';
  const { response: upstream, failure } = await callVendor(c, {
    connector, config, base,
    init: token => {
      const headers = upstreamHeaders(c, token, session.upstream, method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream');
      const lastEvent = c.req.header('Last-Event-ID');
      if (method === 'GET' && lastEvent && /^[\x21-\x7e]{1,256}$/.test(lastEvent)) headers['Last-Event-ID'] = lastEvent;
      return { method, headers };
    },
  });
  if (failure) {
    audit(c, { ...base, method: auditMethod, decision: failure.status === 403 ? 'needs_connect' : 'upstream_error',
      status: failure.status, durationMs: Date.now() - started });
    return failure;
  }
  const headers = { 'Cache-Control': 'no-store', 'Mcp-Session-Id': clientSession };
  if (method === 'DELETE' || upstream.status === 404) {
    upstream.body?.cancel().catch(() => {});
    await deleteRecord(c.env, `mcp-session:${clientSession}`).catch(() => {});
    audit(c, { ...base, method: auditMethod, decision: upstream.ok || upstream.status === 404 ? 'allowed' : 'upstream_error',
      status: upstream.status, durationMs: Date.now() - started });
    if (method === 'GET') return fail(404, 'session_not_found', 'This connector session has ended. Initialize a new one.');
    return new Response(null, { status: upstream.ok ? 204 : upstream.status === 405 ? 405 : 204, headers });
  }
  const contentType = (upstream.headers.get('Content-Type') || '').toLowerCase();
  if (!upstream.ok || !upstream.body || !contentType.startsWith('text/event-stream')) {
    upstream.body?.cancel().catch(() => {});
    audit(c, { ...base, method: auditMethod, decision: 'upstream_error', status: upstream.status,
      errorClass: `http_${upstream.status}`, durationMs: Date.now() - started });
    // 405: the vendor offers no server-to-client stream, which the client must accept.
    return new Response(null, { status: upstream.status === 405 ? 405 : 502, headers });
  }
  const stream = relayEvents(upstream.body, {
    connector, request: null, remember: async () => true, totalCap: 0, eventCap: maxResponseBytes(c.env),
    onEnd: ({ reason, bytesOut }) => audit(c, { ...base, method: auditMethod, decision: reason === 'too_large' ? 'too_large' : 'allowed',
      status: 200, bytesOut, durationMs: Date.now() - started }),
  });
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Type': 'text/event-stream' } });
}

export function registerMcpProxyRoutes(api) {
  api.all('/mcp/:connector', handle);
}
