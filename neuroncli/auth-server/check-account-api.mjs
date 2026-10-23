// WP-B3: auth context, CORS, /api/* account routes, API keys, sessions, health, 404 and clean
// URLs, against a stubbed PostgREST (docs/PLATFORM_CONTRACT.md §3-4). Run: node check-account-api.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import app from './src/index.js';
import { DEVELOPMENT_PLANS } from './src/plan-policy.js';
import { devToken, devUserId, resolveCaller } from './src/auth-context.js';
import { openSession, rearmRecord, sealSession } from './src/session-store.js';
import { runScheduledMaintenance } from './src/routes/admin.js';
import { v1ModelsPayload } from './src/routes/plans.js';
import { credentialExpiresAt, displayName, initials } from './src/routes/account.js';
import { overviewPools } from './src/routes/admin.js';
import { ProviderHealthTracker, FailureKind } from './src/provider-health.js';
import { B1_KEY_PREFIX, planPolicyRows } from './contract-rows.mjs';

// zerox_plan_policies_v2 rows exactly as WP-B1 returns them; the account overview's policy
// column is one of these rows (to_jsonb of zerox_plan_policies_v2).
const B1_POLICY_ROWS = await planPolicyRows();
const b1Policy = (plan, overrides = {}) => ({ ...(B1_POLICY_ROWS.find(row => row.plan === plan) ||
  B1_POLICY_ROWS.find(row => row.plan === 'free')), ...overrides });

const require = createRequire(import.meta.url);
const SUPABASE_URL = 'https://accounts.supabase.test';
const SECRET = 'sb_secret_account_api_test';
const OPERATOR = 'operator-'.padEnd(48, 'k');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const originalFetch = globalThis.fetch;
const DAY = 86400000;
const today = new Date(Math.floor(Date.now() / DAY) * DAY).toISOString().slice(0, 10);
const dayOffset = days => new Date(Date.parse(today + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);

// ── Stubbed PostgREST with in-memory state for every RPC this package calls ──
function fakeDatabase() {
  const accounts = new Map();
  const keys = [];
  const sessionIndex = [];
  const calls = [];
  const usage = { series: [], byModel: [], events: [] };
  const state = { accounts, keys, sessionIndex, calls, usage, policiesV2: [], policyOverrides: {}, fail: new Set(), store: new Map(), onRevokeAll: null };
  const raise = message => Object.assign(new Error(message), { raise: message });
  const overview = account => {
    const policy = { ...b1Policy(account.plan), ...(state.policyOverrides[account.plan] || {}) };
    return [{
    account,
    policy,
    credits: { balance_microusd: account.credit_balance_microusd ?? 0, monthly_grant_microusd: policy.monthly_credit_microusd },
    subscription: account.subscription ?? null,
    usage_today: { requests: account.daily_requests, tokens: account.daily_tokens_used, resets_at: `${dayOffset(1)}T00:00:00.000Z` },
  }];
  };
  const rpc = {
    zerox_sync_account: ({ p_user_id, p_profile, p_plan }) => {
      const existing = accounts.get(p_user_id);
      const row = {
        clerk_id: p_user_id, email: p_profile.email || '', name: p_profile.name || '', first_name: '', last_name: '',
        image_url: p_profile.imageUrl || '', plan: existing?.plan ?? p_plan ?? 'free',
        daily_requests: existing?.daily_requests ?? 0, daily_tokens_used: existing?.daily_tokens_used ?? 0,
        credit_balance_microusd: existing?.credit_balance_microusd ?? 0, subscription: existing?.subscription ?? null,
        suspended: existing?.suspended ?? false,
      };
      accounts.set(p_user_id, row);
      return [row];
    },
    zerox_get_account: ({ p_user_id }) => accounts.has(p_user_id) ? [accounts.get(p_user_id)] : [],
    zerox_plan_policies: () => [{ policies: DEVELOPMENT_PLANS }],
    zerox_plan_policies_v2: () => state.policiesV2,
    zerox_account_overview: ({ p_user_id }) => accounts.has(p_user_id) ? overview(accounts.get(p_user_id)) : [],
    zerox_api_key_create: ({ p_user_id, p_name, p_prefix, p_hash }) => {
      // WP-B1 argument checks (zerox_api_key_create).
      if (typeof p_name !== 'string' || p_name.trim().length < 1 || p_name.trim().length > 64) throw raise('invalid_key_name');
      if (typeof p_prefix !== 'string' || !B1_KEY_PREFIX.test(p_prefix)) throw raise('invalid_key_prefix');
      if (typeof p_hash !== 'string' || !/^[a-f0-9]{64}$/.test(p_hash)) throw raise('invalid_key_hash');
      if (!accounts.has(p_user_id)) throw raise('account_not_found');
      if (keys.filter(key => key.user_id === p_user_id && !key.revoked_at).length >= 10) throw raise('too_many_keys');
      const key = { id: crypto.randomUUID(), user_id: p_user_id, name: p_name, prefix: p_prefix, hash: p_hash,
        created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
      keys.push(key);
      return [{ id: key.id, name: key.name, prefix: key.prefix, created_at: key.created_at }];
    },
    zerox_api_key_list: ({ p_user_id }) => keys.filter(key => key.user_id === p_user_id)
      .map(({ hash, user_id, ...key }) => key),
    zerox_api_key_revoke: ({ p_user_id, p_key_id }) => {
      const key = keys.find(entry => entry.id === p_key_id && entry.user_id === p_user_id && !entry.revoked_at);
      if (key) key.revoked_at = new Date().toISOString();
      return [{ revoked: !!key }];
    },
    zerox_api_key_verify: ({ p_hash }) => {
      const key = keys.find(entry => entry.hash === p_hash && !entry.revoked_at);
      if (key) key.last_used_at = new Date().toISOString();
      return key ? [{ key_id: key.id, user_id: key.user_id }] : [];
    },
    zerox_usage_series: ({ p_from, p_to }) => usage.series.filter(row => row.day.slice(0, 10) >= p_from && row.day.slice(0, 10) <= p_to),
    zerox_usage_by_model: () => usage.byModel,
    // WP-B1 clamps p_limit to 1..200.
    zerox_usage_events: ({ p_limit, p_before }) => usage.events
      .filter(event => p_before === null || event.id < p_before).sort((left, right) => right.id - left.id)
      .slice(0, Math.min(Math.max(p_limit ?? 50, 1), 200)),
    zerox_session_index_add: ({ p_user_id, p_token_hash, p_expires_at }) => {
      sessionIndex.push({ user_id: p_user_id, token_hash: p_token_hash, expires_at: p_expires_at, revoked: false });
      return [{ token_hash: p_token_hash }];
    },
    zerox_session_index_list: ({ p_user_id }) => sessionIndex.filter(entry => entry.user_id === p_user_id && !entry.revoked)
      .map(({ token_hash, expires_at }) => ({ token_hash, expires_at })),
    // WP-B1 returns one row per removed index entry: RETURNS TABLE (token_hash text).
    zerox_session_index_revoke_all: ({ p_user_id }) => {
      state.onRevokeAll?.(p_user_id);
      const removed = [];
      for (const entry of sessionIndex) if (entry.user_id === p_user_id && !entry.revoked) { entry.revoked = true; removed.push({ token_hash: entry.token_hash }); }
      return removed;
    },
    zerox_session_index_remove: ({ p_token_hash }) => {
      const entry = sessionIndex.find(item => item.token_hash === p_token_hash && !item.revoked);
      if (entry) entry.revoked = true;
      return [{ removed: Boolean(entry) }];
    },
    zerox_session_get: ({ p_key }) => state.store.has(p_key) ? [{ value: state.store.get(p_key) }] : [],
    zerox_session_put: ({ p_key, p_value, p_ttl }) => { assert.ok(p_ttl >= 1 && p_ttl <= 604800); state.store.set(p_key, p_value); return []; },
    zerox_session_delete: ({ p_key }) => { state.store.delete(p_key); return []; },
    // Updates only an existing record (WP-B1 zerox_session_rearm).
    zerox_session_rearm: ({ p_key, p_value, p_ttl }) => {
      assert.ok(p_ttl >= 1 && p_ttl <= 604800);
      if (!state.store.has(p_key)) return [{ rearmed: false }];
      state.store.set(p_key, p_value);
      return [{ rearmed: true }];
    },
    // Minimal quota RPCs for the /v1/models/health probe (the full semantics are in check-business-db).
    zerox_reserve_v2: () => [{ status: 'ok', reservation_id: crypto.randomUUID(), plan: 'free', remaining_requests: 99,
      remaining_tokens: 499000, credit_balance_microusd: 0, resets_at: `${dayOffset(1)}T00:00:00.000Z`, retry_after_seconds: null }],
    zerox_settle_v2: () => [{ status: 'settled', credit_balance_microusd: 0 }],
    zerox_admin_overview: () => [{ overview: { users: { total: accounts.size, active_today: 1, by_plan: { free: 1 } },
      revenue: { active_subscriptions: 0, mrr_usd_estimate: 0 }, usage_today: { requests: 3, tokens: 30, cost_usd: 0 }, pools: [] } }],
    zerox_release_stale_reservations: () => [{ released: 2 }],
    zerox_apply_subscription_expiry: () => [{ downgraded: 1 }],
  };
  state.fetch = async (url, options) => {
    assert.equal(options.headers.apikey, SECRET, 'RPCs use the server-only key');
    assert.equal(options.headers.Authorization, undefined, 'User credentials never reach PostgREST');
    const name = url.split('/').at(-1);
    const args = JSON.parse(options.body || '{}');
    calls.push({ name, args });
    if (state.fail.has(name) || state.fail.has('*')) return new Response('database down', { status: 503 });
    if (!rpc[name]) return Response.json({ code: 'PGRST202', message: `Could not find the function ${name}` }, { status: 404 });
    try { return Response.json(rpc[name](args)); }
    catch (error) {
      if (error.raise) return Response.json({ code: 'P0001', message: error.raise }, { status: 400 });
      throw error;
    }
  };
  return state;
}

// ── Stubbed Supabase Auth ──
const identity = { users: new Map(), calls: 0, down: false };
const upstream = { gemini: null, calls: [] };
const addUser = (token, user) => { identity.users.set(token, user); return user; };

const db = fakeDatabase();
const servers = [];
const router = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) return db.fetch(url, init);
  if (url === `${SUPABASE_URL}/auth/v1/user`) {
    identity.calls++;
    if (identity.down) throw new TypeError('fetch failed');
    assert.equal(init.headers.apikey, 'sb_publishable_test');
    const user = identity.users.get(init.headers.Authorization.replace(/^Bearer /, ''));
    return user ? Response.json(user) : Response.json({ code: 401, msg: 'invalid JWT' }, { status: 401 });
  }
  if (url === `${SUPABASE_URL}/auth/v1/settings`) return Response.json({ external: { email: true, google: true } });
  if (url.startsWith('https://generativelanguage.googleapis.com/') && upstream.gemini) {
    upstream.calls.push(JSON.parse(init.body));
    return upstream.gemini();
  }
  if (url.startsWith('http://127.0.0.1:') && servers.length) return originalFetch(input, init);
  throw new Error(`Unexpected outbound request: ${url}`);
};
globalThis.fetch = router;

function memoryKv() {
  const records = new Map();
  const ttls = new Map();
  return {
    records, ttls,
    get: async key => records.get(key) ?? null,
    put: async (key, value, options = {}) => { records.set(key, value); ttls.set(key, options.expirationTtl); },
    delete: async key => { records.delete(key); ttls.delete(key); },
  };
}

const kv = memoryKv();
const env = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: SECRET, SESSIONS_KV: kv };
const request = (path, { method = 'GET', token, body, headers = {}, bindings = env, base = 'https://zero-x.live' } = {}) =>
  app.request(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }, bindings);
const json = async response => ({ status: response.status, body: await response.json(), headers: response.headers });

function assertOpenAIError(result, status, code) {
  assert.equal(result.status, status, `expected ${status} ${code}, got ${result.status} ${JSON.stringify(result.body)}`);
  const error = result.body.error;
  assert.equal(typeof error, 'object');
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 10);
  assert.equal(typeof error.type, 'string');
  assert.ok(error.param === null || typeof error.param === 'string');
  assert.match(error.request_id, /^req_[0-9a-f]{32}$/);
  assert.equal(result.headers.get('x-request-id'), error.request_id);
}

const userA = addUser('supabase-token-user-a', {
  id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test',
  user_metadata: { full_name: 'Alice Example', avatar_url: 'https://img.example.test/a.png' }, app_metadata: { provider: 'google' },
});
addUser('supabase-token-user-b', {
  id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.test', user_metadata: { name: 'Bob' }, app_metadata: {},
});

try {
  // ── 1. Credential matrix ──
  const missing = await json(await request('/api/account'));
  assertOpenAIError(missing, 401, 'invalid_session');
  assert.equal(missing.body.error.type, 'authentication_error');
  assert.match(missing.body.error.message, /neuron auth login/);
  assertOpenAIError(await json(await request('/api/account', { token: 'not-a-real-supabase-token' })), 401, 'invalid_session');

  const callsBefore = identity.calls;
  let account = await json(await request('/api/account', { token: 'supabase-token-user-a' }));
  assert.equal(account.status, 200);
  await request('/api/account', { token: 'supabase-token-user-a' });
  assert.equal(identity.calls - callsBefore, 1, 'Supabase verification is cached for 60 s');
  assert.deepEqual(account.body.user, { id: userA.id, email: 'alice@example.test', name: 'Alice Example', display_name: 'Alice Example',
    initials: 'AE', image_url: 'https://img.example.test/a.png' });
  assert.equal(account.body.session_expires_at, null, 'a website token without a readable exp claim has no expiry');
  assert.equal(db.calls.filter(call => call.name === 'zerox_sync_account' && call.args.p_user_id === userA.id).length, 1,
    'the account is synced once per cached credential');
  // A website access token (a JWT) reports its exp claim, for "sign in again" warnings (A3).
  const jwtExp = Math.floor(Date.now() / 1000) + 3600;
  const jwtToken = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: userA.id, exp: jwtExp })).toString('base64url'), 'c2lnbmF0dXJl'].join('.');
  addUser(jwtToken, userA);
  assert.equal((await json(await request('/api/account', { token: jwtToken }))).body.session_expires_at, new Date(jwtExp * 1000).toISOString());

  identity.down = true;
  assertOpenAIError(await json(await request('/api/account', { token: 'supabase-token-unknown-while-down' })), 503, 'service_unavailable');
  identity.down = false;
  assertOpenAIError(await json(await request('/api/account', { token: 'supabase-token-user-a', bindings: { ...env, SUPABASE_URL: '' } })),
    503, 'identity_not_configured');

  // CLI session (ses_): minted from a Supabase token, accepted on /api/*
  const minted = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: { machine_fingerprint: 'laptop' } }));
  assert.equal(minted.status, 200);
  assert.match(minted.body.session_token, /^ses_[A-Za-z0-9_-]{32}$/);
  assert.equal(minted.body.ttl_seconds, 720 * 3600, 'CLI sessions default to 720 hours');
  assert.ok(Math.abs(Date.parse(minted.body.expires_at) - (Date.now() + 720 * 3600000)) < 60000);
  const sessionToken = minted.body.session_token;
  assert.equal((await request('/api/account', { token: sessionToken })).status, 200);

  // Session storage is hashed: the KV key is sha256(token) and the token never appears raw.
  const sessionKey = sha256(sessionToken);
  assert.ok(kv.records.has(sessionKey), 'session stored under sha256(token)');
  assert.ok(![...kv.records.keys()].includes(sessionToken), 'raw token is never a KV key');
  assert.ok(![...kv.records.values()].some(value => value.includes(sessionToken)));
  assert.ok(Math.abs(kv.ttls.get(sessionKey) - 720 * 3600) <= 2);
  assert.ok(db.sessionIndex.some(entry => entry.token_hash === sessionKey && entry.user_id === userA.id), 'session registered in the index');
  const sessionInfo = await json(await request('/auth/session', { token: sessionToken }));
  assert.equal(sessionInfo.status, 200);
  assert.equal(sessionInfo.body.expires_at, minted.body.expires_at);
  assert.ok(sessionInfo.body.ttl_remaining_seconds > 719 * 3600);
  const shortLived = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {},
    bindings: { ...env, CLI_SESSION_TTL_HOURS: '48' } }));
  assert.equal(shortLived.body.ttl_seconds, 48 * 3600);

  // Legacy raw-key sessions remain readable (fallback) with their original 24 h lifetime.
  const legacyToken = 'ses_legacyRawKeySession0123456789ab';
  kv.records.set(legacyToken, JSON.stringify({ created: Date.now() - 3600000, user_id: userA.id, account_backed: true, plan: 'free' }));
  const legacyInfo = await json(await request('/auth/session', { token: legacyToken }));
  assert.equal(legacyInfo.status, 200);
  assert.ok(Math.abs(Date.parse(legacyInfo.body.expires_at) - (Date.now() + 23 * 3600000)) < 60000);
  assert.equal((await request('/api/account', { token: legacyToken })).status, 200);
  assert.equal((await request('/auth/session', { method: 'DELETE', token: legacyToken })).status, 200);
  assert.ok(!kv.records.has(legacyToken) && !kv.records.has(sha256(legacyToken)), 'sign-out removes raw and hashed records');
  const expiredLegacy = 'ses_expiredLegacySession0123456789';
  kv.records.set(expiredLegacy, JSON.stringify({ created: Date.now() - 25 * 3600000, user_id: userA.id, account_backed: true }));
  assertOpenAIError(await json(await request('/auth/session', { token: expiredLegacy })), 401, 'invalid_session');
  assert.ok(!kv.records.has(expiredLegacy), 'expired legacy session removed');
  // Without SESSIONS_KV the Postgres store caps each write at 7 days: a session in use is
  // re-armed with its remaining lifetime at most once a day (review B3 P3).
  const dbStoreEnv = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: SECRET };
  const dbStoredToken = 'ses_databaseStoredSession0123456789';
  const dbStoreKey = sha256(sha256(dbStoredToken));
  db.store.set(dbStoreKey, JSON.stringify({ created: Date.now() - 3 * DAY, expires: Date.now() + 27 * DAY, account_backed: true,
    user_id: userA.id, plan: 'free' }));
  // The rewrite is conditional (zerox_session_rearm), never zerox_session_put.
  const sessionRearms = () => db.calls.filter(call => call.name === 'zerox_session_rearm');
  const sessionPuts = () => db.calls.filter(call => call.name === 'zerox_session_put');
  const putsBefore = sessionPuts().length;
  const rearmsBefore = sessionRearms().length;
  assert.equal((await request('/auth/session', { token: dbStoredToken, bindings: dbStoreEnv })).status, 200);
  assert.equal(sessionRearms().length - rearmsBefore, 1, 'the session is rewritten on read');
  assert.equal(sessionPuts().length, putsBefore, 'with a conditional write, not a put');
  assert.equal(sessionRearms().at(-1).args.p_ttl, 604800, 'with the longest TTL the store accepts');
  assert.ok(JSON.parse(db.store.get(dbStoreKey)).rearmed_at > Date.now() - 60000);
  assert.equal((await request('/auth/session', { token: dbStoredToken, bindings: dbStoreEnv })).status, 200);
  assert.equal(sessionRearms().length - rearmsBefore, 1, 'at most once a day');
  // Review P3 (integration): a sign-out landing between the read and the re-arm was undone by
  // the rewrite. The record is read, then deleted, then re-armed: it stays deleted.
  const racedToken = 'ses_signedOutWhileRearming0123456789';
  const racedKey = sha256(sha256(racedToken));
  const racedRecord = { created: Date.now() - 3 * DAY, expires: Date.now() + 27 * DAY, account_backed: true, user_id: userA.id, plan: 'free' };
  db.store.set(racedKey, JSON.stringify(racedRecord));
  db.store.delete(racedKey);
  assert.equal(await rearmRecord(dbStoreEnv, racedToken, { ...racedRecord }), false);
  assert.equal(db.store.has(racedKey), false, 'a deleted session is never recreated by its re-arm');
  assert.equal((await request('/auth/session', { token: racedToken, bindings: dbStoreEnv })).status, 401);
  // Account-less sessions are not accounts.
  const anonymous = 'ses_anonymousSession0123456789abcd';
  kv.records.set(sha256(anonymous), JSON.stringify({ created: Date.now(), expires: Date.now() + 3600000, plan: 'free' }));
  assertOpenAIError(await json(await request('/api/account', { token: anonymous })), 401, 'invalid_session');

  // API keys (nzx_): created with an interactive credential, shown once, stored only as a hash.
  const createdKey = await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'CI runner' } }));
  assert.equal(createdKey.status, 201);
  assert.match(createdKey.body.secret, /^nzx_[A-Za-z0-9_-]{43}$/);
  // The prefix is the display form WP-B1 stores (^nzx_[A-Za-z0-9_-]{0,28}$): 'nzx_' + 8 characters.
  assert.equal(createdKey.body.key.prefix, createdKey.body.secret.slice(0, 12));
  assert.match(createdKey.body.key.prefix, B1_KEY_PREFIX);
  assert.equal(db.keys.find(key => key.id === createdKey.body.key.id).prefix, createdKey.body.key.prefix);
  assert.equal(createdKey.body.key.name, 'CI runner');
  assert.deepEqual(Object.keys(createdKey.body.key).sort(), ['created_at', 'id', 'name', 'prefix']);
  assert.equal(createdKey.headers.get('cache-control'), 'no-store');
  const storedKey = db.keys.find(key => key.id === createdKey.body.key.id);
  assert.equal(storedKey.hash, sha256(createdKey.body.secret), 'only sha256(secret) is stored');
  assert.ok(!JSON.stringify(db.calls.filter(call => call.name === 'zerox_api_key_create')).includes(createdKey.body.secret));
  const apiKey = createdKey.body.secret;
  const listed = await json(await request('/api/keys', { token: 'supabase-token-user-a' }));
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body.keys[0]).sort(), ['created_at', 'id', 'last_used_at', 'name', 'prefix', 'revoked_at']);
  assert.ok(!JSON.stringify(listed.body).includes(apiKey) && !JSON.stringify(listed.body).includes(storedKey.hash), 'secret shown once');

  const keyAccount = await json(await request('/api/account', { token: apiKey }));
  assert.equal(keyAccount.status, 200, 'nzx_ keys read the account');
  assert.equal(keyAccount.body.session_expires_at, null, 'API keys do not expire');
  assert.equal((await request('/api/usage', { token: apiKey })).status, 200, 'nzx_ keys read usage');
  assert.equal((await request('/api/usage/events', { token: apiKey })).status, 200);
  for (const [method, path, body] of [['GET', '/api/keys'], ['POST', '/api/keys', { name: 'x' }], ['DELETE', `/api/keys/${storedKey.id}`],
    ['POST', '/api/sessions/revoke-all'], ['GET', '/api/billing'], ['POST', '/api/billing/checkout', { plan: 'pro', currency: 'INR' }],
    ['POST', '/api/billing/topup', { pack: 'credits_5', currency: 'INR' }], ['POST', '/api/billing/verify', {}], ['POST', '/api/billing/cancel']]) {
    const denied = await json(await request(path, { method, token: apiKey, body }));
    assertOpenAIError(denied, 403, 'api_key_not_allowed');
    assert.equal(denied.body.error.type, 'permission_error');
  }
  assertOpenAIError(await json(await request('/auth/cli/session', { method: 'POST', token: apiKey, body: {} })), 401, 'invalid_session');
  assertOpenAIError(await json(await request('/auth/session', { token: apiKey })), 401, 'invalid_session');
  assert.equal((await request('/v1/models', { token: apiKey, bindings: { ...env, ALLOW_ANONYMOUS_SESSIONS: 'true' } })).status, 200,
    'nzx_ keys authenticate /v1/*');
  assertOpenAIError(await json(await request('/v1/models', { token: 'nzx_' + 'A'.repeat(43) })), 401, 'invalid_session');
  const chat = await request('/v1/chat/completions', { method: 'POST', token: 'nzx_' + 'B'.repeat(43), body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(chat.status, 401, 'unknown API keys are rejected on /v1/chat/completions');

  // Key validation, limit and revocation
  assertOpenAIError(await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'x'.repeat(65) } })), 400, 'invalid_request');
  assertOpenAIError(await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 42 } })), 400, 'invalid_request');
  assertOpenAIError(await json(await request('/api/keys', { method: 'POST', token: sessionToken })), 403, 'session_not_allowed');
  const defaultName = await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a' }));
  assert.equal(defaultName.status, 201, 'the website sign-in creates keys');
  assert.equal(defaultName.body.key.name, 'API key');
  for (let index = 0; index < 8; index++) {
    assert.equal((await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: `k${index}` } })).status, 201);
  }
  assertOpenAIError(await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'eleventh' } })), 409, 'too_many_keys');
  assert.equal(db.keys.filter(key => key.user_id === userA.id).length, 10, 'at most 10 active keys');
  assertOpenAIError(await json(await request('/api/keys/not-a-uuid', { method: 'DELETE', token: 'supabase-token-user-a' })), 400, 'invalid_request');
  assertOpenAIError(await json(await request(`/api/keys/${storedKey.id}`, { method: 'DELETE', token: 'supabase-token-user-b' })), 404, 'not_found');
  assert.deepEqual((await json(await request(`/api/keys/${storedKey.id}`, { method: 'DELETE', token: 'supabase-token-user-a' }))).body, { status: 'revoked' });
  assertOpenAIError(await json(await request(`/api/keys/${storedKey.id}`, { method: 'DELETE', token: 'supabase-token-user-a' })), 404, 'not_found');
  assertOpenAIError(await json(await request('/api/account', { token: apiKey })), 401, 'invalid_session');
  assert.equal((await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'after revoke' } })).status, 201);

  // ── 2. Local dev identity: Node server on loopback only, never the Worker ──
  const devEmail = 'dev.user@example.test';
  const dev = devToken(devEmail);
  assert.equal(dev, 'dev_' + Buffer.from(devEmail).toString('base64url'));
  const devId = await devUserId(devEmail);
  assert.match(devId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(devId, await devUserId(devEmail), 'dev user ids are deterministic');
  assert.equal(devId.replace(/-/g, '').slice(0, 12), sha256('zerox-dev:' + devEmail).slice(0, 12));
  const devEnv = { ...env, DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
  const local = { base: 'http://127.0.0.1:8787', bindings: devEnv };
  assert.deepEqual((await json(await request('/auth/config', local))).body, { provider: 'dev', configured: true, dev: true, providers: ['dev'] });
  const devAccount = await json(await request('/api/account', { ...local, token: dev }));
  assert.equal(devAccount.status, 200);
  assert.equal(devAccount.body.user.id, devId);
  assert.equal(devAccount.body.user.email, devEmail);
  assert.deepEqual([devAccount.body.user.display_name, devAccount.body.user.initials, devAccount.body.session_expires_at], ['dev.user', 'DU', null]);
  assert.ok(db.calls.some(call => call.name === 'zerox_sync_account' && call.args.p_user_id === devId && call.args.p_plan === 'free'),
    'the dev account is created through zerox_sync_account');
  assert.equal((await request('/api/account', { ...local, base: 'http://localhost:8787', token: dev })).status, 200);
  assert.equal((await request('/v1/models', { ...local, token: dev })).status, 200, 'dev tokens work on /v1/*');
  const devSession = await json(await request('/auth/cli/session', { ...local, method: 'POST', token: dev, body: {} }));
  assert.equal(devSession.status, 200);
  assert.equal(devSession.body.user_id, devId);
  assert.equal((await request('/auth/me', { ...local, token: dev })).status, 200);
  assert.equal((await request('/api/keys', { ...local, token: dev })).status, 200);
  for (const [label, options] of [
    ['Worker runtime (no NEURON_RUNTIME)', { base: 'http://127.0.0.1:8787', bindings: { ...env, DEV_AUTH_ENABLED: 'true' } }],
    ['flag missing', { base: 'http://127.0.0.1:8787', bindings: { ...env, NEURON_RUNTIME: 'node' } }],
    ['public host', { base: 'https://zero-x.live', bindings: devEnv }],
    ['spoofed Host header', { base: 'http://127.0.0.1:8787', bindings: devEnv, headers: { Host: 'zero-x.live' } }],
    // Review P3 (integration): refused under NODE_ENV=production even on loopback, and on browser
    // requests from another site (the /v1 CORS policy is open).
    ['NODE_ENV=production', { base: 'http://127.0.0.1:8787', bindings: { ...devEnv, NODE_ENV: 'production' } }],
    ['cross-origin page', { base: 'http://127.0.0.1:8787', bindings: devEnv, headers: { Origin: 'https://evil.example' } }],
    ['opaque origin', { base: 'http://127.0.0.1:8787', bindings: devEnv, headers: { Origin: 'null' } }],
  ]) {
    assertOpenAIError(await json(await request('/api/account', { ...options, token: dev })), 401, 'invalid_session');
    assert.equal((await request('/v1/models', { ...options, token: dev })).status, 401, label);
    assert.equal((await request('/auth/cli/session', { ...options, method: 'POST', token: dev, body: {} })).status, 401, label);
    assert.notEqual((await json(await request('/auth/config', options))).body.provider, 'dev', label);
  }
  for (const origin of ['http://127.0.0.1:8787', 'http://localhost:5173', 'http://[::1]:8787']) {
    assert.equal((await request('/api/account', { ...local, token: dev, headers: { Origin: origin } })).status, 200, `loopback page ${origin}`);
  }
  const crossOrigin = await request('/v1/chat/completions', { ...local, method: 'POST', token: dev, headers: { Origin: 'https://evil.example' },
    body: { model: 'groq/openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(crossOrigin.status, 401, 'a minted dev token from another site never reaches the upstream');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Cloudflare-Workers' }, configurable: true });
  try {
    assert.equal((await request('/api/account', { ...local, token: dev })).status, 401, 'the Workers runtime never honours dev tokens');
    assert.equal((await json(await request('/auth/config', local))).body.provider, 'supabase');
  } finally { Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); }
  for (const bad of ['dev_', 'dev_!!!!', devToken('not-an-email'), 'dev_' + Buffer.from([0xff, 0xfe, 0x40]).toString('base64url')]) {
    assert.equal((await request('/api/account', { ...local, token: bad })).status, 401, bad);
  }
  // resolveCaller honours allow lists directly.
  const fakeContext = (token, bindings = env, url = 'https://zero-x.live/api/account') => ({
    env: bindings, req: { header: name => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined, url },
    get() {}, set() {},
  });
  const caller = await resolveCaller(fakeContext('supabase-token-user-a'));
  assert.deepEqual({ kind: caller.kind, user_id: caller.user_id, email: caller.email, plan: caller.plan },
    { kind: 'supabase', user_id: userA.id, email: 'alice@example.test', plan: 'free' });
  await assert.rejects(resolveCaller(fakeContext('supabase-token-user-a'), { allow: ['session'] }), { status: 401 });
  // A valid CLI session on a website-only action is refused with 403, so the CLI does not
  // mistake it for an expired session and loop back to sign-in.
  await assert.rejects(resolveCaller(fakeContext(sessionToken), { allow: ['supabase'] }),
    { status: 403, code: 'session_not_allowed' });
  const sessionCaller = await resolveCaller(fakeContext(sessionToken));
  assert.equal(sessionCaller.kind, 'session');
  assert.equal(sessionCaller.session.user_id, userA.id);

  // ── 3. CORS: identity routes are restricted, /v1/* stays open ──
  const preflight = (path, origin, bindings = env) => app.request('https://zero-x.live' + path, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  }, bindings);
  for (const origin of ['https://zero-x.live', 'https://www.zero-x.live', 'https://dashboard.zero-x.live']) {
    for (const path of ['/api/account', '/auth/cli/session', '/neuroncli/auth-server/api/keys']) {
      const response = await preflight(path, origin);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin, `${origin} ${path}`);
      assert.match(response.headers.get('vary') || '', /Origin/);
    }
  }
  for (const origin of ['https://evil.example', 'https://zero-x.live.evil.example', 'http://127.0.0.1:5173', 'null']) {
    assert.equal((await preflight('/api/account', origin)).headers.get('access-control-allow-origin'), null, origin);
    assert.equal((await request('/auth/config', { headers: { Origin: origin } })).headers.get('access-control-allow-origin'), null, origin);
  }
  assert.equal((await preflight('/api/account', 'http://127.0.0.1:5173', devEnv)).headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.equal((await preflight('/api/account', 'http://localhost:3000', devEnv)).headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal((await preflight('/api/account', 'http://127.0.0.1:5173', { ...env, DEV_AUTH_ENABLED: 'true' })).headers.get('access-control-allow-origin'), null,
    'loopback origins need the Node dev runtime');
  assert.equal((await preflight('/v1/chat/completions', 'https://any.example')).headers.get('access-control-allow-origin'), '*');
  const openModels = await request('/v1/models', { headers: { Origin: 'https://any.example' }, bindings: { ...env, ALLOW_ANONYMOUS_SESSIONS: 'true' } });
  assert.equal(openModels.headers.get('access-control-allow-origin'), '*');
  assert.match(openModels.headers.get('access-control-expose-headers'), /X-Request-Id/);
  assert.equal((await preflight('/webhooks/razorpay', 'https://dashboard.zero-x.live')).headers.get('access-control-allow-origin'), null);
  assert.equal((await preflight('/admin/overview', 'https://dashboard.zero-x.live')).headers.get('access-control-allow-origin'), null);

  // ── 4. GET /api/plans (public, static fallback identical to contract §1) ──
  const expectedPlans = [
    { id: 'free', name: 'Free', price: { usd_cents: 0, inr_paise: 0 }, limits: { daily_requests: 100, daily_tokens: 500000, rpm: 10, concurrency: 2 }, monthly_credit_usd: 0, tiers: ['free'] },
    { id: 'pro', name: 'Pro', price: { usd_cents: 1000, inr_paise: 89900 }, limits: { daily_requests: 2000, daily_tokens: 10000000, rpm: 30, concurrency: 4 }, monthly_credit_usd: 8, tiers: ['free', 'paid'] },
    { id: 'max', name: 'Max', price: { usd_cents: 4000, inr_paise: 349900 }, limits: { daily_requests: 10000, daily_tokens: 50000000, rpm: 60, concurrency: 8 }, monthly_credit_usd: 35, tiers: ['free', 'paid'] },
  ];
  const expectedTopups = [
    { id: 'credits_5', credit_usd: 5, price: { usd_cents: 500, inr_paise: 44900 } },
    { id: 'credits_20', credit_usd: 20, price: { usd_cents: 2000, inr_paise: 174900 } },
  ];
  const checkPlans = (body, overrides = {}) => {
    assert.equal(body.currency_default, 'USD');
    assert.deepEqual(body.topups, expectedTopups);
    assert.deepEqual(body.plans.map(plan => plan.id), ['free', 'pro', 'max'], 'legacy ultrawork is not offered');
    for (const [index, expected] of expectedPlans.entries()) {
      const plan = body.plans[index];
      assert.deepEqual({ id: plan.id, name: plan.name, price: plan.price, limits: plan.limits, monthly_credit_usd: plan.monthly_credit_usd, tiers: plan.tiers },
        { ...expected, ...(overrides[expected.id] || {}) });
      assert.equal(plan.interval, 'month');
      assert.ok(Array.isArray(plan.features) && plan.features.length && plan.features.every(item => typeof item === 'string'));
      assert.equal(typeof plan.highlighted, 'boolean');
      assert.ok(!('razorpay_plan_id_inr' in plan), 'provider plan ids are not public');
    }
  };
  const staticPlans = await json(await request('/api/plans', { bindings: {} }));
  assert.equal(staticPlans.status, 200);
  checkPlans(staticPlans.body);
  assert.equal(staticPlans.headers.get('cache-control'), 'public, max-age=60');
  // The seeded B1 rows reproduce the static catalogue exactly.
  db.policiesV2 = B1_POLICY_ROWS;
  checkPlans((await json(await request('/api/plans', { bindings: { ...env } }))).body);
  // Edits in zerox_plan_policy reach /api/plans through B1's column names (review B3 P2).
  db.policiesV2 = B1_POLICY_ROWS.map(row => row.plan === 'pro' ? { ...row, daily_requests: 2500, daily_tokens: '10000000',
    rpm_limit: 99, concurrency_limit: 9, allowed_tiers: ['free'], razorpay_plan_id_inr: 'plan_PROINR12345' } : row);
  checkPlans((await json(await request('/api/plans', { bindings: { ...env } }))).body,
    { pro: { limits: { daily_requests: 2500, daily_tokens: 10000000, rpm: 99, concurrency: 9 }, tiers: ['free'] } });
  db.fail.add('zerox_plan_policies_v2');
  checkPlans((await json(await request('/api/plans', { bindings: { ...env } }))).body);
  db.fail.delete('zerox_plan_policies_v2');
  db.policiesV2 = [];

  // ── 5. GET /api/account ──
  Object.assign(db.accounts.get(userA.id), { credit_balance_microusd: 1234567, daily_requests: 7, daily_tokens_used: 7000 });
  account = await json(await request('/api/account', { token: sessionToken }));
  assert.deepEqual(account.body, {
    user: { id: userA.id, email: 'alice@example.test', name: 'Alice Example', display_name: 'Alice Example', initials: 'AE',
      image_url: 'https://img.example.test/a.png' },
    session_expires_at: minted.body.expires_at,
    plan: { id: 'free', name: 'Free' },
    limits: { daily_requests: 100, daily_tokens: 500000, rpm: 10, concurrency: 2 },
    usage_today: { requests: 7, tokens: 7000, resets_at: `${dayOffset(1)}T00:00:00.000Z` },
    credits: { balance_usd: 1.234567, monthly_grant_usd: 0 },
    subscription: null,
    flags: { suspended: false },
  });
  Object.assign(db.accounts.get(userA.id), { plan: 'pro', subscription: { status: 'active', current_period_end: '2026-11-16T00:00:00.000Z',
    cancel_at_period_end: false, provider_subscription_id: 'sub_TEST123456' } });
  account = await json(await request('/api/account', { token: sessionToken }));
  assert.deepEqual(account.body.plan, { id: 'pro', name: 'Pro' });
  assert.equal(account.body.credits.monthly_grant_usd, 8);
  assert.deepEqual(account.body.subscription, { status: 'active', current_period_end: '2026-11-16T00:00:00.000Z', cancel_at_period_end: false });
  // The overview's policy column is a zerox_plan_policies_v2 row: rpm_limit and
  // concurrency_limit edited in the database are what /api/account reports (review B3 P2).
  db.policyOverrides.pro = { rpm_limit: 99, concurrency_limit: 9, daily_requests: 2100 };
  account = await json(await request('/api/account', { token: sessionToken }));
  assert.deepEqual(account.body.limits, { daily_requests: 2100, daily_tokens: 10000000, rpm: 99, concurrency: 9 });
  db.policyOverrides = {};
  db.accounts.get(userA.id).suspended = true;
  assert.equal((await json(await request('/api/account', { token: sessionToken }))).body.flags.suspended, true);
  assertOpenAIError(await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'blocked' } })), 403, 'account_suspended');
  db.accounts.get(userA.id).suspended = false;
  db.fail.add('zerox_account_overview');
  assertOpenAIError(await json(await request('/api/account', { token: sessionToken })), 503, 'service_unavailable');
  db.fail.delete('zerox_account_overview');
  // display_name and initials fall back from the profile name to the email (A3).
  addUser('supabase-token-nameless', { id: '33333333-3333-4333-8333-333333333333', email: 'rahul.s@example.test', user_metadata: {}, app_metadata: {} });
  const namelessAccount = (await json(await request('/api/account', { token: 'supabase-token-nameless' }))).body;
  assert.deepEqual([namelessAccount.user.name, namelessAccount.user.display_name, namelessAccount.user.initials], ['', 'rahul.s', 'RS']);
  assert.equal(displayName({ name: '  Rahul\u0000  S​ ' }), 'Rahul S', 'control and format characters are removed');
  assert.equal(displayName({ first_name: 'Ada', last_name: 'Lovelace' }), 'Ada Lovelace');
  assert.equal(displayName({ username: 'octocat' }), 'octocat');
  assert.equal(displayName({}, { email: 'x@example.test' }), 'x');
  assert.equal(displayName({}), 'Zero-X user');
  assert.equal(Array.from(displayName({ name: '\u{1F600}'.repeat(200) })).length, 80, 'display names are capped');
  assert.deepEqual(['Alice Example', 'bob', 'Mary Ann Smith', 'rahul_s', 'élodie durand', '李 小龙', '\u{1F600}', '', '42 Labs'].map(initials),
    ['AE', 'B', 'MS', 'RS', 'ÉD', '李小', '?', '?', '4L']);
  assert.equal(credentialExpiresAt({}, { kind: 'session', session: { created: 0, expires: 86400000 } }), '1970-01-02T00:00:00.000Z');
  assert.equal(credentialExpiresAt({ SESSION_TTL_HOURS: '24' }, { kind: 'session', session: { created: 0 } }), '1970-01-02T00:00:00.000Z',
    'sessions created before hashed storage keep their 24 h lifetime');
  for (const token of ['', 'opaque', 'a.b.c', 'a.' + Buffer.from('{"exp":"soon"}').toString('base64url') + '.c']) {
    assert.equal(credentialExpiresAt({}, { kind: 'supabase' }, token), null, token);
  }
  assert.equal(credentialExpiresAt({}, { kind: 'api_key' }, jwtToken), null);

  // ── 6. GET /api/usage ──
  db.usage.series = [
    { day: dayOffset(-1), requests: 3, prompt_tokens: 300, completion_tokens: 30, cost_microusd: 1234567 },
    { day: `${today}T00:00:00+00:00`, requests: 2, prompt_tokens: 200, completion_tokens: 20, cost_microusd: 5 },
    { day: dayOffset(-40), requests: 9, prompt_tokens: 900, completion_tokens: 90, cost_microusd: 0 },
  ];
  db.usage.byModel = [
    { model: 'groq/openai/gpt-oss-20b', requests: 1, prompt_tokens: 100, completion_tokens: 10, cost_microusd: 0 },
    { model: 'gemini/gemini-2.5-flash', requests: 4, prompt_tokens: 400, completion_tokens: 40, cost_microusd: 1234572 },
  ];
  let usage = await json(await request('/api/usage', { token: sessionToken }));
  assert.equal(usage.status, 200);
  assert.equal(usage.body.to, today);
  assert.equal(usage.body.from, dayOffset(-29));
  assert.equal(usage.body.series.length, 30, 'default range is the last 30 days, gap-filled');
  assert.deepEqual(usage.body.series.at(-2), { day: dayOffset(-1), requests: 3, prompt_tokens: 300, completion_tokens: 30, cost_usd: 1.234567 });
  assert.deepEqual(usage.body.series.at(-1), { day: today, requests: 2, prompt_tokens: 200, completion_tokens: 20, cost_usd: 0.000005 });
  assert.deepEqual(usage.body.series[0], { day: dayOffset(-29), requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 });
  assert.deepEqual(usage.body.totals, { requests: 5, prompt_tokens: 500, completion_tokens: 50, cost_usd: 1.234572 });
  assert.deepEqual(usage.body.by_model.map(row => row.model), ['gemini/gemini-2.5-flash', 'groq/openai/gpt-oss-20b']);
  assert.equal(usage.body.by_model[0].cost_usd, 1.234572);
  assert.deepEqual(db.calls.filter(call => call.name === 'zerox_usage_series').at(-1).args, { p_user_id: userA.id, p_from: dayOffset(-29), p_to: today });
  usage = await json(await request(`/api/usage?from=${dayOffset(-91)}&to=${today}`, { token: sessionToken }));
  assert.equal(usage.status, 200);
  assert.equal(usage.body.series.length, 92, '92 days is the maximum');
  assert.equal(usage.body.totals.requests, 14);
  for (const query of [`from=${dayOffset(-92)}&to=${today}`, 'from=2026-02-30', 'from=2026-1-01', 'to=tomorrow', `from=${today}&to=${dayOffset(-1)}`, 'from=2026-13-01']) {
    const invalid = await json(await request(`/api/usage?${query}`, { token: sessionToken }));
    assertOpenAIError(invalid, 400, 'invalid_request');
    assert.ok(['from', 'to'].includes(invalid.body.error.param), query);
  }
  usage = await json(await request(`/api/usage?to=${dayOffset(-1)}`, { token: sessionToken }));
  assert.equal(usage.body.from, dayOffset(-30));

  // ── 7. GET /api/usage/events (cursor pagination) ──
  db.usage.events = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, created_at: `${today}T00:0${index}:00Z`, model: 'groq/openai/gpt-oss-20b', provider: 'groq', tier: 'free',
    status: 'ok', prompt_tokens: 10, completion_tokens: 2, cost_microusd: index * 1000, latency_ms: 120, request_id: `req_${index}`, user_id: userA.id,
  }));
  let page = await json(await request('/api/usage/events?limit=2', { token: sessionToken }));
  assert.deepEqual(page.body.events.map(event => event.id), [5, 4]);
  assert.equal(page.body.next_before, 4);
  assert.deepEqual(Object.keys(page.body.events[0]).sort(), ['completion_tokens', 'cost_usd', 'created_at', 'id', 'latency_ms', 'model',
    'prompt_tokens', 'provider', 'request_id', 'status', 'tier']);
  assert.equal(page.body.events[0].cost_usd, 0.004);
  assert.deepEqual(db.calls.filter(call => call.name === 'zerox_usage_events').at(-1).args, { p_user_id: userA.id, p_limit: 3, p_before: null });
  page = await json(await request(`/api/usage/events?limit=2&before=${page.body.next_before}`, { token: sessionToken }));
  assert.deepEqual(page.body.events.map(event => event.id), [3, 2]);
  page = await json(await request(`/api/usage/events?limit=2&before=${page.body.next_before}`, { token: sessionToken }));
  assert.deepEqual(page.body.events.map(event => event.id), [1]);
  assert.equal(page.body.next_before, null);
  assert.equal((await json(await request('/api/usage/events', { token: sessionToken }))).body.events.length, 5, 'default limit 50');
  // A full page at the 200-row maximum still reports the next page (review B3 P3).
  const savedEvents = db.usage.events;
  db.usage.events = Array.from({ length: 250 }, (_, index) => ({ ...savedEvents[0], id: index + 1, request_id: `req_many_${index}` }));
  page = await json(await request('/api/usage/events?limit=200', { token: sessionToken }));
  assert.equal(page.body.events.length, 200);
  assert.equal(page.body.next_before, 51, 'limit=200 paginates');
  page = await json(await request('/api/usage/events?limit=200&before=51', { token: sessionToken }));
  assert.equal(page.body.events.length, 50);
  assert.equal(page.body.next_before, null);
  db.usage.events = Array.from({ length: 200 }, (_, index) => ({ ...savedEvents[0], id: index + 1 }));
  assert.equal((await json(await request('/api/usage/events?limit=200', { token: sessionToken }))).body.next_before, null,
    'exactly 200 events is one page');
  db.usage.events = savedEvents;
  for (const query of ['limit=0', 'limit=201', 'limit=abc', 'before=-1', 'before=0', 'before=1e3']) {
    assertOpenAIError(await json(await request(`/api/usage/events?${query}`, { token: sessionToken })), 400, 'invalid_request');
  }

  // ── 8. POST /api/sessions/revoke-all ──
  const second = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  const bobSession = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-b', body: {} }));
  for (const token of [sessionToken, second.body.session_token, bobSession.body.session_token]) {
    assert.equal((await request('/auth/session', { token })).status, 200);
  }
  const indexedForA = db.sessionIndex.filter(entry => entry.user_id === userA.id && !entry.revoked).length;
  assert.ok(indexedForA >= 3);
  const revoked = await json(await request('/api/sessions/revoke-all', { method: 'POST', token: 'supabase-token-user-a' }));
  assert.deepEqual(revoked.body, { revoked: indexedForA });
  for (const token of [sessionToken, second.body.session_token, shortLived.body.session_token]) {
    assertOpenAIError(await json(await request('/auth/session', { token })), 401, 'invalid_session');
    assert.ok(!kv.records.has(sha256(token)), 'revoked session record deleted');
  }
  assert.equal((await request('/auth/session', { token: bobSession.body.session_token })).status, 200, 'other users keep their sessions');
  assert.deepEqual((await json(await request('/api/sessions/revoke-all', { method: 'POST', token: 'supabase-token-user-a' }))).body, { revoked: 0 });
  // A session indexed between zerox_session_index_list and zerox_session_index_revoke_all is
  // revoked too: its hash comes back from revoke_all (review B3 P3).
  const racing = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  const late = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  const lateHash = sha256(late.body.session_token);
  const lateEntry = db.sessionIndex.find(entry => entry.token_hash === lateHash);
  lateEntry.revoked = true; // hidden from the list call ...
  db.onRevokeAll = () => { lateEntry.revoked = false; db.onRevokeAll = null; }; // ... indexed just before revoke_all
  assert.deepEqual((await json(await request('/api/sessions/revoke-all', { method: 'POST', token: 'supabase-token-user-a' }))).body, { revoked: 2 });
  for (const token of [racing.body.session_token, late.body.session_token]) {
    assertOpenAIError(await json(await request('/auth/session', { token })), 401, 'invalid_session');
  }
  // Review P3 (integration): sign-in fails (and leaves no session behind) when the session
  // cannot be indexed, since revoke-all could never reach it.
  const recordsBefore = kv.records.size;
  const indexAdds = () => db.calls.filter(call => call.name === 'zerox_session_index_add').length;
  const addsBefore = indexAdds();
  db.fail.add('zerox_session_index_add');
  const unindexed = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  db.fail.delete('zerox_session_index_add');
  assertOpenAIError(unindexed, 503, 'service_unavailable');
  assert.equal(kv.records.size, recordsBefore, 'the unindexed session record is deleted');
  assert.equal(indexAdds() - addsBefore, 2, 'the index write is retried once');
  // Revoke-all can also revoke API keys (a leaked session may have minted some).
  const keyForB = await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-b', body: { name: 'bob ci' } }));
  assert.equal(keyForB.status, 201);
  const freeSlot = db.keys.find(key => key.user_id === userA.id && !key.revoked_at);
  if (freeSlot) freeSlot.revoked_at = new Date().toISOString(); // user A is at the 10-key limit here
  const keyForA = await json(await request('/api/keys', { method: 'POST', token: 'supabase-token-user-a', body: { name: 'leaked?' } }));
  assert.equal(keyForA.status, 201);
  assert.equal((await request('/v1/models', { token: keyForA.body.secret })).status, 200);
  const keyed = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  assertOpenAIError(await json(await request('/api/sessions/revoke-all', { method: 'POST', token: 'supabase-token-user-a', body: { api_keys: 'yes' } })),
    400, 'invalid_request');
  const activeKeys = db.keys.filter(key => key.user_id === userA.id && !key.revoked_at).length;
  assert.ok(activeKeys >= 1);
  assert.deepEqual((await json(await request('/api/sessions/revoke-all', { method: 'POST', token: 'supabase-token-user-a', body: { api_keys: true } }))).body,
    { revoked: 1, api_keys_revoked: activeKeys });
  assertOpenAIError(await json(await request('/auth/session', { token: keyed.body.session_token })), 401, 'invalid_session');
  assertOpenAIError(await json(await request('/v1/models', { token: keyForA.body.secret })), 401, 'invalid_session');
  assert.equal(db.keys.filter(key => key.user_id === userA.id && !key.revoked_at).length, 0, 'every key of the user is revoked');
  assert.equal((await request('/v1/models', { token: keyForB.body.secret })).status, 200, 'other users keep their keys');

  // Single sign-out removes the session's index entry.
  const single = await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-user-a', body: {} }));
  assert.equal((await request('/auth/session', { method: 'DELETE', token: single.body.session_token })).status, 200);
  assert.ok(db.sessionIndex.filter(entry => entry.token_hash === sha256(single.body.session_token)).every(entry => entry.revoked),
    'DELETE /auth/session calls zerox_session_index_remove');

  // ── 9. /health trimming, admin overview, scheduled maintenance ──
  const operatorEnv = { ...env, GATEWAY_ADMIN_TOKEN: OPERATOR };
  assert.deepEqual((await json(await request('/health', { bindings: operatorEnv }))).body, { status: 'ok', service: 'neuroncli-gateway-worker', version: '2.0.0' });
  assert.deepEqual(Object.keys((await json(await request('/health', { bindings: operatorEnv, token: 'wrong-operator-token-value' }))).body).sort(),
    ['service', 'status', 'version']);
  const fullHealth = await json(await request('/health', { bindings: operatorEnv, token: OPERATOR }));
  assert.equal(fullHealth.body.database_configured, true);
  assert.equal(fullHealth.body.billing_configured, false);
  assert.equal(fullHealth.body.session_encryption, false);
  assert.ok(!JSON.stringify(fullHealth.body).includes(SECRET) && !JSON.stringify(fullHealth.body).includes(OPERATOR));
  assertOpenAIError(await json(await request('/admin/overview', { bindings: operatorEnv })), 401, 'invalid_session');
  assertOpenAIError(await json(await request('/admin/overview', { bindings: operatorEnv, token: bobSession.body.session_token })), 401, 'invalid_session');
  assertOpenAIError(await json(await request('/admin/overview', { bindings: env, token: OPERATOR })), 401, 'invalid_session');
  const overview = await json(await request('/admin/overview', { bindings: operatorEnv, token: OPERATOR }));
  assert.equal(overview.status, 200);
  assert.deepEqual(Object.keys(overview.body).sort(), ['pools', 'revenue', 'usage_today', 'users']);
  assert.equal(overview.headers.get('cache-control'), 'no-store');
  // Contract §3.6 pools[]: database counters merged with the catalogue's limits and pool health (review B3 P3).
  const tracker = new ProviderHealthTracker();
  tracker.recordFailure('groq:openai/gpt-oss-120b:free', { kind: FailureKind.RATE_LIMITED, retryAfterSeconds: 30 });
  const pools = overviewPools({ GROQ_API_KEY: 'g' }, [{ model: 'groq/openai/gpt-oss-120b', tier: 'free', requests_today: 7, tokens_today: 700,
    requests_this_minute: 1, tokens_this_minute: 100 }, { model: 'retired/model', tier: 'free', requests_today: 2, tokens_today: 20 }], tracker);
  const groqFree = pools.find(pool => pool.model === 'groq/openai/gpt-oss-120b' && pool.tier === 'free');
  assert.deepEqual(groqFree.limits, { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 });
  assert.deepEqual([groqFree.requests_today, groqFree.tokens_today, groqFree.configured], [7, 700, true]);
  assert.equal(groqFree.health.status, 'RATE_LIMITED');
  assert.equal(groqFree.health.circuit_open, true);
  assert.equal(pools.find(pool => pool.model === 'groq/openai/gpt-oss-120b' && pool.tier === 'paid').limits, null, 'paid pools have no shared budget');
  assert.equal(pools.find(pool => pool.model === 'gemini/gemini-2.5-flash' && pool.tier === 'free').health.status, 'HEALTHY');
  assert.ok(pools.every(pool => ['model', 'tier', 'requests_today', 'tokens_today', 'limits', 'health'].every(key => key in pool)));
  assert.equal(pools.find(pool => pool.model === 'retired/model').requests_today, 2, 'counters of pools no longer offered stay visible');
  assert.ok(Array.isArray(overview.body.pools) && overview.body.pools.some(pool => pool.limits), 'the route returns the merged pools');
  db.fail.add('zerox_admin_overview');
  assertOpenAIError(await json(await request('/admin/overview', { bindings: operatorEnv, token: OPERATOR })), 503, 'service_unavailable');
  db.fail.delete('zerox_admin_overview');
  const waited = [];
  assert.deepEqual(await app.scheduled({ cron: '*/10 * * * *' }, env, { waitUntil: promise => waited.push(promise) }), { released: 2, downgraded: 1 });
  assert.equal(waited.length, 1, 'the cron work is registered with waitUntil');
  assert.deepEqual(await runScheduledMaintenance({}), { skipped: true });
  db.fail.add('zerox_apply_subscription_expiry');
  const maintenanceCalls = db.calls.length;
  await assert.rejects(runScheduledMaintenance(env), /Scheduled maintenance failed/);
  assert.ok(db.calls.slice(maintenanceCalls).some(call => call.name === 'zerox_release_stale_reservations'), 'each job runs even if another fails');
  db.fail.delete('zerox_apply_subscription_expiry');

  // ── 10. OpenRouter PKCE: 10-minute hashed records and a per-IP limiter; sealed BYOK keys ──
  const pkceEnv = { SESSIONS_KV: kv, ALLOW_ANONYMOUS_SESSIONS: 'true' };
  const pkceStart = ip => request('/auth/openrouter/start', { bindings: pkceEnv, headers: { 'CF-Connecting-IP': ip } });
  const started = await json(await pkceStart('198.51.100.7'));
  assert.equal(started.status, 200);
  const pkceKey = sha256(`pkce:${started.body.state}`);
  assert.ok(kv.records.has(pkceKey) && !kv.records.has(`pkce:${started.body.state}`), 'PKCE records are hashed');
  assert.equal(kv.ttls.get(pkceKey), 600, 'PKCE records live 10 minutes');
  for (let index = 1; index < 10; index++) assert.equal((await pkceStart('198.51.100.7')).status, 200);
  const limited = await json(await pkceStart('198.51.100.7'));
  assertOpenAIError(limited, 429, 'rate_limited');
  assert.equal(limited.body.error.type, 'rate_limit_error');
  assert.ok(limited.body.error.retry_after_seconds > 0 && Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await pkceStart('198.51.100.8')).status, 200, 'the limit is per address');

  const encryptionKey = 'test-session-encryption-key-0123456789abcdef';
  // No anonymous sessions here: a session whose sealed key cannot be opened must be rejected.
  const sealedEnv = { ...env, SESSION_ENCRYPTION_KEY: encryptionKey, OPENROUTER_MODELS: 'cohere/north-mini-code:free' };
  const sealedStart = await json(await request('/auth/openrouter/start', { bindings: sealedEnv, headers: { 'CF-Connecting-IP': '203.0.113.9' } }));
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://openrouter.ai/api/v1/auth/keys') return router(url, init);
    assert.ok(JSON.parse(init.body).code_verifier);
    return Response.json({ key: 'sk-or-owned-secret-key' });
  };
  const exchanged = await json(await request(`/auth/openrouter/callback?code=abc&state=${sealedStart.body.state}`, { bindings: sealedEnv }));
  globalThis.fetch = router;
  assert.equal(exchanged.status, 200);
  assert.ok(!JSON.stringify(exchanged.body).includes('sk-or-owned-secret-key'));
  const byokRecord = kv.records.get(sha256(exchanged.body.session_token));
  assert.ok(!byokRecord.includes('sk-or-owned-secret-key'), 'BYOK keys are encrypted at rest');
  assert.match(JSON.parse(byokRecord).openrouter_key_enc, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal((await request('/auth/session', { token: exchanged.body.session_token, bindings: sealedEnv })).status, 200, 'sealed key decrypts');
  assert.equal((await request('/auth/session', { token: exchanged.body.session_token,
    bindings: { ...sealedEnv, SESSION_ENCRYPTION_KEY: 'another-key-'.padEnd(40, 'z') } })).status, 401, 'a wrong key cannot decrypt the session');
  const tampered = JSON.parse(byokRecord);
  tampered.openrouter_key_enc = tampered.openrouter_key_enc.slice(0, -2) + (tampered.openrouter_key_enc.endsWith('A') ? 'BB' : 'AA');
  kv.records.set(sha256(exchanged.body.session_token), JSON.stringify(tampered));
  assert.equal((await request('/auth/session', { token: exchanged.body.session_token, bindings: sealedEnv })).status, 401, 'tampered ciphertext is rejected');
  const sealed = await sealSession(sealedEnv, 'ses_bound', { created: 1, openrouter_key: 'owned' });
  assert.equal((await openSession(sealedEnv, 'ses_bound', sealed)).openrouter_key, 'owned');
  assert.equal((await openSession(sealedEnv, 'ses_other', sealed)).openrouter_key, undefined, 'ciphertext is bound to its session');
  assert.equal((await sealSession({}, 'ses_plain', { openrouter_key: 'owned' })).openrouter_key, 'owned', 'without a key the value stays usable');

  // ── 11. Security headers, custom 404 and clean URLs ──
  const pages = ['/pricing.html', '/neuron-cli.html', '/docs.html', '/refund.html', '/contact.html', '/shipping.html', '/index.html', '/dashboard.html'];
  const assets = {
    fetch: async input => {
      const { pathname } = new URL(input.url);
      if (pathname === '/404.html') return new Response('<h1>Custom 404</h1>', { headers: { 'Content-Type': 'text/html' } });
      if (pages.includes(pathname)) return new Response(pathname, { headers: { 'Content-Type': 'text/html' } });
      return new Response('Not found', { status: 404 });
    },
  };
  const site = { ...env, ASSETS: assets };
  const home = await request('/', { bindings: site });
  assert.equal(home.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  const policy = home.headers.get('content-security-policy-report-only');
  assert.equal(home.headers.get('content-security-policy'), null, 'CSP starts in report-only mode');
  for (const directive of ["default-src 'self'", "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://checkout.razorpay.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com https://cdn.fontshare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdn.fontshare.com", "img-src 'self' data: https:",
    "connect-src 'self' https://*.supabase.co https://api.razorpay.com https://lumberjack.razorpay.com",
    'frame-src https://api.razorpay.com https://checkout.razorpay.com', "form-action 'self' http://127.0.0.1:*",
    "frame-ancestors 'none'", "base-uri 'self'"]) assert.ok(policy.split('; ').includes(directive), directive);
  assert.equal(policy.split('; ').length, 10);
  const enforced = await request('/', { bindings: { ...site, CSP_ENFORCE: 'true' } });
  assert.equal(enforced.headers.get('content-security-policy'), policy);
  assert.equal(enforced.headers.get('content-security-policy-report-only'), null);
  assert.equal((await request('/', { bindings: site, base: 'http://127.0.0.1:8787' })).headers.get('strict-transport-security'), null, 'HSTS only over HTTPS');
  assert.equal((await request('/api/account', { token: 'supabase-token-user-b' })).headers.get('cache-control'), 'no-store');

  for (const path of ['/no-such-page', '/missing.html', '/deep/missing/page']) {
    const response = await request(path, { bindings: site });
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), '<h1>Custom 404</h1>', path);
  }
  const bare = await request('/no-such-page', { bindings: { ...site, ASSETS: { fetch: async () => new Response('plain', { status: 404 }) } } });
  assert.equal(bare.status, 404);
  assert.equal(await bare.text(), 'plain', 'without 404.html the asset 404 is returned');
  assert.equal((await request('/missing.css', { bindings: site })).status, 404);
  assertOpenAIError(await json(await request('/api/does-not-exist', { bindings: site })), 404, 'not_found');
  assertOpenAIError(await json(await request('/v1/unknown', { bindings: site })), 404, 'not_found');

  for (const pagePath of ['/pricing', '/neuron-cli', '/docs', '/refund', '/contact', '/shipping']) {
    const served = await request(pagePath, { bindings: site });
    assert.equal(served.status, 200, pagePath);
    assert.equal(await served.text(), `${pagePath}.html`);
    for (const [from, location] of [[`https://zero-x.live${pagePath}.html`, `https://zero-x.live${pagePath}`], [`https://zero-x.live${pagePath}/`, `https://zero-x.live${pagePath}`],
      [`https://www.zero-x.live${pagePath}`, `https://zero-x.live${pagePath}`], [`https://neuron.zero-x.live${pagePath}?ref=1`, `https://zero-x.live${pagePath}?ref=1`]]) {
      const redirect = await app.request(from, {}, site);
      assert.equal(redirect.status, 301, from);
      assert.equal(redirect.headers.get('location'), location, from);
    }
  }
  for (const path of ['/neuroncli', '/neuroncli/']) {
    const redirect = await request(path, { bindings: site });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), 'https://zero-x.live/neuron-cli');
  }
  const localRedirect = await request('/pricing.html', { bindings: site, base: 'http://127.0.0.1:8787' });
  assert.equal(localRedirect.status, 301);
  assert.equal(localRedirect.headers.get('location'), '/pricing', 'loopback redirects stay on the local origin');
  assert.equal(await (await request('/pricing', { bindings: site, base: 'http://127.0.0.1:8787' })).text(), '/pricing.html');
  assert.equal((await request('/neuroncli/', { bindings: site, base: 'http://127.0.0.1:8787' })).headers.get('location'), '/neuron-cli');
  assert.equal(await (await request('/dashboard', { bindings: site, base: 'http://127.0.0.1:8787' })).text(), '/dashboard.html');
  assert.equal((await request('/dashboard', { bindings: site })).headers.get('location'), 'https://dashboard.zero-x.live/');

  // ── 12. GET /v1/models: WP-B2's catalogue for the caller's plan (database tiers) and country ──
  const modelsEnv = (extra = {}) => ({ ...env, GROQ_API_KEY: 'g', GEMINI_API_KEY: 'g', GEMINI_PAID_API_KEY: 'p', ...extra });
  const modelsContext = (bindings, { country, headers } = {}) => {
    const raw = new Request('https://zero-x.live/v1/models', { headers });
    if (country) Object.defineProperty(raw, 'cf', { value: { country } });
    return { env: bindings, req: { raw } };
  };
  const byId = payload => Object.fromEntries(payload.data.map(model => [model.id, model]));
  db.policiesV2 = B1_POLICY_ROWS;
  const pro = { plan: 'pro', account_backed: true, user_id: userA.id };
  let models = byId(await v1ModelsPayload(modelsContext(modelsEnv(), { country: 'DE' }), pro));
  assert.equal(models.auto.available, true);
  assert.equal(models['gemini/gemini-2.5-flash'].available, true, 'Pro reaches the paid Gemini pool from the EEA');
  assert.equal(models['gemini/gemini-3.5-flash'].unavailable_reason, 'region_unavailable');
  assert.deepEqual(models['gemini/gemini-2.5-flash'].pricing, { input_per_mtok_usd: 0.375, output_per_mtok_usd: 3.125 });
  models = byId(await v1ModelsPayload(modelsContext(modelsEnv(), { country: 'DE' }), {}));
  assert.equal(models['gemini/gemini-2.5-flash'].unavailable_reason, 'upgrade_required', 'anonymous callers are on the free plan');
  models = byId(await v1ModelsPayload(modelsContext(modelsEnv(), { country: 'DE' }), { plan: 'pro' }));
  assert.equal(models['gemini/gemini-2.5-flash'].unavailable_reason, 'upgrade_required', 'paid tiers need an account ledger, as in routing');
  db.policiesV2 = B1_POLICY_ROWS.map(row => row.plan === 'pro' ? { ...row, allowed_tiers: ['free'] } : row);
  models = byId(await v1ModelsPayload(modelsContext(modelsEnv(), { country: 'DE' }), pro));
  assert.equal(models['gemini/gemini-2.5-flash'].unavailable_reason, 'upgrade_required', 'database plan tiers apply');
  db.policiesV2 = [];
  const spoofed = byId(await v1ModelsPayload(modelsContext(modelsEnv(), { headers: { 'cf-ipcountry': 'US' } }), {}));
  assert.equal(spoofed['gemini/gemini-3.5-flash'].unavailable_reason, 'region_unavailable', 'CF-IPCountry is not trusted by default');
  const trusted = byId(await v1ModelsPayload(modelsContext(modelsEnv({ TRUST_CF_IPCOUNTRY: 'true' }), { headers: { 'cf-ipcountry': 'US' } }), {}));
  assert.equal(trusted['gemini/gemini-3.5-flash'].available, true);
  const routed = await json(await request('/v1/models', { bindings: modelsEnv({ ALLOW_ANONYMOUS_SESSIONS: 'true' }) }));
  assert.equal(routed.body.object, 'list');
  assert.equal(routed.body.data[0].id, 'auto');
  assert.ok(routed.body.data.every(model => typeof model.available === 'boolean' && 'unavailable_reason' in model && 'pricing' in model));

  // Review P3 (integration): POST /v1/models/health built a Request without request.cf, so on
  // Workers every free-Gemini probe failed the geo rule. The probe now inherits the caller country.
  const healthUser = addUser('supabase-token-health', { id: '55555555-5555-4555-8555-555555555555', email: 'health@example.test',
    user_metadata: { name: 'Health' }, app_metadata: {} });
  const healthSession = (await json(await request('/auth/cli/session', { method: 'POST', token: 'supabase-token-health', body: {} }))).body.session_token;
  assert.ok(healthSession && healthUser.id);
  upstream.gemini = () => Response.json({ id: 'probe', object: 'chat.completion', choices: [{ index: 0,
    message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  const healthEnv = modelsEnv({ GEMINI_PAID_API_KEY: '' });
  const probeFrom = (path, country, body) => {
    const probe = new Request('https://zero-x.live' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${healthSession}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (country) Object.defineProperty(probe, 'cf', { value: { country } });
    return app.fetch(probe, healthEnv);
  };
  const usChat = await probeFrom('/v1/chat/completions', 'US', { model: 'gemini/gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(usChat.status, 200, 'a US caller may use the free Gemini pool');
  const usHealth = await json(await probeFrom('/v1/models/health', 'US', { model: 'gemini/gemini-3.5-flash' }));
  assert.equal(usHealth.status, 200, `the probe answers like the chat: ${JSON.stringify(usHealth.body)}`);
  assert.equal(usHealth.body.status, 'healthy');
  const deHealth = await json(await probeFrom('/v1/models/health', 'DE', { model: 'gemini/gemini-3.5-flash' }));
  assert.equal(deHealth.status, 403, 'an EEA caller is still geo-blocked through the probe');
  assert.equal(deHealth.body.error.code, 'region_unavailable');
  upstream.gemini = null;

  // ── 13. Node server: runtime marker, loopback-only dev identity, trusted client address ──
  const { runtimeEnv, start: startServer } = require('./server.js');
  const saved = { ...process.env };
  try {
    process.env.DEV_AUTH_ENABLED = 'true';
    assert.equal(runtimeEnv('0.0.0.0').DEV_AUTH_ENABLED, undefined, 'dev identity is dropped when not bound to loopback');
    assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, 'true');
    process.env.NODE_ENV = 'production';
    assert.equal(runtimeEnv('127.0.0.1').DEV_AUTH_ENABLED, undefined, 'dev identity is dropped under NODE_ENV=production');
    delete process.env.NODE_ENV;
    process.env.NEURON_RUNTIME = 'worker';
    assert.equal(runtimeEnv('127.0.0.1').NEURON_RUNTIME, 'node', 'server.js always marks the Node runtime');
    Object.assign(process.env, { AUTH_PORT: '0', AUTH_HOST: '127.0.0.1', NEURON_API_ONLY: 'true', SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: SECRET });
    const server = await startServer();
    servers.push(server);
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(base + '/auth/config')).json(), { provider: 'dev', configured: true, dev: true, providers: ['dev'] });
    const viaServer = await fetch(base + '/api/account', { headers: { Authorization: `Bearer ${devToken('server.dev@example.test')}` } });
    assert.equal(viaServer.status, 200);
    assert.equal((await viaServer.json()).user.id, await devUserId('server.dev@example.test'));
    for (let index = 0; index < 10; index++) {
      const response = await fetch(base + '/auth/openrouter/start', { headers: { 'X-Neuron-Client-Ip': `10.0.0.${index}` } });
      assert.equal(response.status, 200, 'within the limit');
    }
    assert.equal((await fetch(base + '/auth/openrouter/start', { headers: { 'X-Neuron-Client-Ip': '10.0.0.99' } })).status, 429,
      'a client-supplied address cannot evade the limiter');
    assert.ok(db.store.size >= 10, 'without KV the PKCE records use the hashed database store');
    assert.ok([...db.store.keys()].every(key => /^[0-9a-f]{64}$/.test(key)));
    await new Promise(resolve => server.close(resolve));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const server of servers) if (server.listening) server.close();
}
console.log('PASS: auth-context matrix (Supabase, ses_, nzx_, dev_ incl. Worker rejection), CORS allowlist, /api/plans|account|usage|events|keys, ' +
  'show-once hashed API keys with limit, revoke-all, hashed sessions with raw fallback, 720 h TTL, sealed BYOK keys, PKCE limiter, ' +
  'trimmed /health, admin overview, cron, CSP/HSTS, custom 404, clean URLs and the Node dev runtime');
