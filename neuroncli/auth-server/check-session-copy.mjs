// scripts/kv-sessions-to-postgres.mjs: records the Worker wrote to SESSIONS_KV are copied into
// the Postgres session store (PGlite with every migration) so that the Node server, which has no
// KV, reads the same session for the same token. Dry run changes nothing; rows Postgres already
// has are never overwritten; an account session the index no longer lists (signed out) is not
// brought back; TTLs are capped at seven days; other keys, expiring records and non-JSON values
// are skipped.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { readRecord, sha256Hex, writeRecord } from './src/session-store.js';
import { copySessions, parseKeyList } from './scripts/kv-sessions-to-postgres.mjs';

const DAY = 86400;
// Workers KV as session-store.js uses it, with the expiration `wrangler kv key list` reports.
const store = new Map();
const kv = {
  get: async key => store.get(key)?.value ?? null,
  put: async (key, value, { expirationTtl }) => {
    store.set(key, { value, expiration: Math.floor(Date.now() / 1000) + expirationTtl });
  },
  delete: async key => { store.delete(key); },
};
const workerEnv = { SESSIONS_KV: kv };
const nodeEnv = { DATABASE_DRIVER: 'pglite' };
const listing = () => [...store].map(([name, entry]) => ({ name, expiration: entry.expiration }));

try {
  const { db } = await getPgliteHandle(nodeEnv);
  const now = Date.now();
  const userId = randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, 'copy@example.test']);
  const signIn = async (token, record, ttl) => {
    await writeRecord(workerEnv, token, record, ttl);
    await rpc(nodeEnv, 'zerox_session_index_add', { p_user_id: userId, p_token_hash: await sha256Hex(token),
      p_expires_at: new Date(record.expires).toISOString() });
  };
  const cli = { created: now, expires: now + 30 * DAY * 1000, user_id: userId, account_backed: true, plan: 'free' };
  await signIn('ses_copy_a', cli, 30 * DAY);
  await writeRecord(workerEnv, 'pkce:state-b', { verifier: 'v', created: now }, 600);
  // Already in Postgres (signed in again on the Node server): the KV copy must not replace it.
  await writeRecord(workerEnv, 'ses_copy_c', { created: now, expires: now + DAY * 1000, user_id: 'old' }, DAY);
  await writeRecord(nodeEnv, 'ses_copy_c', { created: now, expires: now + DAY * 1000, user_id: 'new' }, DAY);
  await writeRecord(workerEnv, 'ses_copy_d', { created: now, expires: now + 30_000, user_id: 'd' }, 30);
  store.set(await sha256Hex('ses_copy_e'), { value: 'not json', expiration: Math.floor(now / 1000) + DAY });
  store.set('health:groq:free', { value: '{}', expiration: Math.floor(now / 1000) + DAY });
  store.set('oiop:models-dev', { value: '{}' });
  // Signed out after its record was written (index row gone, KV record still there).
  await signIn('ses_copy_f', { ...cli, created: now - 1000 }, 30 * DAY);
  await rpc(nodeEnv, 'zerox_session_index_remove', { p_token_hash: await sha256Hex('ses_copy_f') });

  const database = (name, args) => rpcRows(nodeEnv, name, args);
  const readValue = async name => kv.get(name);
  const dry = await copySessions({ keys: listing(), readValue, database });
  assert.deepEqual(dry, { listed: 8, copied: 0, would_copy: 2, present: 1, not_indexed: 1, expiring: 1, invalid: 1,
    other_keys: 2, failed: 0 });
  assert.equal(await readRecord(nodeEnv, 'ses_copy_a'), null, 'a dry run writes nothing');

  const applied = await copySessions({ keys: listing(), readValue, database, apply: true });
  assert.equal(applied.copied, 2);
  assert.equal(applied.present, 1);
  assert.deepEqual(await readRecord(nodeEnv, 'ses_copy_a'), cli, 'the Node server reads the Worker session for the same token');
  assert.deepEqual(await readRecord(nodeEnv, 'pkce:state-b'), { verifier: 'v', created: now });
  assert.equal((await readRecord(nodeEnv, 'ses_copy_c')).user_id, 'new', 'a row Postgres had is kept');
  assert.equal(await readRecord(nodeEnv, 'ses_copy_d'), null);
  assert.equal(await readRecord(nodeEnv, 'ses_copy_f'), null, 'a signed-out session is not brought back');
  const row = await db.query('SELECT expires_at FROM public.gateway_session_store WHERE key = $1',
    [await sha256Hex(await sha256Hex('ses_copy_a'))]);
  const ttl = (Date.parse(row.rows[0].expires_at) - Date.now()) / 1000;
  assert.ok(ttl > 7 * DAY - 120 && ttl <= 7 * DAY, `TTL capped at seven days (${ttl})`);

  const again = await copySessions({ keys: listing(), readValue, database, apply: true });
  assert.equal(again.copied, 0);
  assert.equal(again.present, 3, 'a second run copies nothing');

  const failing = await copySessions({ keys: listing(), readValue, apply: true,
    database: async () => { throw new Error('database down'); } });
  assert.equal(failing.failed, 5, 'every record that could be copied is reported as failed');

  // `wrangler kv key list` output, with a banner line before the JSON.
  assert.deepEqual(parseKeyList(' ⛅️ wrangler 4.147.0\n[{"name":"ab","expiration":1}]'), [{ name: 'ab', expiration: 1 }]);
  assert.throws(() => parseKeyList('{"error":"x"}'));
  console.log('PASS: KV session records copied into the Postgres store under the key the Node server reads; dry run, no overwrite, signed-out sessions stay out, TTL cap, skips');
} finally {
  await closeAllPglite();
}
