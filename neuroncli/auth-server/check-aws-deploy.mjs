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
// the VM's runtime settings, the release's commit, the Worker's proxy switch or a development
// switch, from [vars] or from a secret.
for (const name of ['NODE_ENV', 'AUTH_HOST', 'AUTH_PORT', 'AUTH_REUSE_PORT', 'READY_PORT', 'ASSETS_DIR', 'NEURON_API_ONLY',
  'TRUST_CLOUDFLARE', 'TRUST_CF_IPCOUNTRY', 'SHUTDOWN_GRACE_MS', 'GIT_COMMIT', 'EC2_PROXY_PREFIXES', 'EC2_PROXY_ORIGIN',
  'DEV_AUTH_ENABLED', 'ALLOW_ANONYMOUS_SESSIONS', 'ALLOW_UNKNOWN_COUNTRY', 'DATABASE_DRIVER', 'PGLITE_DATA_DIR',
  'ALLOW_LOCAL_DATABASE', 'RAZORPAY_API_BASE', 'NEURON_RUNTIME', 'E2E_UPSTREAM_BASE']) {
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


// ── Units: two gateway instances on one port, each checkable on its own loopback port ──
const unit = read('deploy/aws/zerox-gateway@.service');
const cron = read('deploy/aws/zerox-cron.service');
const timer = read('deploy/aws/zerox-cron.timer');
const cloudflared = read('deploy/aws/cloudflared.service');
const sudoers = read('deploy/aws/zerox-deploy.sudoers');
const setup = read('deploy/aws/host-setup.sh');
const activate = read('deploy/aws/activate-release.sh');
const code_ = text => text.replace(/^\s*#.*$/gm, '');
const unitSettings = text => Object.fromEntries([...text.matchAll(/^Environment=(.+)$/gm)]
  .flatMap(([, line]) => line.trim().split(/\s+/)).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
const settings = unitSettings(unit);
assert.equal(settings.AUTH_HOST, '127.0.0.1', 'only cloudflared on the VM reaches the gateway');
assert.equal(settings.AUTH_PORT, '8787');
assert.equal(settings.AUTH_REUSE_PORT, 'true', 'both instances listen on the tunnel origin port');
assert.equal(settings.READY_PORT, '879%i', 'each instance answers /ready on its own loopback port');
assert.equal(settings.ASSETS_DIR, '/opt/zerox/current', 'the VM serves the website from the current release');
assert.equal(settings.TRUST_CLOUDFLARE, 'true');
assert.ok(!/NEURON_API_ONLY/.test(code_(unit)), 'the VM serves the website: no API-only switch');
const app = '/opt/zerox/current/neuroncli/auth-server';
assert.match(unit, new RegExp(`^WorkingDirectory=${app}$`, 'm'));
assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node ${app}/server\\.js$`, 'm'));
assert.match(unit, new RegExp(`^ConditionPathExists=${app}/server\\.js$`, 'm'), 'nothing to start at boot before the first release');
assert.match(cron, new RegExp(`^WorkingDirectory=${app}$`, 'm'));
assert.match(cron, new RegExp(`^ExecStart=/usr/bin/node ${app}/scripts/cron\\.mjs$`, 'm'));
assert.ok(existsSync(join(here, 'scripts/cron.mjs')));
assert.ok(!/NEURON_API_ONLY/.test(code_(cron)));
const serverJs = readFileSync(join(here, 'server.js'), 'utf8');
const graceMs = Number(/SHUTDOWN_GRACE_MS, (\d+)\)/.exec(serverJs)[1]);
const cutTailMs = Number(/cutTailMs = (\d+)/.exec(serverJs)[1]);
assert.ok(Number(/TimeoutStopSec=(\d+)/.exec(unit)[1]) * 1000 > graceMs + cutTailMs, 'systemd waits for the drain and the cut tail');
assert.match(unit, /^KillSignal=SIGTERM$/m, 'a stop drains');
// On reboot or shutdown the gateway stops (drains) before cloudflared, which carries its streams.
assert.match(unit, /^After=.*\bcloudflared\.service\b/m);
assert.match(unit, /^\[Install\]\nWantedBy=multi-user\.target$/m);
const sandbox = text => text.split('\n').filter(line =>
  /^(NoNewPrivileges|CapabilityBoundingSet|AmbientCapabilities|Protect\w+|Private\w+|Restrict\w+|LockPersonality|RemoveIPC|SystemCall\w+|UMask)=/.test(line));
assert.ok(sandbox(unit).length >= 20 && sandbox(unit).includes('ProtectSystem=strict') && sandbox(unit).includes('NoNewPrivileges=true'));
assert.deepEqual(sandbox(cron), sandbox(unit), 'the cron runs in the gateway\'s sandbox');
for (const text of [unit, cron]) {
  assert.match(text, /^EnvironmentFile=\/etc\/zerox\/gateway\.env$/m);
  assert.match(text, /^User=zerox$/m);
  assert.match(text, /^Group=zerox$/m);
  assert.ok(!/MemoryDenyWriteExecute=true/.test(text), 'V8 needs writable executable memory');
}
assert.match(timer, /^OnCalendar=\*:0\/10$/m);
assert.match(timer, /^Persistent=true$/m);
assert.match(timer, /^Unit=zerox-cron\.service$/m);
// The tunnel token stays off every command line, process list and journal (deploy reads the journal).
assert.match(cloudflared, /^ExecStart=\/usr\/bin\/cloudflared .*\brun --token-file \/etc\/cloudflared\/token$/m);
assert.ok(!/--token(?!-file)/.test(code_(cloudflared)), 'no --token argument');
assert.match(read('deploy/aws/zerox-sysctl.conf'), /^net\.ipv4\.tcp_migrate_req = 1$/m,
  'connections queued on a stopping instance move to the other one');

// ── sudoers: deploy may run exactly these commands as root, nothing else ──
const sudoLines = sudoers.replace(/\\\n/g, ' ').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
assert.equal(sudoLines.length, 2, 'one command alias and one rule');
const alias = /^Cmnd_Alias ZEROX_GATEWAY = (.+)$/.exec(sudoLines[0]);
assert.ok(alias, 'the alias');
assert.ok(!/[*?[\]]|\bALL\b|sudoedit|""/.test(alias[1]), 'no wildcard, no ALL, no sudoedit');
const allowed = alias[1].split(',').map(command => command.trim().replace(/\s+/g, ' '));
const expectedCommands = ['start', 'stop', 'restart', 'is-active', 'status --no-pager']
  .flatMap(verb => ['0', '1'].map(n => `/usr/bin/systemctl ${verb} zerox-gateway@${n}.service`));
assert.deepEqual([...allowed].sort(), [...expectedCommands].sort(), 'start, stop, restart, is-active and status of the two instances');
assert.equal(sudoLines[1], 'deploy ALL=(root) NOPASSWD: ZEROX_GATEWAY', 'as root, for deploy only');
const sudoAllowed = line => allowed.includes(line.replace(/^sudo systemctl /, '/usr/bin/systemctl ').trim());

// ── host-setup.sh: never the cron timer, sudoers checked before it is installed ──
assert.ok(!/(enable|start|restart|reenable)\b[^\n]*zerox-cron\.timer/.test(code_(setup)), 'host-setup.sh never enables or starts the cron timer');
assert.match(setup, /visudo -cqf /, 'the sudoers file is checked before it is installed');
assert.ok(!/cloudflared[^\n]*--token(?!-file)/.test(code_(setup)), 'no tunnel token on a command line');

// ── activate-release.sh and host-setup.sh, run: temporary /opt/zerox, /etc/zerox and system
// root, stub sudo, systemctl, curl, visudo and friends. A bash with POSIX symlinks is needed (on
// Windows, Git's with native symlinks). ──
function posixBash() {
  if (process.platform !== 'win32') return { bash: 'bash', env: {} };
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && join(exec, '../../../usr/bin/bash.exe');
  return bash && existsSync(bash) ? { bash, env: { MSYS: 'winsymlinks:nativestrict' } } : null;
}
const shell = posixBash();
const work = mkdtempSync(join(tmpdir(), 'zerox-activate-'));
const posix = path => path.replace(/\\/g, '/');
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');
let ran = false;
try {
  const probe = shell && spawnSync(shell.bash, ['-c', 'mkdir "$1/target" && ln -s "$1/target" "$1/probe" && [ -L "$1/probe" ]', '_', posix(work)],
    { env: { ...process.env, ...shell.env } });
  if (!probe || probe.status !== 0) {
    console.log('SKIP: activate-release.sh and host-setup.sh runs (no bash with symlinks here; CI runs them)');
  } else {
    ran = true;
    const root = join(work, 'opt');
    const etc = join(work, 'etc');
    const stubs = join(work, 'bin');
    const state = join(work, 'state');
    const log = join(work, 'calls.log');
    for (const dir of [join(root, 'releases'), etc, stubs, state]) mkdirSync(dir, { recursive: true });
    const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('sudo', 'echo "sudo $*" >> "$STUB_LOG"\nexec "$@"');
    stub('sleep', 'exit 0');
    // A started instance remembers the release /opt/zerox/current pointed at when it started.
    stub('systemctl', [
      'echo "systemctl $*" >> "$STUB_LOG"',
      'case "$1" in',
      '  start) readlink "$ZEROX_ROOT/current" > "$STUB_STATE/$2" || true ;;',
      '  stop) rm -f "$STUB_STATE/$2" ;;',
      '  is-active) [ "$2" = --quiet ] && shift; [ -e "$STUB_STATE/$2" ] ;;',
      'esac',
    ].join('\n'));
    // Port 879N is instance N: /ready answers 503 while its release carries a not-ready marker,
    // /health reports the release's REVISION (or the commit in its health-commit file).
    stub('curl', [
      'echo "curl $*" >> "$STUB_LOG"',
      'for a in "$@"; do url="$a"; done',
      'port="$(echo "$url" | sed -n "s#^http://127\\.0\\.0\\.1:\\([0-9]*\\)/.*#\\1#p")"',
      'rel="$(cat "$STUB_STATE/zerox-gateway@${port#879}.service" 2>/dev/null)" || { printf 000; exit 7; }',
      'case "$url" in',
      '  */ready) if [ -e "$rel/not-ready" ]; then printf 503; else printf 200; fi ;;',
      '  */health) printf \'{"status":"ok","commit":"%s"}\' "$(cat "$rel/health-commit" 2>/dev/null || cat "$rel/REVISION")" ;;',
      'esac',
    ].join('\n'));
    const env = { ...process.env, ...shell.env, [pathKey]: `${stubs}${delimiter}${process.env[pathKey]}`,
      ZEROX_ROOT: posix(root), ZEROX_ETC: posix(etc), STUB_LOG: posix(log), STUB_STATE: posix(state) };
    const release = (id, { ready = true, commit, modules = true } = {}) => {
      const dir = join(root, 'releases', id);
      mkdirSync(join(dir, 'neuroncli/auth-server', modules ? 'node_modules' : ''), { recursive: true });
      writeFileSync(join(dir, 'neuroncli/auth-server/server.js'), '');
      writeFileSync(join(dir, 'REVISION'), `${id}\n`);
      if (!ready) writeFileSync(join(dir, 'not-ready'), '');
      if (commit) writeFileSync(join(dir, 'health-commit'), commit);
      writeFileSync(join(etc, 'gateway.env.next'), `N="${id}"\n`);
      return id;
    };
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const activateRun = id => {
      rmSync(log, { force: true });
      const run = spawnSync(shell.bash, ['-s', '--', id], { input: activate, encoding: 'utf8', env });
      for (const line of calls().filter(line => line.startsWith('sudo '))) assert.ok(sudoAllowed(line), `sudoers allows "${line}"`);
      return run;
    };
    const current = () => basename(posix(readlinkSync(join(root, 'current'))));
    const running = () => readdirSync(state).sort().map(name => `${name}:${basename(posix(readFileSync(join(state, name), 'utf8').trim()))}`);
    const envFile = name => readFileSync(join(etc, name), 'utf8').trim();
    const position = text => calls().findIndex(line => line.includes(text));

    const first = release('1111111');
    const firstRun = activateRun(first);
    assert.equal(firstRun.status, 0, `the first deploy (one release, nothing to prune) succeeds: ${firstRun.stdout}${firstRun.stderr}`);
    assert.match(firstRun.stdout, /is live/);
    assert.equal(current(), first);
    assert.deepEqual(running(), ['zerox-gateway@0.service:1111111'], 'nothing ran: instance 0 starts on the release');
    assert.equal(envFile('gateway.env'), 'N="1111111"');
    assert.ok(!existsSync(join(etc, 'gateway.env.next')));
    assert.ok(calls().some(line => /^curl .*http:\/\/127\.0\.0\.1:8790\/ready$/.test(line)), 'readiness on instance 0\'s own port');

    const second = release('2222222');
    assert.equal(activateRun(second).status, 0);
    assert.deepEqual(running(), ['zerox-gateway@1.service:2222222'], 'the idle instance took the new release, the old one stopped');
    assert.ok(position('systemctl start zerox-gateway@1.service') < position('8791/ready') &&
      position('8791/ready') < position('systemctl stop zerox-gateway@0.service'),
    'the new instance is started and ready before the old one stops (zero downtime)');
    const ids = [first, second];
    for (const id of ['3333333', '4444444', '5555555', '6666666']) {
      ids.push(release(id));
      assert.equal(activateRun(id).status, 0, `deploy ${id}`);
    }
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), ids.slice(-4), 'the current release and the three most recent others are kept');
    assert.equal(envFile('gateway.env.prev'), 'N="5555555"');
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666']);

    // Not ready: the new instance stops, the release and environment go back, the old instance never stopped.
    const bad = release('7777777', { ready: false });
    const badRun = activateRun(bad);
    assert.equal(badRun.status, 1, 'a release that is not ready fails the deploy');
    assert.match(badRun.stdout, /previous release is live again/);
    assert.equal(current(), '6666666', 'the previous release is back');
    assert.equal(envFile('gateway.env'), 'N="6666666"', 'and its environment');
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666'], 'the serving instance was never stopped');
    assert.ok(!calls().includes('systemctl stop zerox-gateway@1.service'));

    // Ready, but /health reports another commit: refused the same way.
    const stale = release('8888888', { commit: 'deadbee' });
    const staleRun = activateRun(stale);
    assert.equal(staleRun.status, 1, 'a release whose /health reports another commit fails');
    assert.match(staleRun.stdout, /deadbee/);
    assert.equal(current(), '6666666');
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666']);

    // Both instances running (an earlier run stopped half way): the second one is retired first.
    writeFileSync(join(state, 'zerox-gateway@0.service'), posix(join(root, 'releases', '6666666')));
    const both = release('9999999');
    assert.equal(activateRun(both).status, 0);
    assert.ok(position('systemctl stop zerox-gateway@1.service') < position('systemctl start zerox-gateway@1.service') &&
      position('systemctl start zerox-gateway@1.service') < position('systemctl stop zerox-gateway@0.service'));
    assert.deepEqual(running(), ['zerox-gateway@1.service:9999999']);

    // Nothing running (after a crash or a reboot) and the new release is not ready: the previous one is started again.
    rmSync(join(state, 'zerox-gateway@1.service'));
    const cold = release('aaaaaaa', { ready: false });
    const coldRun = activateRun(cold);
    assert.equal(coldRun.status, 1);
    assert.match(coldRun.stdout, /previous release is live again/);
    assert.equal(current(), '9999999');
    assert.deepEqual(running(), ['zerox-gateway@1.service:9999999']);

    assert.equal(activateRun('not-a-sha').status, 2, 'a release id is a 7-character commit');
    const partial = release('bbbbbbb', { modules: false });
    assert.equal(activateRun(partial).status, 2, 'a release without its dependencies is refused');
    assert.equal(current(), '9999999');

    // host-setup.sh against a temporary system root: units, sudoers, kernel setting, legacy unit.
    const sys = join(work, 'sys');
    const sysPath = path => join(sys, path);
    const cloudInitSudo = '# Created by cloud-init v. 24.4 on Thu, 30 Oct 2026 10:00:00 +0000\n\n# User rules for ubuntu\n' +
      'ubuntu ALL=(ALL) NOPASSWD:ALL\n\n# User rules for deploy\n' +
      'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart zerox-gateway.service, /usr/bin/systemctl is-active zerox-gateway.service\n';
    const freshSystem = () => {
      rmSync(sys, { recursive: true, force: true });
      for (const dir of ['etc/systemd/system', 'etc/sudoers.d', 'etc/sysctl.d', 'etc/cloudflared', 'etc/zerox', 'opt/zerox/releases']) {
        mkdirSync(sysPath(dir), { recursive: true });
      }
      writeFileSync(sysPath('etc/sudoers'), 'root ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n');
      writeFileSync(sysPath('etc/sudoers.d/90-cloud-init-users'), cloudInitSudo);
      writeFileSync(sysPath('etc/systemd/system/zerox-gateway.service'), '[Service]\nExecStart=/usr/bin/node /opt/zerox/gateway/server.js\n');
    };
    stub('id', 'case "$1" in -u) echo 0 ;; -nG) echo "$2 systemd-journal" ;; *) exit 0 ;; esac');
    stub('chown', 'echo "chown $*" >> "$STUB_LOG"');
    stub('sysctl', 'echo "sysctl $*" >> "$STUB_LOG"');
    stub('systemd-analyze', 'echo "systemd-analyze $*" >> "$STUB_LOG"');
    stub('visudo', 'echo "visudo $*" >> "$STUB_LOG"\n[ -z "$STUB_VISUDO_FAIL" ]');
    const setupRun = (extra = {}) => {
      rmSync(log, { force: true });
      return spawnSync(shell.bash, [posix(join(repo, 'deploy/aws/host-setup.sh'))], { encoding: 'utf8',
        env: { ...env, ZEROX_SYSROOT: posix(sys), ...extra } });
    };
    freshSystem();
    const setup1 = setupRun();
    assert.equal(setup1.status, 0, `host setup: ${setup1.stdout}${setup1.stderr}`);
    for (const [kit, target] of [['zerox-gateway@.service', 'etc/systemd/system/zerox-gateway@.service'],
      ['zerox-cron.service', 'etc/systemd/system/zerox-cron.service'], ['zerox-cron.timer', 'etc/systemd/system/zerox-cron.timer'],
      ['cloudflared.service', 'etc/systemd/system/cloudflared.service'], ['zerox-deploy.sudoers', 'etc/sudoers.d/zerox-deploy'],
      ['zerox-sysctl.conf', 'etc/sysctl.d/60-zerox.conf']]) {
      assert.equal(readFileSync(sysPath(target), 'utf8'), read(`deploy/aws/${kit}`), `${target} installed`);
    }
    if (process.platform !== 'win32') assert.equal(statSync(sysPath('etc/sudoers.d/zerox-deploy')).mode & 0o777, 0o440);
    const cloudInitAfter = readFileSync(sysPath('etc/sudoers.d/90-cloud-init-users'), 'utf8');
    assert.ok(!/^deploy\s/m.test(cloudInitAfter) && /^ubuntu ALL=\(ALL\) NOPASSWD:ALL$/m.test(cloudInitAfter),
      'cloud-init\'s rule for deploy is gone, ubuntu\'s stays');
    assert.ok(!existsSync(sysPath('etc/systemd/system/zerox-gateway.service')), 'the single-instance unit is removed');
    let setupCalls = calls();
    assert.ok(setupCalls.includes('systemctl disable --now zerox-gateway.service'), 'and stopped (it drains first)');
    assert.ok(setupCalls.some(line => /^visudo -cqf .*zerox-deploy\.sudoers$/.test(line)), 'the kit\'s sudoers checked before installing');
    assert.ok(setupCalls.some(line => /^visudo -cqf .*90-cloud-init-users\.zerox$/.test(line)), 'the edited cloud-init rules checked before replacing them');
    assert.ok(setupCalls.includes('visudo -cq'), 'the whole sudo configuration checked after');
    assert.ok(setupCalls.includes('systemctl daemon-reload'));
    assert.ok(setupCalls.includes('systemctl enable zerox-gateway@0.service'), 'instance 0 starts at boot');
    assert.ok(setupCalls.some(line => /^systemd-analyze verify .*zerox-gateway@0\.service/.test(line)));
    assert.ok(setupCalls.some(line => /^sysctl -q -p .*60-zerox\.conf$/.test(line)));
    assert.ok(!setupCalls.some(line => /zerox-cron\.timer/.test(line) && /\b(enable|start|restart)\b/.test(line)), 'the cron timer stays off');
    assert.ok(!setupCalls.some(line => /cloudflared/.test(line) && /\b(enable|start)\b/.test(line)), 'no tunnel token yet: cloudflared stays off');
    assert.match(setup1.stdout, /token/);

    // Again, with the token in place: cloudflared is enabled and started, nothing else changes.
    writeFileSync(sysPath('etc/cloudflared/token'), 'eyJ0ZXN0IjoidG9rZW4ifQ');
    const setup2 = setupRun();
    assert.equal(setup2.status, 0, `host setup again: ${setup2.stdout}${setup2.stderr}`);
    setupCalls = calls();
    assert.ok(setupCalls.includes('systemctl enable cloudflared.service') && setupCalls.includes('systemctl start cloudflared.service'));
    assert.ok(!setupCalls.includes('systemctl daemon-reload'), 'unchanged units: no reload');
    assert.ok(!setupCalls.some(line => /disable --now/.test(line)));
    assert.ok(!setupCalls.some(line => /zerox-cron\.timer/.test(line) && /\b(enable|start|restart)\b/.test(line)));
    assert.ok(!`${setup2.stdout}${setup2.stderr}`.includes('eyJ0ZXN0'), 'the token is never printed');

    // A sudoers file visudo refuses is never installed, and cloud-init's rules stay as they were.
    freshSystem();
    const refused = setupRun({ STUB_VISUDO_FAIL: '1' });
    assert.equal(refused.status, 1);
    assert.ok(!existsSync(sysPath('etc/sudoers.d/zerox-deploy')));
    assert.equal(readFileSync(sysPath('etc/sudoers.d/90-cloud-init-users'), 'utf8'), cloudInitSudo);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`PASS: EC2 kit: env file from [vars] and the deploy.yml secrets (systemd quoting, VM settings refused), parity secrets required, pinned workflow, complete env template, two gateway instances on one port with their own readiness ports, cron in the same sandbox and never enabled by setup, exact deploy sudoers, /v1 base URLs${ran ? ', activation run (new instance ready before the old one stops, rollback without a gap, commit check, prune), host setup run (sudoers checked, cloud-init rule removed, idempotent)' : ''}`);
