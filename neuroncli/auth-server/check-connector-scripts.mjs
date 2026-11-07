// Owner scripts for hosted connectors: scripts/connector-kek.mjs and scripts/connector-preflight.mjs.
// They must never print a secret value. Run: node check-connector-scripts.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorKekConfigured } from './src/connector-vault.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const kekScript = join(here, 'scripts', 'connector-kek.mjs');
const preScript = join(here, 'scripts', 'connector-preflight.mjs');
const dir = mkdtempSync(join(tmpdir(), 'zx-conn-'));
const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const cleanEnv = extra => {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
};
const run = (script, args, env = {}, input) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: cleanEnv(env), input });
const everything = r => `${r.stdout}\n${r.stderr}`;

try {
  // ── KEK generator ──
  const out = join(dir, 'kek.txt');
  let r = run(kekScript, ['--out', out]);
  assert.equal(r.status, 0, everything(r));
  assert.ok(existsSync(out));
  const key = readFileSync(out, 'utf8').trim();
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.ok(connectorKekConfigured({ CONNECTOR_TOKENS_KEK: key }));
  assert.ok(!everything(r).includes(key), 'the key is never printed');
  assert.ok(!everything(r).includes(key.slice(0, 12)));
  if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600);
  ok('connector-kek writes a 32-byte base64 key to the chosen path without printing it');

  r = run(kekScript, ['--out', out]);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(out, 'utf8').trim(), key, 'an existing file is not overwritten');
  assert.match(everything(r), /exists/i);
  ok('connector-kek refuses to overwrite');

  r = run(kekScript, ['--out', out, '--force']);
  assert.equal(r.status, 0, everything(r));
  assert.notEqual(readFileSync(out, 'utf8').trim(), key);
  ok('connector-kek --force replaces the file');

  r = run(kekScript, ['--out', join(here, 'must-not-exist.kek')]);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(here, 'must-not-exist.kek')), 'no key file inside the repository');
  assert.match(everything(r), /repository/i);
  ok('connector-kek refuses a path inside the repository');

  r = run(kekScript, []);
  assert.notEqual(r.status, 0);
  assert.match(everything(r), /--out|--gh-secret/);
  ok('connector-kek needs an explicit destination');

  const current = readFileSync(out, 'utf8').trim();
  r = run(kekScript, ['--check', out]);
  assert.equal(r.status, 0, everything(r));
  assert.match(r.stdout, /valid/i);
  assert.ok(!everything(r).includes(current));
  writeFileSync(join(dir, 'bad.txt'), 'not-a-key\n');
  r = run(kekScript, ['--check', join(dir, 'bad.txt')]);
  assert.notEqual(r.status, 0);
  ok('connector-kek --check validates a file and prints no value');

  r = run(kekScript, ['--gh-secret', '--dry-run']);
  assert.equal(r.status, 0, everything(r));
  assert.match(r.stdout, /gh secret set CONNECTOR_TOKENS_KEK/);
  r = run(kekScript, ['--gh-secret', '--dry-run', '--env', 'staging', '--repo', 'owner/repo']);
  assert.match(r.stdout, /--env staging/);
  assert.match(r.stdout, /--repo owner\/repo/);
  r = run(kekScript, ['--gh-secret', '--dry-run', '--env', 'bad name;rm']);
  assert.notEqual(r.status, 0);
  ok('connector-kek --gh-secret --dry-run shows the command and validates arguments');

  // ── Preflight ──
  const sentinel = 'SENTINEL-secret-value-91ac';
  r = run(preScript, [], {});
  assert.equal(r.status, 0, everything(r));
  assert.match(r.stdout, /HOSTED_CONNECTORS\s+off/);
  assert.match(r.stdout, /CONNECTOR_TOKENS_KEK\s+unset/);
  for (const id of ['ATLASSIAN', 'GITHUB', 'LINEAR', 'NOTION', 'SLACK']) assert.match(r.stdout, new RegExp(`CONNECTOR_${id}_CLIENT_ID\\s+unset`));
  assert.match(r.stdout, /github\s+not ready/i);
  ok('preflight lists every name as unset on an empty environment');

  r = run(preScript, ['--strict'], {});
  assert.notEqual(r.status, 0);
  ok('preflight --strict fails while anything is missing');

  r = run(preScript, [], {
    HOSTED_CONNECTORS: 'true', CONNECTOR_TOKENS_KEK: current, CONNECTOR_GITHUB_CLIENT_ID: sentinel,
    CONNECTOR_GITHUB_CLIENT_SECRET: sentinel, CONNECTORS_CALLBACK_URL: `https://${sentinel}.example/cb`,
  });
  assert.equal(r.status, 0, everything(r));
  assert.ok(!everything(r).includes(sentinel), 'no value is printed');
  assert.ok(!everything(r).includes(current));
  assert.match(r.stdout, /HOSTED_CONNECTORS\s+on/);
  assert.match(r.stdout, /CONNECTOR_TOKENS_KEK\s+set/);
  assert.match(r.stdout, /CONNECTOR_GITHUB_CLIENT_ID\s+set/);
  assert.match(r.stdout, /github\s+ready/i);
  assert.match(r.stdout, /linear\s+not ready/i);
  ok('preflight reports names and states, never values');

  r = run(preScript, [], { CONNECTOR_TOKENS_KEK: 'short' });
  assert.match(r.stdout, /CONNECTOR_TOKENS_KEK\s+set but invalid/);
  r = run(preScript, [], { CONNECTOR_TOKENS_KEK: current, PROVIDER_KEYS_KEK: current });
  assert.match(r.stdout, /reuses PROVIDER_KEYS_KEK/i);
  assert.ok(!everything(r).includes(current));
  ok('preflight flags an invalid or reused key without printing it');

  r = run(preScript, [], { HOSTED_CONNECTORS: 'true' });
  assert.match(r.stdout, /503/);
  ok('preflight warns that the flag without a key answers 503');

  const envFile = join(dir, 'staging.env');
  writeFileSync(envFile, `# comment\nHOSTED_CONNECTORS=true\nCONNECTOR_LINEAR_CLIENT_ID="${sentinel}"\nexport CONNECTOR_LINEAR_CLIENT_SECRET=${sentinel}\n`);
  r = run(preScript, ['--env-file', envFile], {});
  assert.equal(r.status, 0, everything(r));
  assert.ok(!everything(r).includes(sentinel));
  assert.match(r.stdout, /CONNECTOR_LINEAR_CLIENT_ID\s+set/);
  assert.match(r.stdout, /linear\s+ready/i);
  ok('preflight reads names and states from an env file without printing values');

  r = run(preScript, ['--env-file', join(dir, 'missing.env')], {});
  assert.notEqual(r.status, 0);
  ok('preflight fails on an unreadable env file');

  r = run(preScript, ['--json'], { CONNECTOR_GITHUB_CLIENT_ID: sentinel });
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hosted_connectors, 'off');
  assert.ok(Array.isArray(parsed.connectors) && parsed.connectors.length === 5);
  assert.ok(!r.stdout.includes(sentinel));
  ok('preflight --json is machine readable and value free');

  console.log(`\n${passed.length} connector script checks passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
