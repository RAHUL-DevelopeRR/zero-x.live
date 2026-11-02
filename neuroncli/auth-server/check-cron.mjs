// scripts/cron.mjs (the Node server's 10-minute cron, deploy/aws/zerox-cron.timer) runs the
// Worker's scheduled work against the database: stale reservations released, subscription
// expiry, device grant purge and the discovery claim. Exit 0 when maintenance ran (or there is
// no database), 1 when it failed. The database is a fake PostgREST on loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./scripts/cron.mjs', import.meta.url));
const calls = [];
let failRelease = false;
const database = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const name = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(request.url)?.[1];
  calls.push({ name, apikey: request.headers.apikey });
  const reply = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(value === undefined ? '' : JSON.stringify(value));
  };
  if (name === 'zerox_release_stale_reservations') {
    return failRelease ? reply(500, { message: 'boom', code: 'XX000' }) : reply(200, [{ released: 2 }]);
  }
  if (name === 'zerox_apply_subscription_expiry') return reply(200, [{ downgraded: 1 }]);
  if (name === 'zerox_device_purge') return reply(204);
  // zerox_discovery_claim (nothing due) and the catalog reads: no rows.
  return reply(200, []);
});
database.listen(0, '127.0.0.1');
await once(database, 'listening');
const databaseUrl = `http://127.0.0.1:${database.address().port}`;

// A directory without a .env, so server.js's dotenv cannot add a real database to the child.
const cwd = await mkdtemp(join(tmpdir(), 'zerox-cron-'));
const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  NEURON_API_ONLY: 'true', DISCOVERY_RESEARCH: 'false' };
for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];

async function run(env) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  const line = (stdout + stderr).split('\n').map(text => text.trim()).filter(text => text.startsWith('{"cron"')).pop();
  return { code, record: line ? JSON.parse(line) : null, stderr };
}

try {
  const unconfigured = await run({});
  assert.equal(unconfigured.code, 0, `${unconfigured.code} ${unconfigured.stderr}`);
  assert.deepEqual(unconfigured.record.maintenance, { skipped: true });
  assert.equal(calls.length, 0);

  const db = { SUPABASE_URL: databaseUrl, SUPABASE_SECRET_KEY: 'sb_secret_cron_check' };
  const ok = await run(db);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.record.cron, 'ok');
  assert.deepEqual(ok.record.maintenance, { released: 2, downgraded: 1 });
  const names = new Set(calls.map(call => call.name));
  for (const name of ['zerox_release_stale_reservations', 'zerox_apply_subscription_expiry', 'zerox_device_purge', 'zerox_discovery_claim']) {
    assert.ok(names.has(name), `${name} was called`);
  }
  assert.ok(calls.every(call => call.apikey === db.SUPABASE_SECRET_KEY));

  failRelease = true;
  const failed = await run(db);
  assert.equal(failed.code, 1);
  assert.equal(failed.record.cron, 'failed');
  console.log('PASS: scripts/cron.mjs runs the scheduled maintenance and discovery claim, skips without a database and exits 1 on failure');
} finally {
  database.close();
  await rm(cwd, { recursive: true, force: true });
}
