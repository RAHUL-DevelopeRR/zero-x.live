import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const entry = process.env.PGLITE_ENTRY;
const { PGlite } = await import(entry ? pathToFileURL(entry).href : '@electric-sql/pglite');
const db = new PGlite();
const id = '12345678-1234-4234-8234-123456789abc';
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${id}');`);
  const directory = new URL('./migrations/', import.meta.url);
  const policyMigration = (await readdir(directory)).find(name => name.endsWith('_plan_policies.sql'));
  assert.ok(policyMigration, 'CLI-generated plan policy migration exists');
  for (const migration of ['20261003_accounts.sql', '20261004_quota_reservations.sql', policyMigration]) {
    await db.exec(await readFile(new URL(migration, directory), 'utf8'));
  }
  await db.exec('SET ROLE service_role');
  const policy = (await db.query('SELECT * FROM public.zerox_plan_policies()')).rows[0].policies;
  assert.equal(policy.free.daily_tokens, 256000);
  assert.equal(policy.pro.daily_requests, 20000);
  assert.equal(policy.ultrawork.price_usd, 10);
  await db.query('SELECT * FROM public.zerox_sync_account($1, $2::jsonb)', [id, JSON.stringify({ plan: 'pro', email: 'test@example.invalid' })]);
  assert.equal((await db.query('SELECT plan FROM public.zerox_accounts WHERE clerk_id = $1', [id])).rows[0].plan, 'free', 'profile metadata cannot promote an account');

  await db.exec("UPDATE public.zerox_plan_policy SET daily_tokens = 100, daily_requests = 2 WHERE plan = 'free'");
  assert.equal((await db.query('SELECT * FROM public.zerox_plan_policies()')).rows[0].policies.free.daily_tokens, 100);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 101)', [id])).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 60)', [id])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 41)', [id])).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 40)', [id])).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 1)', [id])).rows.length, 0);
  await db.query("UPDATE public.zerox_accounts SET last_usage_reset = '2000-01-01' WHERE clerk_id = $1", [id]);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 100)', [id])).rows[0].daily_requests, 1);

  await db.query("UPDATE public.zerox_accounts SET plan = 'pro', daily_requests = 0, daily_tokens_used = 0 WHERE clerk_id = $1", [id]);
  await db.exec("DELETE FROM public.zerox_plan_policy WHERE plan = 'pro'");
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 101)', [id])).rows.length, 0, 'unconfigured plan falls back to current free policy');
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 100)', [id])).rows.length, 1);
  await db.exec("DELETE FROM public.zerox_plan_policy WHERE plan = 'free'");
  await assert.rejects(db.query('SELECT * FROM public.zerox_reserve_usage($1, 1)', [id]), /Missing quota policy/);

  await db.exec('RESET ROLE');
  const functions = (await db.query(`SELECT proname, prosecdef, proconfig FROM pg_proc
    WHERE proname IN ('zerox_plan_policies', 'zerox_reserve_usage')`)).rows;
  assert.ok(functions.every(row => row.prosecdef === false && row.proconfig.includes('search_path=""')));
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zerox_plan_policy'::regclass")).rows[0].relrowsecurity, true);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.zerox_plan_policies()'), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM public.zerox_plan_policy'), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM public.zerox_reserve_usage($1, 1)', [id]), /permission denied/);
    await db.exec('RESET ROLE');
  }
  console.log('PASS: DB-authoritative plan edits, reservations, UTC reset, free fallback, fail-closed policy, metadata and RPC/table access controls');
} finally { await db.close(); }
