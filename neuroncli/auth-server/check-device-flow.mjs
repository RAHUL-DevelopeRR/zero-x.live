// Device sign-in (src/routes/device.js) against an in-memory PGlite with every migration applied,
// through the app as the loopback Node server runs it (dev identity, x-neuron-client-ip):
// findings of the 2026-10-21 local end-to-end run.
//   node check-device-flow.mjs
import assert from 'node:assert/strict';
import app from './src/index.js';
import { devToken, devUserId } from './src/auth-context.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';

const env = { DATABASE_DRIVER: 'pglite', DEV_AUTH_ENABLED: 'true', NEURON_RUNTIME: 'node' };
const base = 'http://127.0.0.1:8787';
const page = { Origin: base };
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };

const call = async (path, { body = {}, token, ip = '203.0.113.10', headers = {} } = {}) => {
  const response = await app.request(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-neuron-client-ip': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  }, env);
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const newCode = ip => call('/auth/device/code', { ip, body: { client_id: 'neuron-cli', client_version: '7.0.0', device_name: 'ci', os: 'linux' } });
const lookup = (token, userCode) => call('/auth/device/lookup', { token, headers: page, body: { user_code: userCode } });
const decide = (token, looked, decision) => call('/auth/device/approve', { token, headers: page,
  body: { grant_id: looked.grant_id, approval_nonce: looked.approval_nonce, decision } });
const poll = deviceCode => call('/auth/device/token', { body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode } });

async function captureErrors(fn) {
  const lines = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => lines.push(args);
  console.error = (...args) => lines.push(args);
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
}

const handle = await getPgliteHandle(env);
const sql = async (text, params) => (await handle.db.query(text, params)).rows;
// Takes one database function away for the duration of `fn`, so its RPC fails. The driver caches
// function signatures by name, so the entry is dropped once the function is back.
async function without(signature, fn) {
  const [name, args] = signature.split('(');
  await handle.db.exec(`ALTER FUNCTION public.${name}(${args} RENAME TO ${name}_off`);
  try { return await fn(); } finally {
    await handle.db.exec(`ALTER FUNCTION public.${name}_off(${args} RENAME TO ${name}`);
    handle.functions.delete(name);
  }
}

try {
  // ── Deny works for an account that was never synced (it returned 503 and left the grant pending) ──
  {
    const email = 'never.synced@example.test';
    const dev = devToken(email);
    const userId = await devUserId(email);
    const created = await newCode('203.0.113.11');
    assert.equal(created.status, 200);
    const looked = await lookup(dev, created.body.user_code);
    assert.equal(looked.status, 200);
    assert.deepEqual(await sql('SELECT 1 FROM auth.users WHERE id = $1', [userId]), [], 'the identity was never synced');
    const denied = await decide(dev, looked.body, 'deny');
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.status, 'denied');
    const [grant] = await sql('SELECT status, user_id FROM public.zerox_device_grants WHERE id = $1', [looked.body.grant_id]);
    assert.deepEqual(grant, { status: 'denied', user_id: userId });
    const answer = await poll(created.body.device_code);
    assert.deepEqual([answer.status, answer.body.error.code], [400, 'access_denied']);
    ok('deny on a never-synced account: the account is synced first, the grant is denied and polling answers access_denied');
  }

  // ── Too many pending codes: Retry-After is when the oldest pending grant expires ──
  {
    const ip = '203.0.113.12';
    for (let index = 0; index < 5; index++) assert.equal((await newCode(ip)).status, 200);
    await sql(`UPDATE public.zerox_device_grants SET expires_at = now() + interval '95 seconds'
      WHERE id = (SELECT id FROM public.zerox_device_grants WHERE requester_ip = $1 ORDER BY created_at LIMIT 1)`, [ip]);
    const refused = await newCode(ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'rate_limited');
    const retryAfter = Number(refused.headers.get('Retry-After'));
    assert.ok(retryAfter >= 94 && retryAfter <= 95, `Retry-After ${retryAfter}`);
    assert.equal(refused.body.error.retry_after_seconds, retryAfter);
    assert.match(refused.body.error.message, /try again in 2 min/);
    assert.equal((await newCode('203.0.113.13')).status, 200, 'other requesters are unaffected');
    ok('too many pending codes: 429 with Retry-After from the oldest pending grant (95 s), not a fixed 600 s');
  }

  // ── Every failed step logs one line without user codes, device codes or tokens ──
  {
    const email = 'device.logs@example.test';
    const dev = devToken(email);
    const ip = '203.0.113.14';
    const secrets = [dev];
    const expectStep = (outcome, step) => {
      const line = outcome.lines.find(([message, fields]) => message === 'Device sign-in step failed' && fields.step === step);
      assert.ok(line, `a log line for ${step}: ${JSON.stringify(outcome.lines)}`);
      assert.deepEqual(Object.keys(line[1]).sort(), ['code', 'message', 'step']);
      for (const secret of secrets) assert.ok(!JSON.stringify(outcome.lines).includes(secret), `${step} logs no code or token`);
      for (const secret of secrets.filter(value => /^[A-Z]{4}-[A-Z]{4}$/.test(value))) {
        assert.ok(!JSON.stringify(outcome.lines).includes(secret.replace('-', '')), `${step} logs no user code`);
      }
    };
    const grant = async () => {
      const created = await newCode(ip);
      secrets.push(created.body.device_code, created.body.user_code);
      return created.body;
    };

    const first = await grant();
    const lookupFailed = await captureErrors(() => without('zerox_device_lookup(text)', () => lookup(dev, first.user_code)));
    assert.equal(lookupFailed.result.status, 503);
    expectStep(lookupFailed, 'lookup');

    const looked = (await lookup(dev, first.user_code)).body;
    const syncFailed = await captureErrors(() => without('zerox_sync_account(uuid, jsonb, text)', () => decide(dev, looked, 'deny')));
    assert.equal(syncFailed.result.status, 503);
    expectStep(syncFailed, 'deny_sync_account');
    const decideFailed = await captureErrors(() => without('zerox_device_decide(uuid, uuid, text)', () => decide(dev, looked, 'approve')));
    assert.equal(decideFailed.result.status, 503);
    expectStep(decideFailed, 'approve');
    assert.equal((await decide(dev, looked, 'approve')).body.status, 'approved', 'the grant stayed pending');

    const pollFailed = await captureErrors(() => without('zerox_device_poll(text)', () => poll(first.device_code)));
    assert.equal(pollFailed.result.status, 503);
    expectStep(pollFailed, 'poll');
    const loadFailed = await captureErrors(() => without('zerox_get_account(uuid)', () => poll(first.device_code)));
    assert.equal(loadFailed.result.status, 503);
    expectStep(loadFailed, 'load_user');
    const mintFailed = await captureErrors(() => without('zerox_session_index_add(uuid, text, timestamptz)', () => poll(first.device_code)));
    assert.equal(mintFailed.result.status, 503);
    expectStep(mintFailed, 'mint_session');
    const redeemFailed = await captureErrors(() => without('zerox_device_redeem(uuid)', () => poll(first.device_code)));
    assert.equal(redeemFailed.result.status, 503);
    expectStep(redeemFailed, 'redeem');
    const issued = await poll(first.device_code);
    assert.equal(issued.status, 200, 'the approved grant still yields its one session');
    secrets.push(issued.body.access_token);
    for (const outcome of [lookupFailed, syncFailed, decideFailed, pollFailed, loadFailed, mintFailed, redeemFailed]) {
      assert.ok(!JSON.stringify(outcome.lines).includes(issued.body.access_token));
    }

    const second = await grant();
    const createFailed = await captureErrors(() => without('zerox_device_create(text, text, jsonb, jsonb, integer, integer, integer)',
      () => newCode(ip)));
    assert.equal(createFailed.result.status, 503);
    expectStep(createFailed, 'create');
    assert.ok(second.user_code);
    ok('failed device steps (create, lookup, deny/approve account sync, approve, poll, load_user, mint_session, redeem) each log a line without codes or tokens');
  }
} finally {
  await closeAllPglite();
}

console.log(`PASS: device sign-in (${passed.length} groups): deny without a synced account, Retry-After from the oldest pending grant, logged failures`);
