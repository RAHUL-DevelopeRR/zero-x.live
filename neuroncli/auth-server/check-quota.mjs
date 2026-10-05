import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Run with a separately installed PGlite entry path; it is not a gateway runtime dependency.
const entry = process.env.PGLITE_ENTRY;
if (!entry) throw new Error('Set PGLITE_ENTRY to @electric-sql/pglite/dist/index.js in an isolated install');
const { PGlite } = await import(pathToFileURL(entry).href);
const db = new PGlite();
const id = '12345678-1234-4234-8234-123456789abc';
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${id}');`);
  for (const migration of ['20261003_accounts.sql', '20261004_quota_reservations.sql']) {
    await db.exec(await readFile(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await db.query('SELECT * FROM public.zerox_sync_account($1, $2::jsonb)', [id, JSON.stringify({ email: 'test@example.invalid' })]);
  await db.exec('SET ROLE service_role');
  let rows = (await db.query('SELECT * FROM public.zerox_reserve_usage($1, $2)', [id, 250000])).rows;
  assert.equal(Number(rows[0].daily_tokens_used), 250000);
  assert.equal(Number(rows[0].daily_requests), 1);
  rows = (await db.query('SELECT * FROM public.zerox_reserve_usage($1, $2)', [id, 6001])).rows;
  assert.equal(rows.length, 0);
  rows = (await db.query('SELECT * FROM public.zerox_settle_usage($1, $2, $3, (now() AT TIME ZONE \'UTC\')::date)', [id, 250000, 20])).rows;
  assert.equal(Number(rows[0].daily_tokens_used), 20);
  assert.equal(Number(rows[0].total_tokens_used), 20);
  await db.query('UPDATE public.zerox_accounts SET daily_requests = 2000 WHERE clerk_id = $1', [id]);
  assert.equal((await db.query('SELECT * FROM public.zerox_reserve_usage($1, 1)', [id])).rows.length, 0);
  await db.query("UPDATE public.zerox_accounts SET last_usage_reset = '2000-01-01', daily_tokens_used = 256000 WHERE clerk_id = $1", [id]);
  rows = (await db.query('SELECT * FROM public.zerox_reserve_usage($1, 100)', [id])).rows;
  assert.equal(Number(rows[0].daily_requests), 1);
  assert.equal(Number(rows[0].daily_tokens_used), 100);
  rows = (await db.query("SELECT * FROM public.zerox_settle_usage($1, 100, 5, '2000-01-01')", [id])).rows;
  assert.equal(Number(rows[0].daily_tokens_used), 100);
  await assert.rejects(db.query('SELECT * FROM public.zerox_reserve_usage($1, -1)', [id]), /Reservation must be positive/);
  await db.exec('RESET ROLE; SET ROLE anon');
  await assert.rejects(db.query('SELECT * FROM public.zerox_reserve_usage($1, 1)', [id]), /permission denied/);
  await db.exec('RESET ROLE; SET ROLE authenticated');
  await assert.rejects(db.query('SELECT * FROM public.zerox_settle_usage($1, 100, 0, (now() AT TIME ZONE \'UTC\')::date)', [id]), /permission denied/);
  console.log('PASS: PostgreSQL migrations, service-role reservations, quota rejection, settlement, UTC reset, late settlement, RPC access controls');
} finally { await db.close(); }
