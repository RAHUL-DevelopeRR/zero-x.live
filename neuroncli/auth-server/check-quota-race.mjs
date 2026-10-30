// Concurrency check for the quota functions (zerox_reserve_v2, zerox_settle_v2) against a real
// Postgres. PGlite runs one statement at a time, so check-business-db.mjs proves the quota logic
// but not the row locks under contention; this does, with 100 requests at once over 40
// connections. Opt-in: it needs a disposable, empty database and the `pg` client.
//
//   npm i --no-save pg
//   RACE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/zerox_race node check-quota-race.mjs
//
// It applies the dev bootstrap (src/db/bootstrap.js) and every migration, so it refuses a
// database that already has zerox tables: never point it at Supabase. Without
// RACE_DATABASE_URL or `pg` it prints SKIP and exits 0.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DEV_BOOTSTRAP_SQL } from './src/db/bootstrap.js';
import { listMigrations, readMigration } from './src/db/migrations.js';

const url = process.env.RACE_DATABASE_URL;
if (!url) {
  console.log('SKIP: set RACE_DATABASE_URL to a disposable, empty Postgres database to run the quota race check');
  process.exit(0);
}
let pg;
try {
  pg = (await import('pg')).default;
} catch {
  console.log('SKIP: the `pg` client is not installed (npm i --no-save pg)');
  process.exit(0);
}

const PARALLEL = 100;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
const pool = new pg.Pool({ connectionString: url, max: 40 });
pool.on('connect', client => client.query("SET ROLE service_role; SET TimeZone = 'UTC'"));
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };

try {
  const existing = await admin.query("SELECT to_regclass('public.zerox_accounts') AS t");
  if (existing.rows[0].t) throw new Error('RACE_DATABASE_URL already has zerox tables; use an empty, disposable database');
  await admin.query(DEV_BOOTSTRAP_SQL);
  for (const migration of await listMigrations()) await admin.query((await readMigration(migration)).sql);

  const newUser = async (plan, credits = 0) => {
    const { rows: [{ id }] } = await admin.query('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [`race-${randomUUID()}@example.test`]);
    await admin.query('SELECT * FROM public.zerox_sync_account($1, $2)', [id, { email: 'race@example.test' }]);
    await admin.query(`UPDATE public.zerox_accounts SET plan = $2, credit_balance_microusd = $3,
      plan_source = CASE WHEN $2 = 'free' THEN 'default' ELSE 'manual' END WHERE clerk_id = $1`, [id, plan, credits]);
    return id;
  };
  const reserve = async (userId, { model = 'race/model', tier = 'free', tokens = 100, cost = 0, budget = null } = {}) => (await pool.query(
    `SELECT * FROM public.zerox_reserve_v2(p_user_id => $1, p_request_id => $2, p_model => $3, p_tier => $4, p_tokens => $5,
      p_cost_microusd => $6, p_pool => $7::jsonb)`, [userId, `req_${randomUUID()}`, model, tier, tokens, cost, budget])).rows[0];
  const settle = async (reservationId, promptTokens, completionTokens) => (await pool.query(
    `SELECT * FROM public.zerox_settle_v2(p_reservation_id => $1, p_prompt_tokens => $2, p_completion_tokens => $3,
      p_cost_microusd => 0, p_status => 'ok', p_latency_ms => 10, p_provider => 'race', p_upstream_model => 'model',
      p_error_code => NULL)`, [reservationId, promptTokens, completionTokens])).rows[0];
  const count = (rows, status) => rows.filter(row => row.status === status).length;
  const poolRow = async (model, bucket) => (await admin.query(`SELECT * FROM public.zerox_pool_usage
    WHERE model = $1 AND tier = 'free' AND bucket = $2 ORDER BY bucket_start DESC LIMIT 1`, [model, bucket])).rows[0];

  // 1. A shared upstream budget: 100 users at once against rpm 37 -> exactly 37 reservations.
  {
    const users = await Promise.all(Array.from({ length: PARALLEL }, () => newUser('max')));
    const rows = await Promise.all(users.map(user => reserve(user, { model: 'race/pool', budget: { rpm: 37, rpd: null, tpm: null, tpd: null } })));
    assert.equal(count(rows, 'ok'), 37);
    assert.equal(count(rows, 'pool_exhausted'), PARALLEL - 37);
    assert.equal(Number((await poolRow('race/pool', 'minute')).requests), 37);
    // 2. Settling every reservation twice at once settles each exactly once.
    const reserved = rows.filter(row => row.status === 'ok');
    const settled = await Promise.all(reserved.flatMap(row => [settle(row.reservation_id, 30, 10), settle(row.reservation_id, 30, 10)]));
    assert.equal(settled.filter(row => row.status === 'already_settled').length, reserved.length);
    assert.equal(Number((await poolRow('race/pool', 'minute')).tokens), 37 * 40, 'pool tokens are the settled usage, once each');
    ok(`shared pool budget: ${PARALLEL} parallel reservations against rpm 37 -> exactly 37; double settlement counted once`);
  }

  // 3. One user at once: the plan's concurrency (max: 8) holds.
  {
    const user = await newUser('max');
    const rows = await Promise.all(Array.from({ length: PARALLEL }, () => reserve(user, { model: 'race/user' })));
    assert.equal(count(rows, 'ok'), 8);
    const { rows: [account] } = await admin.query('SELECT * FROM public.zerox_accounts WHERE clerk_id = $1', [user]);
    assert.equal(Number(account.daily_requests), 8, 'the account counts exactly the accepted requests');
    ok(`per-user concurrency: ${PARALLEL} parallel reservations by one max user -> exactly 8`);
  }

  // 4. Credits: 5 paid requests' worth, 100 at once -> 5, and the balance never goes negative.
  {
    const user = await newUser('max', 5000);
    const rows = await Promise.all(Array.from({ length: PARALLEL }, () => reserve(user, { model: 'race/paid', tier: 'paid', cost: 1000 })));
    assert.equal(count(rows, 'ok'), 5);
    const { rows: [account] } = await admin.query('SELECT credit_balance_microusd FROM public.zerox_accounts WHERE clerk_id = $1', [user]);
    assert.ok(Number(account.credit_balance_microusd) >= 0);
    ok(`credits: ${PARALLEL} parallel paid reservations with credit for 5 -> exactly 5, balance never negative`);
  }

  // 5. A pool that serves one request at a time (p_pool.concurrency 1, contract section 8.6): 100
  // users at once -> exactly 1, and after its settle exactly 1 again.
  {
    const single = { rpm: null, rpd: null, tpm: null, tpd: null, concurrency: 1 };
    const users = await Promise.all(Array.from({ length: PARALLEL }, () => newUser('max')));
    const rows = await Promise.all(users.map(user => reserve(user, { model: 'race/single', budget: single })));
    assert.equal(count(rows, 'ok'), 1);
    assert.equal(count(rows, 'pool_exhausted'), PARALLEL - 1);
    await settle(rows.find(row => row.status === 'ok').reservation_id, 30, 10);
    const again = await Promise.all(users.map(user => reserve(user, { model: 'race/single', budget: single })));
    assert.equal(count(again, 'ok'), 1, 'a settle frees exactly one slot');
    // The count waits for the pool key's advisory lock, not only for its bucket rows (which two
    // reservations on either side of 00:00 UTC do not share): while another transaction holds the
    // lock, a reservation of that pool key does not finish.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zerox_pool_concurrency:race/held|free|'))");
      let finished = false;
      const waiting = reserve(users[0], { model: 'race/held', budget: single }).finally(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(finished, false, 'the reservation waits for the pool key lock');
      await holder.query('COMMIT');
      assert.equal((await waiting).status, 'ok');
    } finally {
      holder.release();
    }
    ok(`pool concurrency: ${PARALLEL} parallel reservations of a one-slot pool -> exactly 1, again after its settle; the count waits for the pool key lock`);
  }

  console.log(`\nPASS: quota race (${passed.length} groups) on a real Postgres`);
} finally {
  await pool.end();
  await admin.end();
}
