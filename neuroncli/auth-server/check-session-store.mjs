import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.PGLITE_ENTRY;
const { PGlite } = await import(entry ? pathToFileURL(entry).href : '@electric-sql/pglite');
const temporary = await mkdtemp(join(tmpdir(), 'neuron-session-store-'));
let db = new PGlite(temporary);
const key = createHash('sha256').update('unpublished-test-session-token').digest('hex');
try {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS');
  const directory = new URL('./migrations/', import.meta.url);
  const migration = (await readdir(directory)).find(name => name.endsWith('_gateway_session_store.sql'));
  assert.ok(migration, 'CLI-generated session store migration exists');
  await db.exec(await readFile(new URL(migration, directory), 'utf8'));
  await db.exec('SET ROLE service_role');
  assert.equal((await db.query('SELECT * FROM public.zerox_session_get($1)', [key])).rows.length, 0);
  await db.query('SELECT public.zerox_session_put($1, $2, $3)', [key, '{"userId":"test"}', 300]);
  await db.close();
  db = new PGlite(temporary);
  await db.exec('SET ROLE service_role');
  assert.equal((await db.query('SELECT * FROM public.zerox_session_get($1)', [key])).rows[0].value, '{"userId":"test"}');
  await db.query('SELECT public.zerox_session_put($1, $2, $3)', [key, '{"userId":"updated"}', 600]);
  assert.equal((await db.query('SELECT * FROM public.zerox_session_get($1)', [key])).rows[0].value, '{"userId":"updated"}');
  assert.equal((await db.query('SELECT key FROM public.gateway_session_store')).rows[0].key, key);
  await db.query("UPDATE public.gateway_session_store SET expires_at = now() - interval '1 second' WHERE key = $1", [key]);
  assert.equal((await db.query('SELECT * FROM public.zerox_session_get($1)', [key])).rows.length, 0);
  const second = 'b'.repeat(64);
  await db.query('SELECT public.zerox_session_put($1, $2, $3)', [second, 'second', 1]);
  assert.equal((await db.query('SELECT key FROM public.gateway_session_store')).rows.length, 1, 'expired entries cleaned during write');
  await db.query('SELECT public.zerox_session_delete($1)', [second]);
  assert.equal((await db.query('SELECT * FROM public.zerox_session_get($1)', [second])).rows.length, 0);
  await db.query('SELECT public.zerox_session_delete($1)', [second]);
  for (const invalid of ['raw-token', 'A'.repeat(64), '', null]) {
    await assert.rejects(db.query('SELECT public.zerox_session_put($1, $2, 1)', [invalid, 'test']), /Invalid session key/);
    await assert.rejects(db.query('SELECT * FROM public.zerox_session_get($1)', [invalid]), /Invalid session key/);
    await assert.rejects(db.query('SELECT public.zerox_session_delete($1)', [invalid]), /Invalid session key/);
  }
  for (const invalid of [0, -1, 604801, null]) {
    await assert.rejects(db.query('SELECT public.zerox_session_put($1, $2, $3)', [key, 'test', invalid]), /Invalid session TTL/);
  }
  await db.exec('RESET ROLE');
  const functions = (await db.query("SELECT prosecdef, proconfig FROM pg_proc WHERE proname IN ('zerox_session_get', 'zerox_session_put', 'zerox_session_delete')")).rows;
  assert.equal(functions.length, 3);
  assert.ok(functions.every(row => row.prosecdef === false && row.proconfig.includes('search_path=""')));
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.gateway_session_store'::regclass")).rows[0].relrowsecurity, true);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.gateway_session_store'), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM public.zerox_session_get($1)', [key]), /permission denied/);
    await assert.rejects(db.query('SELECT public.zerox_session_put($1, $2, 1)', [key, 'test']), /permission denied/);
    await assert.rejects(db.query('SELECT public.zerox_session_delete($1)', [key]), /permission denied/);
    await db.exec('RESET ROLE');
  }
  console.log('PASS: DB session persistence, hashed keys, upserts, expiry, cleanup, deletion, TTL validation and service-only access');
} finally {
  await db.close();
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true });
}
