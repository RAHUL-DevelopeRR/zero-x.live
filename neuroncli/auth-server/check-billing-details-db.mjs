// Billing details database checks for 20261106000100_billing_details.sql on PGlite
// (DATABASE_DRIVER=pglite): the profile and consent tables and their RPCs, access control,
// append-only consents (including that deleting an account still removes its rows), and the down
// script. The migration is also applied on top of production's state before it (every migration
// up to 20261102000000, with and without 20261029000900_plan_features_claude.sql, which this
// migration does not depend on). 20261106000200_billing_tax_id.sql (the optional tax id) is checked
// the same way: its column, CHECK and replaced functions, on a database with saved profiles, and
// its down script.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { DEV_BOOTSTRAP_SQL } from './src/db/bootstrap.js';
import { listMigrations, readMigration } from './src/db/migrations.js';
import { migrationScript } from './scripts/apply-migrations.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const env = { DATABASE_DRIVER: 'pglite' };
const VERSION = '20261106000100';
const TAX_VERSION = '20261106000200';
const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }

const handle = await getPgliteHandle(env);
const db = handle.db;
const sql = async (text, params) => (await db.query(text, params)).rows;

let counter = 0;
async function newUser() {
  counter += 1;
  const email = `details${counter}-${randomUUID().slice(0, 8)}@example.test`;
  const [{ id }] = await sql('INSERT INTO auth.users (email) VALUES ($1) RETURNING id', [email]);
  await rpc(env, 'zerox_sync_account', { p_user_id: id, p_profile: { email, name: `Details ${counter}` } });
  return id;
}
const profile = (overrides = {}) => ({
  customer_type: 'individual', full_name: 'Asha K', country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113', ...overrides,
});
const upsert = (userId, body) => rpc(env, 'zerox_billing_profile_upsert', { p_user_id: userId, p_profile: body });
const consent = (userId, context, documents) => rpc(env, 'zerox_billing_record_consents',
  { p_user_id: userId, p_context: context, p_consents: documents });

try {
  // ---------------------------------------------------------------- tables, grants, RLS
  const migrations = await listMigrations();
  assert.ok(handle.applied.includes(VERSION), 'the migration applies with every other one');
  assert.ok(handle.applied.includes(TAX_VERSION), 'and so does the tax id migration');
  assert.equal(migrations.at(-1).version >= VERSION, true);
  const tables = await sql(`SELECT c.relname, c.relrowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon_any,
      has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS auth_any,
      has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS service_all
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('zerox_billing_profiles', 'zerox_billing_consents')
    ORDER BY c.relname`);
  assert.deepEqual(tables.map(row => row.relname), ['zerox_billing_consents', 'zerox_billing_profiles']);
  for (const row of tables) {
    assert.equal(row.relrowsecurity, true, `${row.relname} has RLS enabled`);
    assert.equal(row.anon_any, false);
    assert.equal(row.auth_any, false);
    assert.equal(row.service_all, true);
  }
  const columns = (await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'zerox_billing_profiles' ORDER BY ordinal_position`)).map(row => row.column_name);
  assert.deepEqual(columns, ['user_id', 'customer_type', 'full_name', 'business_name', 'country', 'state', 'city', 'postal_code',
    'address_line1', 'address_line2', 'phone_e164', 'created_at', 'updated_at', 'tax_id']);
  assert.deepEqual(columns.filter(name => /gst|tax|vat/i.test(name)), ['tax_id'], 'one tax id column (20261106000200)');
  assert.ok(!columns.some(name => /card|cvv|upi|vpa|bank|ifsc|account|iban/i.test(name)), 'no card, UPI or bank column');
  assert.deepEqual((await sql(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'zerox_billing_profiles' AND column_name = 'tax_id'`))[0], { data_type: 'text', is_nullable: 'YES' });
  const functions = await sql(`SELECT p.oid::regprocedure::text AS signature, p.prosecdef, p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'zerox\\_billing\\_%'
      AND p.proname IN ('zerox_billing_profile_get', 'zerox_billing_profile_upsert', 'zerox_billing_record_consents',
        'zerox_billing_consents_latest', 'zerox_billing_consents_guard')`);
  assert.equal(functions.length, 5);
  for (const row of functions) {
    assert.equal(row.prosecdef, false, `${row.signature} is SECURITY INVOKER`);
    assert.ok(row.proconfig?.includes('search_path=""'), `${row.signature} pins search_path`);
    assert.deepEqual([row.anon_exec, row.auth_exec, row.service_exec], [false, false, true], `${row.signature} is service_role only`);
  }
  const alice = await newUser();
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const name of ['zerox_billing_profiles', 'zerox_billing_consents']) {
        await assert.rejects(db.query(`SELECT * FROM public.${name}`), /permission denied/, `${role} reads ${name}`);
      }
      await assert.rejects(db.query('SELECT * FROM public.zerox_billing_profile_get($1)', [alice]), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM public.zerox_billing_consents_latest($1)', [alice]), /permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  }
  ok('two tables with RLS and service_role-only access, five SECURITY INVOKER functions with a pinned search_path, an optional tax id column and no payment-instrument column');

  // ---------------------------------------------------------------- profile RPCs
  assert.equal(await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice }), null, 'no profile until one is saved');
  const saved = await upsert(alice, profile({ phone_e164: '+919876543210', address_line1: '6/2 N. Pugalur', address_line2: null }));
  assert.deepEqual({ ...saved, created_at: undefined, updated_at: undefined }, {
    customer_type: 'individual', full_name: 'Asha K', business_name: null, country: 'IN', state: 'TN', city: 'Karur', postal_code: '639113',
    address_line1: '6/2 N. Pugalur', address_line2: null, phone_e164: '+919876543210', tax_id: null, created_at: undefined, updated_at: undefined });
  assert.deepEqual((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).full_name, 'Asha K');
  const first = (await sql('SELECT created_at, updated_at FROM public.zerox_billing_profiles WHERE user_id = $1', [alice]))[0];
  await new Promise(done => setTimeout(done, 15));
  // A PUT replaces the profile: optional keys that are absent are cleared, updated_at moves, created_at does not.
  await upsert(alice, profile({ full_name: 'Asha Kumar', country: 'US', state: 'California', city: 'Austin', postal_code: '73301' }));
  const second = (await sql('SELECT * FROM public.zerox_billing_profiles WHERE user_id = $1', [alice]))[0];
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_profiles WHERE user_id = $1', [alice]))[0].n, 1, 'one row per account');
  assert.deepEqual([second.full_name, second.country, second.state, second.phone_e164, second.address_line1], ['Asha Kumar', 'US', 'California', null, null]);
  assert.equal(second.created_at.getTime(), first.created_at.getTime());
  assert.ok(second.updated_at.getTime() > first.updated_at.getTime());
  // Empty strings are stored as NULL for the optional fields.
  await upsert(alice, profile({ business_name: '', address_line1: '', phone_e164: '' }));
  const blanks = await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice });
  assert.deepEqual([blanks.business_name, blanks.address_line1, blanks.phone_e164], [null, null, null]);

  const rejected = async (body, pattern, label) => assert.rejects(upsert(alice, body), pattern, label);
  await rejected(profile({ country: 'in' }), /violates check constraint/, 'country is upper case');
  await rejected(profile({ country: 'IND' }), /violates check constraint/);
  await rejected(profile({ state: null }), /violates check constraint/, 'India needs a state');
  await rejected(profile({ customer_type: 'business' }), /violates check constraint/, 'a business needs a name and an address');
  await rejected(profile({ customer_type: 'business', business_name: 'Zero X Labs' }), /violates check constraint/);
  await rejected(profile({ customer_type: 'company' }), /violates check constraint/);
  await rejected(profile({ address_line2: 'Floor 2' }), /violates check constraint/, 'line 2 needs line 1');
  await rejected(profile({ phone_e164: '98765 43210' }), /violates check constraint/);
  await rejected(profile({ phone_e164: '+0123456789' }), /violates check constraint/);
  await rejected(profile({ full_name: '   ' }), /violates check constraint/);
  await rejected(profile({ full_name: null }), /null value/);
  await rejected(profile({ city: 'x'.repeat(81) }), /violates check constraint/);
  await rejected(profile({ gstin: '33AAAAA0000A1Z5' }), /invalid_billing_profile: unknown field/, 'unknown fields are refused, a tax id included');
  await assert.rejects(upsert(alice, [1]), /invalid_billing_profile: expected a JSON object/);
  await assert.rejects(upsert(alice, null), /invalid_billing_profile/);
  await assert.rejects(upsert(randomUUID(), profile()), /account_not_found/);
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).full_name, 'Asha K', 'a refused save changes nothing');
  await upsert(alice, profile({ customer_type: 'business', business_name: 'Zero X Labs', address_line1: '6/2 N. Pugalur' }));
  ok('profile RPCs: round trip, PUT replaces and keeps created_at, blanks become NULL, every CHECK and the unknown-field guard refuse bad data');

  // ---------------------------------------------------------------- tax id (20261106000200)
  const GSTIN_TN = '33ABCDE1234F1Z7';
  const withTax = await upsert(alice, profile({ tax_id: GSTIN_TN }));
  assert.equal(withTax.tax_id, GSTIN_TN, 'the upsert returns the tax id');
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).tax_id, GSTIN_TN, 'and get reads it back');
  await upsert(alice, profile({ customer_type: 'business', business_name: 'Zero X Labs', address_line1: 'Office 4', tax_id: GSTIN_TN }));
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).tax_id, GSTIN_TN, 'a business keeps it too');
  await upsert(alice, profile());
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).tax_id, null, 'a PUT without it clears it');
  await upsert(alice, profile({ tax_id: GSTIN_TN }));
  await upsert(alice, profile({ tax_id: '' }));
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).tax_id, null, 'an empty one is stored as NULL');
  await upsert(alice, profile({ tax_id: null }));
  for (const [country, state, postal, taxId] of [['US', 'Texas', '73301', 'DE123456789'], ['GB', null, 'SW1A 1AA', 'GB-123-456'], ['US', null, '73301', 'AB'],
    ['US', null, '73301', 'A'.repeat(20)], ['US', null, '73301', GSTIN_TN]]) {
    assert.equal((await upsert(alice, profile({ country, state, postal_code: postal, tax_id: taxId }))).tax_id, taxId, `${country} ${taxId}`);
  }
  const taxRefused = async (overrides, label) => {
    await assert.rejects(upsert(alice, profile(overrides)), /violates check constraint "zerox_billing_profiles_tax_id_check"/, label);
  };
  // India: the GSTIN shape (the gateway also checks the check character and the state code).
  for (const bad of ['33abcde1234f1z7', '33ABCDE 1234F1Z7', '33ABCDE1234F1Z', '33ABCDE1234F1Z77', '33ABCDE1234F0Z7', '33ABCDE1234F1Y7', '3XABCDE1234F1Z7', 'DE123456789', '33-ABCDE-1234']) {
    await taxRefused({ tax_id: bad }, `IN ${bad}`);
  }
  // Elsewhere: 2 to 20 upper-case letters, digits or hyphens, starting and ending with a letter or digit.
  for (const bad of ['A', 'A'.repeat(21), 'de123456789', 'DE 123', '-AB', 'AB-', 'DE_123', 'DE.123', 'ÄB12']) {
    await taxRefused({ country: 'US', state: null, postal_code: '73301', tax_id: bad }, `US ${bad}`);
  }
  // The CHECK follows the country: a VAT id kept while the country changes to India is refused.
  await upsert(alice, profile({ country: 'US', state: null, postal_code: '73301', tax_id: 'DE123456789' }));
  await assert.rejects(db.query(`UPDATE public.zerox_billing_profiles SET country = 'IN', state = 'TN' WHERE user_id = $1`, [alice]),
    /zerox_billing_profiles_tax_id_check/, 'changing the country re-checks the tax id');
  await upsert(alice, profile());
  assert.equal((await rpc(env, 'zerox_billing_profile_get', { p_user_id: alice })).tax_id, null, 'a refused save changes nothing');
  await rejected(profile({ gstin: GSTIN_TN }), /invalid_billing_profile: unknown field/, 'tax_id is the only tax key');
  ok('tax id: round trip through both RPCs, cleared by a PUT without it or with an empty one, and the CHECK refuses lower case, spaces, bad lengths, characters and (in India) non-GSTIN shapes');

  // ---------------------------------------------------------------- consent RPCs
  const bob = await newUser();
  assert.deepEqual(await rpcRows(env, 'zerox_billing_consents_latest', { p_user_id: bob }), []);
  assert.equal((await consent(bob, 'subscription', { terms: '2026-10-25', privacy: '2026-10-25', refund: '2026-10-24', auto_renewal: '2026-11-03' })).recorded, 4);
  assert.equal((await consent(bob, 'topup', { terms: '2026-12-01' })).recorded, 1);
  const latest = await rpcRows(env, 'zerox_billing_consents_latest', { p_user_id: bob });
  assert.deepEqual(latest.map(row => [row.document, row.version]),
    [['auto_renewal', '2026-11-03'], ['privacy', '2026-10-25'], ['refund', '2026-10-24'], ['terms', '2026-12-01']], 'the newest version of each document');
  assert.ok(latest.every(row => row.accepted_at));
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [bob]))[0].n, 5, 'every agreement is a row');
  assert.deepEqual(await rpcRows(env, 'zerox_billing_consents_latest', { p_user_id: alice }), [], 'consents belong to their buyer');
  await assert.rejects(consent(bob, 'subscription', { cookies: '2026-10-25' }), /violates check constraint/);
  await assert.rejects(consent(bob, 'subscription', { terms: 'v2' }), /violates check constraint/);
  await assert.rejects(consent(bob, 'gift', { terms: '2026-10-25' }), /invalid_consent: context/);
  await assert.rejects(consent(bob, 'topup', [1]), /invalid_consent: expected an object/);
  await assert.rejects(consent(randomUUID(), 'topup', { terms: '2026-10-25' }), /account_not_found/);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [bob]))[0].n, 5, 'a refused call records nothing');
  // One bad document rolls the whole call back.
  await assert.rejects(consent(bob, 'topup', { terms: '2026-10-25', cookies: '2026-10-25' }));
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [bob]))[0].n, 5);
  ok('consent RPCs: one row per document and agreement, the newest version per document, bad documents, versions, contexts and accounts refused atomically');

  // ---------------------------------------------------------------- append-only
  for (const role of ['service_role', null]) {
    if (role) await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(db.query('UPDATE public.zerox_billing_consents SET version = $1 WHERE user_id = $2', ['2026-01-01', bob]),
        /consents_append_only/, `${role || 'owner'} cannot update`);
      await assert.rejects(db.query('DELETE FROM public.zerox_billing_consents WHERE user_id = $1', [bob]),
        /consents_append_only/, `${role || 'owner'} cannot delete`);
      // service_role has no TRUNCATE privilege at all; the owner is stopped by the trigger.
      await assert.rejects(db.query('TRUNCATE public.zerox_billing_consents'), role ? /permission denied/ : /consents_append_only/,
        `${role || 'owner'} cannot truncate`);
    } finally { if (role) await db.exec('RESET ROLE'); }
  }
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [bob]))[0].n, 5);
  // Deleting the account (auth.users cascades to zerox_accounts) still removes its rows.
  await db.exec(`DELETE FROM auth.users WHERE id = '${bob}'`);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [bob]))[0].n, 0,
    'consents leave with the account (the cascade is the one delete allowed)');
  const carol = await newUser();
  await upsert(carol, profile());
  await consent(carol, 'topup', { terms: '2026-10-25' });
  await db.exec(`DELETE FROM auth.users WHERE id = '${carol}'`);
  assert.equal((await sql('SELECT count(*)::int AS n FROM public.zerox_billing_profiles WHERE user_id = $1', [carol]))[0].n, 0, 'the profile leaves with the account');
  ok('consents are append-only for every role (UPDATE, DELETE, TRUNCATE refused); deleting an account still deletes its profile and consents');

  // ---------------------------------------------------------------- applies on production's state, and the down script
  const migration = migrations.find(candidate => candidate.version === VERSION);
  assert.ok(migration, 'the migration file exists');
  const up = async database => {
    await database.exec(DEV_BOOTSTRAP_SQL);
  };
  const apply = async (database, items) => {
    for (const item of items) await database.exec(migrationScript(await readMigration(item)));
  };
  const down = await readFile(join(root, 'migrations', 'down', `${VERSION}_billing_details.down.sql`), 'utf8');
  assert.match(down, /^BEGIN;\s+(?:--.*\s+)*SET LOCAL lock_timeout = '\d+s';[\s\S]*\bCOMMIT;\s*$/, 'the down script is one transaction with a lock timeout');
  assert.ok(!/^CREATE\s+FUNCTION\b/im.test(down));
  const schemaOf = async database => (await database.query(`
    SELECT 'function' AS kind, p.oid::regprocedure::text AS name,
        replace(pg_get_functiondef(p.oid), chr(13), '') || coalesce(p.proacl::text, '') AS def
      FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    UNION ALL SELECT 'column', c.table_name || '.' || c.column_name, concat_ws(' ', c.data_type, c.is_nullable, c.column_default)
      FROM information_schema.columns AS c WHERE c.table_schema = 'public'
    UNION ALL SELECT 'index', i.indexname, i.indexdef FROM pg_indexes AS i WHERE i.schemaname = 'public'
    UNION ALL SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger AS t WHERE NOT t.tgisinternal
    UNION ALL SELECT 'relation', c.relname, c.relkind::text FROM pg_class AS c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT 'history', h.version, h.name FROM supabase_migrations.schema_migrations AS h
    ORDER BY 1, 2`)).rows;
  const before = migrations.filter(candidate => candidate.version < VERSION);
  assert.ok(before.some(candidate => candidate.version === '20261102000000'), 'production state: every migration up to 20261102000000');
  const variants = [['every earlier migration', before],
    ['without 20261029000900_plan_features_claude.sql', before.filter(candidate => candidate.version !== '20261029000900')]];
  for (const [label, earlier] of variants) {
    const baseline = await PGlite.create();
    const rolled = await PGlite.create();
    try {
      await up(baseline);
      await up(rolled);
      try { await apply(baseline, earlier); }
      catch (error) {
        // A database cannot be built without 20261029000900 here when a later migration needs it:
        // the dependency is then that migration's, not this one's.
        assert.match(label, /without 20261029000900/, error.message);
        console.log(`note - ${label}: the earlier migrations do not apply without it (${error.message.slice(0, 120)}); skipped`);
        continue;
      }
      await apply(rolled, earlier);
      await apply(rolled, [migration]);
      const applied = await schemaOf(rolled);
      assert.ok(applied.some(row => row.name === 'zerox_billing_profiles'), `${label}: the tables exist after the migration`);
      // Data present when the down script runs.
      await rolled.query(`INSERT INTO auth.users (id, email) VALUES ('11111111-1111-4111-8111-111111111111', 'down@example.test')`);
      await rolled.exec(`SELECT public.zerox_sync_account('11111111-1111-4111-8111-111111111111'::uuid, '{"email":"down@example.test","name":"Down"}'::jsonb)`);
      await rolled.query('SELECT * FROM public.zerox_billing_profile_upsert($1, $2)', ['11111111-1111-4111-8111-111111111111', JSON.stringify(profile())]);
      await rolled.query('SELECT * FROM public.zerox_billing_record_consents($1, $2, $3)', ['11111111-1111-4111-8111-111111111111', 'topup', JSON.stringify({ terms: '2026-10-25' })]);
      await rolled.exec(down);
      assert.deepEqual(await schemaOf(rolled), await schemaOf(baseline), `${label}: the down script restores the schema before the migration`);
      await rolled.exec('DELETE FROM auth.users');
      await apply(rolled, [migration]);
      assert.deepEqual(await schemaOf(rolled), applied, `${label}: the migration applies again after its rollback`);
      await rolled.exec(down);
      assert.deepEqual(await schemaOf(rolled), await schemaOf(baseline), `${label}: running the down script twice changes nothing more`);
    } finally {
      await baseline.close();
      await rolled.close();
    }
  }
  ok('the migration applies on production\'s state (with and without 20261029000900), the down script restores the schema exactly (data and all), applies again and is safe to run twice');

  // ---------------------------------------------------------------- 20261106000200 on a database with saved profiles, and its down script
  {
    const taxMigration = migrations.find(candidate => candidate.version === TAX_VERSION);
    assert.ok(taxMigration, 'the tax id migration file exists');
    const taxDown = await readFile(join(root, 'migrations', 'down', `${TAX_VERSION}_billing_tax_id.down.sql`), 'utf8');
    assert.match(taxDown, /^BEGIN;\s+(?:--.*\s+)*SET LOCAL lock_timeout = '\d+s';[\s\S]*\bCOMMIT;\s*$/, 'the down script is one transaction with a lock timeout');
    assert.match(taxMigration.path ? await readFile(taxMigration.path, 'utf8') : '', /^BEGIN;\s+(?:--.*\s+)*SET LOCAL lock_timeout = '\d+s';[\s\S]*\bCOMMIT;\s*$/,
      'the migration is one transaction with a lock timeout');
    const earlier = migrations.filter(candidate => candidate.version < TAX_VERSION);
    assert.ok(earlier.some(candidate => candidate.version === '20261104300000'), 'every migration before it, 20261104300000 included');
    const baseline = await PGlite.create();
    const rolled = await PGlite.create();
    const USER = '22222222-2222-4222-8222-222222222222';
    try {
      await up(baseline);
      await up(rolled);
      await apply(baseline, earlier);
      await apply(rolled, earlier);
      // A profile saved before the migration keeps everything and gets no tax id.
      await rolled.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'tax@example.test')`, [USER]);
      await rolled.query(`SELECT public.zerox_sync_account($1::uuid, '{"email":"tax@example.test","name":"Tax"}'::jsonb)`, [USER]);
      await rolled.query('SELECT * FROM public.zerox_billing_profile_upsert($1, $2)', [USER, JSON.stringify(profile({ phone_e164: '+919876543210' }))]);
      await rolled.query('SELECT * FROM public.zerox_billing_record_consents($1, $2, $3)', [USER, 'topup', JSON.stringify({ terms: '2026-10-25' })]);
      const beforeRow = (await rolled.query('SELECT * FROM public.zerox_billing_profiles WHERE user_id = $1', [USER])).rows[0];
      const baselineSchema = await schemaOf(baseline);
      await apply(rolled, [taxMigration]);
      const afterRow = (await rolled.query('SELECT * FROM public.zerox_billing_profiles WHERE user_id = $1', [USER])).rows[0];
      assert.deepEqual(afterRow, { ...beforeRow, tax_id: null }, 'existing profiles are unchanged, with no tax id');
      const applied = await schemaOf(rolled);
      assert.ok(applied.some(row => row.kind === 'column' && row.name === 'zerox_billing_profiles.tax_id'));
      assert.ok(applied.some(row => row.kind === 'history' && row.name === TAX_VERSION && row.def === 'billing_tax_id'), 'the runner records it');
      const acl = (await rolled.query(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef, p.proconfig
        FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('zerox_billing_profile_get', 'zerox_billing_profile_upsert') ORDER BY 1`)).rows;
      assert.deepEqual(acl.map(row => [row.proname, row.anon, row.auth, row.service, row.prosecdef, row.proconfig?.includes('search_path=""')]),
        [['zerox_billing_profile_get', false, false, true, false, true], ['zerox_billing_profile_upsert', false, false, true, false, true]],
        'the replaced functions keep SECURITY INVOKER, the pinned search_path and service_role-only grants');
      const saved = (await rolled.query('SELECT * FROM public.zerox_billing_profile_upsert($1, $2)', [USER, JSON.stringify(profile({ tax_id: GSTIN_TN }))])).rows[0];
      assert.equal(saved.tax_id, GSTIN_TN);
      // The down script: the schema of the database before the migration, the other details and the consents kept.
      await rolled.exec(taxDown);
      assert.deepEqual(await schemaOf(rolled), baselineSchema, 'the down script restores the schema before the migration and removes the history row');
      const kept = (await rolled.query('SELECT * FROM public.zerox_billing_profile_get($1)', [USER])).rows[0];
      assert.deepEqual([kept.full_name, kept.phone_e164, 'tax_id' in kept], ['Asha K', null, false], 'the profile stays, without its tax id');
      assert.equal((await rolled.query('SELECT count(*)::int AS n FROM public.zerox_billing_consents WHERE user_id = $1', [USER])).rows[0].n, 1, 'consents are untouched');
      await assert.rejects(rolled.query('SELECT * FROM public.zerox_billing_profile_upsert($1, $2)', [USER, JSON.stringify(profile({ tax_id: GSTIN_TN }))]),
        /invalid_billing_profile: unknown field/, 'the old upsert refuses a tax id again');
      await apply(rolled, [taxMigration]);
      assert.deepEqual(await schemaOf(rolled), applied, 'the migration applies again after its rollback');
      await rolled.exec(taxDown);
      await rolled.exec(taxDown);
      assert.deepEqual(await schemaOf(rolled), baselineSchema, 'running the down script twice changes nothing more');
      // Both down scripts, newest first, take the database back to before 20261106000100.
      await apply(rolled, [taxMigration]);
      await rolled.exec(taxDown);
      await rolled.exec(down);
      const beforeDetails = await PGlite.create();
      try {
        await up(beforeDetails);
        await apply(beforeDetails, earlier.filter(candidate => candidate.version !== VERSION));
        assert.deepEqual(await schemaOf(rolled), await schemaOf(beforeDetails), 'the two down scripts, newest first, undo both migrations');
      } finally { await beforeDetails.close(); }
    } finally {
      await baseline.close();
      await rolled.close();
    }
  }
  ok('20261106000200 applies on a database with saved profiles (kept, tax id NULL), keeps the grants, round-trips the tax id; its down script restores the schema exactly, keeps every other detail, applies again and is safe to run twice');

  console.log(`PASS: billing details database (${passed.length} groups)`);
} finally {
  await closeAllPglite();
}
