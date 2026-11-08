// Sponsored pools and the monthly family allowance (docs/PLATFORM_CONTRACT.md section 19) on a
// fresh PGlite (DATABASE_DRIVER=pglite): migrations 20261106000600_sponsored_pools.sql,
// 20261106000700_haiku_catalog.sql and 20261106000800_plan_features_haiku.sql.
//   * the old 8-argument zerox_reserve_v2 call still works; the 9-argument call with p_cap checks
//     the user's tokens this UTC month atomically, after the plan's daily and window checks and
//     before rpm; a refusal writes nothing; the boundary is exact;
//   * settlement corrects the month row to the settled tokens, charges the user nothing, records
//     the sponsored cost, moves the pool's day bucket from the hold to the settled cost;
//   * refunds, failed_upstream, released reservations; cpd on a free pool; month rollover;
//   * usage_month and sponsored_cost_microusd on the account and usage functions; grants; validation;
//   * the Haiku row is seeded and the Pro/Max/Free feature lines carry the Haiku line.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { codeCatalog } from './src/catalog-db.js';
import { costMicrousd, reserveCostMicrousd } from './src/pricing.js';
import { reservationArgs, settlementArgs } from './src/capacity.js';

const env = { DATABASE_DRIVER: 'pglite' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

const FAMILY = 'anthropic/claude-haiku-5-5';
const MODEL = FAMILY;
const CAP = 10_000_000;
const haiku = codeCatalog().items.find(item => item.id === FAMILY).entry;
const pool = haiku.pools[0];
const capArg = { family: FAMILY, month_tokens: CAP };
const POOL_CPD = 6_250_000;

// Minute buckets and UTC days roll over on the wall clock; keep the run clear of a boundary.
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
const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const nextMonthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
const monthText = date => date.toISOString().slice(0, 10);

let userCounter = 0;
async function newUser(plan = 'free', { credits = 0 } = {}) {
  userCounter += 1;
  const email = `sponsored${userCounter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Sponsored ${userCounter}` } });
  await sql(`UPDATE public.zerox_accounts SET plan = $2, credit_balance_microusd = $3,
    plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END WHERE clerk_id = $1`, [id, plan, credits]);
  return id;
}
const reserve = (userId, overrides = {}) => rpc(env, 'zerox_reserve_v2', {
  p_user_id: userId, p_request_id: `req_${randomUUID().replaceAll('-', '')}`, p_model: MODEL, p_tier: 'free',
  p_tokens: 100, p_cost_microusd: 0, p_pool: null, ...overrides,
});
const sponsored = (userId, overrides = {}) => reserve(userId, { p_cap: capArg, ...overrides });
const settle = (reservationId, overrides = {}) => rpc(env, 'zerox_settle_v2', {
  p_reservation_id: reservationId, p_prompt_tokens: 10, p_completion_tokens: 5, p_cost_microusd: 0,
  p_status: 'ok', p_latency_ms: 20, p_provider: 'anthropic', p_upstream_model: 'claude-haiku-5-5', p_error_code: null, ...overrides,
});
const monthRow = async (userId, month = monthText(monthStart())) =>
  (await sql('SELECT * FROM public.zerox_family_month_usage WHERE user_id = $1 AND family = $2 AND month = $3', [userId, FAMILY, month]))[0];
const setMonth = (userId, tokens, month = monthText(monthStart())) => sql(`INSERT INTO public.zerox_family_month_usage (user_id, family, month, tokens)
  VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, family, month) DO UPDATE SET tokens = EXCLUDED.tokens`, [userId, FAMILY, month, tokens]);
const dayBucket = async (poolKey = '') => (await sql(`SELECT * FROM public.zerox_pool_usage
  WHERE model = $1 AND tier = 'free' AND pool_key = $2 AND bucket = 'day' ORDER BY bucket_start DESC LIMIT 1`, [MODEL, poolKey]))[0];
const reservationRow = async id => (await sql('SELECT * FROM public.zerox_reservations WHERE id = $1', [id]))[0];
const eventFor = async id => (await sql('SELECT * FROM public.zerox_usage_events WHERE reservation_id = $1', [id]))[0];
const account = async id => (await sql('SELECT * FROM public.zerox_accounts WHERE clerk_id = $1', [id]))[0];
const functionRows = name => sql(`SELECT p.pronargs, p.pronargdefaults, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
const secondsToMidnight = () => Math.ceil((Date.parse(`${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}T00:00:00Z`) - Date.now()) / 1000);

try {
  // ---------------------------------------------------------------- shape
  assert.deepEqual((await functionRows('zerox_reserve_v2')).map(row => [row.pronargs, row.pronargdefaults]), [[9, 2]],
    'one zerox_reserve_v2 (9 arguments, 2 defaults), so the 8-argument call still resolves');
  assert.deepEqual((await functionRows('zerox_account_overview')).map(row => [row.pronargs, row.pronargdefaults]), [[2, 1]]);
  assert.equal((await functionRows('zerox_settle_v2')).length, 1);
  const tableCols = await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'zerox_family_month_usage'`);
  assert.deepEqual(tableCols.map(row => row.column_name).sort(), ['family', 'month', 'requests', 'sponsored_cost_microusd', 'tokens', 'updated_at', 'user_id']);
  assert.equal((await sql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zerox_family_month_usage'::regclass`))[0].relrowsecurity, true, 'RLS on');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'zerox_family_month_usage'`))[0].n, 0, 'no policies');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef`))[0].n, 0, 'no security-definer function');
  assert.ok((await sql(`SELECT indexname FROM pg_indexes WHERE tablename = 'zerox_family_month_usage'`)).some(row => row.indexname === 'zerox_family_month_usage_month_idx'));
  ok('migrations applied: 9-argument zerox_reserve_v2 (8-argument call still resolves), month table with RLS on and no policies, no security-definer functions, month index');

  // ---------------------------------------------------------------- 1. the old call, 2-3. the monthly check
  const alpha = await newUser('free');
  const old = await reserve(alpha, { p_tokens: 500 });
  assert.equal(old.status, 'ok');
  assert.deepEqual([old.cap_family, old.cap_tokens, old.cap_used_tokens, old.cap_resets_at], [null, null, null, null], 'no p_cap, no cap columns');
  assert.equal(await monthRow(alpha), undefined, 'no month row without p_cap');
  await settle(old.reservation_id);

  // Max has no token window and 50M tokens a day, so a month's worth fits one account.
  const user = await newUser('max');
  const big = await sponsored(user, { p_tokens: 9_999_000 });
  assert.equal(big.status, 'ok');
  assert.deepEqual([big.cap_family, Number(big.cap_tokens), Number(big.cap_used_tokens)], [FAMILY, CAP, 9_999_000]);
  assert.equal(Date.parse(big.cap_resets_at), nextMonthStart().getTime(), 'the month ends at the first of next month 00:00 UTC');
  await settle(big.reservation_id, { p_prompt_tokens: 9_990_000, p_completion_tokens: 9_000 }); // exactly the hold
  const requests = (await account(user)).daily_requests;
  const refused = await sponsored(user, { p_tokens: 2_000 });
  assert.equal(refused.status, 'user_family_month_tokens');
  assert.equal(refused.reservation_id, null);
  assert.equal(Date.parse(refused.resets_at), nextMonthStart().getTime(), 'resets_at is the first of next month');
  assert.equal(Date.parse(refused.cap_resets_at), nextMonthStart().getTime());
  assert.ok(Math.abs(refused.retry_after_seconds - (nextMonthStart().getTime() - Date.now()) / 1000) <= 5);
  assert.equal(Number(refused.cap_used_tokens), 9_999_000, 'the count is without the refused request');
  assert.equal(Number((await monthRow(user)).tokens), 9_999_000, 'a refusal leaves the month row alone');
  assert.equal((await account(user)).daily_requests, requests, 'a refused request is not counted against the user');
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_reservations WHERE user_id = $1', [user]))[0].n, 1, 'no reservation row for it');
  const groq = await reserve(user, { p_model: 'groq/openai/gpt-oss-120b', p_tokens: 2_000 });
  assert.equal(groq.status, 'ok', 'an uncapped model of the same user is unaffected');
  await settle(groq.reservation_id);
  const exact = await sponsored(user, { p_tokens: 1_000 });
  assert.equal(exact.status, 'ok', 'exactly cap - used is allowed');
  assert.equal(Number(exact.cap_used_tokens), CAP);
  await settle(exact.reservation_id, { p_prompt_tokens: 600, p_completion_tokens: 400 });
  assert.equal((await sponsored(user, { p_tokens: 1 })).status, 'user_family_month_tokens', 'one more is refused');
  const huge = await sponsored(await newUser('max'), { p_tokens: CAP + 1 });
  assert.equal(huge.status, 'user_family_month_tokens');
  assert.deepEqual([huge.resets_at, huge.retry_after_seconds], [null, null], 'larger than the whole allowance: no time makes it fit');
  ok('p_cap: the old 8-argument call is unchanged; a refusal is user_family_month_tokens with resets_at at the first of next month and writes nothing; other models still serve; exact boundary; larger than the allowance has no retry time');

  // ---------------------------------------------------------------- 4. settlement
  const settler = await newUser('free');
  const settled = await sponsored(settler, { p_tokens: 5_000, p_cost_microusd: reserveCostMicrousd(pool.price, 4_000, 1_024), p_pool: { cpd: POOL_CPD } });
  assert.equal(settled.status, 'ok');
  const holdBucket = Number((await dayBucket()).cost_microusd);
  assert.ok(holdBucket > 0, 'the worst-case hold counts toward the pool cap');
  const billed = { cache_read_tokens: 1_000, cache_write_tokens: 0 };
  const cost = costMicrousd(pool.price, 3_200, 400, billed);
  assert.ok(cost > 0);
  const result = await settle(settled.reservation_id, { p_prompt_tokens: 3_200, p_completion_tokens: 400, p_cost_microusd: cost,
    p_cache_read_tokens: 1_000 });
  assert.deepEqual(result, { status: 'settled', credit_balance_microusd: 0 }, 'no credit is charged');
  assert.equal(Number((await monthRow(settler)).tokens), 3_600, 'the month row ends at the settled tokens');
  assert.equal(Number((await monthRow(settler)).requests), 1);
  assert.equal(Number((await monthRow(settler)).sponsored_cost_microusd), cost);
  const event = await eventFor(settled.reservation_id);
  assert.deepEqual([Number(event.cost_microusd), Number(event.sponsored_cost_microusd), event.tier], [0, cost, 'free'], 'the user is charged 0, the sponsored cost is recorded');
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_credit_ledger WHERE user_id = $1', [settler]))[0].n, 0, 'no ledger row');
  assert.equal(Number((await account(settler)).credit_balance_microusd), 0);
  assert.equal(Number((await dayBucket()).cost_microusd), cost, 'the pool day bucket moved from the hold to the settled cost');
  const [daily] = await sql('SELECT * FROM public.zerox_usage_daily WHERE user_id = $1 AND model = $2', [settler, MODEL]);
  assert.equal(Number(daily.sponsored_cost_microusd), cost);
  assert.equal(Number(daily.cost_microusd), 0);
  ok('settlement: month row corrected to the settled tokens, user charged nothing, sponsored cost on the event, daily rollup and month row, pool day bucket moves from the hold to the settled cost');

  // ---------------------------------------------------------------- 5. refunds and failed_upstream
  const refunder = await newUser('free');
  const bucketBefore = Number((await dayBucket()).cost_microusd);
  const first = await sponsored(refunder, { p_tokens: 4_000, p_cost_microusd: 9_000, p_pool: { cpd: POOL_CPD } });
  assert.equal(Number((await monthRow(refunder)).tokens), 4_000);
  assert.equal(Number((await dayBucket()).cost_microusd), bucketBefore + 9_000);
  await settle(first.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0, p_cost_microusd: 0 });
  assert.equal(Number((await monthRow(refunder)).tokens), 0, 'a refund returns the hold to the month row');
  assert.equal(Number((await monthRow(refunder)).requests), 0);
  assert.equal(Number((await monthRow(refunder)).sponsored_cost_microusd), 0);
  assert.equal(Number((await dayBucket()).cost_microusd), bucketBefore, 'and to the pool bucket');
  const reached = await sponsored(refunder, { p_tokens: 4_000, p_cost_microusd: 9_000, p_pool: { cpd: POOL_CPD } });
  await settle(reached.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 3_000, p_completion_tokens: 0, p_cost_microusd: 700,
    p_cache_read_tokens: 1_000, p_error_code: 'upstream_timeout' });
  assert.equal(Number((await monthRow(refunder)).tokens), 0, 'failed_upstream within the allowance refunds the user their tokens');
  assert.equal(Number((await eventFor(reached.reservation_id)).sponsored_cost_microusd), 700, 'but the cost to Zero-X is kept on the event');
  assert.equal(Number((await monthRow(refunder)).sponsored_cost_microusd), 700);
  assert.equal(Number((await dayBucket()).cost_microusd), bucketBefore + 700, 'and in the pool bucket');
  // Beyond the daily refund allowance an attempt counts like an error.
  await sql('UPDATE public.zerox_accounts SET upstream_refunds = 100, upstream_refund_day = (now() AT TIME ZONE \'UTC\')::date WHERE clerk_id = $1', [refunder]);
  const counted = await sponsored(refunder, { p_tokens: 4_000 });
  await settle(counted.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 3_000, p_completion_tokens: 100, p_cost_microusd: 0 });
  assert.equal(Number((await monthRow(refunder)).tokens), 3_100, 'beyond the allowance it counts the processed tokens');
  ok('refunded returns the hold to the month row and pool; failed_upstream refunds the tokens but keeps the sponsored cost; beyond the refund allowance it counts like an error');

  // ---------------------------------------------------------------- 6. release
  const leaver = await newUser('free');
  const lapsed = await sponsored(leaver, { p_tokens: 7_000 });
  await sql(`UPDATE public.zerox_reservations SET lease_expires_at = now() - interval '2 minutes' WHERE id = $1`, [lapsed.reservation_id]);
  const next = await sponsored(leaver, { p_tokens: 1_000 }); // releases the caller's lapsed free lease
  assert.equal((await reservationRow(lapsed.reservation_id)).status, 'released');
  assert.equal(Number((await monthRow(leaver)).tokens), 8_000, 'a released reservation keeps its hold');
  await settle(lapsed.reservation_id, { p_prompt_tokens: 1_500, p_completion_tokens: 500 });
  assert.equal(Number((await monthRow(leaver)).tokens), 3_000, 'a late settle corrects it');
  await settle(next.reservation_id, { p_prompt_tokens: 600, p_completion_tokens: 400 });
  const abandoned = await sponsored(leaver, { p_tokens: 2_000 });
  await sql(`UPDATE public.zerox_reservations SET lease_expires_at = now() - interval '10 minutes' WHERE id = $1`, [abandoned.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reservationRow(abandoned.reservation_id)).status, 'released');
  assert.equal(Number((await monthRow(leaver)).tokens), 5_000, 'the stale release keeps the hold too');
  ok('a reservation released by the next reservation or by the stale release keeps its month hold; a late settle corrects it');

  // ---------------------------------------------------------------- 7. cpd on a free pool
  const spenders = [await newUser('free'), await newUser('free'), await newUser('free'), await newUser('free'), await newUser('free')];
  const cpdModel = `anthropic/claude-cpd-${randomUUID().slice(0, 8)}`;
  const onCpd = (who, cost, overrides = {}) => reserve(who, { p_model: cpdModel, p_tokens: 100, p_cost_microusd: cost, p_pool: { cpd: POOL_CPD }, ...overrides });
  // 1.5M is under each user's share of the 6.25M cap (25 percent: 1,562,500), so four users fill it.
  for (const who of spenders.slice(0, 4)) assert.equal((await onCpd(who, 1_500_000)).status, 'ok');
  const spent = await onCpd(spenders[4], 1_500_000);
  assert.equal(spent.status, 'pool_exhausted', 'holds past the cap are refused on a free pool too');
  assert.ok(Math.abs(spent.retry_after_seconds - secondsToMidnight()) <= 5, 'until 00:00 UTC');
  assert.equal(Number((await sql(`SELECT cost_microusd FROM public.zerox_pool_usage WHERE model = $1 AND tier = 'free' AND bucket = 'day'`, [cpdModel]))[0].cost_microusd), 6_000_000);
  assert.equal((await reserve(spenders[4], { p_model: cpdModel, p_cost_microusd: 5_000_000, p_pool: { rpm: null, rpd: null } })).status, 'ok',
    'the same pool without cpd never refuses on cost');
  ok('cpd applies to a free pool: holds past the spend cap are pool_exhausted until 00:00 UTC; without cpd nothing refuses');

  // ---------------------------------------------------------------- 8. month rollover
  const roller = await newUser('free');
  const lastMonth = monthText(new Date(Date.UTC(monthStart().getUTCFullYear(), monthStart().getUTCMonth() - 1, 1)));
  await setMonth(roller, CAP, lastMonth);
  const rolled = await sponsored(roller, { p_tokens: 2_000 });
  assert.equal(rolled.status, 'ok', 'a full month does not carry over');
  assert.equal(Number((await monthRow(roller, lastMonth)).tokens), CAP, 'the earlier month is untouched');
  assert.equal(Number((await monthRow(roller)).tokens), 2_000);
  ok('month rollover: a new month starts a new row and leaves the earlier one alone');

  // ---------------------------------------------------------------- 9. order of checks
  const full = await newUser('free');
  await setMonth(full, CAP);
  const policy = (await sql(`SELECT * FROM public.zerox_plan_policy WHERE plan = 'free'`))[0];
  await sql('UPDATE public.zerox_accounts SET daily_requests = $2 WHERE clerk_id = $1', [full, policy.daily_requests]);
  assert.equal((await sponsored(full)).status, 'user_daily_requests', 'the daily request cap comes before the month');
  await sql('UPDATE public.zerox_accounts SET daily_requests = 0 WHERE clerk_id = $1', [full]);
  assert.equal((await sponsored(full, { p_tokens: policy.window_tokens + 1 })).status, 'user_window_tokens', 'a request larger than the window is refused by the window first');
  assert.equal((await sponsored(full)).status, 'user_family_month_tokens', 'then the month, before rpm and the pool');
  const limited = await newUser('free');
  for (let index = 0; index < policy.rpm_limit; index += 1) {
    const row = await reserve(limited, { p_tokens: 10 });
    assert.equal(row.status, 'ok');
    await settle(row.reservation_id);
  }
  const rpm = await sponsored(limited);
  assert.equal(rpm.status, 'user_rpm', 'rpm is checked after the month passed');
  assert.equal(Number(rpm.cap_used_tokens), 0);
  const poolFull = await newUser('free');
  assert.equal((await sponsored(poolFull, { p_pool: { cpd: 0 } })).status, 'pool_exhausted', 'a spent cap refuses (a pool with rpd 0 also reads pool_exhausted since 20261107000100)');
  assert.equal(Number((await monthRow(poolFull)).tokens), 0, 'a refusal by a later check holds nothing in the month');
  ok('order: daily requests, window, month, rpm, pool budgets; a later refusal leaves the month row at zero');

  // ---------------------------------------------------------------- 10. overview and usage functions
  const viewer = await newUser('free');
  const used = await sponsored(viewer, { p_tokens: 2_500 });
  await settle(used.reservation_id, { p_prompt_tokens: 2_000, p_completion_tokens: 300, p_cost_microusd: 1_234 });
  const overview = await rpc(env, 'zerox_account_overview', { p_user_id: viewer, p_caps: [capArg] });
  assert.deepEqual(overview.usage_month.map(row => ({ ...row, resets_at: Date.parse(row.resets_at) })), [
    { family: FAMILY, tokens: 2_300, requests: 1, limit_tokens: CAP, remaining_tokens: CAP - 2_300, resets_at: nextMonthStart().getTime() }]);
  const plain = await rpc(env, 'zerox_account_overview', { p_user_id: viewer });
  assert.equal(plain.usage_month[0].limit_tokens, null, 'the one-argument call still works; without caps the limit is unknown');
  assert.deepEqual((await rpc(env, 'zerox_account_overview', { p_user_id: await newUser('free'), p_caps: [capArg] })).usage_month, [], 'empty when unused');
  const today = new Date().toISOString().slice(0, 10);
  const byModel = await rpcRows(env, 'zerox_usage_by_model', { p_user_id: viewer, p_from: today, p_to: today });
  assert.deepEqual(byModel.map(row => [row.model, Number(row.requests), Number(row.cost_microusd), Number(row.sponsored_cost_microusd)]), [[MODEL, 1, 0, 1_234]]);
  ok('zerox_account_overview usage_month (with and without p_caps) and zerox_usage_by_model sponsored_cost_microusd');

  // ---------------------------------------------------------------- 11. grants and validation
  for (const [name, args] of [['zerox_reserve_v2', 'uuid, text, text, text, bigint, bigint, jsonb, text, jsonb'],
    ['zerox_usage_by_model', 'uuid, date, date'], ['zerox_account_overview', 'uuid, jsonb']]) {
    const [row] = await sql(`SELECT has_function_privilege('anon', 'public.${name}(${args})', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'public.${name}(${args})', 'EXECUTE') AS auth,
      has_function_privilege('service_role', 'public.${name}(${args})', 'EXECUTE') AS service`);
    assert.deepEqual([row.anon, row.auth, row.service], [false, false, true], `${name} is service_role only`);
  }
  const [table] = await sql(`SELECT has_table_privilege('anon', 'public.zerox_family_month_usage', 'SELECT') AS anon,
    has_table_privilege('authenticated', 'public.zerox_family_month_usage', 'SELECT') AS auth,
    has_table_privilege('service_role', 'public.zerox_family_month_usage', 'SELECT') AS service`);
  assert.deepEqual([table.anon, table.auth, table.service], [false, false, true]);
  for (const bad of [{ family: '', month_tokens: 5 }, { family: FAMILY, month_tokens: 0 }, { family: FAMILY }, { month_tokens: 5 }, [1], 'x']) {
    await assert.rejects(sponsored(viewer, { p_cap: bad }), /invalid_cap/, JSON.stringify(bad));
  }
  assert.equal((await sponsored(await newUser('free'), { p_cap: null })).cap_family, null, 'a null p_cap is the old behaviour');
  ok('service_role only; a malformed p_cap is invalid_cap');

  // ---------------------------------------------------------------- the arguments the gateway sends
  const session = { user_id: await newUser('pro', { credits: 1_000_000 }) };
  const args = reservationArgs({ env: { ANTHROPIC_API_KEY: 'test' }, session, requestId: 'req_args', entry: haiku, pool, promptTokens: 4_000, maxTokens: 16_000 });
  assert.deepEqual([args.p_tier, args.p_pool.cpd, args.p_cap], ['free', POOL_CPD, capArg]);
  assert.ok(args.p_cost_microusd > 0);
  // On a model id of its own: the earlier sections spent this pool's per-minute token budget (tpm).
  const viaGateway = await rpc(env, 'zerox_reserve_v2', { ...args, p_model: `${MODEL}-args` });
  assert.equal(viaGateway.status, 'ok', 'the gateway\'s own arguments reserve on a Pro account with credits (never charged)');
  const usage = { prompt_tokens: 4_100, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 3_000 } };
  const settlement = settlementArgs({ reservationId: viaGateway.reservation_id, entry: haiku, pool, usage, status: 'ok' });
  assert.ok(settlement.p_cost_microusd > 0, 'settlement sends the pool cost for a sponsored pool');
  const settledGateway = await rpc(env, 'zerox_settle_v2', settlement);
  assert.deepEqual(settledGateway, { status: 'settled', credit_balance_microusd: 1_000_000 }, 'a Pro account keeps its credits');
  ok('reservationArgs and settlementArgs of a sponsored pool: p_cap, cpd, hold and settled cost; a Pro account with credits is never charged');

  // ---------------------------------------------------------------- the migrations' data
  const row = (await sql(`SELECT m.status, m.source, r.revision, r.approved_by, r.context_window, p.tier, p.key_slot, p.daily_spend_cap_microusd,
      p.input_microusd_per_mtok, p.output_microusd_per_mtok, p.rpm, p.tpd
    FROM public.zerox_catalog_models AS m JOIN public.zerox_catalog_revisions AS r ON r.id = m.active_revision_id
    JOIN public.zerox_catalog_revision_pools AS p ON p.revision_id = r.id WHERE m.id = $1`, [FAMILY]))[0];
  assert.deepEqual([row.status, row.source, row.revision, row.approved_by, row.context_window, row.tier, row.key_slot],
    ['active', 'seed', 1, 'migration', 100000, 'free', 'anthropic.paid']);
  assert.deepEqual([Number(row.daily_spend_cap_microusd), Number(row.input_microusd_per_mtok), Number(row.output_microusd_per_mtok), row.rpm, Number(row.tpd)],
    [5_000_000, 100_000, 500_000, 50, 60_000_000]);
  assert.equal((await sql(`SELECT count(*)::int AS n FROM public.zerox_catalog_events WHERE model_id = $1`, [FAMILY]))[0].n, 1, 'one seed audit row');
  assert.equal((await sql(`SELECT public.zerox_catalog_slot_ok('anthropic', 'free', 'anthropic.paid') AS ok`))[0].ok, true);
  assert.equal((await sql(`SELECT public.zerox_catalog_slot_ok('groq', 'free', 'anthropic.paid') AS ok`))[0].ok, false);
  const features = Object.fromEntries((await rpcRows(env, 'zerox_plan_policies_v2', {})).map(plan => [plan.plan, plan.features]));
  const LINE = 'Claude Haiku 5.5 included: 10M tokens a month at no charge';
  assert.equal(features.free[1], LINE, 'second line of Free');
  for (const plan of ['athlete', 'speed', 'pro', 'max', 'ultrawork']) assert.equal(features[plan][0], LINE, `first line of ${plan}`);
  assert.deepEqual(Object.fromEntries(Object.entries(features).map(([plan, list]) => [plan, list.length])), { free: 5, athlete: 6, speed: 6, pro: 6, max: 6, ultrawork: 6 });
  ok('the Haiku catalog row is seeded (revision 1 approved by the migration, free pool on anthropic.paid with price and $5 cap) and every plan carries the Haiku feature line');

  // ---------------------------------------------------------------- every statement can be re-run
  for (let run = 0; run < 2; run += 1) {
    for (const file of ['20261106000600_sponsored_pools.sql', '20261106000700_haiku_catalog.sql', '20261106000800_plan_features_haiku.sql', '20261107000000_pool_user_cost_share.sql']) {
      await db.exec(await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
    }
  }
  handle.functions.clear();
  assert.deepEqual((await functionRows('zerox_reserve_v2')).map(row => [row.pronargs, row.pronargdefaults]), [[9, 2]]);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_catalog_events WHERE model_id = $1', [FAMILY]))[0].n, 1, 'no second seed event');
  assert.equal((await sql(`SELECT count(*)::int AS n FROM public.zerox_plan_policy WHERE plan = 'pro' AND features ? 'Claude Haiku 5.5 included: 10M tokens a month at no charge'`))[0].n, 1);
  assert.equal((await sponsored(await newUser('free'), { p_tokens: 100 })).status, 'ok', 'still works after the re-runs');
  ok('the three migrations re-run cleanly (twice): same function shape, no second catalog event, the feature line once');

  console.log(`PASS: ${passed.length} sponsored-cap checks`);
} finally {
  await closeAllPglite();
}
