// scripts/search-preflight.mjs: the read-only report of which web search backend is configured and
// whether POST /v1/search would work. It must be right about each deployment shape and must never
// print a secret value, an address or a path, only names and verdicts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, searchPreflight } from './scripts/search-preflight.mjs';

const script = fileURLToPath(new URL('./scripts/search-preflight.mjs', import.meta.url));
const BRAVE = 'BSA-fake-brave-token-0000';
const SEARX = 'http://10.0.3.7:8080';
const FWD = 'zero-x.live/v1/';

// Nothing set: not ready on either runtime.
for (const target of ['worker', 'vm']) {
  const report = searchPreflight({}, target);
  assert.equal(report.ready, false);
  assert.deepEqual(report.backends, []);
  assert.equal(report.status, 503);
  assert.match(report.problems.join(' '), /neither SEARXNG_URL nor BRAVE_API_KEY/);
}

// Brave alone works on both runtimes.
for (const target of ['worker', 'vm']) {
  const report = searchPreflight({ BRAVE_API_KEY: BRAVE }, target);
  assert.equal(report.ready, true);
  assert.deepEqual(report.backends, ['brave']);
}
// A malformed Brave key is reported as set but unusable, not as absent.
let report = searchPreflight({ BRAVE_API_KEY: 'short' }, 'vm');
assert.equal(report.ready, false);
assert.equal(report.vars.BRAVE_API_KEY, 'set-but-invalid');
// A SearXNG URL with credentials is unusable.
report = searchPreflight({ SEARXNG_URL: 'https://u:p@search.example' }, 'vm');
assert.equal(report.ready, false);
assert.equal(report.vars.SEARXNG_URL, 'set-but-invalid');

// SearXNG alone: the VM can use it only for forwarded /v1/ requests; the Worker never can.
report = searchPreflight({ SEARXNG_URL: SEARX }, 'vm');
assert.equal(report.ready, false, 'VM without forwarding never receives /v1/search from users');
assert.match(report.problems.join(' '), /EC2_PROXY_PREFIXES/);
report = searchPreflight({ SEARXNG_URL: SEARX, EC2_PROXY_PREFIXES: FWD }, 'vm');
assert.equal(report.ready, true);
assert.deepEqual(report.backends, ['searxng']);
report = searchPreflight({ SEARXNG_URL: SEARX, EC2_PROXY_PREFIXES: FWD }, 'worker');
assert.equal(report.ready, false, 'the Worker has no route to a private SearXNG');
assert.match(report.problems.join(' '), /Worker/);
assert.ok(report.warnings.join(' ').includes('SEARXNG_URL'));
// Forwarding that does not cover /v1/search does not count.
report = searchPreflight({ SEARXNG_URL: SEARX, EC2_PROXY_PREFIXES: 'dashboard.zero-x.live/' }, 'vm');
assert.equal(report.ready, false);
// Both: the Worker falls back to Brave, the VM asks SearXNG first.
report = searchPreflight({ SEARXNG_URL: SEARX, BRAVE_API_KEY: BRAVE, EC2_PROXY_PREFIXES: FWD }, 'vm');
assert.deepEqual(report.backends, ['searxng', 'brave']);
report = searchPreflight({ SEARXNG_URL: SEARX, BRAVE_API_KEY: BRAVE }, 'worker');
assert.deepEqual(report.backends, ['brave']);
assert.equal(report.ready, true);
assert.match(report.warnings.join(' '), /wait|8 s/);
// A public plain-http SearXNG draws a warning.
report = searchPreflight({ SEARXNG_URL: 'http://search.example.org', EC2_PROXY_PREFIXES: FWD }, 'vm');
assert.match(report.warnings.join(' '), /private/);

// Env-file parsing: names and values only for the keys we ask for, comments and quotes handled.
assert.deepEqual(parseEnvFile(`# c\nBRAVE_API_KEY="${BRAVE}"\nexport SEARXNG_URL=${SEARX} # x\nOTHER=1\n\nBAD LINE\n`,
  ['BRAVE_API_KEY', 'SEARXNG_URL']), { BRAVE_API_KEY: BRAVE, SEARXNG_URL: SEARX });

// The CLI: exit codes and no secret in any output.
const dir = await mkdtemp(join(tmpdir(), 'search-preflight-'));
try {
  const file = join(dir, 'gateway.env');
  await writeFile(file, `BRAVE_API_KEY=${BRAVE}\nSEARXNG_URL=${SEARX}\nEC2_PROXY_PREFIXES=${FWD}\n`);
  const cleanEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const run = args => spawnSync(process.execPath, [script, ...args], { env: cleanEnv, encoding: 'utf8' });
  let out = run(['--from-file', file, '--target', 'vm']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const text = out.stdout + out.stderr;
  for (const secret of [BRAVE, '10.0.3.7', FWD, file]) assert.ok(!text.includes(secret), `output leaked ${secret.slice(0, 4)}`);
  assert.match(out.stdout, /searxng, brave/);
  out = run(['--from-file', file, '--target', 'worker', '--json']);
  assert.equal(out.status, 0);
  assert.deepEqual(JSON.parse(out.stdout).backends, ['brave']);
  out = run(['--target', 'vm']);
  assert.equal(out.status, 1, 'nothing configured exits 1');
  out = run(['--target', 'moon']);
  assert.equal(out.status, 2);
  out = run(['--from-file', join(dir, 'missing.env')]);
  assert.equal(out.status, 2);
  assert.ok(!out.stderr.includes(dir), 'a missing file is reported without its path');
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('search preflight checks passed');
