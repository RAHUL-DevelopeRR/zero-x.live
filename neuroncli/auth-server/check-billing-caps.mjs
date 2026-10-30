// Paid billing checks for 20261029000800_paid_billing_caps.sql and
// 20261029000900_plan_features_claude.sql on a fresh PGlite (DATABASE_DRIVER=pglite):
// the per-pool daily spend cap (p_pool.cpd) and its reconciliation, cache-aware settlement with
// the old 9-argument and the new 11-argument zerox_settle_v2, in-flight credit holds (paid
// reservations released after 60 minutes), rpm per client request, the Claude plan rows, and the
// down scripts (revert to the previous definitions, then re-apply twice).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle, migrate } from './src/db/pglite.js';
import { listMigrations } from './src/db/migrations.js';

const root = dirname(fileURLToPath(import.meta.url));
const site = join(root, '..', '..');
const env = { DATABASE_DRIVER: 'pglite' };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const utcDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

const CAPS = '20261029000800_paid_billing_caps.sql';
const PLANS = '20261029000900_plan_features_claude.sql';
const migrationSql = file => readFile(join(root, 'migrations', file), 'utf8');
const downSql = file => readFile(join(root, 'migrations', 'down', file.replace(/\.sql$/, '.down.sql')), 'utf8');

// Minute buckets and UTC days roll over on the wall clock; keep each timed section clear of a boundary.
async function clockHeadroom(seconds = 12) {
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
const secondsToMidnight = () => Math.ceil((Date.parse(`${utcDay(1)}T00:00:00Z`) - Date.now()) / 1000);

let userCounter = 0;
async function newUser(plan = 'free', { credits = 0 } = {}) {
  userCounter += 1;
  const email = `billing${userCounter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Billing ${userCounter}` } });
  await sql(`UPDATE public.zerox_accounts SET plan = $2, credit_balance_microusd = $3,
    plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END WHERE clerk_id = $1`, [id, plan, credits]);
  return id;
}
const account = async id => (await sql('SELECT * FROM public.zerox_accounts WHERE clerk_id = $1', [id]))[0];
const reserve = (userId, overrides = {}) => rpc(env, 'zerox_reserve_v2', {
  p_user_id: userId, p_request_id: `req_${randomUUID().replaceAll('-', '')}`, p_model: 'test/model', p_tier: 'free',
  p_tokens: 100, p_cost_microusd: 0, p_pool: null, ...overrides,
});
// The 9 named arguments the deployed Worker sends.
const settle = (reservationId, overrides = {}) => rpc(env, 'zerox_settle_v2', {
  p_reservation_id: reservationId, p_prompt_tokens: 10, p_completion_tokens: 5, p_cost_microusd: 0,
  p_status: 'ok', p_latency_ms: 20, p_provider: 'test', p_upstream_model: 'model', p_error_code: null, ...overrides,
});
const dayBucket = async (model, poolKey = '') => (await sql(`SELECT * FROM public.zerox_pool_usage
  WHERE model = $1 AND tier = 'paid' AND pool_key = $2 AND bucket = 'day' ORDER BY bucket_start DESC LIMIT 1`, [model, poolKey]))[0];
const reservation = async id => (await sql('SELECT * FROM public.zerox_reservations WHERE id = $1', [id]))[0];
const eventFor = async id => (await sql('SELECT * FROM public.zerox_usage_events WHERE reservation_id = $1', [id]))[0];
const functionRows = name => sql(`SELECT p.pronargs, p.pronargdefaults, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
const columnsOf = async table => (await sql(`SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, [table])).map(row => row.column_name);

const PLAN_FEATURES = {
  free: ['Free models from Groq, Google Gemini, Cloudflare Workers AI, NVIDIA and OpenRouter',
    '100 requests and 500K tokens per day', '10 requests per minute, 2 at once', 'Every Neuron feature, the same on all plans'],
  pro: ['Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits', '$8 of credits included every month',
    'Free models with higher limits: 2,000 requests and 10M tokens per day', '30 requests per minute, 4 at once',
    'Every Neuron feature, the same on all plans'],
  max: ['Claude Sonnet 5.5 and Claude Opus 5.5, billed from credits', '$35 of credits included every month',
    'Free models with higher limits: 10,000 requests and 50M tokens per day', '60 requests per minute, 8 at once',
    'Every Neuron feature, the same on all plans'],
};
PLAN_FEATURES.ultrawork = PLAN_FEATURES.pro;

let baseline;
try {
  // ---------------------------------------------------------------- migrations and signatures
  const files = (await listMigrations()).map(migration => migration.file);
  assert.ok(files.indexOf(CAPS) > files.indexOf('20261029000500_credit_programs.sql') && files.indexOf(PLANS) === files.indexOf(CAPS) + 1,
    'the billing migrations come after the OIOP credit programs, caps before plans');
  assert.ok(handle.applied.includes('20261029000800') && handle.applied.includes('20261029000900'));
  const settleFns = await functionRows('zerox_settle_v2');
  assert.equal(settleFns.length, 1, 'one zerox_settle_v2, so PostgREST never has to choose between overloads');
  assert.equal(settleFns[0].pronargs, 11);
  assert.equal(settleFns[0].pronargdefaults, 2);
  assert.match(settleFns[0].args, /p_error_code text, p_cache_read_tokens bigint, p_cache_write_tokens bigint$/);
  const reserveFns = await functionRows('zerox_reserve_v2');
  assert.deepEqual(reserveFns.map(row => [row.pronargs, row.pronargdefaults]), [[8, 1]], 'zerox_reserve_v2 keeps its 8-argument signature');
  assert.ok((await columnsOf('zerox_pool_usage')).includes('cost_microusd'));
  for (const table of ['zerox_reservations', 'zerox_usage_events', 'zerox_usage_daily']) {
    const columns = await columnsOf(table);
    assert.ok(columns.includes('cache_read_tokens') && columns.includes('cache_write_tokens'), `${table} has the cache columns`);
  }
  ok('migrations applied in order; one 11-argument zerox_settle_v2 (2 defaults), zerox_reserve_v2 unchanged, cost and cache columns');

  // ---------------------------------------------------------------- per-pool daily spend cap (cpd)
  await clockHeadroom(30);
  const capModel = `anthropic/claude-cap-${randomUUID().slice(0, 8)}`;
  const capPool = { rpm: null, rpd: null, tpm: null, tpd: null, cpd: 100000 };
  const spender = await newUser('pro', { credits: 10000000 });
  const other = await newUser('max', { credits: 10000000 });
  const onCap = (user, cost, overrides = {}) => reserve(user, { p_model: capModel, p_tier: 'paid', p_cost_microusd: cost, p_pool: capPool, ...overrides });
  const first = await onCap(spender, 60000);
  assert.equal(first.status, 'ok');
  assert.equal((await dayBucket(capModel)).cost_microusd, 60000, 'the worst-case hold counts toward the cap while the request runs');
  const before = await account(spender);
  const capped = await onCap(spender, 60000);
  assert.equal(capped.status, 'pool_exhausted');
  assert.equal(capped.reservation_id, null);
  assert.ok(Math.abs(capped.retry_after_seconds - secondsToMidnight()) <= 5, 'a spent daily cap retries at 00:00 UTC');
  assert.equal((await dayBucket(capModel)).cost_microusd, 60000, 'a refused reservation adds nothing');
  assert.equal((await dayBucket(capModel)).requests, 1);
  assert.equal((await account(spender)).daily_requests, before.daily_requests, 'a refused reservation is not counted against the user');
  assert.equal((await onCap(other, 60000)).status, 'pool_exhausted', 'the cap is shared by every user of the pool');
  assert.equal((await reserve(other, { p_model: capModel, p_tier: 'free', p_pool: { cpd: 0 } })).status, 'ok',
    'cpd applies to the paid tier only');
  // Settlement moves the bucket from the hold to the settled cost.
  assert.deepEqual(await settle(first.reservation_id, { p_prompt_tokens: 20000, p_completion_tokens: 800, p_cost_microusd: 20000,
    p_cache_read_tokens: 16000, p_cache_write_tokens: 4000 }), { status: 'settled', credit_balance_microusd: 10000000 - 20000 });
  assert.equal((await dayBucket(capModel)).cost_microusd, 20000);
  const second = await onCap(other, 60000);
  assert.equal(second.status, 'ok', 'settling the first request at 20000 lets the next 60000 through');
  const exact = await onCap(spender, 20000);
  assert.equal(exact.status, 'ok', 'a reservation that fills the cap exactly is allowed');
  assert.equal((await dayBucket(capModel)).cost_microusd, 100000);
  assert.equal((await onCap(spender, 1)).status, 'pool_exhausted');
  assert.equal((await onCap(spender, 0)).status, 'pool_exhausted', 'a spent cap refuses even a zero estimate');
  // A refunded attempt returns its whole hold to the bucket.
  await settle(second.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0, p_cost_microusd: 0 });
  assert.equal((await dayBucket(capModel)).cost_microusd, 40000);
  // A settled cost above the hold (prompt underestimated) is counted as spent.
  const over = await onCap(other, 30000);
  await settle(over.reservation_id, { p_prompt_tokens: 50000, p_completion_tokens: 10, p_cost_microusd: 45000 });
  assert.equal((await dayBucket(capModel)).cost_microusd, 85000);
  // failed_upstream reached the model: the user is refunded but the pool keeps the cost.
  await sql("UPDATE public.zerox_pool_usage SET cost_microusd = 0 WHERE model = $1 AND tier = 'paid'", [capModel]);
  await sql("UPDATE public.zerox_reservations SET status = 'settled' WHERE model = $1 AND status = 'active'", [capModel]);
  const reached = await onCap(spender, 50000);
  const balanceBefore = (await account(spender)).credit_balance_microusd;
  await settle(reached.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 3000, p_completion_tokens: 0,
    p_cost_microusd: 7500, p_cache_read_tokens: 1000, p_error_code: 'upstream_timeout' });
  assert.equal((await account(spender)).credit_balance_microusd, balanceBefore, 'a refunded failed_upstream attempt costs the user nothing');
  assert.equal((await dayBucket(capModel)).cost_microusd, 7500, 'the pool keeps the cost of an attempt that reached the model');
  assert.equal((await eventFor(reached.reservation_id)).cost_microusd, 0);
  // A released (stale) reservation keeps its hold until a late settle reconciles it. Abandoned:
  // its lease lapsed (nothing renews it), 20261028000000_reservation_leases.sql.
  const stale = await onCap(other, 40000);
  await sql(`UPDATE public.zerox_reservations SET created_at = now() - interval '61 minutes',
    lease_expires_at = now() - interval '6 minutes' WHERE id = $1`, [stale.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reservation(stale.reservation_id)).status, 'released');
  assert.equal((await dayBucket(capModel)).cost_microusd, 47500, 'a released reservation still holds its share of the cap');
  assert.equal((await settle(stale.reservation_id, { p_cost_microusd: 1000 })).status, 'settled');
  assert.equal((await dayBucket(capModel)).cost_microusd, 8500, 'a late settle reconciles the hold');
  // The cap is checked per pool key bucket, like rpm/rpd/tpm/tpd.
  const keyA = `${capModel.replace('/', ':')}:paid#${randomUUID()}`;
  const keyed = await onCap(spender, 95000, { p_pool_key: keyA });
  assert.equal(keyed.status, 'ok', 'a vault key bucket has a cap of its own');
  assert.equal((await dayBucket(capModel, keyA)).cost_microusd, 95000);
  assert.equal((await onCap(spender, 10000, { p_pool_key: keyA })).status, 'pool_exhausted');
  assert.equal((await onCap(spender, 10000)).status, 'ok', 'the default bucket is separate');
  // Operators see the day's held plus settled cost per pool and per key.
  const capRow = (await rpc(env, 'zerox_admin_overview', {})).overview.pools.find(row => row.model === capModel && row.tier === 'paid');
  assert.equal(capRow.cost_today_microusd, 8500 + 10000 + 95000);
  assert.deepEqual(Object.fromEntries(capRow.keys.map(key => [key.pool_key, key.cost_today_microusd])), { null: 18500, [keyA]: 95000 });
  // Validation, as for the other budgets.
  await assert.rejects(onCap(spender, 1, { p_pool: { cpd: -1 } }), /invalid_pool_budget: cpd/);
  await assert.rejects(onCap(spender, 1, { p_pool: { cpd: 'ten dollars' } }), /invalid_pool_budget: cpd/);
  const fractional = await onCap(spender, 1, { p_model: `${capModel}-f`, p_pool: { cpd: 1.9 } });
  assert.equal(fractional.status, 'ok', 'cpd is floored like the other budgets');
  assert.equal((await onCap(spender, 1, { p_model: `${capModel}-f`, p_pool: { cpd: 1.9 } })).status, 'pool_exhausted');
  ok('cpd: worst-case holds count toward the per-pool daily cap across users, a spent cap is pool_exhausted until 00:00 UTC, settle reconciles to the settled cost (refund returns the hold, failed_upstream keeps its cost, overshoot counted, late settle after release), per pool key, admin overview cost_today_microusd, validation');

  // ---------------------------------------------------------------- cache-aware settlement, old and new signatures
  const cacheUser = await newUser('pro', { credits: 5000000 });
  const cacheModel = `anthropic/claude-cache-${randomUUID().slice(0, 8)}`;
  const paid = (overrides = {}) => reserve(cacheUser, { p_model: cacheModel, p_tier: 'paid', p_tokens: 36000, p_cost_microusd: 462500, ...overrides });
  const turn = await paid();
  assert.equal(turn.status, 'ok');
  // Sonnet 5.5 at list x 1.25: 16,000 cache read, 4,000 cache write, 800 output = 26,500 micro-USD.
  assert.deepEqual(await settle(turn.reservation_id, { p_prompt_tokens: 20000, p_completion_tokens: 800, p_cost_microusd: 26500,
    p_provider: 'anthropic', p_upstream_model: 'claude-sonnet-5-5', p_cache_read_tokens: 16000, p_cache_write_tokens: 4000 }),
  { status: 'settled', credit_balance_microusd: 5000000 - 26500 });
  const turnRow = await reservation(turn.reservation_id);
  assert.deepEqual([turnRow.prompt_tokens, turnRow.cache_read_tokens, turnRow.cache_write_tokens, turnRow.cost_microusd], [20000, 16000, 4000, 26500]);
  const turnEvent = (await rpcRows(env, 'zerox_usage_events', { p_user_id: cacheUser, p_limit: 1 }))[0];
  assert.deepEqual([turnEvent.prompt_tokens, turnEvent.cache_read_tokens, turnEvent.cache_write_tokens, turnEvent.completion_tokens, turnEvent.cost_microusd],
    [20000, 16000, 4000, 800, 26500], 'the usage event carries the cache columns');
  const ledger = await sql('SELECT * FROM public.zerox_credit_ledger WHERE user_id = $1', [cacheUser]);
  assert.deepEqual(ledger.map(row => [row.delta_microusd, row.ref]), [[-26500, `usage:${turn.reservation_id}`]]);
  // The legacy 9 named arguments of the deployed Worker still resolve, with no cache tokens.
  const legacy = await paid();
  assert.deepEqual(await settle(legacy.reservation_id, { p_prompt_tokens: 1000, p_completion_tokens: 100, p_cost_microusd: 3750 }),
    { status: 'settled', credit_balance_microusd: 5000000 - 26500 - 3750 });
  assert.deepEqual([(await reservation(legacy.reservation_id)).cache_read_tokens, (await eventFor(legacy.reservation_id)).cache_write_tokens], [0, 0]);
  // ...also positionally, and an explicit null counts as 0.
  const positional = await paid();
  await db.query('SELECT * FROM public.zerox_settle_v2($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [positional.reservation_id, 2000, 50, 5625, 'ok', 15, 'anthropic', 'claude-sonnet-5-5', null]);
  assert.equal((await eventFor(positional.reservation_id)).cost_microusd, 5625);
  const nulls = await paid();
  await settle(nulls.reservation_id, { p_prompt_tokens: 100, p_cost_microusd: 300, p_cache_read_tokens: null, p_cache_write_tokens: null });
  assert.deepEqual([(await eventFor(nulls.reservation_id)).cache_read_tokens, (await eventFor(nulls.reservation_id)).cache_write_tokens], [0, 0]);
  // Cache counts are part of the prompt.
  const bad = await paid();
  await assert.rejects(settle(bad.reservation_id, { p_prompt_tokens: 100, p_cache_read_tokens: 80, p_cache_write_tokens: 21 }),
    /invalid_settlement: cache token counts/);
  await assert.rejects(settle(bad.reservation_id, { p_prompt_tokens: 100, p_cache_read_tokens: -1 }), /invalid_settlement: cache token counts/);
  assert.equal((await reservation(bad.reservation_id)).status, 'active', 'a rejected settlement changes nothing');
  await settle(bad.reservation_id, { p_prompt_tokens: 100, p_cache_read_tokens: 60, p_cache_write_tokens: 40, p_cost_microusd: 200 });
  // A refunded failed_upstream attempt records no tokens for the user; the reservation keeps the raw counts.
  const timeout = await paid();
  await settle(timeout.reservation_id, { p_status: 'failed_upstream', p_prompt_tokens: 9000, p_completion_tokens: 0,
    p_cache_read_tokens: 8000, p_cache_write_tokens: 1000, p_cost_microusd: 5000, p_error_code: 'first_byte_timeout' });
  const timeoutEvent = await eventFor(timeout.reservation_id);
  assert.deepEqual([timeoutEvent.status, timeoutEvent.prompt_tokens, timeoutEvent.cache_read_tokens, timeoutEvent.cache_write_tokens, timeoutEvent.cost_microusd],
    ['refunded', 0, 0, 0, 0]);
  assert.deepEqual([(await reservation(timeout.reservation_id)).cache_read_tokens, (await reservation(timeout.reservation_id)).cache_write_tokens], [8000, 1000]);
  // The daily rollup and usage by model sum the cache columns.
  const [daily] = await sql('SELECT * FROM public.zerox_usage_daily WHERE user_id = $1 AND model = $2', [cacheUser, cacheModel]);
  assert.deepEqual([daily.requests, daily.prompt_tokens, daily.cache_read_tokens, daily.cache_write_tokens, daily.cost_microusd],
    [5, 23200, 16060, 4040, 26500 + 3750 + 5625 + 300 + 200]);
  assert.deepEqual(await rpcRows(env, 'zerox_usage_by_model', { p_user_id: cacheUser, p_from: utcDay(0), p_to: utcDay(0) }), [
    { model: cacheModel, requests: 5, prompt_tokens: 23200, cache_read_tokens: 16060, cache_write_tokens: 4040,
      completion_tokens: 800 + 100 + 50 + 5 + 5, cost_microusd: 36375 }]);
  await assert.rejects(rpc(env, 'zerox_settle_v2', { p_reservation_id: turn.reservation_id, p_cache_tokens: 1 }), /Could not find the function/);
  ok('cache-aware settlement: 11-argument call stores cache reads and writes on the reservation, event, rollup and usage by model; the 9-argument call (named and positional) and nulls record 0; cache > prompt is invalid_settlement; refunded failed_upstream records no tokens for the user');

  // ---------------------------------------------------------------- in-flight holds
  const holder = await newUser('pro', { credits: 100000 });
  const holdA = await reserve(holder, { p_tier: 'paid', p_cost_microusd: 60000 });
  assert.equal(holdA.status, 'ok');
  assert.equal((await reserve(holder, { p_tier: 'paid', p_cost_microusd: 60000 })).status, 'insufficient_credits',
    'credits held by a running paid request cannot pay for another');
  assert.equal((await reserve(holder, { p_tier: 'paid', p_cost_microusd: 40000 })).status, 'ok', 'the unheld remainder can');
  await sql("UPDATE public.zerox_reservations SET status = 'settled' WHERE user_id = $1 AND id <> $2", [holder, holdA.reservation_id]);
  await settle(holdA.reservation_id, { p_cost_microusd: 10000 });
  assert.equal((await account(holder)).credit_balance_microusd, 90000);
  const holdB = await reserve(holder, { p_tier: 'paid', p_cost_microusd: 60000 });
  assert.equal(holdB.status, 'ok', 'settling releases the unused part of the hold');
  // Abandoned reservations: their leases lapsed. A running request renews its lease and is never
  // released; a lapsed paid lease frees its concurrency slot but keeps its credits held.
  for (const [minutes, expected] of [[11, 'insufficient_credits'], [16, 'insufficient_credits'], [59, 'insufficient_credits']]) {
    await sql(`UPDATE public.zerox_reservations SET created_at = now() - interval '${minutes} minutes',
      lease_expires_at = now() - interval '6 minutes' WHERE id = $1`, [holdB.reservation_id]);
    await rpc(env, 'zerox_release_stale_reservations', {});
    assert.equal((await reservation(holdB.reservation_id)).status, 'active', `a paid reservation is still active after ${minutes} minutes`);
    assert.equal((await reserve(holder, { p_tier: 'paid', p_cost_microusd: 60000 })).status, expected, `credits still held after ${minutes} minutes`);
  }
  await sql("UPDATE public.zerox_reservations SET created_at = now() - interval '61 minutes' WHERE id = $1", [holdB.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reservation(holdB.reservation_id)).status, 'released', 'a paid reservation is released after 60 minutes');
  assert.equal((await reserve(holder, { p_tier: 'paid', p_cost_microusd: 60000 })).status, 'ok', 'release returns the held credits');
  // A paid request still running after an hour renews its lease, so it is never released.
  const running = await reserve(holder, { p_tier: 'paid', p_cost_microusd: 1000 });
  await sql("UPDATE public.zerox_reservations SET created_at = now() - interval '61 minutes' WHERE id = $1", [running.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reservation(running.reservation_id)).status, 'active', 'a paid reservation whose lease runs is not released');
  const freeHold = await reserve(holder);
  await sql(`UPDATE public.zerox_reservations SET created_at = now() - interval '16 minutes',
    lease_expires_at = now() - interval '6 minutes' WHERE id = $1`, [freeHold.reservation_id]);
  await rpc(env, 'zerox_release_stale_reservations', {});
  assert.equal((await reservation(freeHold.reservation_id)).status, 'released', 'a free reservation is still released after 15 minutes');
  ok('in-flight holds: held credits are unavailable until settle (unused part returned) or release; abandoned paid reservations are released after 60 minutes, free ones 5 minutes after their lease lapsed');

  // ---------------------------------------------------------------- rpm counts client requests
  await clockHeadroom(20);
  const rpmUser = await newUser('free');
  const client = `req_${randomUUID().replaceAll('-', '')}`;
  for (const attempt of [client, `${client}.1`, `${client}.2`, `${client}.3`, `${client}.4`, `${client}.5`]) {
    const result = await reserve(rpmUser, { p_request_id: attempt });
    assert.equal(result.status, 'ok', attempt);
    await settle(result.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0 });
  }
  for (let index = 0; index < 9; index += 1) {
    const result = await reserve(rpmUser);
    assert.equal(result.status, 'ok', `client request ${index + 2} of 10`);
    await settle(result.reservation_id);
  }
  const limited = await reserve(rpmUser);
  assert.equal(limited.status, 'user_rpm', 'the eleventh client request in a minute is refused');
  assert.ok(limited.retry_after_seconds >= 1 && limited.retry_after_seconds <= 60);
  const failover = await reserve(rpmUser, { p_request_id: `${client}.6` });
  assert.equal(failover.status, 'ok', 'a failover attempt of an admitted request already holds its rpm slot');
  await settle(failover.reservation_id, { p_status: 'refunded', p_prompt_tokens: 0, p_completion_tokens: 0 });
  assert.equal((await account(rpmUser)).daily_requests, 9, 'refunded attempts give their requests back');
  ok('rpm counts client requests: failover attempts <id>.<n> share one slot, so a Free user keeps 10 requests per minute');

  // ---------------------------------------------------------------- plans
  const plans = await rpcRows(env, 'zerox_plan_policies_v2', {});
  assert.deepEqual(plans.map(plan => [plan.plan, plan.allowed_tiers, plan.daily_requests, plan.daily_tokens, plan.price_usd,
    plan.monthly_credit_microusd, plan.rpm_limit, plan.concurrency_limit]), [
    ['free', ['free'], 100, 500000, 0, 0, 10, 2],
    ['pro', ['free', 'paid'], 2000, 10000000, 10, 8000000, 30, 4],
    ['max', ['free', 'paid'], 10000, 50000000, 40, 35000000, 60, 8],
    ['ultrawork', ['free', 'paid'], 2000, 10000000, 10, 8000000, 30, 4],
  ], 'Free has the free tier only, Pro and Max add paid; limits, prices and credits unchanged');
  assert.deepEqual(Object.fromEntries(plans.map(plan => [plan.plan, plan.features])), PLAN_FEATURES);
  // The static fallbacks on the site show the same strings until /api/plans answers.
  const { PLAN_CATALOG: sitePlans } = await import(pathToFileURL(join(site, 'pricing.js')).href);
  for (const plan of sitePlans.plans) assert.deepEqual(plan.features, PLAN_FEATURES[plan.id], `site pricing.js fallback features for ${plan.id}`);
  // So does the gateway's static plan catalogue (src/plan-policy.js, /api/plans without a database).
  const { PLAN_CATALOG: gatewayPlans } = await import('./src/plan-policy.js');
  for (const plan of gatewayPlans) assert.deepEqual(plan.features, PLAN_FEATURES[plan.id], `src/plan-policy.js features for ${plan.id}`);
  assert.deepEqual(gatewayPlans.map(plan => [plan.id, plan.tiers]), [['free', ['free']], ['pro', ['free', 'paid']], ['max', ['free', 'paid']]]);
  const pricingHtml = await readFile(join(site, 'pricing.html'), 'utf8');
  for (const id of ['free', 'pro', 'max']) {
    const list = pricingHtml.match(new RegExp(`<ul data-plan-features="${id}">([\\s\\S]*?)</ul>`))[1];
    assert.deepEqual([...list.matchAll(/<li>([^<]+)<\/li>/g)].map(match => match[1]), PLAN_FEATURES[id], `pricing.html features for ${id}`);
  }
  const freeUser = await newUser('free', { credits: 5000000 });
  assert.equal((await reserve(freeUser, { p_model: capModel, p_tier: 'paid', p_cost_microusd: 1000 })).status, 'upgrade_required',
    'credits alone do not open paid pools on Free');
  // Re-running the plans migration repairs drifted tiers and leaves the rest alone.
  await sql("UPDATE public.zerox_plan_policy SET allowed_tiers = ARRAY['free'] WHERE plan = 'max'");
  await sql("UPDATE public.zerox_plan_policy SET allowed_tiers = ARRAY['free', 'paid'] WHERE plan = 'free'");
  const stamp = (await sql("SELECT updated_at FROM public.zerox_plan_policy WHERE plan = 'pro'"))[0].updated_at;
  await db.exec(await migrationSql(PLANS));
  assert.deepEqual((await sql('SELECT plan, allowed_tiers FROM public.zerox_plan_policy ORDER BY sort')).map(row => [row.plan, row.allowed_tiers]),
    [['free', ['free']], ['pro', ['free', 'paid']], ['max', ['free', 'paid']], ['ultrawork', ['free', 'paid']]]);
  assert.equal((await sql("SELECT updated_at FROM public.zerox_plan_policy WHERE plan = 'pro'"))[0].updated_at.getTime(), stamp.getTime(),
    'rows already up to date are not rewritten');
  ok('plans: Free free-only, Pro/Max/ultrawork free+paid, limits and credits unchanged, features equal the site fallback, pricing.html and src/plan-policy.js, re-run repairs drifted tiers');

  // ---------------------------------------------------------------- down scripts and re-runs
  // Baseline: every migration except the two under test, on a fresh PGlite.
  const scratch = await mkdtemp(join(tmpdir(), 'zerox-billing-caps-'));
  baseline = { scratch, db: null };
  for (const migration of await listMigrations()) {
    if (![CAPS, PLANS].includes(migration.file)) await copyFile(migration.path, join(scratch, migration.file));
  }
  baseline.db = await PGlite.create();
  await migrate(baseline.db, { directory: scratch });
  // Line endings follow the checkout (CRLF on Windows working trees), so they are not compared.
  const definitions = async (target, names) => Object.fromEntries(await Promise.all(names.map(async name => [name,
    (await target.query(`SELECT array_agg(pg_get_functiondef(p.oid) ORDER BY p.oid) AS defs FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]))
      .rows[0].defs.map(definition => definition.replaceAll('\r\n', '\n'))])));
  const shape = async (target, tables) => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await target.query(`SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`, [table])).rows])));
  const touched = ['zerox_reserve_v2', 'zerox_settle_v2', 'zerox_usage_by_model', 'zerox_usage_events',
    'zerox_release_stale_reservations', 'zerox_admin_overview'];
  const tables = ['zerox_pool_usage', 'zerox_reservations', 'zerox_usage_events', 'zerox_usage_daily'];
  const features = async target => (await target.query('SELECT plan, features, allowed_tiers FROM public.zerox_plan_policy ORDER BY plan')).rows;
  const privileges = async (target, names) => (await target.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1) ORDER BY 1, 2`, [names])).rows;
  await db.exec(await downSql(PLANS));
  await db.exec(await downSql(CAPS));
  handle.functions.clear();
  assert.deepEqual(await definitions(db, touched), await definitions(baseline.db, touched), 'the down scripts restore every function definition');
  assert.deepEqual(await shape(db, tables), await shape(baseline.db, tables), 'the down script drops the cost and cache columns');
  assert.deepEqual(await features(db), await features(baseline.db), 'the plans down script restores the seeded features');
  assert.deepEqual(await privileges(db, touched), await privileges(baseline.db, touched), 'service_role-only EXECUTE after the down script');
  const reverted = await newUser('pro', { credits: 100000 });
  const old = await reserve(reverted, { p_tier: 'paid', p_cost_microusd: 1000, p_model: capModel, p_pool: { cpd: 1 } });
  assert.equal(old.status, 'ok', 'the reverted zerox_reserve_v2 ignores cpd');
  assert.deepEqual(await settle(old.reservation_id, { p_cost_microusd: 500 }), { status: 'settled', credit_balance_microusd: 99500 },
    'the reverted 9-argument zerox_settle_v2 serves the previous Worker');
  // Re-apply, twice: every statement of both up migrations is safe to re-run.
  for (let run = 0; run < 2; run += 1) {
    await db.exec(await migrationSql(CAPS));
    await db.exec(await migrationSql(PLANS));
  }
  handle.functions.clear();
  assert.equal((await functionRows('zerox_settle_v2')).length, 1);
  assert.deepEqual(Object.fromEntries((await rpcRows(env, 'zerox_plan_policies_v2', {})).map(plan => [plan.plan, plan.features])), PLAN_FEATURES);
  for (const row of await privileges(db, touched)) {
    assert.deepEqual([row.anon, row.auth, row.service], [false, false, true], `${row.proname}(${row.args}) is service_role only`);
  }
  const again = await reserve(reverted, { p_tier: 'paid', p_cost_microusd: 1000, p_model: `${capModel}-again`, p_pool: { cpd: 1500 } });
  assert.equal(again.status, 'ok');
  assert.equal((await reserve(reverted, { p_tier: 'paid', p_cost_microusd: 1000, p_model: `${capModel}-again`, p_pool: { cpd: 1500 } })).status, 'pool_exhausted');
  await settle(again.reservation_id, { p_prompt_tokens: 100, p_cache_read_tokens: 90, p_cost_microusd: 400 });
  assert.equal((await eventFor(again.reservation_id)).cache_read_tokens, 90);
  ok('down scripts restore the previous functions, columns, features and grants exactly; the up migrations re-apply cleanly twice');

  console.log(`PASS: ${passed.length} billing-cap checks`);
} finally {
  await closeAllPglite();
  if (baseline?.db) await baseline.db.close().catch(() => {});
  if (baseline?.scratch) await rm(baseline.scratch, { recursive: true, force: true });
}
