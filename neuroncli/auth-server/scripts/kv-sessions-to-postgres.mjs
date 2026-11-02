#!/usr/bin/env node
// Operator tool, run once when the Worker stops using Workers KV for sessions (deploy/aws
// SESSIONS.md): copies the session records in SESSIONS_KV into the Postgres session store
// (gateway_session_store, zerox_session_put), so sign-ins made on the Worker keep working on
// both the Worker and the Node server on the VM. Dry run by default (counts only).
//
//   node scripts/kv-sessions-to-postgres.mjs            # dry run: what would be copied
//   node scripts/kv-sessions-to-postgres.mjs --apply    # copy the records Postgres lacks
//   node scripts/kv-sessions-to-postgres.mjs --apply --namespace-id <id>   # after the unbind
//
// KV is read with wrangler from this directory (`wrangler login` or CLOUDFLARE_API_TOKEN with
// Workers KV read): by the SESSIONS_KV binding in wrangler.toml, or by --namespace-id once the
// binding is gone (`npx wrangler kv namespace list` shows the id). Postgres is written with
// SUPABASE_URL and SUPABASE_SECRET_KEY from the environment. Keys and values are never printed.
//
// What is copied: every record session-store.js wrote (CLI sessions, PKCE records, relay
// tickets, the changelog cache), all stored under sha256(key) in KV. The Postgres store hashes
// the key it is given once more (persistentSessionStore), so a KV key K lands under
// sha256(K), the row the Node server reads for the same token. TTLs come from the KV
// expiration, capped at Postgres's seven days (a session in use is re-armed daily after that).
// A row Postgres already has is never overwritten, so a second run, or a run after the Worker
// switched, cannot roll back newer state. An account session is copied only while the session
// index still lists it (zerox_session_index_list; the KV key is the index's token hash), so a
// sign-out or revoke between two runs is never undone. Skipped: records with under a minute
// left, values that are not JSON objects, account sessions the index does not list, and every
// other key (raw keys from before hashed storage, which lived 24 hours, the health share and
// models.dev facts, which are KV-only caches).
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rpcRows } from '../src/account-store.js';
import { sha256Hex } from '../src/session-store.js';

const HASHED_KEY = /^[0-9a-f]{64}$/;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 3600; // zerox_session_put's limit
const here = dirname(dirname(fileURLToPath(import.meta.url)));

// keys: [{ name, expiration? (unix seconds) }] as `wrangler kv key list` prints them.
// readValue(name) -> string; database(name, args) -> rows (rpcRows). Returns counts only.
export async function copySessions({ keys, readValue, database, apply = false, now = Date.now(), concurrency = 4 }) {
  const counts = { listed: keys.length, copied: 0, would_copy: 0, present: 0, not_indexed: 0, expiring: 0, invalid: 0,
    other_keys: 0, failed: 0 };
  // Token hashes the index lists per user, loaded once per user.
  const indexes = new Map();
  const indexed = userId => {
    if (!indexes.has(userId)) {
      indexes.set(userId, database('zerox_session_index_list', { p_user_id: userId })
        .then(rows => new Set(rows.map(row => row.token_hash))));
    }
    return indexes.get(userId);
  };
  const candidates = [];
  for (const key of keys) {
    if (!HASHED_KEY.test(String(key?.name))) counts.other_keys++;
    else if (!(Number(key.expiration) * 1000 - now >= MIN_TTL_SECONDS * 1000)) counts.expiring++;
    else candidates.push(key);
  }
  const copyOne = async key => {
    const target = await sha256Hex(key.name);
    if ((await database('zerox_session_get', { p_key: target }))[0]?.value != null) return 'present';
    const value = await readValue(key.name);
    let record = null;
    try { record = JSON.parse(value); } catch { /* counted as invalid */ }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return 'invalid';
    if (record.account_backed === true) {
      if (typeof record.user_id !== 'string' || !(await indexed(record.user_id)).has(key.name)) return 'not_indexed';
    }
    const ttl = Math.min(MAX_TTL_SECONDS, Math.floor((Number(key.expiration) * 1000 - Date.now()) / 1000));
    if (ttl < MIN_TTL_SECONDS) return 'expiring';
    if (!apply) return 'would_copy';
    await database('zerox_session_put', { p_key: target, p_value: value, p_ttl: ttl });
    return 'copied';
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < candidates.length) {
      const key = candidates[next++];
      try { counts[await copyOne(key)]++; }
      catch (error) {
        counts.failed++;
        console.warn('Session record not copied', { message: String(error?.message).slice(0, 160) });
      }
    }
  }));
  return counts;
}

// wrangler from this directory; `npx` needs a shell on Windows. Arguments are fixed strings,
// a 32-hex namespace id and 64-hex keys only. stdout is returned as text; a non-zero exit
// throws without its output.
function wrangler(command, args, namespace) {
  return new Promise((resolve, reject) => {
    const target = namespace ? ['--namespace-id', namespace] : ['--binding', 'SESSIONS_KV'];
    const child = spawn(command, [...args, ...target, '--remote'], {
      cwd: here, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} exited with ${code}`))));
  });
}

export function parseKeyList(text) {
  // wrangler may print a banner before the JSON array.
  const start = text.indexOf('[');
  const keys = JSON.parse(start >= 0 ? text.slice(start) : text);
  if (!Array.isArray(keys)) throw new Error('wrangler kv key list did not return a JSON array');
  return keys;
}

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean' }, concurrency: { type: 'string' }, wrangler: { type: 'string' },
    'namespace-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('usage: node scripts/kv-sessions-to-postgres.mjs [--apply] [--namespace-id <id>] [--concurrency 4] [--wrangler "npx wrangler"]');
    return;
  }
  const namespace = values['namespace-id'];
  if (namespace !== undefined && !/^[0-9a-f]{32}$/.test(namespace)) throw new Error('--namespace-id must be a 32-hex KV namespace id');
  const env = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
  if (!env.SUPABASE_URL || !String(env.SUPABASE_SECRET_KEY || '').startsWith('sb_secret_')) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (sb_secret_...) in the environment');
  }
  // The command may carry its own arguments (`npx wrangler@4.147.0`); keys are appended after them.
  const [command, ...prefix] = (values.wrangler || 'npx wrangler').split(/\s+/).filter(Boolean);
  const run = args => wrangler(command, [...prefix, ...args], namespace);
  const keys = parseKeyList(await run(['kv', 'key', 'list']));
  const counts = await copySessions({
    keys, apply: values.apply === true, concurrency: Number(values.concurrency) || 4,
    readValue: async name => {
      if (!HASHED_KEY.test(name)) throw new Error('Refusing a key that is not a record hash');
      // Records are JSON objects; anything wrangler prints before one is dropped.
      const text = await run(['kv', 'key', 'get', name]);
      const start = text.indexOf('{');
      return (start > 0 ? text.slice(start) : text).trimEnd();
    },
    database: (name, args) => rpcRows(env, name, args),
  });
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', ...counts }));
  if (counts.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
