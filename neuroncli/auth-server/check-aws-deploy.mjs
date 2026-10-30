// The EC2 VM kit (deploy/aws, job ec2 of .github/workflows/deploy.yml, the zerox-ci stack) stays in
// step with the gateway: the environment file builder (wrangler.toml [vars], VM-only values and
// secrets, systemd quoting, the VM's own settings refused), job ec2 (gated, after the Worker,
// OIDC, the Worker's secret set with the parity secrets required, pinned actions, the commit
// check), the CI role's least privilege, every variable the gateway reads listed in
// gateway.env.example, the two-instance units and the exact deploy sudoers; then runs, against
// temporary trees with stub commands: activate-release.sh (swap, rollback, prune), host-setup.sh,
// package-release.sh on a fixture repository and on HEAD, and push-release.sh with the VM side
// run locally. Values from wrangler.toml are never printed.
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
assert.throws(() => buildEnvFile({ vars: { X: '1' }, env: { X: '2' }, required: [], optional: ['X'] }), /both a plain value and a secret/);
// VM-only plain values (EXTRA_WEB_HOSTS from a repository variable): written when set, after [vars].
const withHosts = buildEnvFile({ vars: { PLAIN: 'v' }, env: { EXTRA_WEB_HOSTS: 'aws.zero-x.live', SECRET_A: 's' },
  required: ['SECRET_A'], optional: [], vmVars: ['EXTRA_WEB_HOSTS'] });
assert.deepEqual(withHosts.text.trim().split('\n').slice(1), ['PLAIN="v"', 'EXTRA_WEB_HOSTS="aws.zero-x.live"', 'SECRET_A="s"']);
assert.ok(!/EXTRA_WEB_HOSTS/.test(buildEnvFile({ vars: {}, env: { EXTRA_WEB_HOSTS: '' }, required: [], optional: [], vmVars: ['EXTRA_WEB_HOSTS'] }).text),
  'unset (production): not written');
assert.throws(() => buildEnvFile({ vars: { X: '1' }, env: {}, required: [], optional: [], vmVars: ['X'] }), /both a wrangler var and a VM variable/);
assert.throws(() => buildEnvFile({ vars: {}, env: {}, required: [], optional: ['X'], vmVars: ['X'] }), /both a plain value and a secret/);
assert.throws(() => buildEnvFile({ vars: {}, env: {}, required: [], optional: [], vmVars: ['AUTH_PORT'] }), /not allowed in the VM environment/);
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

// ── deploy.yml: the Worker job, then job ec2 for the same commit ──
const deploy = read('.github/workflows/deploy.yml');
assert.ok(!existsSync(join(repo, '.github/workflows/deploy-oracle.yml')), 'the manual Oracle workflow is retired');
for (const [, action] of deploy.matchAll(/uses:\s*(\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned by commit`);
assert.match(deploy, /^permissions:\n {2}contents: read$/m, 'the workflow token reads only');
const jobs = deploy.split(/^jobs:\n/m)[1];
const [workerJob, ec2Job] = jobs.split(/^ {2}ec2:\n/m);
assert.ok(ec2Job, 'job ec2');
assert.ok(!/id-token/.test(workerJob), 'only job ec2 may request an OIDC token');
assert.match(ec2Job, /^ {4}needs: deploy$/m, 'after the Worker deploy of the same run (the same commit)');
assert.match(ec2Job, /^ {4}if: vars\.EC2_DEPLOY == 'true'$/m, 'off until the repository variable says so');
assert.match(ec2Job, /^ {4}environment: production$/m, 'approved in the production environment');
assert.match(ec2Job, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m);
assert.match(ec2Job, /^ {6}cancel-in-progress: false$/m, 'a deploy is never cancelled half way');
assert.match(ec2Job, /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v\d/);
assert.match(ec2Job, /^ {10}role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}$/m);
assert.match(ec2Job, /^ {10}aws-region: ap-south-1$/m);
assert.ok(!/aws-access-key-id|aws-secret-access-key|secrets\.AWS_/.test(deploy), 'no stored AWS keys');
// The Worker reports its commit in /health.
assert.match(workerJob, /run: echo "short=\$\{GITHUB_SHA::7\}" >> "\$GITHUB_OUTPUT"/);
assert.match(workerJob, /^ {10}command: deploy --var GIT_COMMIT:\$\{\{ steps\.commit\.outputs\.short \}\}$/m);
// Job ec2: the Worker's secret set, except that the secrets the VM must share with the Worker
// to behave like it (users' sealed OpenRouter keys, the provider key vault, device approvals,
// the proxy secret the Worker sends) are required, and the VM's database key is its own secret.
// A value the Worker got outside GitHub would otherwise leave the VM without it, silently.
const PARITY_SECRETS = ['SESSION_ENCRYPTION_KEY', 'PROVIDER_KEYS_KEK', 'DEVICE_APPROVAL_SECRET', 'EC2_PROXY_SECRET'];
const list = (text, name) => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(text)?.[1].trim().split(/\s+/);
for (const name of [...list(workerJob, 'REQUIRED_SECRETS'), ...list(workerJob, 'OPTIONAL_SECRETS')]) {
  const passed = [...workerJob.matchAll(new RegExp(`^\\s*${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'gm'))].length;
  assert.equal(passed, 2, `${name} is in both env blocks of the Worker job`);
}
assert.ok(PARITY_SECRETS.every(name => list(workerJob, 'OPTIONAL_SECRETS').includes(name)), 'the Worker gets the parity secrets');
assert.deepEqual(list(ec2Job, 'REQUIRED_SECRETS'), [...list(workerJob, 'REQUIRED_SECRETS'), ...PARITY_SECRETS]);
assert.deepEqual(list(ec2Job, 'OPTIONAL_SECRETS'), list(workerJob, 'OPTIONAL_SECRETS').filter(name => !PARITY_SECRETS.includes(name)));
assert.deepEqual(list(ec2Job, 'VM_VARS'), ['EXTRA_WEB_HOSTS']);
assert.match(ec2Job, /^ {10}EXTRA_WEB_HOSTS: \$\{\{ vars\.EXTRA_WEB_HOSTS \}\}$/m);
const vmSecretSource = { SUPABASE_SECRET_KEY: 'SUPABASE_SECRET_KEY_EC2' };
for (const name of [...list(ec2Job, 'REQUIRED_SECRETS'), ...list(ec2Job, 'OPTIONAL_SECRETS')]) {
  assert.match(ec2Job, new RegExp(`^\\s*${name}: \\$\\{\\{ secrets\\.${vmSecretSource[name] || name} \\}\\}$`, 'm'), `${name} is passed`);
}
const ec2Secrets = new Set([...ec2Job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]));
for (const name of ec2Secrets) {
  assert.ok([...list(ec2Job, 'REQUIRED_SECRETS'), ...list(ec2Job, 'OPTIONAL_SECRETS'), ...Object.values(vmSecretSource)].includes(name),
    `${name} is not one of the gateway secrets`);
}
assert.ok(!ec2Secrets.has('CLOUDFLARE_API_TOKEN') && !ec2Secrets.has('SUPABASE_SECRET_KEY'), 'no Worker deploy token or Worker database key on the VM');
const step = text => ec2Job.indexOf(text);
assert.ok(step('gateway-env.mjs') > 0 && step('gateway-env.mjs') < step('configure-aws-credentials') &&
  step('configure-aws-credentials') < step('push-release.sh'), 'a missing secret fails before AWS or the VM is touched');
assert.match(ec2Job, /deploy\/aws\/push-release\.sh --os-user deploy --lookup tags \\\n\s+--env-file "\$RUNNER_TEMP\/gateway\.env" --known-hosts "\$RUNNER_TEMP\/known_hosts"/);
assert.match(ec2Job, /^ {10}EC2_KNOWN_HOSTS: \$\{\{ vars\.EC2_KNOWN_HOSTS \}\}$/m, 'the host key is checked, never trusted on first use');
assert.ok(step('push-release.sh') < step('want="${GITHUB_SHA::7}"') && /https:\/\/\$1\/health/.test(ec2Job) && /hosts="zero-x\.live"/.test(ec2Job),
  'then zero-x.live (and the test host) must report this commit');
assert.match(ec2Job, /if: always\(\)\n\s+run: rm -f "\$RUNNER_TEMP\/gateway\.env"/, 'the environment file is removed');

// ── ci-role.yaml (stack zerox-ci): trust only production of this repository; three permissions ──
const ciRole = read('deploy/aws/ci-role.yaml');
const ciCode = ciRole.replace(/^\s*#.*$/gm, '');
assert.match(ciCode, /Url: https:\/\/token\.actions\.githubusercontent\.com\n\s+ClientIdList: \[sts\.amazonaws\.com\]/);
assert.ok(!/ThumbprintList/.test(ciCode), 'IAM verifies the GitHub certificate chain itself; no pinned thumbprint');
assert.match(ciCode, /RoleName: zerox-github-deploy\n/);
assert.match(ciCode, /MaxSessionDuration: 3600\n/);
assert.match(ciCode, /Action: sts:AssumeRoleWithWebIdentity\n\s+Condition:\n\s+StringEquals:\n\s+'token\.actions\.githubusercontent\.com:aud': sts\.amazonaws\.com\n\s+'token\.actions\.githubusercontent\.com:sub': 'repo:RAHUL-DevelopeRR\/zero-x\.live:environment:production'\n/,
  'exact audience and subject: only jobs in the production environment of this repository');
const actions = [...ciCode.matchAll(/^\s*Action: (.+)$/gm)].flatMap(([, value]) => value.replace(/^\[|\]$/g, '').split(',').map(item => item.trim()));
assert.deepEqual(actions.sort(), ['ec2-instance-connect:OpenTunnel', 'ec2-instance-connect:SendSSHPublicKey', 'ec2:DescribeInstanceConnectEndpoints',
  'ec2:DescribeInstances', 'sts:AssumeRoleWithWebIdentity'].sort(), 'nothing but the trust, the tunnel, the one-time key and the two lookups');
assert.ok(!/ManagedPolicyArns|NotAction|NotResource|Action: .*\*/.test(ciCode), 'no AWS managed policy, no negation, no wildcard action');
const statements = ciCode.split(/^\s*- Sid: /m).slice(1);
const statement = sid => statements.find(text => text.startsWith(sid)) || '';
assert.equal(statements.length, 4, 'one trust statement and three permission statements');
assert.match(statement('TunnelToSshOnly'), /Resource: !Sub 'arn:\$\{AWS::Partition\}:ec2:\$\{AWS::Region\}:\$\{AWS::AccountId\}:instance-connect-endpoint\/\$\{InstanceConnectEndpointId\}'\n\s+Condition:\n\s+NumericEquals:\n\s+'ec2-instance-connect:remotePort': '22'\n/);
assert.match(statement('OneTimeKeyForDeployOnly'), /Resource: !Sub 'arn:\$\{AWS::Partition\}:ec2:\$\{AWS::Region\}:\$\{AWS::AccountId\}:instance\/\$\{InstanceId\}'\n\s+Condition:\n\s+StringEquals:\n\s+'ec2:osuser': deploy\n/);
assert.match(statement('FindInstanceAndEndpoint'), /Action: \[ec2:DescribeInstances, ec2:DescribeInstanceConnectEndpoints\]\n\s+Resource: '\*'/);
assert.equal([...ciCode.matchAll(/Resource: '\*'/g)].length, 1, 'a wildcard resource only for the Describe actions');
assert.match(ciCode, /Roles: \[!Ref DeployRole\]/, 'the policy is attached to this role only');
assert.ok(!/\b\d{12}\b/.test(ciCode), 'no account id in the template');

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

// ── Runbooks: the CLI's base URL includes /v1 (it appends /chat/completions and /models to it),
// every script they name exists, the cutover keeps its switch and rollbacks, no account id ──
for (const name of readdirSync(join(repo, 'deploy/aws'))) {
  for (const [, base] of read(`deploy/aws/${name}`).matchAll(/NEURON_API_BASE=([^\s`'")]+)/g)) {
    assert.match(base, /\/v1$/, `deploy/aws/${name}: NEURON_API_BASE=${base} must end in /v1`);
  }
}
const cutover = read('deploy/aws/CUTOVER.md');
for (const doc of ['deploy/aws/README.md', 'deploy/aws/CUTOVER.md', 'deploy/aws/SESSIONS.md']) {
  for (const [, script] of read(doc).matchAll(/\b([a-z-]+\.(?:sh|mjs))\b/g)) {
    assert.ok(existsSync(join(repo, 'deploy/aws', script)) || existsSync(join(here, script)) || existsSync(join(here, 'scripts', script)),
      `${doc} names ${script}, which exists`);
  }
}
for (const text of ['EC2_PROXY_PREFIXES', 'rollback/kv-rebind', 'rollback/cron-trigger', 'secret delete EC2_PROXY_PREFIXES',
  'sudo systemctl enable --now zerox-cron.timer', 'sudo systemctl disable --now zerox-cron.timer', 'gh variable delete EXTRA_WEB_HOSTS']) {
  assert.ok(cutover.includes(text), `CUTOVER.md: ${text}`);
}
assert.ok(cutover.indexOf('enable --now zerox-cron.timer') > cutover.indexOf('### 5. Cron switch'), 'the cron timer is enabled at step 5 only');
const prefixValues = [...cutover.matchAll(/printf '%s' '([^']+)' \| npx wrangler@[\d.]+ secret put EC2_PROXY_PREFIXES/g)].map(match => match[1]);
assert.ok(prefixValues.includes('zero-x.live/v1/') && prefixValues.includes('zero-x.live/'), 'steps 2 and 3');
for (const value of [...prefixValues, ...[...cutover.matchAll(/^\s+\d\. `([^`]+)`:/gm)].map(match => match[1])]) {
  assert.match(value, /^(?:[a-z]+\.)?zero-x\.live\/[a-z0-9/-]*(?:,(?:[a-z]+\.)?zero-x\.live\/[a-z0-9/-]*)*$/,
    `EC2_PROXY_PREFIXES value ${value}: host + path prefixes, comma separated, no scheme or spaces`);
}
for (const doc of ['deploy/aws/CUTOVER.md', 'deploy/aws/README.md', 'deploy/aws/ci-role.yaml', '.github/workflows/deploy.yml']) {
  assert.ok(!/\b\d{12}\b/.test(read(doc)), `${doc} names no account id`);
}

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

// ── package-release.sh, install-release.sh and push-release.sh, run: a fixture repository with
// the real .assetsignore and this deploy kit, stub aws, ssh (which runs the remote command
// locally), npm, sudo, systemctl and curl. ──
// .assetsignore read with gitignore rules (what wrangler applies), independently of git: a
// pattern matches a path or one of its directories; one with a slash before its end is anchored.
function assetsIgnored(text) {
  const rules = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(pattern => {
    assert.ok(!pattern.startsWith('!'), 'no negated patterns (this reading does not support them)');
    const dirOnly = pattern.endsWith('/');
    const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\//, '');
    let source = '';
    for (let i = 0; i < body.length; i++) {
      if (body.startsWith('**/', i)) { source += '(?:.*/)?'; i += 2; }
      else if (body.startsWith('**', i)) { source += '.*'; i += 1; }
      else if (body[i] === '*') source += '[^/]*';
      else if (body[i] === '?') source += '[^/]';
      else source += body[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const anchored = (dirOnly ? pattern.slice(0, -1) : pattern).includes('/');
    return { re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`), dirOnly };
  });
  return path => path.split('/').some((_, i, parts) => {
    const sub = parts.slice(0, i + 1).join('/');
    const isDir = i < parts.length - 1;
    return rules.some(rule => (!rule.dirOnly || isDir) && rule.re.test(sub));
  });
}
const ignored = assetsIgnored(read('.assetsignore'));
assert.ok(ignored('neuroncli/auth-server/server.js') && ignored('README.md') && ignored('docs/x/y.md') && ignored('Assets/RahulCIT.png') &&
  ignored('Assets/Pasted text.txt') && ignored('a/node_modules/b.js') && !ignored('index.html') && !ignored('Assets/logo.png') &&
  !ignored('videos/clip.mp4') && ignored('Assets/demo.mp4'), 'the reading of .assetsignore');
const GATEWAY_RUNTIME = ['neuroncli/auth-server/server.js', 'neuroncli/auth-server/package.json', 'neuroncli/auth-server/package-lock.json',
  'neuroncli/auth-server/src/index.js', 'neuroncli/auth-server/scripts/cron.mjs'];
const KIT = ['install-release.sh', 'activate-release.sh', 'host-setup.sh', 'zerox-gateway@.service', 'zerox-cron.service',
  'zerox-cron.timer', 'cloudflared.service', 'zerox-deploy.sudoers', 'zerox-sysctl.conf'].map(name => `deploy/aws/${name}`);
const NOT_SHIPPED = /^neuroncli\/auth-server\/(check-|test\.js$|e2e-|fixtures\/|migrations\/|docs\/|wrangler[^/]*\.toml$|Dockerfile$|\.)|(^|\/)(output|tmp)\/|\.md$|(^|\/)\.(env|dev\.vars)/;
let packaged = false;
const fixture = mkdtempSync(join(tmpdir(), 'zerox-package-'));
try {
  if (ran) {
    packaged = true;
    const bash = (args, options = {}) => spawnSync(shell.bash, args, { encoding: 'utf8', ...options, env: { ...process.env, ...shell.env, ...options.env } });
    const tarList = file => bash(['-c', 'tar -tzf - < "$1"', '_', posix(file)]).stdout.trim().split('\n').sort();
    const fxRepo = join(fixture, 'repo');
    const files = {
      '.assetsignore': read('.assetsignore'), '.gitignore': 'node_modules/\n', 'index.html': '<!doctype html>', '404.html': '',
      'Assets/logo.png': 'png', 'Assets/RahulCIT.png': 'private', 'Assets/Pasted text.txt': 'notes', 'videos/clip.mp4': 'mp4',
      'releases/neuron/latest.json': '{}', 'neuroncli/callback/index.html': '', 'SEO_AUDIT.md': '# notes', 'seo-pages.json': '[]',
      'legacy.html': '', 'tailwind.config.cjs': '', '.github/workflows/deploy.yml': '', 'docs/guide.html': '', '.env': 'SECRET=1',
      'neuroncli/auth-server/server.js': '', 'neuroncli/auth-server/package.json': '{}', 'neuroncli/auth-server/package-lock.json': '{}',
      'neuroncli/auth-server/src/index.js': 'export default {};\nexport const lf = true;\n', 'neuroncli/auth-server/scripts/cron.mjs': '', 'neuroncli/auth-server/check-gateway.mjs': '',
      'neuroncli/auth-server/check-node-lifecycle.cjs': '', 'neuroncli/auth-server/test.js': '', 'neuroncli/auth-server/e2e-upstream-shim.mjs': '',
      'neuroncli/auth-server/fixtures/request.json': '{}', 'neuroncli/auth-server/migrations/20261001000000_x.sql': '',
      'neuroncli/auth-server/docs/RELAY.md': '', 'neuroncli/auth-server/README.md': '', 'neuroncli/auth-server/wrangler.toml': '',
      'neuroncli/auth-server/wrangler.api.toml': '', 'neuroncli/auth-server/.dev.vars.example': '', 'neuroncli/auth-server/.env.example': '',
      'neuroncli/auth-server/Dockerfile': '',
    };
    for (const name of readdirSync(join(repo, 'deploy/aws'))) files[`deploy/aws/${name}`] = read(`deploy/aws/${name}`);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(fxRepo, path, '..'), { recursive: true });
      writeFileSync(join(fxRepo, path), text);
    }
    const git = (...args) => spawnSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', '-c', 'core.autocrlf=false', ...args],
      { cwd: fxRepo, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A', '-f');
    git('commit', '-q', '-m', 'fixture');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const out = join(fixture, 'release.tar.gz');
    const pack = (ref = 'HEAD') => bash([posix(join(fxRepo, 'deploy/aws/package-release.sh')), ref, posix(out)], { cwd: fxRepo });
    const packed = pack();
    assert.equal(packed.status, 0, `package-release.sh: ${packed.stderr}`);
    assert.equal(packed.stdout.trim(), head.slice(0, 7), 'it prints the release id');
    const listed = tarList(out);
    const expectedSite = Object.keys(files).filter(path => !ignored(path));
    assert.deepEqual(listed, [...new Set(['REVISION', '.assetsignore', ...expectedSite, ...GATEWAY_RUNTIME, ...KIT])].sort(),
      'the website as .assetsignore leaves it, the gateway without tests and tools, the VM\'s deploy kit, REVISION');
    assert.equal(bash(['-c', 'tar -xzOf - REVISION < "$1"', '_', posix(out)]).stdout, `${head.slice(0, 7)}\n`);
    assert.equal(bash(['-c', 'tar -xzOf - neuroncli/auth-server/src/index.js < "$1"', '_', posix(out)]).stdout,
      files['neuroncli/auth-server/src/index.js'], 'files as committed (no CRLF from a Windows checkout)');
    assert.ok(!listed.some(path => NOT_SHIPPED.test(path) && !path.startsWith('deploy/aws/')), 'no tests, migrations, docs, Markdown or env files');
    // A tracked working file or key fails the build instead of shipping.
    const leaks = ['output/plan.txt', 'tmp/notes.txt', 'keys/zerox.pem'];
    for (const leak of leaks) {
      mkdirSync(join(fxRepo, leak, '..'), { recursive: true });
      writeFileSync(join(fxRepo, leak), 'x');
    }
    git('add', '-f', ...leaks);
    git('commit', '-q', '-m', 'leaks');
    const refused = pack();
    assert.equal(refused.status, 2, 'tracked working files and keys are refused');
    assert.match(refused.stderr, /refusing to ship 3 file\(s\)/);
    git('rm', '-q', ...leaks);
    git('commit', '-q', '-m', 'no leaks');
    assert.equal(pack('no-such-ref').status, 2);
    const fxRelease = git('rev-parse', 'HEAD').stdout.trim().slice(0, 7);
    assert.equal(pack().status, 0);

    // install-release.sh and activation through push-release.sh, with the remote side run here.
    const vm = join(fixture, 'vm');
    const root = join(vm, 'opt');
    const etc = join(vm, 'etc');
    const stubs = join(fixture, 'bin');
    const state = join(fixture, 'state');
    const log = join(fixture, 'calls.log');
    for (const dir of [join(root, 'releases'), etc, stubs, state]) mkdirSync(dir, { recursive: true });
    const stub = (name, body, sh = '/bin/sh') => writeFileSync(join(stubs, name), `#!${sh}\n${body}\n`, { mode: 0o755 });
    stub('sudo', 'echo "sudo $*" >> "$STUB_LOG"\nif [ "$1" = -u ]; then shift 2; fi\nexec "$@"');
    stub('sleep', 'exit 0');
    stub('npm', 'echo "npm $*" >> "$STUB_LOG"\nmkdir -p node_modules');
    stub('systemctl', [
      'echo "systemctl $*" >> "$STUB_LOG"',
      'case "$1" in',
      '  start) readlink "$ZEROX_ROOT/current" > "$STUB_STATE/$2" || true ;;',
      '  stop) rm -f "$STUB_STATE/$2" ;;',
      '  is-active) [ "$2" = --quiet ] && shift; [ -e "$STUB_STATE/$2" ] ;;',
      'esac',
    ].join('\n'));
    stub('curl', [
      'echo "curl $*" >> "$STUB_LOG"',
      'for a in "$@"; do url="$a"; done',
      'port="$(echo "$url" | sed -n "s#^http://127\\.0\\.0\\.1:\\([0-9]*\\)/.*#\\1#p")"',
      'rel="$(cat "$STUB_STATE/zerox-gateway@${port#879}.service" 2>/dev/null)" || { printf 000; exit 7; }',
      'case "$url" in',
      '  */ready) printf 200 ;;',
      '  */health) printf \'{"status":"ok","commit":"%s"}\' "$(cat "$rel/REVISION")" ;;',
      'esac',
    ].join('\n'));
    stub('aws', [
      'echo "aws $*" >> "$STUB_LOG"',
      'case "$1 $2" in',
      '  "cloudformation describe-stacks") echo i-0abc1234def567890 ;;',
      '  "ec2 describe-instances") printf "i-0abc1234def567890\\r\\n" ;;',
      '  "ec2-instance-connect send-ssh-public-key")',
      '    while [ $# -gt 0 ]; do [ "$1" = --ssh-public-key ] && echo "$2" | cut -d" " -f1,2 > "$STUB_DIR/pushed-key"; shift; done',
      '    echo True ;;',
      'esac',
    ].join('\n'));
    // sshd runs the command with the user's shell; the probe (no authentication method) only records a host key.
    stub('ssh', [
      'echo "ssh $*" >> "$STUB_LOG"',
      'key=; opts=()',
      'while [ $# -gt 0 ]; do case "$1" in -i) key="$2"; shift 2 ;; -o) opts+=("$2"); shift 2 ;; -*) shift ;; *) break ;; esac; done',
      'shift',
      'printf "%s\\n" "${opts[@]}" > "$STUB_DIR/ssh-opts"',
      'for opt in "${opts[@]}"; do [ "$opt" = PubkeyAuthentication=no ] && exit 255; done',
      'ssh-keygen -y -f "$key" | cut -d" " -f1,2 > "$STUB_DIR/ssh-key"',
      'echo "$key" > "$STUB_DIR/ssh-key-path"',
      'exec bash -c "$*"',
    ].join('\n'), '/bin/bash');
    const knownHosts = join(fixture, 'known_hosts');
    writeFileSync(knownHosts, 'zerox-gateway ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkLSo4hRj3mnsTQUAmJKSv1n6ssD3wDq4d2qy4ZpC3H\n');
    const envSecret = join(fixture, 'gateway.env');
    writeFileSync(envSecret, 'SUPABASE_URL="https://example.invalid"\n');
    const pushEnv = { [pathKey]: `${stubs}${delimiter}${process.env[pathKey]}`, ZEROX_ROOT: posix(root), ZEROX_ETC: posix(etc),
      STUB_LOG: posix(log), STUB_STATE: posix(state), STUB_DIR: posix(fixture), AWS_PROFILE: '' };
    const push = (...args) => {
      rmSync(log, { force: true });
      return bash([posix(join(fxRepo, 'deploy/aws/push-release.sh')), ...args], { cwd: fxRepo, env: pushEnv, input: '' });
    };
    const pushCalls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const ci = push('--os-user', 'deploy', '--lookup', 'tags', '--env-file', posix(envSecret), '--known-hosts', posix(knownHosts));
    assert.equal(ci.status, 0, `push-release.sh as CI: ${ci.stdout}${ci.stderr}`);
    const released = join(root, 'releases', fxRelease);
    assert.equal(basename(posix(readlinkSync(join(root, 'current')))), fxRelease, 'the pushed release is current');
    assert.ok(existsSync(join(released, '.installed')) && existsSync(join(released, 'neuroncli/auth-server/node_modules')));
    assert.deepEqual(readdirSync(join(root, 'releases')), [fxRelease], 'no partial release left behind');
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), readFileSync(envSecret, 'utf8'), 'CI\'s environment file is in place');
    assert.deepEqual(readdirSync(state), ['zerox-gateway@0.service']);
    let seen = pushCalls();
    assert.ok(seen.some(line => /^aws ec2 describe-instances .*Name=tag:aws:cloudformation:stack-name,Values=zerox-gateway/.test(line)));
    assert.ok(seen.some(line => /^aws ec2-instance-connect send-ssh-public-key .*--instance-id i-0abc1234def567890 --instance-os-user deploy /.test(line)));
    assert.ok(seen.includes('npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error'), 'production dependencies, no install scripts');
    const sshOptions = readFileSync(join(fixture, 'ssh-opts'), 'utf8').trim().split('\n');
    for (const option of ['ProxyCommand=aws ec2-instance-connect open-tunnel --instance-id %h --region ap-south-1', 'HostKeyAlias=zerox-gateway',
      `UserKnownHostsFile=${posix(knownHosts)}`, 'StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes']) {
      assert.ok(sshOptions.includes(option), `ssh ${option}`);
    }
    assert.equal(readFileSync(join(fixture, 'ssh-key'), 'utf8'), readFileSync(join(fixture, 'pushed-key'), 'utf8'), 'ssh uses the key it pushed');
    const keyPath = readFileSync(join(fixture, 'ssh-key-path'), 'utf8').trim();
    assert.equal(bash(['-c', '[ -e "$1" ]', '_', keyPath]).status, 1, 'the one-time key is deleted');

    // The same commit again (a new environment only): installed once, activated again on the other instance.
    const again = push('--os-user', 'deploy', '--lookup', 'tags', '--known-hosts', posix(knownHosts));
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    assert.match(again.stdout, /already installed/);
    assert.deepEqual(readdirSync(state), ['zerox-gateway@1.service']);

    // The laptop: ubuntu, instance from the stack outputs, deploy through sudo -u deploy, no secret.
    const laptop = push('--known-hosts', posix(knownHosts));
    assert.equal(laptop.status, 0, `push-release.sh from the laptop: ${laptop.stdout}${laptop.stderr}`);
    seen = pushCalls();
    assert.ok(seen.some(line => /^aws cloudformation describe-stacks --stack-name zerox-gateway /.test(line)));
    assert.ok(seen.some(line => /--instance-os-user ubuntu /.test(line)));
    assert.ok(seen.some(line => /^sudo -u deploy bash .*install-release\.sh /.test(line)), 'installed as deploy');
    for (const line of seen.filter(line => line.startsWith('sudo ') && !line.startsWith('sudo -u deploy '))) {
      assert.ok(sudoAllowed(line), `sudoers allows "${line}"`);
    }
    const refusedEnv = push('--env-file', posix(envSecret), '--known-hosts', posix(knownHosts));
    assert.equal(refusedEnv.status, 2, 'the laptop never sends an environment file');
    assert.match(refusedEnv.stderr, /never sends secrets/);
    assert.ok(!pushCalls().some(line => line.startsWith('aws ') || line.startsWith('ssh ')), 'refused before any call');
    const noHostKey = push('--os-user', 'deploy', '--lookup', 'tags', '--known-hosts', posix(join(fixture, 'none')));
    assert.equal(noHostKey.status, 2, 'CI without a known host key stops');
    assert.ok(!pushCalls().some(line => /send-ssh-public-key/.test(line)), 'before pushing a key');
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// ── The real repository's HEAD, when it has this kit: what the VM would get from it ──
let packagedHead = false;
const headHasKit = spawnSync('git', ['cat-file', '-e', 'HEAD:deploy/aws/package-release.sh'], { cwd: repo }).status === 0;
if (ran && headHasKit) {
  packagedHead = true;
  const out = join(mkdtempSync(join(tmpdir(), 'zerox-head-')), 'release.tar.gz');
  try {
    const packed = spawnSync(shell.bash, [posix(join(repo, 'deploy/aws/package-release.sh')), 'HEAD', posix(out)],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, ...shell.env } });
    assert.equal(packed.status, 0, `package-release.sh HEAD: ${packed.stderr}`);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    assert.equal(packed.stdout.trim(), head.slice(0, 7));
    const listed = spawnSync(shell.bash, ['-c', 'tar -tzf - < "$1"', '_', posix(out)], { encoding: 'utf8' }).stdout.trim().split('\n');
    const tracked = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8' })
      .stdout.trim().split('\n');
    const siteOnly = path => !path.startsWith('neuroncli/auth-server/') && !['REVISION', '.assetsignore'].includes(path) && !KIT.includes(path);
    assert.deepEqual(listed.filter(siteOnly).sort(), tracked.filter(path => !ignored(path) && siteOnly(path)).sort(),
      'HEAD\'s website files are exactly what .assetsignore leaves');
    for (const path of [...GATEWAY_RUNTIME, ...KIT, 'REVISION', '.assetsignore', 'index.html']) assert.ok(listed.includes(path), `${path} is in the release`);
    assert.ok(!listed.some(path => NOT_SHIPPED.test(path) && !path.startsWith('deploy/aws/')), 'no tests, migrations, docs, Markdown or env files');
    assert.ok(!listed.some(path => /^(output|tmp|Microsoft)\//.test(path)));
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
}

console.log(`PASS: EC2 kit: env file from [vars], VM-only values and the Worker's secrets (systemd quoting, VM settings refused), job ec2 gated after the Worker with OIDC, pinned actions, parity secrets required and the commit checked, CI role limited to the tunnel, the deploy key and two lookups, complete env template, two gateway instances on one port with their own readiness ports, cron in the same sandbox and never enabled by setup, exact deploy sudoers, /v1 base URLs${ran ? ', activation run (new instance ready before the old one stops, rollback without a gap, commit check, prune), host setup run (sudoers checked, cloud-init rule removed, idempotent)' : ''}${packaged ? ', release tarball (.assetsignore as wrangler reads it, gateway without tests, kit, REVISION, tracked secrets and working files refused), push and install through stub endpoint and ssh (CI with its env file, the same commit again, the laptop without secrets, host key required)' : ''}${packagedHead ? ', HEAD packaged' : ''}`);
