// The Athlete ($1) and Speed ($5) plans (migration 20261108000000_athlete_speed_plans.sql) on a
// fresh PGlite (DATABASE_DRIVER=pglite) with every migration applied:
//   * the two zerox_plan_policy rows carry the approved prices, limits, credits, tiers, order and
//     features, equal to src/plan-policy.js PLAN_CATALOG and the gateway's built-in policies;
//   * accounts, manual plans and subscriptions accept the ids; the billing functions take them and a
//     subscription grants the plan; plans rank by price (upgrade and downgrade flags);
//   * re-running the migration keeps stored Razorpay plan ids and an operator's connector policy;
//   * deploy safety: without the rows (the down script) the catalogue does not offer either plan
//     (it still resolves them for existing subscribers) and the billing functions refuse them; the
//     down script refuses while an account or a live subscription is on a plan, and keeps ended
//     subscriptions;
//   * up, down, up: the migration applies again after the down script.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { BUILTIN_PLANS, loadPlanPolicies } from './src/catalog.js';
import { loadPlanCatalog, offeredPlans, PAID_PLAN_IDS, PLAN_CATALOG, ROW_REQUIRED_PLAN_IDS } from './src/plan-policy.js';

const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }
// Every catalogue read gets its own env object: the plan caches are keyed by env.
const freshEnv = () => ({ DATABASE_DRIVER: 'pglite' });
const env = freshEnv();
const handle = await getPgliteHandle(env);
const db = handle.db;
const sql = async (text, params) => (await db.query(text, params)).rows;

const VERSION = '20261108000000';
const up = await readFile(new URL(`./migrations/${VERSION}_athlete_speed_plans.sql`, import.meta.url), 'utf8');
const down = await readFile(new URL(`./migrations/down/${VERSION}_athlete_speed_plans.sql`, import.meta.url), 'utf8');

let counter = 0;
async function newUser() {
  counter += 1;
  const email = `athlete${counter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Athlete ${counter}` } });
  return id;
}
const subId = () => `sub_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const future = () => new Date(Date.now() + 20 * 86400000).toISOString();
const upsert = (userId, plan, id = subId(), status = 'active') => rpc(env, 'zerox_billing_upsert_subscription', {
  p_user_id: userId, p_provider: 'razorpay', p_provider_subscription_id: id, p_plan: plan, p_status: status,
  p_current_period_start: new Date().toISOString(), p_current_period_end: future(), p_cancel_at_period_end: false,
  p_raw: { plan_id: 'plan_Test' + plan },
});
const account = async userId => (await sql('SELECT plan, plan_source, manual_plan FROM public.zerox_accounts WHERE clerk_id = $1', [userId]))[0];
const reconcile = async userId => (await rpcRows(env, 'zerox_reconcile_subscription_plan', { p_user_id: userId }))[0];
const policyRows = () => sql(`SELECT plan, name, price_usd::float AS price_usd, price_inr_paise, daily_requests, daily_tokens, rpm_limit,
  concurrency_limit, allowed_tiers, monthly_credit_microusd, features, sort, public, highlighted, window_tokens, window_seconds,
  razorpay_plan_id_inr, razorpay_plan_id_usd, connector_policy FROM public.zerox_plan_policy ORDER BY sort, plan`);
const rejects = async (text, params, pattern) => {
  await assert.rejects(db.query(text, params), pattern);
};

try {
  // ── 1. The seeded rows ──
  const rows = await policyRows();
  assert.deepEqual(rows.filter(row => row.public).map(row => row.plan), ['free', 'athlete', 'speed', 'pro', 'max'],
    'public plans in sort order: Free, Athlete, Speed, Pro, Max');
  const byId = Object.fromEntries(rows.map(row => [row.plan, row]));
  assert.deepEqual(['athlete', 'speed'].map(id => {
    const { plan, name, price_usd, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers,
      monthly_credit_microusd, sort, public: visible, highlighted, window_tokens, window_seconds, razorpay_plan_id_inr, razorpay_plan_id_usd } = byId[id];
    return { plan, name, price_usd, price_inr_paise, daily_requests, daily_tokens, rpm_limit, concurrency_limit, allowed_tiers,
      monthly_credit_microusd, sort, visible, highlighted, window_tokens, window_seconds, razorpay_plan_id_inr, razorpay_plan_id_usd };
  }), [
    { plan: 'athlete', name: 'Athlete', price_usd: 1, price_inr_paise: 8900, daily_requests: 300, daily_tokens: 6000000, rpm_limit: 15,
      concurrency_limit: 2, allowed_tiers: ['free', 'paid'], monthly_credit_microusd: 750000, sort: 12, visible: true, highlighted: false,
      window_tokens: null, window_seconds: null, razorpay_plan_id_inr: null, razorpay_plan_id_usd: null },
    { plan: 'speed', name: 'Speed', price_usd: 5, price_inr_paise: 44900, daily_requests: 1000, daily_tokens: 8000000, rpm_limit: 20,
      concurrency_limit: 3, allowed_tiers: ['free', 'paid'], monthly_credit_microusd: 4000000, sort: 15, visible: true, highlighted: false,
      window_tokens: null, window_seconds: null, razorpay_plan_id_inr: null, razorpay_plan_id_usd: null },
  ]);
  assert.equal(byId.pro.highlighted, true, 'Pro stays highlighted');
  assert.deepEqual([byId.pro.price_usd, byId.pro.price_inr_paise, byId.max.price_usd, byId.max.price_inr_paise], [10, 89900, 40, 349900],
    'Pro and Max prices unchanged');
  for (const id of ['athlete', 'speed']) {
    assert.deepEqual(byId[id].features, PLAN_CATALOG.find(plan => plan.id === id).features, `${id}: features equal PLAN_CATALOG`);
    assert.deepEqual(byId[id].connector_policy, byId.pro.connector_policy, `${id}: the connector policy of Pro`);
  }
  ok('athlete and speed rows: approved prices, limits, credits, tiers, sort and features; Pro and Max unchanged');

  // ── 2. The gateway reads them as it reads every plan ──
  const catalog = await loadPlanCatalog(freshEnv());
  assert.equal(catalog.source, 'database');
  assert.deepEqual(catalog.plans.map(plan => plan.id), ['free', 'athlete', 'speed', 'pro', 'max']);
  for (const plan of catalog.plans) {
    const base = PLAN_CATALOG.find(entry => entry.id === plan.id);
    const { razorpay_plan_id_inr: _inr, razorpay_plan_id_usd: _usd, offered, ...fromDb } = plan;
    assert.equal(offered, true, `${plan.id}: offered`);
    assert.deepEqual(fromDb, base, `${plan.id}: the database row equals the static catalogue`);
  }
  const policies = await loadPlanPolicies(freshEnv());
  for (const id of ['athlete', 'speed']) assert.deepEqual({ ...policies[id] }, { ...BUILTIN_PLANS[id] }, `${id}: routing policy equals the built-in plan`);
  const overview = await rpc(env, 'zerox_plan_policies', {});
  assert.equal(overview.policies.athlete.daily_tokens, 6000000);
  assert.equal(overview.policies.speed.daily_requests, 1000);
  const prices = PAID_PLAN_IDS.map(id => catalog.plans.find(plan => plan.id === id).price.usd_cents);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'PAID_PLAN_IDS is in price order');
  ok('catalogue, routing policies and zerox_plan_policies read athlete and speed; paid plans in price order');

  // ── 3. Constraints and billing functions accept the ids; a subscription grants the plan ──
  const user = await newUser();
  const athleteSub = subId();
  const row = await upsert(user, 'athlete', athleteSub);
  assert.equal(row.plan, 'athlete');
  assert.deepEqual(await account(user), { plan: 'athlete', plan_source: 'subscription', manual_plan: null });
  const recorded = (await rpcRows(env, 'zerox_billing_record_checkout', {
    p_user_id: await newUser(), p_provider: 'razorpay', p_provider_subscription_id: subId(), p_plan: 'speed', p_raw: { plan_id: 'plan_TestSpeed' },
  }))[0];
  assert.equal(recorded.recorded, true, 'a Speed checkout is recorded');
  await rejects(`SELECT * FROM public.zerox_billing_upsert_subscription($1, 'razorpay', 'sub_Unknown1234', 'gold', 'active', now(), now(), false, '{}')`,
    [user], /invalid_plan: gold/);
  ok('accounts, subscriptions and the billing functions take athlete and speed; an Athlete subscription grants the plan');

  // ── 4. Ranking by price: upgrade and downgrade flags ──
  await sql(`UPDATE public.zerox_accounts SET manual_plan = 'speed' WHERE clerk_id = $1`, [user]);
  let moved = await reconcile(user);
  assert.deepEqual([moved.previous_plan, moved.new_plan, moved.changed, moved.downgraded], ['athlete', 'speed', true, false],
    'a Speed operator plan outranks an Athlete subscription: an upgrade');
  await sql(`UPDATE public.zerox_accounts SET plan_source = 'subscription', manual_plan = NULL WHERE clerk_id = $1`, [user]);
  moved = await reconcile(user);
  assert.deepEqual([moved.previous_plan, moved.new_plan, moved.changed, moved.downgraded], ['speed', 'athlete', true, true],
    'back to the Athlete subscription is a downgrade');
  await sql(`UPDATE public.zerox_accounts SET manual_plan = 'pro' WHERE clerk_id = $1`, [user]);
  moved = await reconcile(user);
  assert.deepEqual([moved.new_plan, moved.downgraded], ['pro', false], 'Pro outranks Athlete');
  await sql(`UPDATE public.zerox_accounts SET plan = 'athlete', plan_source = 'subscription', manual_plan = NULL WHERE clerk_id = $1`, [user]);
  const proUser = await newUser();
  await upsert(proUser, 'pro');
  await sql(`UPDATE public.zerox_accounts SET manual_plan = 'speed' WHERE clerk_id = $1`, [proUser]);
  moved = await reconcile(proUser);
  assert.equal(moved.new_plan, 'pro', 'a Pro subscription outranks a Speed operator plan');
  ok('plans rank by price: Athlete < Speed < Pro (upgrade and downgrade flags)');

  // ── 5. Re-running keeps Razorpay ids and an operator's connector policy ──
  for (const text of [up, down]) assert.match(text, /SET LOCAL lock_timeout = '5s'/);
  assert.match(down, new RegExp(`schema_migrations WHERE version = '${VERSION}'`));
  await sql(`UPDATE public.zerox_plan_policy SET razorpay_plan_id_inr = 'plan_AthleteInr01', daily_requests = 1,
    connector_policy = '{"allowed": [], "denied": [], "required": [], "hosted": [], "allow_unvetted": false}'::jsonb WHERE plan = 'athlete'`);
  await sql(`UPDATE public.zerox_plan_policy SET razorpay_plan_id_inr = 'plan_SpeedInr0001' WHERE plan = 'speed'`);
  await sql(`UPDATE public.zerox_plan_policy SET razorpay_plan_id_inr = 'plan_ProInr000001', razorpay_plan_id_usd = 'plan_ProUsd000001' WHERE plan = 'pro'`);
  const before = await policyRows();
  await db.exec(up);
  await db.exec(up);
  const after = Object.fromEntries((await policyRows()).map(item => [item.plan, item]));
  assert.equal(after.athlete.razorpay_plan_id_inr, 'plan_AthleteInr01', 'athlete keeps its INR plan id');
  assert.equal(after.athlete.razorpay_plan_id_usd, null, 'USD ids stay null');
  assert.equal(after.speed.razorpay_plan_id_inr, 'plan_SpeedInr0001');
  assert.equal(after.athlete.daily_requests, 300, 'the approved values are set again');
  assert.equal(after.athlete.connector_policy.allow_unvetted, false, "an operator's connector policy is kept");
  for (const item of before.filter(entry => !['athlete', 'speed'].includes(entry.plan))) {
    assert.deepEqual(after[item.plan], item, `${item.plan}: untouched by a re-run`);
  }
  assert.deepEqual(await account(user), { plan: 'athlete', plan_source: 'subscription', manual_plan: null }, 'subscribers unaffected');
  ok('re-running keeps Razorpay plan ids, connector policies and every other plan');

  // ── 6. Down: refused while in use; then removes the plans; the gateway hides them ──
  const downBody = down.replace(/DELETE FROM supabase_migrations[^\n]*\n/, '');
  const downRefused = async message => {
    await assert.rejects(db.exec(downBody), /athlete_speed_in_use/, message);
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal((await policyRows()).filter(item => ['athlete', 'speed'].includes(item.plan)).length, 2, 'a refused down changes nothing');
  };
  await downRefused('refused while accounts and live subscriptions use the plans');
  await sql(`UPDATE public.zerox_accounts SET plan = 'free', plan_source = 'default', manual_plan = NULL WHERE plan IN ('athlete', 'speed') OR manual_plan IN ('athlete', 'speed')`);
  await downRefused('refused while a live subscription uses a plan, even with no account on it');
  // Ended subscriptions (payment history) do not block the rollback and survive it.
  await sql(`UPDATE public.zerox_subscriptions SET status = 'cancelled' WHERE plan IN ('athlete', 'speed')`);
  await sql(`UPDATE public.zerox_accounts SET plan = 'free', plan_source = 'default', manual_plan = NULL WHERE plan IN ('athlete', 'speed') OR manual_plan IN ('athlete', 'speed')`);
  const endedBefore = (await sql(`SELECT count(*)::int AS n FROM public.zerox_subscriptions WHERE plan IN ('athlete', 'speed')`))[0].n;
  assert.ok(endedBefore > 0, 'there are ended Athlete or Speed subscriptions');
  await db.exec(downBody);
  handle.functions.clear();
  assert.equal((await sql(`SELECT count(*)::int AS n FROM public.zerox_subscriptions WHERE plan IN ('athlete', 'speed')`))[0].n, endedBefore,
    'ended Athlete and Speed subscriptions are kept');
  assert.deepEqual((await policyRows()).map(item => item.plan), ['free', 'pro', 'max', 'ultrawork']);
  assert.equal((await policyRows()).find(item => item.plan === 'pro').razorpay_plan_id_inr, 'plan_ProInr000001', 'down keeps Pro ids');
  const other = await newUser();
  await rejects(`UPDATE public.zerox_accounts SET plan = 'athlete' WHERE clerk_id = $1`, [other], /zerox_accounts_plan_check/);
  await rejects(`UPDATE public.zerox_accounts SET manual_plan = 'speed' WHERE clerk_id = $1`, [other], /zerox_accounts_manual_plan_check/);
  await assert.rejects(upsert(other, 'athlete'), /invalid_plan: athlete/);
  await assert.rejects(rpc(env, 'zerox_billing_record_checkout', {
    p_user_id: other, p_provider: 'razorpay', p_provider_subscription_id: subId(), p_plan: 'speed', p_raw: {},
  }), /invalid_plan: speed/);
  const without = await loadPlanCatalog(freshEnv());
  assert.deepEqual(offeredPlans(without.plans).map(plan => plan.id), ['free', 'pro', 'max'], 'before the migration the catalogue offers neither plan');
  assert.ok(ROW_REQUIRED_PLAN_IDS.every(id => without.plans.find(plan => plan.id === id)?.offered === false),
    'both plans are still in the catalogue (not offered), so existing subscribers resolve');
  ok('down: refused while an account or a live subscription is on a plan, keeps ended subscriptions; without the rows the gateway offers Free, Pro and Max only');

  // ── 7. Up again ──
  await db.exec(up);
  handle.functions.clear();
  assert.deepEqual((await policyRows()).filter(item => item.public).map(item => item.plan), ['free', 'athlete', 'speed', 'pro', 'max']);
  assert.equal((await upsert(other, 'speed')).plan, 'speed');
  assert.equal((await account(other)).plan, 'speed');
  assert.deepEqual(offeredPlans((await loadPlanCatalog(freshEnv())).plans).map(plan => plan.id), ['free', 'athlete', 'speed', 'pro', 'max']);
  await sql(`UPDATE public.zerox_plan_policy SET public = false WHERE plan = 'athlete'`);
  const hidden = await loadPlanCatalog(freshEnv());
  assert.deepEqual(offeredPlans(hidden.plans).map(plan => plan.id), ['free', 'speed', 'pro', 'max'], 'public = false hides a new plan again');
  assert.equal(hidden.plans.find(plan => plan.id === 'athlete')?.monthly_credit_microusd, 750000,
    'a hidden plan still resolves (with its row values) for existing subscribers');
  ok('up, down, up: the migration applies again; public = false hides a new plan');

  console.log(`PASS: ${passed.length} athlete and speed plan checks`);
} finally {
  await closeAllPglite();
}
