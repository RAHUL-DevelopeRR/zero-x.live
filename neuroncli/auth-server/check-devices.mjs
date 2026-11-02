// Linked devices (A9) and sliding session expiry (A10) on a real database: every migration on a
// fresh in-memory PGlite, the gateway on the local dev identity, with the KV session store and
// with the Postgres one (docs/PLATFORM_CONTRACT.md §10). Run: node check-devices.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import app from './src/index.js';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { devToken } from './src/auth-context.js';
import { readRecord, sha256Hex } from './src/session-store.js';
import { noteSessionUse, resetSessionActivity, sessionActivitySettled, sessionMaxLifetimeMs, slidingExpiry } from './src/session-activity.js';
import { sessionId } from './src/routes/sessions.js';

const DAY = 86400000;
const sha = value => createHash('sha256').update(value).digest('hex');
const base = 'http://127.0.0.1:8787';
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };

function memoryKv(onPut = null) {
  const records = new Map();
  return {
    records,
    onPut,
    get: async key => records.get(key) ?? null,
    async put(key, value) { records.set(key, value); await this.onPut?.(key, value); },
    delete: async key => { records.delete(key); },
  };
}

const pgEnv = { DATABASE_DRIVER: 'pglite', DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
const handle = await getPgliteHandle(pgEnv);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;

const call = async (env, path, { method = 'GET', token, body } = {}) => {
  const response = await app.request(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const signIn = async (env, email, device = {}) => {
  const minted = await call(env, '/auth/cli/session', { method: 'POST', token: devToken(email), body: { machine_fingerprint: 'fp', ...device } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  return minted.body;
};

try {
  for (const [label, kv] of [['KV session store', memoryKv()], ['Postgres session store', null]]) {
    resetSessionActivity();
    const env = { ...pgEnv, ...(kv ? { SESSIONS_KV: kv } : {}) };
    const email = `devices-${kv ? 'kv' : 'pg'}@example.test`;

    // ── A9: sign-ins record their device; the list shows them, newest use first ──
    const laptop = await signIn(env, email, { device_name: 'rahul-laptop\u0007', os: 'Windows 11', client_name: 'neuron-cli', client_version: '6.3.0' });
    const desktop = await signIn(env, email, { device_name: 'studio', os: 'macOS 15', client_name: 'neuron-desktop', client_version: '0.2.0' });
    let list = await call(env, '/api/sessions', { token: laptop.session_token });
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 2);
    const mine = list.body.sessions.find(session => session.current);
    assert.deepEqual({ ...mine, id: undefined, created_at: undefined, expires_at: undefined, last_used_at: undefined },
      { id: undefined, device_name: 'rahul-laptop', os: 'Windows 11', client: { name: 'neuron-cli', version: '6.3.0' },
        created_at: undefined, expires_at: undefined, last_used_at: undefined, current: true }, 'control characters are dropped');
    assert.equal(mine.id, await sessionId(sha(laptop.session_token)));
    assert.match(mine.id, /^[0-9a-f]{24}$/);
    assert.ok(!JSON.stringify(list.body).includes(sha(laptop.session_token)), 'storage keys are never listed');
    assert.equal(mine.expires_at, laptop.expires_at);
    const other = list.body.sessions.find(session => !session.current);
    assert.equal(other.device_name, 'studio');
    assert.equal(other.client.name, 'neuron-desktop');
    await sessionActivitySettled();
    list = await call(env, '/api/sessions', { token: laptop.session_token });
    assert.ok(list.body.sessions.find(session => session.current).last_used_at, 'using a session records when');
    assert.equal(list.body.sessions[0].current, true, 'most recently used first');

    // The website identity sees the same list, with no current session.
    const fromWebsite = await call(env, '/api/sessions', { token: devToken(email) });
    assert.equal(fromWebsite.body.sessions.length, 2);
    assert.ok(fromWebsite.body.sessions.every(session => !session.current));

    // ── A9: revoke one device ──
    assert.equal((await call(env, '/api/sessions/not-an-id', { method: 'DELETE', token: laptop.session_token })).body.error.code, 'invalid_request');
    assert.equal((await call(env, `/api/sessions/${'0'.repeat(24)}`, { method: 'DELETE', token: laptop.session_token })).status, 404);
    const stranger = await signIn(env, `stranger-${email}`);
    assert.equal((await call(env, `/api/sessions/${other.id}`, { method: 'DELETE', token: stranger.session_token })).status, 404,
      "another account's session is not found");
    const revoked = await call(env, `/api/sessions/${other.id}`, { method: 'DELETE', token: laptop.session_token });
    assert.deepEqual(revoked.body, { status: 'revoked', current: false });
    assert.equal((await call(env, '/api/account', { token: desktop.session_token })).status, 401, 'the revoked session stops working');
    assert.equal(await readRecord(env, desktop.session_token), null, 'and its record is gone');
    assert.equal((await call(env, `/api/sessions/${other.id}`, { method: 'DELETE', token: laptop.session_token })).status, 404);
    assert.equal((await call(env, '/api/sessions', { token: laptop.session_token })).body.sessions.length, 1);
    ok(`${label}: sign-ins record the device, GET /api/sessions lists them, DELETE revokes one`);

    // ── A10: sliding expiry ──
    const token = laptop.session_token;
    const hash = sha(token);
    const stored = await readRecord(env, token);
    const ttl = 720 * 3600000;
    assert.equal(slidingExpiry(env, stored, stored.created + 3600000), null, 'no extension within the first day');
    const later = stored.created + 5 * DAY;
    assert.equal(slidingExpiry(env, stored, later), later + ttl);
    resetSessionActivity();
    const extended = await noteSessionUse(env, token, await readRecord(env, token), later);
    assert.deepEqual(extended, { touched: true, extended: true, expires: later + ttl });
    assert.equal((await readRecord(env, token)).expires, later + ttl, 'the record carries the new expiry');
    assert.equal(new Date((await sql('SELECT expires_at FROM public.zerox_session_index WHERE token_hash = $1', [hash]))[0].expires_at).getTime(), later + ttl,
      'and so does the index');
    assert.equal((await call(env, '/auth/session', { token })).body.expires_at, new Date(later + ttl).toISOString());
    assert.equal((await call(env, '/api/account', { token })).body.session_expires_at, new Date(later + ttl).toISOString());
    assert.deepEqual(await noteSessionUse(env, token, await readRecord(env, token), later + 3600000), { touched: true, extended: false },
      'at most one extension a day');
    // Never beyond CLI_SESSION_MAX_DAYS after sign-in.
    const longLived = { created: stored.created, expires: stored.created + 80 * DAY };
    assert.equal(slidingExpiry(env, longLived, stored.created + 75 * DAY), stored.created + sessionMaxLifetimeMs(env));
    assert.equal(sessionMaxLifetimeMs(env), 90 * DAY);
    assert.equal(slidingExpiry({ ...env, CLI_SESSION_MAX_DAYS: '30' }, await readRecord(env, token), later + DAY), null, 'a lower cap stops sliding');
    // Old sessions without `expires` keep their fixed lifetime.
    assert.equal(slidingExpiry(env, { created: Date.now() - DAY }, Date.now()), null);

    // A sign-out that lands between the record write and the index check wins (KV writes are
    // unconditional): the record is deleted again.
    const racer = await signIn(env, email, { device_name: 'racer' });
    const racerHash = sha(racer.session_token);
    if (kv) {
      kv.onPut = async () => { await sql('DELETE FROM public.zerox_session_index WHERE token_hash = $1', [racerHash]); };
    } else {
      await sql('DELETE FROM public.zerox_session_index WHERE token_hash = $1', [racerHash]);
    }
    resetSessionActivity();
    const racerStored = await readRecord(env, racer.session_token);
    const raced = await noteSessionUse(env, racer.session_token, racerStored, racerStored.created + 5 * DAY);
    assert.equal(raced.extended, false, label);
    if (kv) kv.onPut = null;
    if (kv) {
      assert.equal(await readRecord(env, racer.session_token), null, 'a sign-out between the write and the index check wins');
      assert.equal(kv.records.has(racerHash), false, 'the rewritten record was deleted again');
    } else {
      assert.equal((await readRecord(env, racer.session_token)).expires, racerStored.expires, 'an unindexed session is never extended');
    }
    ok(`${label}: sliding expiry (daily, capped, mirrored in the index), never resurrecting a revoked session`);

    await call(env, '/api/sessions/revoke-all', { method: 'POST', token: devToken(email) });
    assert.equal((await call(env, '/api/sessions', { token: devToken(email) })).body.sessions.length, 0);
  }

  // ── Database functions ──
  const env = pgEnv;
  const [{ id: user }] = await sql("INSERT INTO auth.users (email) VALUES ('grant-owner@example.test') RETURNING id");
  await rpc(env, 'zerox_sync_account', { p_user_id: user, p_profile: { email: 'grant-owner@example.test' } });
  const [{ id: grant }] = await sql(`INSERT INTO public.zerox_device_grants (device_code_hash, user_code, client_name, client_version,
      device_name, device_os, status, user_id, expires_at, decided_at)
    VALUES ($1, 'BCDFGHJK', 'neuron-cli', '6.3.0', 'build-box', 'Ubuntu 24.04', 'approved', $2, now() + interval '5 minutes', now()) RETURNING id`,
  [sha('zdc_test'), user]);
  const expires = new Date(Date.now() + 30 * DAY).toISOString();
  await rpc(env, 'zerox_session_register', { p_user_id: user, p_token_hash: sha('ses_grant'), p_expires_at: expires,
    p_client: { device_name: 'ignored' }, p_device_grant_id: grant });
  let [row] = await rpcRows(env, 'zerox_session_list', { p_user_id: user });
  assert.deepEqual([row.device_name, row.device_os, row.client_name, row.client_version], ['build-box', 'Ubuntu 24.04', 'neuron-cli', '6.3.0'],
    'device-flow sessions take the device the grant recorded');
  const [{ id: otherUser }] = await sql("INSERT INTO auth.users (email) VALUES ('not-the-owner@example.test') RETURNING id");
  await rpc(env, 'zerox_sync_account', { p_user_id: otherUser, p_profile: { email: 'not-the-owner@example.test' } });
  await rpc(env, 'zerox_session_register', { p_user_id: otherUser, p_token_hash: sha('ses_other'), p_expires_at: expires, p_device_grant_id: grant });
  [row] = await rpcRows(env, 'zerox_session_list', { p_user_id: otherUser });
  assert.equal(row.device_name, null, "another user's grant is never read");
  await assert.rejects(rpc(env, 'zerox_session_register', { p_user_id: user, p_token_hash: sha('ses_bad'), p_expires_at: expires, p_client: ['x'] }),
    /p_client must be an object/);
  await assert.rejects(rpc(env, 'zerox_session_register', { p_user_id: otherUser, p_token_hash: sha('ses_grant'), p_expires_at: expires }),
    /session_owner_mismatch/);
  await assert.rejects(rpc(env, 'zerox_session_touch', { p_token_hash: 'ses_raw' }), /invalid_session_index/);
  assert.deepEqual(await rpc(env, 'zerox_session_touch', { p_token_hash: sha('unknown') }), { present: false, expires_at: null });
  const shorter = new Date(Date.now() + DAY).toISOString();
  assert.equal(Date.parse((await rpc(env, 'zerox_session_touch', { p_token_hash: sha('ses_grant'), p_expires_at: shorter })).expires_at), Date.parse(expires),
    'touch never shortens a session');
  const tooFar = new Date(Date.now() + 401 * DAY).toISOString();
  assert.equal(Date.parse((await rpc(env, 'zerox_session_touch', { p_token_hash: sha('ses_grant'), p_expires_at: tooFar })).expires_at), Date.parse(expires),
    'nor extends it beyond 400 days after sign-in');
  assert.deepEqual(await rpc(env, 'zerox_session_revoke', { p_user_id: otherUser, p_token_hash: sha('ses_grant') }), { revoked: false },
    "a user cannot revoke another user's session");
  assert.deepEqual(await rpc(env, 'zerox_session_revoke', { p_user_id: user, p_token_hash: sha('ses_grant') }), { revoked: true });
  assert.deepEqual(await rpcRows(env, 'zerox_session_list', { p_user_id: user }), []);
  ok('zerox_session_register/list/touch/revoke: grant devices, ownership, never shorten or exceed 400 days');
} finally {
  await sessionActivitySettled();
  await closeAllPglite();
}

console.log(`PASS: linked devices and sliding expiry (${passed.length} groups): device metadata at sign-in, GET/DELETE /api/sessions, current-session marker, ownership, daily capped extension mirrored in the index, no resurrection after a raced sign-out, on KV and Postgres session stores`);
