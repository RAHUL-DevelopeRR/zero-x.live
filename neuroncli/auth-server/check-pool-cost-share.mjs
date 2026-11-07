// Per-user share of a sponsored pool's daily spend cap (go-live follow-up, finding M3;
// migration 20261107000000_pool_user_cost_share.sql) on a fresh PGlite (DATABASE_DRIVER=pglite).
//   * one free account cannot spend more than 25 percent of cpd: holds and settled cost both count;
//   * the refusal is user_pool_share, writes nothing, and other users are still served;
//   * the pool's own cap still holds the total (money stays capped), cpd 0 stays pool_exhausted;
//   * a refunded request gives its share back; separate pool keys have separate shares;
//   * a paid pool is not touched by the share; the down script restores the old function.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rpc } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';

const env = { DATABASE_DRIVER: 'pglite' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

const CPD = 8_000_000;
const SHARE = 2_000_000; // 25 percent of CPD

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
async function newUser(plan = 'free', credits = 0) {
  counter += 1;
  const email = `costshare${counter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Share ${counter}` } });
  await sql(`UPDATE public.zerox_accounts SET plan = $2, credit_balance_microusd = $3,
    plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END WHERE clerk_id = $1`, [id, plan, credits]);
  return id;
}
const newModel = () => `anthropic/claude-share-${randomUUID().slice(0, 8)}`;
const reserve = (userId, model, cost, overrides = {}) => rpc(env, 'zerox_reserve_v2', {
  p_user_id: userId, p_request_id: `req_${randomUUID().replaceAll('-', '')}`, p_model: model, p_tier: 'free',
  p_tokens: 100, p_cost_microusd: cost, p_pool: { cpd: CPD }, ...overrides,
});
const settle = (reservationId, cost, status = 'ok') => rpc(env, 'zerox_settle_v2', {
  p_reservation_id: reservationId, p_prompt_tokens: 10, p_completion_tokens: 5, p_cost_microusd: cost,
  p_status: status, p_latency_ms: 20, p_provider: 'anthropic', p_upstream_model: 'claude-haiku-5-5', p_error_code: null,
});
const dayCost = async (model, tier = 'free') => Number((await sql(
  `SELECT coalesce(max(cost_microusd), 0) AS c FROM public.zerox_pool_usage WHERE model = $1 AND tier = $2 AND bucket = 'day'`,
  [model, tier]))[0].c);
const reservations = async (userId, model) => Number((await sql(
  'SELECT count(*) AS n FROM public.zerox_reservations WHERE user_id = $1 AND model = $2', [userId, model]))[0].n);

try {
  // The per-user limits (concurrency, rpm, daily requests and tokens) are not under test here: lift them
  // on this throwaway database so only the pool's spend share can refuse.
  await sql(`UPDATE public.zerox_plan_policy SET concurrency_limit = 100, rpm_limit = 10000, daily_requests = 100000,
    daily_tokens = 1000000000, window_tokens = NULL, window_seconds = NULL`);

  // ------------------------------------------------------------ 1. holds count toward the share
  const model = newModel();
  const heavy = await newUser();
  assert.equal((await reserve(heavy, model, 1_500_000)).status, 'ok');
  assert.equal((await reserve(heavy, model, 500_000)).status, 'ok', 'exactly the share is allowed');
  const over = await reserve(heavy, model, 1);
  assert.equal(over.status, 'user_pool_share', 'one micro-dollar past the share is refused');
  assert.ok(over.retry_after_seconds >= 1, 'retry at 00:00 UTC');
  assert.equal(await reservations(heavy, model), 2, 'a refusal writes no reservation');
  assert.equal(await dayCost(model), SHARE, 'a refusal adds nothing to the pool bucket');
  const other = await newUser();
  assert.equal((await reserve(other, model, 1_000_000)).status, 'ok', 'another user is still served from the same pool');
  ok('holds count: a user may hold exactly 25 percent of cpd, the next micro-dollar is user_pool_share and writes nothing; others are served');

  // ------------------------------------------------------------ 2. settled spend counts
  const model2 = newModel();
  const spender = await newUser();
  const first = await reserve(spender, model2, 1_000_000);
  await settle(first.reservation_id, 1_900_000);
  assert.equal(await dayCost(model2), 1_900_000, 'the bucket holds the settled cost');
  assert.equal((await reserve(spender, model2, 200_000)).status, 'user_pool_share', 'settled cost 1.9M + 0.2M is past the share');
  assert.equal((await reserve(spender, model2, 100_000)).status, 'ok', '1.9M + 0.1M is exactly the share');
  ok('settled sponsored cost counts toward the share, not the hold it replaced');

  // ------------------------------------------------------------ 3. refunds give the share back
  const model3 = newModel();
  const refunded = await newUser();
  const held = await reserve(refunded, model3, 2_000_000);
  assert.equal((await reserve(refunded, model3, 1)).status, 'user_pool_share');
  await settle(held.reservation_id, 0, 'refunded');
  assert.equal((await reserve(refunded, model3, 1_000_000)).status, 'ok', 'a refunded request no longer counts');
  ok('a refunded request gives its share back');

  // ------------------------------------------------------------ 4. the pool cap still bounds the money
  const model4 = newModel();
  const users = [];
  for (let index = 0; index < 6; index += 1) users.push(await newUser());
  const statuses = [];
  for (const user of users) statuses.push((await reserve(user, model4, SHARE)).status);
  assert.deepEqual(statuses, ['ok', 'ok', 'ok', 'ok', 'pool_exhausted', 'pool_exhausted'], 'four full shares fill the cap; the rest see pool_exhausted');
  assert.ok(await dayCost(model4) <= CPD, 'total spend never passes cpd');
  assert.equal((await reserve(users[0], model4, 1)).status, 'user_pool_share', 'a user at its share reads the share, not the pool');
  assert.equal((await reserve(await newUser(), newModel(), 1_000_000, { p_pool: { cpd: 0 } })).status, 'pool_exhausted', 'cpd 0 stays pool_exhausted');
  ok('money stays capped: four users fill cpd, then pool_exhausted; cpd 0 stays pool_exhausted');

  // ------------------------------------------------------------ 5. scope of the share
  const model5 = newModel();
  const scoped = await newUser();
  assert.equal((await reserve(scoped, model5, SHARE, { p_pool_key: 'key-a' })).status, 'ok');
  assert.equal((await reserve(scoped, model5, 1, { p_pool_key: 'key-a' })).status, 'user_pool_share');
  assert.equal((await reserve(scoped, model5, SHARE, { p_pool_key: 'key-b' })).status, 'ok', 'another key of the model has its own share');
  const model6 = newModel();
  const payer = await newUser('pro', 20_000_000);
  assert.equal((await reserve(payer, model6, 5_000_000, { p_tier: 'paid' })).status, 'ok', 'a paid pool is not limited by the free share');
  assert.equal((await reserve(await newUser(), newModel(), 5_000_000, { p_pool: { rpm: 60 } })).status, 'ok', 'without cpd there is no cost share');
  ok('the share is per pool key, free tier only, and needs a cpd');

  // ------------------------------------------------------------ 6. migration files
  const up = await readFile(new URL('./migrations/20261107000000_pool_user_cost_share.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('./migrations/down/20261107000000_pool_user_cost_share.sql', import.meta.url), 'utf8');
  for (const text of [up, down]) assert.match(text, /SET LOCAL lock_timeout = '5s'/);
  assert.match(down, /DELETE FROM supabase_migrations\.schema_migrations WHERE version = '20261107000000'/);
  await db.exec(up);
  await db.exec(up);
  handle.functions.clear();
  assert.equal((await reserve(await newUser(), newModel(), 1_000)).status, 'ok', 'the migration re-runs');
  const downBody = down.replace(/DELETE FROM supabase_migrations[^\n]*\n/, '');
  await db.exec(downBody);
  handle.functions.clear();
  const model7 = newModel();
  const rolledBack = await newUser();
  assert.equal((await reserve(rolledBack, model7, 5_000_000)).status, 'ok', 'after the down script a user may exceed the share again');
  await db.exec(up);
  handle.functions.clear();
  assert.equal((await reserve(rolledBack, model7, 1)).status, 'user_pool_share', 'applied again, the share is back');
  ok('the up migration re-runs, the down script restores the previous function and the up applies again');

  console.log(`PASS: ${passed.length} pool cost share checks`);
} finally {
  await closeAllPglite();
}
