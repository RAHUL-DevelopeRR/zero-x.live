// The EC2 VM kit (deploy/aws, .github/workflows/deploy-oracle.yml until the EC2 job replaces it)
// stays in step with the gateway: the environment file builder (wrangler.toml [vars] plus
// secrets, systemd quoting, the VM's own settings refused), the workflow's secret set (deploy.yml's,
// the parity secrets required), actions pinned by commit, every variable the gateway reads listed
// in gateway.env.example, the units and activation script agreeing on paths, port and the
// shutdown grace, and activate-release.sh run against a temporary tree. Values from wrangler.toml
// are never printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvFile, envLine, wranglerVars } from '../../deploy/aws/gateway-env.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '../..');
const read = path => readFileSync(join(repo, path), 'utf8');

// ── Environment file ──
// systemd's EnvironmentFile reading of KEY="value": \ " ` $ are unescaped inside double quotes.
const systemdValue = line => /^[A-Z0-9_]+="(.*)"$/.exec(line)[1].replace(/\\([\\"`$])/g, '$1');
for (const value of ['plain', 'a"b', 'back\\slash', '$HOME and ${X}', 'tick`s', 'sb_secret_x/y+z=', '']) {
  assert.equal(systemdValue(envLine('NAME', value)), value, `round trip of ${JSON.stringify(value)}`);
}
assert.throws(() => envLine('NAME', 'two\nlines'), /line break/);
assert.throws(() => envLine('lower', 'x'), /Invalid variable name/);

const wrangler = read('neuroncli/auth-server/wrangler.toml');
const vars = wranglerVars(wrangler);
const section = wrangler.split(/^\[vars\]\s*$/m)[1].split(/^\[/m)[0];
const declared = [...section.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]);
assert.deepEqual(Object.keys(vars).sort(), declared.sort(), 'every [vars] entry is read');
assert.ok(Object.values(vars).every(value => typeof value === 'string'));
assert.throws(() => wranglerVars('[vars]\nLIST = ["a"]\n'), /unsupported entry/);
assert.deepEqual(wranglerVars('[vars]\nA = "x" # note\nB = "q\\"z"\n[other]\nC = "no"\n'), { A: 'x', B: 'q"z' });

const built = buildEnvFile({ vars: { PLAIN: 'v' }, env: { SECRET_A: 's$1', SECRET_B: '' },
  required: ['SECRET_A'], optional: ['SECRET_B', 'SECRET_C'] });
assert.deepEqual(built.text.trim().split('\n').slice(1), ['PLAIN="v"', 'SECRET_A="s\\$1"']);
assert.deepEqual(built.skipped, ['SECRET_B', 'SECRET_C']);
assert.throws(() => buildEnvFile({ vars: {}, env: {}, required: ['SECRET_A'], optional: [] }), /Required secret SECRET_A/);
assert.throws(() => buildEnvFile({ vars: { X: '1' }, env: { X: '2' }, required: [], optional: ['X'] }), /both a wrangler var/);
// systemd lets EnvironmentFile= override the unit's Environment=, so the file may never carry
// the VM's runtime settings or a development switch, from [vars] or from a secret.
for (const name of ['NODE_ENV', 'AUTH_HOST', 'AUTH_PORT', 'NEURON_API_ONLY', 'TRUST_CLOUDFLARE', 'TRUST_CF_IPCOUNTRY',
  'SHUTDOWN_GRACE_MS', 'DEV_AUTH_ENABLED', 'ALLOW_ANONYMOUS_SESSIONS', 'ALLOW_UNKNOWN_COUNTRY', 'DATABASE_DRIVER',
  'PGLITE_DATA_DIR', 'ALLOW_LOCAL_DATABASE', 'RAZORPAY_API_BASE', 'NEURON_RUNTIME', 'E2E_UPSTREAM_BASE']) {
  assert.throws(() => buildEnvFile({ vars: { [name]: 'x' }, env: {}, required: [], optional: [] }), /not allowed in the VM environment/, `${name} as a var`);
  assert.throws(() => buildEnvFile({ vars: {}, env: { [name]: 'x' }, required: [], optional: [name] }), /not allowed in the VM environment/, `${name} as a secret`);
}
assert.ok(buildEnvFile({ vars, env: {}, required: [], optional: [] }).text, 'the real [vars] hold none of them');

// ── Workflow: deploy.yml's secrets and nothing else, actions pinned ──
// The secrets the VM must share with the Worker to behave like it (users' sealed OpenRouter
// keys, the provider key vault, device approvals) are required here: a value the Worker got
// outside GitHub would otherwise leave the VM without it, silently.
const PARITY_SECRETS = ['SESSION_ENCRYPTION_KEY', 'PROVIDER_KEYS_KEK', 'DEVICE_APPROVAL_SECRET'];
const deploy = read('.github/workflows/deploy.yml');
const oracle = read('.github/workflows/deploy-oracle.yml');
const list = (text, name) => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(text)?.[1].trim().split(/\s+/);
assert.deepEqual(list(oracle, 'REQUIRED_SECRETS'), [...list(deploy, 'REQUIRED_SECRETS'), ...PARITY_SECRETS]);
assert.deepEqual(list(oracle, 'OPTIONAL_SECRETS'), list(deploy, 'OPTIONAL_SECRETS').filter(name => !PARITY_SECRETS.includes(name)));
assert.ok(PARITY_SECRETS.every(name => list(deploy, 'OPTIONAL_SECRETS').includes(name)), 'deploy.yml gives the Worker the parity secrets');
for (const name of [...list(oracle, 'REQUIRED_SECRETS'), ...list(oracle, 'OPTIONAL_SECRETS')]) {
  assert.match(oracle, new RegExp(`^\\s*${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'm'), `${name} is passed`);
}
const secretsUsed = new Set([...oracle.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]));
for (const name of secretsUsed) {
  assert.ok(name.startsWith('ORACLE_') || list(oracle, 'OPTIONAL_SECRETS').includes(name) || list(oracle, 'REQUIRED_SECRETS').includes(name),
    `${name} is not one of the gateway secrets`);
}
assert.ok(!secretsUsed.has('CLOUDFLARE_API_TOKEN'), 'the Worker deploy token never reaches the VM');
assert.match(oracle, /^on:\s*\n\s+workflow_dispatch:\s*$/m, 'manual trigger only');
for (const [, action] of oracle.matchAll(/uses:\s*(\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned by commit`);
assert.ok(oracle.indexOf('gateway-env.mjs') < oracle.indexOf('rsync '), 'a missing secret fails before the VM is touched');

// ── gateway.env.example names every variable the gateway reads ──
function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.js') ? [readFileSync(path, 'utf8')] : [];
  });
}
const code = [...sources(join(here, 'src')), readFileSync(join(here, 'server.js'), 'utf8')].join('\n');
const read_ = new Set([
  ...[...code.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]),
  ...[...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(match => match[1]),
  ...[...code.matchAll(/\b(?:keyVar|modelsVar|hosted_flag|models_var|env|requires_flag):\s*'([A-Z][A-Z0-9_]+)'/g)].map(match => match[1]),
]);
const NOT_CONFIGURATION = new Set([
  'AI', 'ASSETS', 'SESSIONS_KV', 'HEALTH_HUB', 'RELAY', 'RELEASES', // Worker bindings
  'NEURON_RUNTIME', // set by server.js itself
  'HEALTH_CANARIES', // read by the HealthHub Durable Object, which only runs on the Worker
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', // Anthropic SDK variables the gateway pins
  'CATALOG_DB_MODELS', 'MAX_REQUESTS_PER_SESSION', 'OPENROUTER_CLIENT_ID', 'BEDROCK_TOOL_MODELS', // no longer read (warned or ignored)
]);
const template = read('deploy/aws/gateway.env.example');
const listed = new Set([...template.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map(match => match[1]));
const missing = [...read_].filter(name => !NOT_CONFIGURATION.has(name) && !name.startsWith('E2E_') && !listed.has(name));
assert.deepEqual(missing, [], 'gateway.env.example lists every variable the gateway reads');
assert.ok(!/^[A-Z][A-Z0-9_]*=\S/m.test(template), 'the template holds names only');

// ── Units and activation agree ──
const unit = read('deploy/aws/zerox-gateway@.service');
const cron = read('deploy/aws/zerox-cron.service');
const timer = read('deploy/aws/zerox-cron.timer');
const activate = read('deploy/aws/activate-release.sh');
const port = /AUTH_PORT=(\d+)/.exec(unit)[1];
assert.match(unit, /AUTH_HOST=127\.0\.0\.1/);
// /ready loads plan limits, the session store and the catalog: a bad database key, a missing RPC
// or an unreachable database fails the deploy (anonymous /health is a static answer).
assert.match(activate, new RegExp(`http://127\\.0\\.0\\.1:${port}/ready`));
assert.ok(!/\/health\b/.test(activate.replace(/^#.*$/gm, '')), 'activation gates on /ready, not /health');
const serverJs = readFileSync(join(here, 'server.js'), 'utf8');
const graceMs = Number(/SHUTDOWN_GRACE_MS, (\d+)\)/.exec(serverJs)[1]);
const cutTailMs = Number(/cutTailMs = (\d+)/.exec(serverJs)[1]);
assert.ok(Number(/TimeoutStopSec=(\d+)/.exec(unit)[1]) * 1000 > graceMs + cutTailMs, 'systemd waits for the drain and the cut tail');
// On reboot or shutdown the gateway stops (drains) before cloudflared, which carries its streams.
assert.match(unit, /^After=.*\bcloudflared\.service\b/m);
for (const text of [unit, cron]) {
  assert.match(text, /^EnvironmentFile=\/etc\/zerox\/gateway\.env$/m);
  assert.match(text, /^User=zerox$/m);
  assert.match(text, /^WorkingDirectory=\/opt\/zerox\/gateway$/m);
  assert.ok(!/MemoryDenyWriteExecute=true/.test(text), 'V8 needs writable executable memory');
}
assert.match(unit, /^Environment=.*NEURON_API_ONLY=true/m);
assert.match(unit, /^Environment=.*TRUST_CLOUDFLARE=true/m);
assert.match(cron, /^ExecStart=\/usr\/bin\/node \/opt\/zerox\/gateway\/scripts\/cron\.mjs$/m);
assert.match(timer, /^OnCalendar=\*:0\/10$/m);
assert.match(timer, /^Persistent=true$/m);

// ── The CLI's base URL includes /v1 (it appends /chat/completions and /models to it) ──
for (const name of readdirSync(join(repo, 'deploy/aws'))) {
  for (const [, base] of read(`deploy/aws/${name}`).matchAll(/NEURON_API_BASE=([^\s`'")]+)/g)) {
    assert.match(base, /\/v1$/, `deploy/aws/${name}: NEURON_API_BASE=${base} must end in /v1`);
  }
}

// ── activate-release.sh, run: a temporary /opt/zerox and /etc/zerox, stub sudo, systemctl, curl
// and sleep. A bash with POSIX symlinks is needed (on Windows, Git's with native symlinks). ──
function posixBash() {
  if (process.platform !== 'win32') return { bash: 'bash', env: {} };
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && join(exec, '../../../usr/bin/bash.exe');
  return bash && existsSync(bash) ? { bash, env: { MSYS: 'winsymlinks:nativestrict' } } : null;
}
const shell = posixBash();
const work = mkdtempSync(join(tmpdir(), 'zerox-activate-'));
const posix = path => path.replace(/\\/g, '/');
try {
  const probe = shell && spawnSync(shell.bash, ['-c', 'mkdir "$1/target" && ln -s "$1/target" "$1/probe" && [ -L "$1/probe" ]', '_', posix(work)],
    { env: { ...process.env, ...shell.env } });
  if (!probe || probe.status !== 0) {
    console.log('SKIP: activate-release.sh run (no bash with symlinks here; CI runs it)');
  } else {
    const root = join(work, 'opt');
    const etc = join(work, 'etc');
    const stubs = join(work, 'bin');
    const log = join(work, 'calls.log');
    for (const dir of [join(root, 'releases'), etc, stubs]) mkdirSync(dir, { recursive: true });
    const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('sudo', 'exec "$@"');
    stub('systemctl', 'echo "systemctl $*" >> "$STUB_LOG"');
    stub('sleep', 'exit 0');
    // 503 while the current release carries a not-ready marker, else 200.
    stub('curl', 'echo "curl $*" >> "$STUB_LOG"\nif [ -e "$(readlink "$ZEROX_ROOT/gateway")/not-ready" ]; then printf 503; else printf 200; fi');
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');
    const env = { ...process.env, ...shell.env, [pathKey]: `${stubs}${delimiter}${process.env[pathKey]}`,
      ZEROX_ROOT: posix(root), ZEROX_ETC: posix(etc), STUB_LOG: posix(log) };
    const release = (n, { ready = true } = {}) => {
      const id = `2026103000000${n}-${String(n).repeat(12)}`;
      mkdirSync(join(root, 'releases', id, 'node_modules'), { recursive: true });
      writeFileSync(join(root, 'releases', id, 'server.js'), '');
      if (!ready) writeFileSync(join(root, 'releases', id, 'not-ready'), '');
      writeFileSync(join(etc, 'gateway.env.next'), `N="${n}"\n`);
      return id;
    };
    const activateRun = id => spawnSync(shell.bash, ['-s', '--', id], { input: activate, encoding: 'utf8', env });
    const current = () => basename(posix(readlinkSync(join(root, 'gateway'))));
    const envFile = name => readFileSync(join(etc, name), 'utf8').trim();

    const first = release(1);
    const firstRun = activateRun(first);
    assert.equal(firstRun.status, 0, `the first deploy (one release, nothing to prune) succeeds: ${firstRun.stdout}${firstRun.stderr}`);
    assert.match(firstRun.stdout, /is live/);
    assert.equal(current(), first);
    assert.equal(envFile('gateway.env'), 'N="1"');
    assert.ok(!existsSync(join(etc, 'gateway.env.next')));
    assert.match(readFileSync(log, 'utf8'), /systemctl restart zerox-gateway\.service/);
    assert.match(readFileSync(log, 'utf8'), new RegExp(`curl .*http://127\\.0\\.0\\.1:${port}/ready`));
    const ids = [first];
    for (let n = 2; n <= 6; n++) {
      ids.push(release(n));
      assert.equal(activateRun(ids.at(-1)).status, 0, `deploy ${n}`);
    }
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), ids.slice(-4), 'the current release and the three newest others are kept');
    assert.equal(envFile('gateway.env.prev'), 'N="5"');
    const bad = release(7, { ready: false });
    const badRun = activateRun(bad);
    assert.equal(badRun.status, 1, 'a release that is not ready fails the deploy');
    assert.match(badRun.stdout, /previous release is live again/);
    assert.equal(current(), ids.at(-1), 'the previous release is back');
    assert.equal(envFile('gateway.env'), 'N="6"', 'and its environment');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('PASS: EC2 kit: env file from [vars] and the deploy.yml secrets (systemd quoting, VM settings refused), parity secrets required, pinned manual workflow, complete env template, consistent units, /v1 base URLs, activation run (readiness gate, rollback, prune)');
