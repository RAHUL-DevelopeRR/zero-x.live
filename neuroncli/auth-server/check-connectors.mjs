// Hosted connectors (docs/PLATFORM_CONTRACT.md section 14.4) on a real database: every migration on
// a fresh in-memory PGlite, the gateway on the local dev identity, a mock OAuth provider and a
// mock vendor MCP server behind a fetch stub. Nothing leaves the process.
// Run: node check-connectors.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import app from './src/index.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { clearIdentityCaches, devToken } from './src/auth-context.js';
import { connectorConfig, hostedConnector, toolTier } from './src/connector-catalog.js';
import { openConnectorTokens, sealConnectorTokens } from './src/connector-vault.js';
import { resetConnectorPolicyCache } from './src/connector-accounts.js';
import {
  JSONRPC_CONFIRMATION_REQUIRED, JSONRPC_TOO_LARGE, TIER_META_KEY, mcpAuditSettled, resetMcpRateLimits,
} from './src/mcp-proxy.js';
import { runScheduledMaintenance } from './src/routes/admin.js';

const base = 'http://127.0.0.1:8787';
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = text => createHash('sha256').update(text).digest('hex');

// ── Mock OAuth provider and vendor MCP server ──
const OAUTH = 'https://oauth.mock.test';
const VENDOR = 'https://mcp.mock.test/mcp';
const SENTINEL = 'SENTINEL-argument-text-7f3a';
const vendor = {
  challenges: new Map(), // code -> challenge
  valid: new Set(),
  issued: 0,
  refreshes: 0,
  refreshValid: new Set(),
  calls: [],
  sessions: new Set(),
  tokenRequests: [],
};
function issue() {
  vendor.issued += 1;
  const access = `gho_access${vendor.issued}`;
  const refresh = `ghr_refresh${vendor.issued}`;
  vendor.valid.add(access);
  vendor.refreshValid.add(refresh);
  return { access_token: access, refresh_token: refresh, expires_in: 3600, scope: 'repo,read:org', token_type: 'bearer' };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const TOOLS = [
  { name: 'list_issues', description: 'List issues', annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create an issue', annotations: { readOnlyHint: true } }, // lies about itself
  { name: 'delete_file', description: 'Delete a file' },
  { name: 'merge_pull_request', description: 'Merge' },
  { name: 'get_big', description: 'A large answer' },
];
async function vendorMcp(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer /, '');
  const session = request.headers.get('Mcp-Session-Id');
  const body = request.method === 'POST' ? await request.json() : null;
  vendor.calls.push({ method: request.method, token, session, rpc: body?.method, name: body?.params?.name,
    protocol: request.headers.get('MCP-Protocol-Version'), confirmed: request.headers.get('x-neuron-confirmed'),
    cookie: request.headers.get('Cookie') });
  if (!vendor.valid.has(token)) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.mock.test/.well-known"' } });
  if (request.method === 'GET') {
    if (!vendor.sessions.has(session)) return new Response('gone', { status: 404 });
    return new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (request.method === 'DELETE') { vendor.sessions.delete(session); return new Response(null, { status: 200 }); }
  if (body.method === 'initialize') {
    const id = `vendor-session-${vendor.sessions.size + 1}`;
    vendor.sessions.add(id);
    return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } },
      200, { 'Mcp-Session-Id': id, 'Set-Cookie': 'vendor=1' });
  }
  if (session && !vendor.sessions.has(session)) return new Response('gone', { status: 404 });
  if (body.id === undefined) return new Response(null, { status: 202 });
  if (body.method === 'tools/list') {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } });
    return new Response(`event: message\nid: 1\ndata: ${payload}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (body.method === 'tools/call') {
    if (body.params.name === 'get_big') {
      const big = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'x'.repeat(20000) }] } });
      return new Response(`data: ${big}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `ok:${body.params.name}` }] } });
  }
  return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } });
}
async function oauthToken(request) {
  const form = new URLSearchParams(await request.text());
  vendor.tokenRequests.push(Object.fromEntries(form));
  if (form.get('client_id') !== 'zx-test-client' || form.get('client_secret') !== 'zx-test-secret') return json({ error: 'invalid_client' }, 401);
  if (form.get('grant_type') === 'authorization_code') {
    const challenge = vendor.challenges.get(form.get('code'));
    vendor.challenges.delete(form.get('code'));
    if (!challenge || b64url(createHash('sha256').update(form.get('code_verifier') || '').digest()) !== challenge) return json({ error: 'invalid_grant' }, 400);
    if (form.get('redirect_uri') !== `${base}/api/connectors/callback`) return json({ error: 'invalid_grant' }, 400);
    return json(issue());
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (!vendor.refreshValid.delete(form.get('refresh_token'))) return json({ error: 'invalid_grant' }, 400);
    vendor.refreshes += 1;
    return json(issue());
  }
  return json({ error: 'unsupported_grant_type' }, 400);
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.url === `${OAUTH}/token` && request.method === 'POST') return oauthToken(request);
  if (request.url === VENDOR) return vendorMcp(request);
  if (request.url.startsWith('https://')) throw new Error(`Unexpected network call in a check: ${request.url}`);
  return realFetch(input, init);
};
// The user approves on the vendor's page: the vendor redirects with a code bound to the challenge.
function approveAtVendor(authorizeUrl) {
  const url = new URL(authorizeUrl);
  const code = 'code-' + randomBytes(8).toString('hex');
  vendor.challenges.set(code, url.searchParams.get('code_challenge'));
  return { code, state: url.searchParams.get('state') };
}

const pgEnv = { DATABASE_DRIVER: 'pglite', DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
const handle = await getPgliteHandle(pgEnv);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;
const KEK = randomBytes(32).toString('base64');
const onEnv = {
  ...pgEnv, HOSTED_CONNECTORS: 'true', CONNECTOR_TOKENS_KEK: KEK,
  CONNECTOR_GITHUB_CLIENT_ID: 'zx-test-client', CONNECTOR_GITHUB_CLIENT_SECRET: 'zx-test-secret',
  CONNECTOR_GITHUB_AUTHORIZE_URL: `${OAUTH}/authorize`, CONNECTOR_GITHUB_TOKEN_URL: `${OAUTH}/token`,
  CONNECTOR_GITHUB_MCP_URL: VENDOR, CONNECTORS_CALLBACK_URL: `${base}/api/connectors/callback`, CONNECTORS_RETURN_URL: '/dashboard',
};
const offEnv = { ...onEnv, HOSTED_CONNECTORS: 'false' };

const call = async (env, path, { method = 'GET', token, body, headers = {}, raw } = {}) => {
  const response = await app.request(base + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }, env);
  if (raw) return response;
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, headers: response.headers, body: parsed };
};
const mcp = (env, token, message, { session, confirmed, protocol = '2025-06-18' } = {}) => call(env, '/mcp/github', {
  method: 'POST', token, body: message,
  headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol,
    ...(session ? { 'Mcp-Session-Id': session } : {}), ...(confirmed ? { 'x-neuron-confirmed': confirmed } : {}) },
});
const sseMessages = text => String(text).split(/\n\n/).map(block => block.split('\n').filter(line => line.startsWith('data:'))
  .map(line => line.slice(5).trim()).join('\n')).filter(Boolean).map(data => JSON.parse(data));
const signIn = async email => {
  const minted = await call(onEnv, '/auth/cli/session', { method: 'POST', token: devToken(email), body: { machine_fingerprint: 'fp' } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  return minted.body.session_token;
};
const setPlan = async (email, plan) => {
  await sql('UPDATE public.zerox_accounts SET plan = $2 WHERE email = $1', [email, plan]);
  clearIdentityCaches();
};
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'neuron', version: '7' } } };

try {
  const proEmail = 'connectors-pro@example.test';
  const freeEmail = 'connectors-free@example.test';
  const proSession = await signIn(proEmail);
  const freeSession = await signIn(freeEmail);
  await setPlan(proEmail, 'pro');
  const proWeb = devToken(proEmail);
  const freeWeb = devToken(freeEmail);
  const [{ clerk_id: proId }] = await sql('SELECT clerk_id FROM public.zerox_accounts WHERE email = $1', [proEmail]);

  // ── Off by default: every new route is 404 ──
  for (const env of [pgEnv, offEnv]) {
    assert.equal((await call(env, '/api/connectors', { token: proWeb })).status, 404);
    assert.equal((await call(env, '/api/connectors/github/connect', { method: 'POST', token: proWeb, body: {} })).status, 404);
    assert.equal((await call(env, '/api/connectors/callback?state=x&code=y')).status, 404);
    assert.equal((await call(env, '/api/connectors/github', { method: 'DELETE', token: proWeb })).status, 404);
    const proxied = await mcp(env, proSession, initialize);
    assert.equal(proxied.status, 404);
    assert.equal(proxied.body.error, 'not_found');
    assert.equal((await call(env, '/neuroncli/auth-server/mcp/github', { method: 'POST', token: proSession, body: initialize })).status, 404);
    assert.deepEqual((await call(env, '/api/account', { token: proSession })).body.policy.connectors.hosted, [], 'no hosted ids while off');
  }
  assert.equal(vendor.calls.length + vendor.tokenRequests.length, 0, 'nothing reached a vendor while off');
  ok('HOSTED_CONNECTORS off (unset or false): /api/connectors/*, the callback and /mcp/<id> answer 404');

  // ── Catalog and config ──
  const github = hostedConnector('github');
  assert.equal(toolTier(github, 'list_issues'), 'read');
  assert.equal(toolTier(github, 'create_issue'), 'write');
  assert.equal(toolTier(github, 'delete_file'), 'destructive');
  assert.equal(toolTier(github, 'merge_pull_request'), 'destructive');
  assert.equal(toolTier(hostedConnector('slack'), 'slack_send_message'), 'external');
  assert.equal(connectorConfig({}, github).configured, false, 'no client id: not configured');
  assert.deepEqual(connectorConfig({}, github).missing, ['CONNECTOR_GITHUB_CLIENT_ID']);
  assert.deepEqual(connectorConfig({}, hostedConnector('atlassian')).missing.sort(), ['CONNECTOR_ATLASSIAN_AUTHORIZE_URL',
    'CONNECTOR_ATLASSIAN_CLIENT_ID', 'CONNECTOR_ATLASSIAN_MCP_URL', 'CONNECTOR_ATLASSIAN_SCOPES', 'CONNECTOR_ATLASSIAN_TOKEN_URL']);
  const insecure = connectorConfig({ ...onEnv, CONNECTOR_GITHUB_MCP_URL: 'http://evil.test/mcp' }, github);
  assert.equal(insecure.mcpUrl, null, 'a non-https override is no URL, not the default');
  assert.deepEqual(insecure.missing, ['CONNECTOR_GITHUB_MCP_URL']);
  assert.equal(connectorConfig({}, github).mcpUrl, 'https://api.githubcopilot.com/mcp/');
  assert.equal(connectorConfig(onEnv, github).configured, true);
  ok('catalog: tool tiers by name (vendor annotations ignored), per-connector env config, https only');

  // ── Envelope encryption ──
  const link = { id: crypto.randomUUID(), userId: proId, connector: 'github' };
  const sealed = await sealConnectorTokens(onEnv, link, { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: 123, extra: 'dropped' });
  assert.ok(!sealed.includes('tok-A') && !sealed.includes('ref-A'));
  assert.deepEqual(await openConnectorTokens(onEnv, link, sealed), { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: 123 });
  await assert.rejects(openConnectorTokens(onEnv, { ...link, id: crypto.randomUUID() }, sealed), 'another row id does not open');
  await assert.rejects(openConnectorTokens(onEnv, { ...link, connector: 'linear' }, sealed), 'another connector does not open');
  await assert.rejects(openConnectorTokens({ CONNECTOR_TOKENS_KEK: randomBytes(32).toString('base64') }, link, sealed), 'another KEK does not open');
  const parts = JSON.parse(sealed);
  assert.notEqual(parts.dek, (JSON.parse(await sealConnectorTokens(onEnv, link, { access_token: 'tok-A' }))).dek, 'a fresh data key per seal');
  ok('vault: per-row data key under CONNECTOR_TOKENS_KEK; row id, user and connector bound as additional data');

  // ── Listing and plan policy ──
  const freeList = await call(onEnv, '/api/connectors', { token: freeWeb });
  assert.equal(freeList.status, 200);
  assert.ok(freeList.body.connectors.every(connector => connector.status === 'not_in_plan' && connector.in_plan === false));
  const proList = await call(onEnv, '/api/connectors', { token: proWeb });
  const byId = Object.fromEntries(proList.body.connectors.map(connector => [connector.id, connector]));
  assert.equal(byId.github.status, 'not_connected');
  assert.equal(byId.github.endpoint, 'https://zero-x.live/mcp/github');
  assert.equal(byId.linear.status, 'unavailable', 'no OAuth app configured');
  assert.equal(proList.body.connect_url, 'https://zero-x.live/dashboard#connectors');
  assert.deepEqual((await call(onEnv, '/api/account', { token: proSession })).body.policy.connectors.hosted,
    ['atlassian', 'github', 'linear', 'notion', 'slack']);
  assert.equal((await call(onEnv, '/api/connectors', { token: 'nzx_' + 'a'.repeat(43) })).body.error.code, 'api_key_not_allowed',
    'API keys cannot manage connector links');
  assert.equal((await call(onEnv, '/api/connectors')).status, 401);
  ok('GET /api/connectors: Free sees not_in_plan everywhere; Pro sees github ready to connect, unconfigured vendors unavailable');

  // ── Free plan refused ──
  const freeConnect = await call(onEnv, '/api/connectors/github/connect', { method: 'POST', token: freeWeb, body: {} });
  assert.equal(freeConnect.status, 403);
  assert.equal(freeConnect.body.error.code, 'not_in_plan');
  const freeMcp = await mcp(onEnv, freeSession, initialize);
  assert.equal(freeMcp.status, 403);
  assert.equal(freeMcp.body.error, 'not_in_plan');
  assert.equal(vendor.calls.length, 0);
  ok('Free plan: connect and /mcp/github are refused (403 not_in_plan), nothing reaches the vendor');

  // ── 401 and needs_connect ──
  const anonymous = await mcp(onEnv, null, initialize);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'invalid_session');
  assert.match(anonymous.headers.get('WWW-Authenticate'), /^Bearer /);
  assert.equal((await mcp(onEnv, 'ses_not-a-real-session', initialize)).status, 401);
  assert.equal((await mcp(onEnv, proWeb.replace('dev_', 'sb_'), initialize)).status, 401, 'website tokens are not MCP credentials');
  const unlinked = await mcp(onEnv, proSession, initialize);
  assert.equal(unlinked.status, 403);
  assert.deepEqual(unlinked.body, { error: 'needs_connect', message: 'Connect GitHub on the Zero-X dashboard first.',
    connect_url: 'https://zero-x.live/dashboard#connectors' });
  ok('/mcp/github: 401 without a valid Neuron credential; 403 needs_connect before the account is linked');

  // ── Connect (OAuth with PKCE and state) ──
  const unknown = await call(onEnv, '/api/connectors/jira/connect', { method: 'POST', token: proWeb, body: {} });
  assert.equal(unknown.status, 404);
  const linear = await call(onEnv, '/api/connectors/linear/connect', { method: 'POST', token: proWeb, body: {} });
  assert.equal(linear.status, 503);
  assert.equal(linear.body.error.code, 'connector_not_configured');
  const started = await call(onEnv, '/api/connectors/github/connect', { method: 'POST', token: proWeb, body: {} });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const authorize = new URL(started.body.authorize_url);
  assert.equal(authorize.origin + authorize.pathname, `${OAUTH}/authorize`);
  assert.equal(authorize.searchParams.get('client_id'), 'zx-test-client');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/api/connectors/callback`);
  assert.equal(authorize.searchParams.get('scope'), 'repo read:org');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!started.body.authorize_url.includes('zx-test-secret'), 'the client secret never reaches the browser');
  const cookie = started.headers.get('Set-Cookie');
  assert.match(cookie, /^zx_connect=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const nonce = cookie.split(';')[0];
  const approved = approveAtVendor(started.body.authorize_url);

  // A callback without this browser's cookie (a link started by someone else) is refused.
  const otherBrowserStart = await call(onEnv, '/api/connectors/github/connect', { method: 'POST', token: proWeb, body: {} });
  const otherApproved = approveAtVendor(otherBrowserStart.body.authorize_url);
  const mismatch = await call(onEnv, `/api/connectors/callback?code=${otherApproved.code}&state=${otherApproved.state}`, { headers: { Cookie: nonce } });
  assert.equal(mismatch.status, 303);
  assert.equal(mismatch.headers.get('Location'), '/dashboard?connector=github&connect=error&reason=browser_mismatch#connectors');
  assert.equal(vendor.tokenRequests.length, 0, 'no token exchange without the browser cookie');

  const callback = await call(onEnv, `/api/connectors/callback?code=${approved.code}&state=${approved.state}`, { headers: { Cookie: nonce } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('Location'), '/dashboard?connector=github&connect=ok#connectors');
  assert.match(callback.headers.get('Set-Cookie'), /^zx_connect=; .*Max-Age=0/);
  assert.equal(vendor.tokenRequests.at(-1).grant_type, 'authorization_code');
  const replay = await call(onEnv, `/api/connectors/callback?code=${approved.code}&state=${approved.state}`, { headers: { Cookie: nonce } });
  assert.equal(replay.headers.get('Location'), '/dashboard?connect=error&reason=expired#connectors', 'state is single use');
  assert.equal((await call(onEnv, '/api/connectors/callback?state=bad')).headers.get('Location'), '/dashboard?connect=error&reason=invalid_state#connectors');

  const rows = await sql('SELECT * FROM public.zerox_connector_accounts WHERE user_id = $1 AND revoked_at IS NULL', [proId]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].scopes, ['repo', 'read:org']);
  assert.ok(!rows[0].enc_refresh_token.includes('gho_access1') && !rows[0].enc_refresh_token.includes('ghr_refresh1'), 'tokens are stored sealed');
  const linked = await call(onEnv, '/api/connectors', { token: proWeb });
  const githubRow = linked.body.connectors.find(connector => connector.id === 'github');
  assert.equal(githubRow.status, 'connected');
  assert.deepEqual(githubRow.scopes, ['repo', 'read:org']);
  assert.ok(!JSON.stringify(linked.body).includes('gho_') && !JSON.stringify(linked.body).includes('ghr_'), 'no token in the list');
  ok('connect: authorize URL with PKCE S256 and state, HttpOnly browser cookie, single-use state, tokens sealed, list shows connected');

  // ── Calls through the proxy ──
  const init = await mcp(onEnv, proSession, initialize);
  assert.equal(init.status, 200, JSON.stringify(init.body));
  assert.equal(init.body.result.serverInfo.name, 'mock');
  const session = init.headers.get('Mcp-Session-Id');
  assert.match(session, /^zxs_[A-Za-z0-9_-]{43}$/);
  assert.equal(init.headers.get('Set-Cookie'), null, 'vendor headers are not passed on');
  const first = vendor.calls.at(-1);
  assert.equal(first.token, 'gho_access1', 'the vendor sees the linked token');
  assert.equal(first.protocol, '2025-06-18');
  assert.equal(first.session, null);

  const listed = await call(onEnv, '/mcp/github', { method: 'POST', token: proSession,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { 'Mcp-Session-Id': session, Accept: 'application/json, text/event-stream' } });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(vendor.calls.at(-1).session, 'vendor-session-1', 'the gateway session maps to the vendor session');
  const [toolList] = sseMessages(listed.body);
  const tools = Object.fromEntries(toolList.result.tools.map(tool => [tool.name, tool]));
  assert.equal(tools.create_issue.annotations.readOnlyHint, false, "the catalog tier overrides the vendor's own hint");
  assert.equal(tools.create_issue._meta[TIER_META_KEY], 'write');
  assert.equal(tools.list_issues.annotations.readOnlyHint, true);
  assert.equal(tools.delete_file.annotations.destructiveHint, true);
  assert.equal(tools.delete_file._meta[TIER_META_KEY], 'destructive');

  const created = await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_issue', arguments: { title: SENTINEL } } }, { session });
  assert.equal(created.status, 200);
  assert.equal(created.body.result.content[0].text, 'ok:create_issue');
  assert.equal(created.headers.get('Mcp-Session-Id'), session);
  ok('call: initialize maps a gateway session id to the vendor session; tools/list carries catalog tiers; tools/call reaches the vendor');

  // ── Destructive tools need x-neuron-confirmed: 1 ──
  const before = vendor.calls.length;
  const refused = await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_file', arguments: { path: SENTINEL } } }, { session });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.id, 4);
  assert.equal(refused.body.error.code, JSONRPC_CONFIRMATION_REQUIRED);
  assert.equal(refused.body.error.data.reason, 'confirmation_required');
  assert.equal(vendor.calls.length, before, 'the vendor never saw the unconfirmed call');
  assert.equal((await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'merge_pull_request', arguments: {} } },
    { session, confirmed: 'yes' })).body.error.code, JSONRPC_CONFIRMATION_REQUIRED, 'only the value 1 confirms');
  const confirmed = await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_file', arguments: { path: 'a' } } },
    { session, confirmed: '1' });
  assert.equal(confirmed.body.result.content[0].text, 'ok:delete_file');
  assert.equal(vendor.calls.at(-1).confirmed, null, 'the confirmation header stays at the gateway');
  ok('destructive tools: refused with a JSON-RPC confirmation error unless x-neuron-confirmed: 1');

  // ── Sessions belong to their user; size cap; GET stream; nzx_ key ──
  const otherEmail = 'connectors-other@example.test';
  const otherSession = await signIn(otherEmail);
  await setPlan(otherEmail, 'pro');
  const stolen = await mcp(onEnv, otherSession, { jsonrpc: '2.0', id: 7, method: 'tools/list' }, { session });
  assert.equal(stolen.status, 404, "another user's session id is unknown");
  assert.equal(stolen.body.error, 'session_not_found');
  assert.equal((await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 8, method: 'tools/list' }, { session: 'zxs_' + 'x'.repeat(43) })).status, 404);

  const capped = await mcp({ ...onEnv, HOSTED_CONNECTORS_MAX_RESPONSE_BYTES: '4096' }, proSession,
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_big', arguments: {} } }, { session });
  const cappedMessages = sseMessages(capped.body);
  assert.equal(cappedMessages.length, 1);
  assert.equal(cappedMessages[0].error.code, JSONRPC_TOO_LARGE);
  const tooBig = await mcp({ ...onEnv, HOSTED_CONNECTORS_MAX_REQUEST_BYTES: '1024' }, proSession,
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_issue', arguments: { body: 'y'.repeat(4000) } } }, { session });
  assert.equal(tooBig.status, 413);
  assert.equal((await mcp(onEnv, proSession, [initialize])).status, 400, 'batches are refused');

  const stream = await call(onEnv, '/mcp/github', { token: proSession, headers: { 'Mcp-Session-Id': session, Accept: 'text/event-stream' } });
  assert.equal(stream.status, 200);
  assert.equal(sseMessages(stream.body)[0].method, 'notifications/tools/list_changed');
  assert.equal((await call(onEnv, '/mcp/github', { token: proSession })).status, 400, 'GET needs a session');

  const key = await call(onEnv, '/api/keys', { method: 'POST', token: proWeb, body: { name: 'ci' } });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  const viaKey = await mcp(onEnv, key.body.secret,{ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_issues', arguments: {} } }, { session });
  assert.equal(viaKey.body.result.content[0].text, 'ok:list_issues', 'an nzx_ key of the same account uses the session');
  ok('sessions are bound to user and connector; request and answer size caps; GET stream relayed; nzx_ keys accepted');

  // ── Expired vendor token: refreshed once, then retried ──
  vendor.valid.delete('gho_access1');
  const refreshed = await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'list_issues', arguments: {} } }, { session });
  assert.equal(refreshed.body.result.content[0].text, 'ok:list_issues');
  assert.equal(vendor.refreshes, 1);
  assert.equal(vendor.calls.at(-1).token, 'gho_access2');
  const [rotated] = await sql('SELECT enc_refresh_token FROM public.zerox_connector_accounts WHERE user_id = $1 AND revoked_at IS NULL', [proId]);
  assert.notEqual(rotated.enc_refresh_token, rows[0].enc_refresh_token, 'the refreshed tokens are stored');
  ok('a vendor 401 refreshes the tokens (refresh_token grant), stores them sealed and retries once');

  // ── Rate limit ──
  resetMcpRateLimits();
  const limited = { ...onEnv, HOSTED_CONNECTORS_RPM: '2' };
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await mcp(limited, proSession, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session })).status, 202);
  }
  const throttled = await mcp(limited, proSession, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error, 'rate_limited');
  assert.ok(Number(throttled.headers.get('Retry-After')) >= 1);
  resetMcpRateLimits();
  ok('per-user rate limit: 429 with Retry-After past HOSTED_CONNECTORS_RPM');

  // ── Audit rows: metadata only ──
  await mcpAuditSettled();
  const audits = await sql('SELECT * FROM public.zerox_connector_audit WHERE user_id = $1 ORDER BY id', [proId]);
  assert.ok(audits.length >= 10);
  assert.ok(!JSON.stringify(audits).includes(SENTINEL), 'no argument text in the audit log');
  const unconfirmed = audits.find(row => row.decision === 'needs_confirmation' && row.tool === 'delete_file');
  assert.equal(unconfirmed.tier, 'destructive');
  assert.equal(unconfirmed.args_sha256, sha256(JSON.stringify({ path: SENTINEL })));
  assert.ok(audits.some(row => row.decision === 'allowed' && row.tool === 'create_issue' && row.tier === 'write' && row.bytes_out > 0));
  assert.ok(audits.some(row => row.decision === 'too_large'));
  assert.ok(audits.some(row => row.decision === 'rate_limited'));
  assert.ok(audits.some(row => row.method === 'stream'));
  assert.deepEqual(Object.keys(audits[0]).sort(), ['args_sha256', 'bytes_in', 'bytes_out', 'connector', 'created_at', 'decision',
    'duration_ms', 'error_class', 'id', 'method', 'status', 'tier', 'tool', 'user_id']);
  await sql("UPDATE public.zerox_connector_audit SET created_at = now() - interval '31 days' WHERE id = $1", [audits[0].id]);
  await runScheduledMaintenance(onEnv);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_connector_audit WHERE id = $1', [audits[0].id]))[0].n, 0,
    'the maintenance purges rows older than 30 days');
  ok('audit: one metadata row per handled message (decision, tier, sha256 of the arguments), no argument text, 30-day purge');

  // ── Disconnect, then needs_connect ──
  const sessionEnded = await call(onEnv, '/mcp/github', { method: 'DELETE', token: proSession, headers: { 'Mcp-Session-Id': session } });
  assert.equal(sessionEnded.status, 204);
  assert.equal(vendor.sessions.has('vendor-session-1'), false, 'DELETE ends the vendor session');
  assert.equal((await mcp(onEnv, proSession, { jsonrpc: '2.0', id: 13, method: 'tools/list' }, { session })).status, 404);
  const disconnected = await call(onEnv, '/api/connectors/github', { method: 'DELETE', token: proWeb });
  assert.deepEqual(disconnected.body, { status: 'disconnected', connector: 'github' });
  assert.equal((await call(onEnv, '/api/connectors/github', { method: 'DELETE', token: proWeb })).status, 404);
  const afterRevoke = await mcp(onEnv, proSession, initialize);
  assert.equal(afterRevoke.status, 403);
  assert.equal(afterRevoke.body.error, 'needs_connect');
  assert.equal((await call(onEnv, '/api/connectors', { token: proWeb })).body.connectors.find(row => row.id === 'github').status, 'not_connected');
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_connector_accounts WHERE user_id = $1 AND revoked_at IS NOT NULL', [proId]))[0].n, 1,
    'revoked rows are kept as a record, sealed');
  ok('disconnect: the link is revoked and the next call answers 403 needs_connect');

  // ── A vendor that refuses the link (revoked at the vendor) also ends it ──
  const again = await call(onEnv, '/api/connectors/github/connect', { method: 'POST', token: proWeb, body: {} });
  const againApproved = approveAtVendor(again.body.authorize_url);
  await call(onEnv, `/api/connectors/callback?code=${againApproved.code}&state=${againApproved.state}`, { headers: { Cookie: again.headers.get('Set-Cookie').split(';')[0] } });
  assert.equal((await mcp(onEnv, proSession, initialize)).status, 200);
  vendor.valid.clear();
  vendor.refreshValid.clear();
  const dead = await mcp(onEnv, proSession, initialize);
  assert.equal(dead.status, 403);
  assert.equal(dead.body.error, 'needs_connect');
  assert.equal((await call(onEnv, '/api/connectors', { token: proWeb })).body.connectors.find(row => row.id === 'github').status, 'not_connected');
  ok('a vendor that refuses both the token and its refresh: the link is revoked, needs_connect');

  // ── Downgrade to Free: the link stays but the proxy refuses ──
  await setPlan(proEmail, 'free');
  resetConnectorPolicyCache(onEnv);
  assert.equal((await mcp(onEnv, proSession, initialize)).body.error, 'not_in_plan');
  ok('a plan without the connector in policy.connectors.hosted is refused even with a link');

  console.log(`\n${passed.length} connector checks passed`);
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}
