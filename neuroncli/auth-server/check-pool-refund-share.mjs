// Fair share of a free pool vs refunded attempts and zero budgets (go-live follow-up;
// migration 20261107000100_pool_share_refunds.sql) on a fresh PGlite (DATABASE_DRIVER=pglite).
//   * an attempt settled 'refunded' (upstream failure) does not count toward a user's share of rpd or tpd;
//   * the old behaviour is reproduced with the down script (refunded attempts used up the share);
//   * a pool with rpd 0 or tpd 0 answers pool_exhausted, not user_pool_share;
//   * a settled ok attempt still counts, so the share still limits a user.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rpc } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';

const env = { DATABASE_DRIVER: 'pglite' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

async function clockHeadroom(seconds = 20) {
  const now = new Date();
  const intoMinute = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  if (intoMinute > 60 - seconds) await sleep((60 - intoMinute + 0.5) * 1000);
  const toMidnight = 86400 - (Date.now() / 1000) % 86400;
  if (toMidnight < 90) await sleep((toMidnight + 1) * 1000);
}

await clockHeadroom();
const handle = await getPgliteHandle(env);
const db = handle.db;
const sql = async (text, params) => (await db.query(text, params)).rows;

let counter = 0;
async function newUser() {
  counter += 1;
  const email = `refundshare${counter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Refund ${counter}` } });
  return id;
}
const newModel = () => `gemini/refund-share-${randomUUID().slice(0, 8)}`;
const reserve = (userId, model, pool, tokens = 100) => rpc(env, 'zerox_reserve_v2', {
  p_user_id: userId, p_request_id: `req_${randomUUID().replaceAll('-', '')}`, p_model: model, p_tier: 'free',
  p_tokens: tokens, p_cost_microusd: 0, p_pool: pool,
});
const settle = (reservationId, status) => rpc(env, 'zerox_settle_v2', {
  p_reservation_id: reservationId, p_prompt_tokens: 10, p_completion_tokens: 5, p_cost_microusd: 0,
  p_status: status, p_latency_ms: 20, p_provider: 'google', p_upstream_model: 'gemini', p_error_code: null,
});

// rpd 8 -> a share of 2 requests.
const POOL = { rpd: 8 };
// Three refunded attempts, then one more reservation; returns the first refusal, else the last result.
async function refundedBurst(pool, tokens = 100) {
  const model = newModel();
  const user = await newUser();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await reserve(user, model, pool, tokens);
    if (r.status !== 'ok') return r; // the first refusal (old behaviour refuses before the last attempt)
    await settle(r.reservation_id, 'refunded');
  }
  return reserve(user, model, pool, tokens);
}

try {
  await sql(`UPDATE public.zerox_plan_policy SET concurrency_limit = 100, rpm_limit = 10000, daily_requests = 100000,
    daily_tokens = 1000000000, window_tokens = NULL, window_seconds = NULL`);

  const up = await readFile(new URL('./migrations/20261107000100_pool_share_refunds.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('./migrations/down/20261107000100_pool_share_refunds.sql', import.meta.url), 'utf8');
  const downBody = down.replace(/DELETE FROM supabase_migrations[^\n]*\n/, '');

  assert.equal((await refundedBurst(POOL)).status, 'ok', 'rpd share: refunded attempts do not count');
  assert.equal((await refundedBurst({ tpd: 400 }, 100)).status, 'ok', 'tpd share: refunded attempts do not count');
  ok('attempts settled refunded do not count toward the rpd or tpd share');

  for (const status of ['ok', 'error']) {
    const model = newModel();
    const user = await newUser();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await reserve(user, model, POOL);
      assert.equal(r.status, 'ok');
      await settle(r.reservation_id, status);
    }
    assert.equal((await reserve(user, model, POOL)).status, 'user_pool_share', `settled ${status} attempts still use the share`);
  }
  const unsettled = newModel();
  const holder = await newUser();
  await reserve(holder, unsettled, POOL);
  await reserve(holder, unsettled, POOL);
  assert.equal((await reserve(holder, unsettled, POOL)).status, 'user_pool_share', 'unsettled holds still count');
  assert.equal((await reserve(await newUser(), unsettled, POOL)).status, 'ok', 'another user is still served');
  ok('ok, error and unsettled attempts still count; the share still limits one user');

  for (const pool of [{ rpd: 0 }, { tpd: 0 }, { rpd: 0, tpd: 1000 }]) {
    const r = await reserve(await newUser(), newModel(), pool);
    assert.equal(r.status, 'pool_exhausted', `${JSON.stringify(pool)} reads pool_exhausted`);
    assert.ok(r.retry_after_seconds >= 1);
  }
  ok('a pool with rpd 0 or tpd 0 answers pool_exhausted, not user_pool_share');

  // NULL cases: a refunded attempt with no usage event (event status NULL after the LEFT JOIN), and a settled ok attempt with no usage event.
  const forceSettled = async (reservationId, outcome) => {
    await sql("UPDATE public.zerox_reservations SET status = 'settled', outcome = $2, settled_at = now() WHERE id = $1", [reservationId, outcome]);
    await sql('DELETE FROM public.zerox_usage_events WHERE reservation_id = $1', [reservationId]);
  };
  {
    const model = newModel();
    const user = await newUser();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await reserve(user, model, POOL);
      assert.equal(r.status, 'ok', 'refunded with no usable event status does not count');
      await forceSettled(r.reservation_id, 'refunded');
    }
    assert.equal((await reserve(user, model, POOL)).status, 'ok');
    const model2 = newModel();
    const user2 = await newUser();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const r = await reserve(user2, model2, POOL);
      assert.equal(r.status, 'ok');
      await forceSettled(r.reservation_id, null);
    }
    assert.equal((await reserve(user2, model2, POOL)).status, 'user_pool_share', 'a settled ok attempt with no usage event still counts');
  }
  ok('NULL-safe: refunded with a null event status is free; a settled attempt with no usage event counts');

  for (const pool of [{ cpd: 1000000, rpd: 0 }, { cpd: 1000000, tpd: 0 }]) {
    const r = await reserve(await newUser(), newModel(), pool);
    assert.equal(r.status, 'pool_exhausted', `${JSON.stringify(pool)} (cpd > 0) reads pool_exhausted`);
  }
  ok('a pool with cpd > 0 and rpd 0 answers pool_exhausted');

  for (const text of [up, down]) assert.match(text, /SET LOCAL lock_timeout = '5s'/);
  assert.match(down, /schema_migrations WHERE version = '20261107000100'/);
  await db.exec(up);
  await db.exec(up);
  handle.functions.clear();
  assert.equal((await refundedBurst(POOL)).status, 'ok', 'the migration re-runs');

  await db.exec(downBody);
  handle.functions.clear();
  assert.equal((await refundedBurst(POOL)).status, 'user_pool_share', 'old behaviour: refunded attempts used up the share');
  assert.equal((await reserve(await newUser(), newModel(), { rpd: 0 })).status, 'user_pool_share', 'old behaviour: rpd 0 read as the share');
  await db.exec(up);
  handle.functions.clear();
  assert.equal((await refundedBurst(POOL)).status, 'ok', 'applied again, refunded attempts are free');
  ok('the down script reproduces the old behaviour; the up migration re-runs and applies again');

  console.log(`PASS: ${passed.length} pool refund share checks`);
} finally {
  await closeAllPglite();
}
