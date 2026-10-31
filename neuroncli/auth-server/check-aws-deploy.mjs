// The EC2 VM kit (deploy/aws, .github/workflows/deploy.yml, the zerox-ci stack) stays in step with
// the gateway: the environment file builder (wrangler.toml [vars], VM-only values and secrets,
// systemd quoting, the VM's own settings refused), the workflow (job verify with this check before
// both deploys, the Worker and job ec2 approved together, OIDC only in job ec2, the Worker's secret
// set with the parity secrets required, pinned actions), the CI role's least privilege, every
// variable the gateway reads listed in gateway.env.example, the two-instance units, the upgrade
// handling and the exact deploy sudoers; then runs, against temporary trees with stub commands:
// job same-commit's script, zerox-install-env, activate-release.sh (swap, rollback, prune),
// zerox-gateway-refresh, host-setup.sh, package-release.sh on a fixture repository and on HEAD, and push-release.sh with
// the VM side run locally. CI runs it on Linux in job verify. Values from wrangler.toml are never
// printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_NAMES, buildEnvFile, envLine, refusedName, wranglerVars } from '../../deploy/aws/gateway-env.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '../..');
// As committed: a Windows checkout with core.autocrlf writes CRLF where .gitattributes does not pin LF.
const read = path => readFileSync(join(repo, path), 'utf8').replace(/\r\n/g, '\n');

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
// switch, from [vars] or from a secret; nor a name that changes how Node loads code, which
// certificates it trusts, or where its outbound calls go (any case).
const LOADER_NAMES = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'BASH_ENV', 'BASH_FUNC_X', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'node_options', 'Ld_Preload'];
for (const name of ['NODE_ENV', 'AUTH_HOST', 'AUTH_PORT', 'AUTH_REUSE_PORT', 'READY_PORT', 'ASSETS_DIR', 'NEURON_API_ONLY',
  'TRUST_CLOUDFLARE', 'TRUST_CF_IPCOUNTRY', 'SHUTDOWN_GRACE_MS', 'GIT_COMMIT', 'EC2_PROXY_PREFIXES', 'EC2_PROXY_ORIGIN',
  'DEV_AUTH_ENABLED', 'ALLOW_ANONYMOUS_SESSIONS', 'ALLOW_UNKNOWN_COUNTRY', 'DATABASE_DRIVER', 'PGLITE_DATA_DIR',
  'ALLOW_LOCAL_DATABASE', 'RAZORPAY_API_BASE', 'NEURON_RUNTIME', 'E2E_UPSTREAM_BASE', 'NODE_OPTIONS', 'LD_PRELOAD', 'TRUST_PROXY',
  'READY_TIMEOUT_MS', ...LOADER_NAMES]) {
  assert.throws(() => buildEnvFile({ vars: { [name]: 'x' }, env: {}, required: [], optional: [] }), /not allowed in the VM environment/, `${name} as a var`);
  assert.throws(() => buildEnvFile({ vars: {}, env: { [name]: 'x' }, required: [], optional: [name] }), /not allowed in the VM environment/, `${name} as a secret`);
}
assert.ok(buildEnvFile({ vars, env: {}, required: [], optional: [] }).text, 'the real [vars] hold none of them');
assert.ok(!refusedName('EC2_PROXY_SECRET') && !refusedName('EC2_PROXY_SECRET_ROTATION') && !refusedName('NODEJS_FLAG') && !refusedName('PROXY_URL'),
  'the families are prefixes and a suffix, nothing wider');
assert.throws(() => buildEnvFile({ vars: {}, env: { EC2_PROXY_SECRET_ROTATION: 'b'.repeat(31) }, required: [], optional: ['EC2_PROXY_SECRET_ROTATION'] }),
  /Secret EC2_PROXY_SECRET_ROTATION must be at least 32 characters/, 'the rotation value is a proxy secret too');
// Secret values: printable ASCII only (what the smoke test's workflow allowed), and a proxy secret
// server.js accepts. The error names the secret, never its value.
for (const value of ['with space', 'tab\there', 'café', 'line sep', ' lead']) {
  assert.throws(() => buildEnvFile({ vars: {}, env: { SECRET_A: value }, required: ['SECRET_A'], optional: [] }),
    error => /Secret SECRET_A has characters other than printable ASCII/.test(error.message) && !error.message.includes(value), JSON.stringify(value));
}
assert.throws(() => buildEnvFile({ vars: {}, env: { EC2_PROXY_SECRET: 'a'.repeat(31) }, required: ['EC2_PROXY_SECRET'], optional: [] }),
  /Secret EC2_PROXY_SECRET must be at least 32 characters/);
assert.match(buildEnvFile({ vars: {}, env: { EC2_PROXY_SECRET: 'a'.repeat(32) }, required: ['EC2_PROXY_SECRET'], optional: [] }).text,
  /^EC2_PROXY_SECRET="a{32}"$/m);
// The command as job ec2 runs it: an optional secret that is not set is named in a warning, except
// the rotation value, which is unset except during a rotation (a warning on every deploy would
// teach the operator to read past them). It is still left out of the file.
{
  const dir = mkdtempSync(join(tmpdir(), 'zerox-env-'));
  try {
    writeFileSync(join(dir, 'wrangler.toml'), '[vars]\nPLAIN = "v"\n');
    const run = spawnSync(process.execPath, [join(repo, 'deploy/aws/gateway-env.mjs'), '--wrangler', join(dir, 'wrangler.toml'),
      '--out', join(dir, 'gateway.env')], { encoding: 'utf8', env: { ...process.env, REQUIRED_SECRETS: '', VM_VARS: '',
      OPTIONAL_SECRETS: 'GLM_API_KEY EC2_PROXY_SECRET_ROTATION', GLM_API_KEY: '', EC2_PROXY_SECRET_ROTATION: '' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), ['::warning::Optional secret GLM_API_KEY is not set; the feature that needs it stays disabled']);
    assert.ok(!readFileSync(join(dir, 'gateway.env'), 'utf8').includes('EC2_PROXY_SECRET_ROTATION'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── deploy.yml: job verify, then the Worker (job deploy) and job ec2 for the same commit, approved
// together, then job same-commit ──
const deploy = read('.github/workflows/deploy.yml');
assert.ok(!existsSync(join(repo, '.github/workflows/deploy-oracle.yml')), 'the manual Oracle workflow is retired');
for (const [, action] of deploy.matchAll(/uses:\s*(\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, `${action} is pinned by commit`);
// Every job without its own permissions inherits this block, so it holds exactly one line.
assert.deepEqual(/^permissions:\n((?: {2}.*\n)+)/m.exec(deploy)?.[1].trimEnd().split('\n'), ['  contents: read'], 'the workflow token reads only');
const jobs = Object.fromEntries(deploy.split(/^jobs:\n/m)[1].split(/^(?= {2}[a-z][a-z0-9-]*:\n)/m).filter(text => text.trim())
  .map(text => [/^ {2}([a-z][a-z0-9-]*):\n/.exec(text)[1], text]));
assert.deepEqual(Object.keys(jobs), ['verify', 'deploy', 'ec2', 'same-commit']);
const { verify: verifyJob, deploy: workerJob, ec2: ec2Job, 'same-commit': sameCommitJob } = jobs;
for (const [name, text] of Object.entries(jobs)) {
  if (name !== 'ec2') assert.ok(!/id-token|^ {4}permissions:/m.test(text), `job ${name} has the read-only token: only job ec2 may request an OIDC token`);
}
// The body of a step's `run: |` block, as the runner gets it.
function stepRun(job, name) {
  assert.ok(job.includes(`- name: ${name}\n`), `step "${name}"`);
  const lines = job.slice(job.indexOf(`- name: ${name}\n`)).split('\n');
  const start = lines.findIndex(line => /^\s+run: \|$/.test(line)) + 1;
  const indent = /^\s*/.exec(lines[start])[0].length;
  const end = lines.findIndex((line, i) => i >= start && line.trim() && /^\s*/.exec(line)[0].length < indent);
  return lines.slice(start, end).map(line => line.slice(indent)).join('\n').trimEnd();
}
// Job verify runs on every push, before anything ships, without an environment or a secret: the
// deploy kit included, so a kit that breaks (on Linux too: its scripts run here against stubs)
// stops both runtimes on the commit they have.
assert.ok(!/^ {4}(needs|environment|if):/m.test(verifyJob) && !/secrets\./.test(verifyJob), 'job verify: every push, no environment, no secret');
const checks = stepRun(verifyJob, 'Verify production code').split('\n');
for (const command of ['npm ci --ignore-scripts', 'npm run check:production', 'npm run check:database', 'node check-aws-deploy.mjs', 'npm audit --omit=dev']) {
  assert.ok(checks.includes(command), `job verify runs ${command}`);
}
// No install script runs anywhere in the workflow (job deploy holds the Cloudflare token and every
// runtime secret in a later step; a script could reach them through $GITHUB_ENV), and no checkout
// leaves the job's token in .git/config.
const npmInstalls = [...deploy.replace(/^\s*#.*$/gm, '').matchAll(/\bnpm (?:ci|install|i)\b[^\n]*/g)].map(([line]) => line);
assert.ok(npmInstalls.length >= 2 && npmInstalls.every(line => /--ignore-scripts\b/.test(line)), `every npm install skips scripts: ${npmInstalls.join('; ')}`);
const checkouts = deploy.split(/^ {6}- name: /m).filter(step => /uses: actions\/checkout@/.test(step));
assert.equal(checkouts.length, 3);
for (const step of checkouts) assert.match(step, /^ {10}persist-credentials: false$/m, 'the checkout keeps no credentials');
// Both deploy jobs need only job verify and run in the environment "production": they wait for
// its approval at the same time, so one approval starts both (GitHub reviews a run's pending
// deployments per environment), the Worker never ships ahead of an approval the VM still waits
// for, and both read the environment's secrets.
for (const [name, text] of [['deploy', workerJob], ['ec2', ec2Job]]) {
  assert.match(text, /^ {4}needs: verify$/m, `job ${name} needs only job verify`);
  assert.match(text, /^ {4}environment: production$/m, `job ${name} is approved in the environment "production"`);
}
assert.ok(!/^ {4}if:/m.test(workerJob), 'the Worker ships on every approved push');
assert.ok(stepRun(workerJob, 'Install dependencies and build the sitemap').split('\n').includes('node build-sitemap.mjs') &&
  workerJob.indexOf('build-sitemap.mjs') < workerJob.indexOf('- name: Deploy Worker'), 'the sitemap the Worker uploads is built in its job');
assert.match(ec2Job, /^ {4}if: vars\.EC2_DEPLOY == 'true'$/m, 'off until the repository variable says so');
// Then both runtimes must report the commit; no secret, no environment.
assert.match(sameCommitJob, /^ {4}needs: \[deploy, ec2\]$/m);
assert.match(sameCommitJob, /^ {4}if: vars\.EC2_DEPLOY == 'true'$/m);
assert.ok(!/secrets\.|^ {4}environment:/m.test(sameCommitJob), 'job same-commit reads no secret');
const commitCheck = stepRun(sameCommitJob, 'Both runtimes report this commit');
assert.match(ec2Job, /^ {4}environment: production$/m, 'approved in the production environment');
assert.match(ec2Job, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write$/m);
assert.match(ec2Job, /^ {6}cancel-in-progress: false$/m, 'a deploy is never cancelled half way');
assert.match(ec2Job, /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v\d/);
// The role ARN is an environment secret (the run logs are public), and the account id is masked.
assert.match(ec2Job, /^ {10}role-to-assume: \$\{\{ secrets\.AWS_DEPLOY_ROLE_ARN \}\}$/m);
assert.match(ec2Job, /^ {10}mask-aws-account-id: true$/m);
assert.match(ec2Job, /^ {10}aws-region: ap-south-1$/m);
assert.ok(!/aws-access-key-id|aws-secret-access-key|secrets\.AWS_(?!DEPLOY_ROLE_ARN\b)/.test(deploy), 'no stored AWS keys');
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
// EC2_PROXY_SECRET_ROTATION is the VM's alone: the second proxy secret it accepts during a
// rotation; the Worker only ever sends EC2_PROXY_SECRET.
const VM_ONLY_SECRETS = ['EC2_PROXY_SECRET_ROTATION'];
assert.deepEqual(list(ec2Job, 'OPTIONAL_SECRETS'), [...list(workerJob, 'OPTIONAL_SECRETS').filter(name => !PARITY_SECRETS.includes(name)), ...VM_ONLY_SECRETS]);
assert.ok(!/EC2_PROXY_SECRET_ROTATION/.test(workerJob), 'the Worker never gets the rotation value');
assert.deepEqual(list(ec2Job, 'VM_VARS'), ['EXTRA_WEB_HOSTS']);
// package-release.sh dates the release's sitemap from the history, as job deploy does.
assert.match(ec2Job, /uses: actions\/checkout@\S+ # v[\d.]+\n {8}with:\n {10}fetch-depth: 0\n/);
assert.match(ec2Job, /^ {10}EXTRA_WEB_HOSTS: \$\{\{ vars\.EXTRA_WEB_HOSTS \}\}$/m);
const vmSecretSource = { SUPABASE_SECRET_KEY: 'SUPABASE_SECRET_KEY_EC2' };
for (const name of [...list(ec2Job, 'REQUIRED_SECRETS'), ...list(ec2Job, 'OPTIONAL_SECRETS')]) {
  assert.match(ec2Job, new RegExp(`^\\s*${name}: \\$\\{\\{ secrets\\.${vmSecretSource[name] || name} \\}\\}$`, 'm'), `${name} is passed`);
}
const ec2Secrets = new Set([...ec2Job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]));
for (const name of ec2Secrets) {
  assert.ok([...list(ec2Job, 'REQUIRED_SECRETS'), ...list(ec2Job, 'OPTIONAL_SECRETS'), ...Object.values(vmSecretSource), 'AWS_DEPLOY_ROLE_ARN'].includes(name),
    `${name} is not one of the gateway secrets`);
}
assert.ok(!ec2Secrets.has('CLOUDFLARE_API_TOKEN') && !ec2Secrets.has('SUPABASE_SECRET_KEY'), 'no Worker deploy token or Worker database key on the VM');
const step = text => ec2Job.indexOf(text);
assert.ok(step('gateway-env.mjs') > 0 && step('gateway-env.mjs') < step('configure-aws-credentials') &&
  step('configure-aws-credentials') < step('deploy/aws/push-release.sh --os-user'), 'a missing secret fails before AWS or the VM is touched');
assert.match(ec2Job, /deploy\/aws\/push-release\.sh --os-user deploy --instance-id "\$EC2_INSTANCE_ID" \\\n\s+--env-file "\$RUNNER_TEMP\/gateway\.env" --known-hosts "\$RUNNER_TEMP\/known_hosts"/);
// The VM's id and host key line: the environment's variables, under the names the smoke test set.
assert.match(ec2Job, /^ {4}env:\n {6}EC2_INSTANCE_ID: \$\{\{ vars\.EC2_INSTANCE_ID \}\}\n {6}EC2_HOST_KEY: \$\{\{ vars\.EC2_HOST_KEY \}\}\n/m);
assert.ok(step('Instance and host key of the VM') > 0 && step('Instance and host key of the VM') < step('configure-aws-credentials'),
  'a wrong instance id or host key fails before AWS is touched');
const hostKeyCheck = stepRun(ec2Job, 'Instance and host key of the VM');
assert.match(ec2Job, /if: always\(\)\n\s+run: rm -f "\$RUNNER_TEMP\/gateway\.env"/, 'the environment file is removed');
assert.ok(/https:\/\/\$1\/health/.test(commitCheck) && /hosts="zero-x\.live"/.test(commitCheck), 'zero-x.live (and the test host) must report this commit');

// ── ci-role.yaml: the template stack zerox-ci runs (applied 2026-10-30). Its logical ids, names and
// parameters stay those of the live stack: an update that renamed GitHubOidcProvider would delete
// and recreate the account's only OIDC provider for GitHub, and with it every role's trust. Trust:
// only production of this repository. Permissions: the tunnel, the one-time key, two lookups. ──
const ciRole = read('deploy/aws/ci-role.yaml');
const ciCode = ciRole.replace(/^\s*#.*$/gm, '');
const ciSection = name => ciCode.split(new RegExp(`^${name}:\n`, 'm'))[1]?.split(/^[A-Z][A-Za-z]*:/m)[0] || '';
const ciBlocks = text => Object.fromEntries(text.split(/^(?= {2}[A-Za-z][A-Za-z0-9]*:\n)/m).filter(block => block.trim())
  .map(block => [/^ {2}([A-Za-z][A-Za-z0-9]*):\n/.exec(block)[1], block]));
const ciResources = ciBlocks(ciSection('Resources'));
const ciParameters = ciBlocks(ciSection('Parameters'));
assert.deepEqual(Object.keys(ciResources), ['GitHubOidcProvider', 'GatewaySshPolicy', 'DeployRole'], 'the live stack\'s logical ids');
assert.deepEqual(Object.keys(ciParameters), ['InstanceId', 'InstancePrivateIp', 'EndpointId', 'Repository', 'Environment'], 'the live stack\'s parameters');
assert.match(ciParameters.Repository, /^ {4}Default: RAHUL-DevelopeRR\/zero-x\.live$/m);
assert.match(ciParameters.Environment, /^ {4}Default: production$/m);
assert.ok(!/^Conditions:/m.test(ciCode) && !/^ {4}Condition:/m.test(ciCode), 'every resource always exists: none of them is conditional');
assert.match(ciResources.GitHubOidcProvider, /Type: AWS::IAM::OIDCProvider\n\s+Properties:\n\s+Url: https:\/\/token\.actions\.githubusercontent\.com\n\s+ClientIdList: \[sts\.amazonaws\.com\]\n/);
assert.ok(!/ThumbprintList/.test(ciCode), 'IAM verifies the GitHub certificate chain itself; no pinned thumbprint');
assert.match(ciResources.GatewaySshPolicy, /Type: AWS::IAM::ManagedPolicy\n\s+Properties:\n\s+ManagedPolicyName: zerox-github-deploy-gateway-ssh\n/);
assert.match(ciResources.DeployRole, /Type: AWS::IAM::Role\n\s+Properties:\n\s+RoleName: zerox-github-deploy\n/);
assert.match(ciResources.DeployRole, /MaxSessionDuration: 3600\n/);
assert.match(ciResources.DeployRole, /Principal:\n\s+Federated: !Ref GitHubOidcProvider\n\s+Action: sts:AssumeRoleWithWebIdentity\n\s+Condition:\n\s+StringEquals:\n\s+token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com\n\s+token\.actions\.githubusercontent\.com:sub: !Sub repo:\$\{Repository\}:environment:\$\{Environment\}\n/,
  'exact audience and subject: only jobs in the production environment of this repository');
assert.match(ciResources.DeployRole, /ManagedPolicyArns:\n\s+- !Ref GatewaySshPolicy\n(?!\s+- )/, 'its own customer-managed policy only, no AWS managed one');
const actions = [...ciCode.matchAll(/^\s*Action:(?: (\S+)\n|\n((?:\s+- \S+\n)+))/gm)]
  .flatMap(([, one, many]) => one ? [one] : many.trim().split('\n').map(line => line.trim().replace(/^- /, '')));
assert.deepEqual(actions.sort(), ['ec2-instance-connect:OpenTunnel', 'ec2-instance-connect:SendSSHPublicKey', 'ec2:DescribeInstanceConnectEndpoints',
  'ec2:DescribeInstances', 'sts:AssumeRoleWithWebIdentity'].sort(), 'nothing but the trust, the tunnel, the one-time key and the two lookups');
assert.ok(!/NotAction|NotResource|NotPrincipal|Effect: Deny|Action: .*\*/.test(ciCode), 'no negation, no wildcard action');
const statements = ciResources.GatewaySshPolicy.split(/^\s*- Sid: /m).slice(1);
const statement = sid => statements.find(text => text.startsWith(`${sid}\n`)) || '';
assert.deepEqual(statements.map(text => text.split('\n')[0]), ['TunnelToTheVmSshOnly', 'OneTimeKeyForDeployOnly', 'LookUpTheVmAndEndpoint']);
assert.match(statement('TunnelToTheVmSshOnly'), /Action: ec2-instance-connect:OpenTunnel\n\s+Resource: !Sub arn:\$\{AWS::Partition\}:ec2:\$\{AWS::Region\}:\$\{AWS::AccountId\}:instance-connect-endpoint\/\$\{EndpointId\}\n\s+Condition:\n\s+NumericEquals:\n\s+ec2-instance-connect:remotePort: 22\n\s+IpAddress:\n\s+ec2-instance-connect:privateIpAddress: !Sub \$\{InstancePrivateIp\}\/32\n/,
  'a tunnel to port 22 of the VM\'s address only');
assert.match(statement('OneTimeKeyForDeployOnly'), /Action: ec2-instance-connect:SendSSHPublicKey\n\s+Resource: !Sub arn:\$\{AWS::Partition\}:ec2:\$\{AWS::Region\}:\$\{AWS::AccountId\}:instance\/\$\{InstanceId\}\n\s+Condition:\n\s+StringEquals:\n\s+ec2:osuser: deploy\n/);
assert.match(statement('LookUpTheVmAndEndpoint'), /Action:\n\s+- ec2:DescribeInstances\n\s+- ec2:DescribeInstanceConnectEndpoints\n\s+Resource: '\*'/);
assert.equal([...ciCode.matchAll(/Resource: '\*'/g)].length, 1, 'a wildcard resource only for the Describe actions');
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
// Each instance runs the release its own link names (/opt/zerox/instance-N), which
// activate-release.sh changes only while that instance is stopped; /opt/zerox/current, which the
// cron follows, flips only once a release passed its checks.
assert.equal(settings.ASSETS_DIR, '/opt/zerox/instance-%i', 'the VM serves the website from the instance\'s release');
assert.equal(settings.TRUST_CLOUDFLARE, 'true');
assert.ok(!/NEURON_API_ONLY/.test(code_(unit)), 'the VM serves the website: no API-only switch');
const app = '/opt/zerox/instance-%i/neuroncli/auth-server';
assert.match(unit, new RegExp(`^WorkingDirectory=${app}$`, 'm'));
assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node ${app}/server\\.js$`, 'm'));
assert.match(unit, new RegExp(`^ConditionPathExists=${app}/server\\.js$`, 'm'), 'nothing to start at boot before the first release');
assert.ok(!/\/opt\/zerox\/current/.test(code_(unit)), 'no instance follows /opt/zerox/current');
const cronApp = '/opt/zerox/current/neuroncli/auth-server';
assert.match(cron, new RegExp(`^WorkingDirectory=${cronApp}$`, 'm'));
assert.match(cron, new RegExp(`^ExecStart=/usr/bin/node ${cronApp}/scripts/cron\\.mjs$`, 'm'));
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
  .flatMap(verb => ['0', '1'].map(n => `/usr/bin/systemctl ${verb} zerox-gateway@${n}.service`))
  .concat(['install', 'next', 'restore'].map(action => `/usr/local/sbin/zerox-install-env ${action}`));
assert.deepEqual([...allowed].sort(), [...expectedCommands].sort(),
  'start, stop, restart, is-active and status of the two instances, and the environment installer with its three fixed arguments');
assert.equal(sudoLines[1], 'deploy ALL=(root) NOPASSWD: ZEROX_GATEWAY', 'as root, for deploy only');
const sudoAllowed = line => allowed.includes(line.replace(/^sudo systemctl /, '/usr/bin/systemctl ').replace(/^sudo /, '').trim());

// ── host-setup.sh: never the cron timer, sudoers checked before it is installed ──
assert.ok(!/(enable|start|restart|reenable)\b[^\n]*zerox-cron\.timer/.test(code_(setup)), 'host-setup.sh never enables or starts the cron timer');
assert.match(setup, /visudo -cqf /, 'the sudoers file is checked before it is installed');
assert.ok(!/cloudflared[^\n]*--token(?!-file)/.test(code_(setup)), 'no tunnel token on a command line');
// /etc/zerox is root's: deploy writes nothing there itself; the environment reaches root's
// installer on stdin. activate-release.sh never names a path under /etc/zerox.
assert.ok(!/\/etc\/zerox|ZEROX_ETC|\$etc\b/.test(code_(activate)), 'activate-release.sh never touches /etc/zerox');
assert.match(activate, /installed sudo "\$installer" install < "\$env_file"/);
assert.match(activate, /^installer=\/usr\/local\/sbin\/zerox-install-env$/m);

// ── Upgrades: needrestart leaves the gateway alone (a restart closes the only listener for the
// whole drain); apt starts the refresh, which root runs from a root-owned path (never a file
// deploy can write) and which hands the swap to deploy ──
const refreshUnit = read('deploy/aws/zerox-gateway-refresh.service');
assert.match(refreshUnit, /^Type=oneshot$/m);
assert.match(refreshUnit, /^ExecStart=\/usr\/local\/sbin\/zerox-gateway-refresh$/m);
assert.ok(!/\/opt\/zerox|^User=/m.test(code_(refreshUnit)) && !/^\[Install\]/m.test(refreshUnit), 'root runs only its own copy; apt starts it, nothing enables it');
assert.match(read('deploy/aws/zerox-apt-refresh.conf'), /^DPkg::Post-Invoke \{ "systemctl start --no-block zerox-gateway-refresh\.service[^"]*\|\| true"; \};$/m,
  'apt never waits for the swap, and never fails because of it');
assert.match(read('deploy/aws/zerox-gateway-refresh.sh'), /^exec runuser -u deploy -- bash "\$dir\/deploy\/aws\/activate-release\.sh" "\$release"$/m);
// Root opens no file under /opt/zerox (deploy's): the release id is the link's target name.
assert.ok(!/REVISION|\bcat\b|<\s*"\$/.test(code_(read('deploy/aws/zerox-gateway-refresh.sh'))), 'the refresh reads no release file as root');
assert.match(read('deploy/aws/zerox-needrestart.conf'), /^\$nrconf\{override_rc\}\{qr\(\^zerox-gateway\\@\\d\+\\\.service\$\)\} = 0;$/m);

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
// Deleting `crons` from wrangler.toml leaves the deployed schedule in place (Cloudflare's wrangler
// configuration docs: "set crons = []"), so step 5 commits an empty list, and checks it took.
const cronStep = cutover.slice(cutover.indexOf('### 5. Cron switch'), cutover.indexOf('### 6.'));
assert.ok(cronStep.includes('crons = []') && /no Cron Triggers?/i.test(cronStep), 'step 5 sets crons = [] and checks the Worker has no schedule left');
assert.match(wrangler, /^\[triggers\]\n(?:#.*\n)*crons = \["\*\/10 \* \* \* \*"\]$/m, 'until then the Worker owns the schedule');
assert.match(wrangler.split('[triggers]')[0].split('\n').slice(-12).join('\n'), /crons = \[\]/, 'wrangler.toml says how to switch it off');
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
const posix = path => path.replace(/\\/g, '/');
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH');

// Job same-commit's script, run with a stub curl that answers each host's /health: it passes only
// when every host reports the commit.
let commitChecked = false;
if (shell) {
  const dir = mkdtempSync(join(tmpdir(), 'zerox-commit-'));
  try {
    commitChecked = true;
    writeFileSync(join(dir, 'curl'), [
      '#!/bin/sh',
      'for a in "$@"; do url="$a"; done',
      'case "$url" in',
      '  https://zero-x.live/health) printf \'{"status":"ok","commit":"%s"}\' "$STUB_WORKER" ;;',
      '  https://aws.zero-x.live/health) printf \'{"status":"ok","commit":"%s"}\' "$STUB_VM" ;;',
      '  *) exit 22 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const sha = 'abc1234def5678abc1234def5678abc1234def56';
    const runCheck = (worker, vm, hosts) => spawnSync(shell.bash, ['-c', commitCheck], { encoding: 'utf8',
      env: { ...process.env, ...shell.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey]}`, GITHUB_SHA: sha,
        EXTRA_WEB_HOSTS: hosts, STUB_WORKER: worker, STUB_VM: vm } });
    const same = runCheck('abc1234', 'abc1234', 'aws.zero-x.live,other.zero-x.live');
    assert.equal(same.status, 0, `both runtimes on the commit: ${same.stdout}${same.stderr}`);
    assert.match(same.stdout, /https:\/\/aws\.zero-x\.live\/health: commit abc1234/, 'the first test host is checked');
    const vmBehind = runCheck('abc1234', '9999999', 'aws.zero-x.live');
    assert.notEqual(vmBehind.status, 0, 'the VM on another commit fails the run');
    assert.match(vmBehind.stdout, /aws\.zero-x\.live\/health reports commit 9999999, not abc1234/);
    assert.notEqual(runCheck('9999999', 'abc1234', 'aws.zero-x.live').status, 0, 'the Worker on another commit fails the run');
    assert.notEqual(runCheck('', '', '').status, 0, 'no commit in /health fails the run');
    assert.equal(runCheck('abc1234', '9999999', '').status, 0, 'production (no test host): zero-x.live only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Job ec2's host key step, run: the environment's "<instance id> ssh-ed25519 ..." line becomes the
// known_hosts line push-release.sh checks (name zerox-gateway); another instance's key, a malformed
// id or key fails the job.
let hostKeyChecked = false;
if (shell) {
  const dir = mkdtempSync(join(tmpdir(), 'zerox-hostkey-'));
  try {
    hostKeyChecked = true;
    const id = 'i-04e44e4412d553639';
    const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    // As the runner runs a step: bash -e -o pipefail.
    const runHostKey = (instance, line) => spawnSync(shell.bash, ['-eo', 'pipefail', '-c', hostKeyCheck], { encoding: 'utf8',
      env: { ...process.env, ...shell.env, RUNNER_TEMP: posix(dir), EC2_INSTANCE_ID: instance, EC2_HOST_KEY: line } });
    const good = runHostKey(id, `${id} ssh-ed25519 ${key}`);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(readFileSync(join(dir, 'known_hosts'), 'utf8'), `zerox-gateway ssh-ed25519 ${key}\n`);
    rmSync(join(dir, 'known_hosts'));
    for (const [instance, line, why] of [
      [id, `i-0aaaaaaaaaaaaaaaa ssh-ed25519 ${key}`, 'another instance\'s key'],
      ['i-04e44e4412d553639; rm -rf /', `${id} ssh-ed25519 ${key}`, 'an instance id with more'],
      ['', ` ssh-ed25519 ${key}`, 'no instance id'],
      [id, `${id} ssh-rsa ${key}`, 'another key type'],
      [id, `${id} ssh-ed25519 not/a/key!`, 'a malformed key'],
      [id, '', 'no host key'],
    ]) {
      const refused = runHostKey(instance, line);
      assert.notEqual(refused.status, 0, why);
      assert.match(refused.stdout, /::error::Environment variable EC2_(INSTANCE_ID|HOST_KEY)/, why);
      assert.ok(!existsSync(join(dir, 'known_hosts')), `${why}: no known_hosts written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const work = mkdtempSync(join(tmpdir(), 'zerox-activate-'));
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
    // root's /usr/local/sbin/zerox-install-env is the kit's zerox-install-env.sh, on ZEROX_ETC.
    stub('sudo', 'echo "sudo $*" >> "$STUB_LOG"\nif [ "$1" = /usr/local/sbin/zerox-install-env ]; then shift; exec bash "$STUB_INSTALL_ENV" "$@"; fi\nexec "$@"');
    stub('sleep', 'exit 0');
    // A started instance remembers the release its link (/opt/zerox/instance-N) pointed at when it
    // started; `show` gives a running instance a main PID (100 + N).
    stub('systemctl', [
      'echo "systemctl $*" >> "$STUB_LOG"',
      'unit="$2"; [ "$1" = show ] && unit="$5"',
      'n="${unit#zerox-gateway@}"; n="${n%.service}"',
      'case "$1" in',
      '  start) readlink "$ZEROX_ROOT/instance-$n" > "$STUB_STATE/$unit" || true ;;',
      '  stop) rm -f "$STUB_STATE/$unit" ;;',
      '  disable) if [ "$2" = --now ]; then rm -f "$STUB_STATE/$3"; fi ;;',
      '  is-active) [ "$2" = --quiet ] && shift; [ -e "$STUB_STATE/$2" ] ;;',
      '  show) if [ -e "$STUB_STATE/$unit" ]; then echo $((100 + n)); else echo 0; fi ;;',
      'esac',
    ].join('\n'));
    // Port 879N is instance N: /ready answers 503 while its release carries a not-ready marker,
    // /health reports the release's REVISION (or the commit in its health-commit file). Each
    // readiness poll logs where /opt/zerox/current points; with STUB_RESTART, systemd restarts
    // every running instance first (Restart=always after a crash), on its link.
    stub('curl', [
      'echo "curl $*" >> "$STUB_LOG"',
      'for a in "$@"; do url="$a"; done',
      'port="$(echo "$url" | sed -n "s#^http://127\\.0\\.0\\.1:\\([0-9]*\\)/.*#\\1#p")"',
      'case "$url" in */ready) cur="$(readlink "$ZEROX_ROOT/current" 2>/dev/null || true)"; echo "ready-check current=${cur##*/}" >> "$STUB_LOG" ;; esac',
      'if [ -n "$STUB_RESTART" ]; then',
      '  for f in "$STUB_STATE"/zerox-gateway@*.service; do',
      '    [ -e "$f" ] || continue; u="${f##*/}"; u="${u#zerox-gateway@}"',
      '    readlink "$ZEROX_ROOT/instance-${u%.service}" > "$f"',
      '  done',
      'fi',
      'rel="$(cat "$STUB_STATE/zerox-gateway@${port#879}.service" 2>/dev/null)" || { printf 000; exit 7; }',
      'case "$url" in',
      '  */ready) if [ -e "$rel/not-ready" ]; then printf 503; else printf 200; fi ;;',
      '  */health) printf \'{"status":"ok","commit":"%s"}\' "$(cat "$rel/health-commit" 2>/dev/null || cat "$rel/REVISION")" ;;',
      'esac',
    ].join('\n'));
    const installEnv = posix(join(repo, 'deploy/aws/zerox-install-env.sh'));
    const env = { ...process.env, ...shell.env, [pathKey]: `${stubs}${delimiter}${process.env[pathKey]}`,
      ZEROX_ROOT: posix(root), ZEROX_ETC: posix(etc), STUB_LOG: posix(log), STUB_STATE: posix(state), STUB_INSTALL_ENV: installEnv };

    // zerox-install-env.sh, root's installer of the environment file: it takes the new file on
    // stdin (or the operator's gateway.env.next), refuses anything gateway-env.mjs would not write
    // (the same names, the same quoting, printable ASCII), keeps the live file as gateway.env.prev,
    // never follows a link, and never prints a value.
    const installer = (args, input = '') => spawnSync(shell.bash, [installEnv, ...args], { input, encoding: 'utf8', env });
    const etcFile = name => existsSync(join(etc, name)) ? readFileSync(join(etc, name), 'utf8') : null;
    const etcEntries = () => readdirSync(etc).sort();
    const secretValues = { SUPABASE_SECRET_KEY: 'sb_secret_a$b`c"d\\e', EC2_PROXY_SECRET: 'p'.repeat(40), GROQ_API_KEY: 'gsk_x+y/z=' };
    const ciFile = buildEnvFile({ vars, env: secretValues, required: Object.keys(secretValues), optional: ['GLM_API_KEY'],
      vmVars: ['EXTRA_WEB_HOSTS'] }).text;
    const installed = installer(['install'], ciFile);
    assert.equal(installed.status, 0, `CI's file, as gateway-env.mjs writes it, is accepted: ${installed.stderr}`);
    assert.equal(etcFile('gateway.env'), ciFile);
    assert.equal(etcFile('gateway.env.prev'), '', 'no environment before it: an empty previous one');
    assert.ok(!`${installed.stdout}${installed.stderr}`.includes('sb_secret_a'), 'no value printed');
    const secondEnv = 'A="1"\nB=plain/value:8787,x\n\n# comment\n';
    assert.equal(installer(['install'], secondEnv).status, 0);
    assert.deepEqual([etcFile('gateway.env'), etcFile('gateway.env.prev')], [secondEnv, ciFile], 'the live file becomes gateway.env.prev');
    const refusedInstall = (text, why, pattern) => {
      const run = installer(['install'], text);
      assert.equal(run.status, 2, `${why}: ${run.stdout}${run.stderr}`);
      assert.match(run.stderr, pattern, why);
      assert.match(run.stderr, /nothing changed/);
      assert.deepEqual([etcFile('gateway.env'), etcFile('gateway.env.prev')], [secondEnv, ciFile], `${why}: nothing changed`);
      assert.deepEqual(etcEntries(), ['gateway.env', 'gateway.env.prev'], `${why}: no temporary file left`);
      return run;
    };
    for (const [text, why, pattern] of [
      ['', 'an empty file', /empty/],
      ['A="x"\nexport B="y"\n', 'not NAME=value', /line 2 is not NAME="value"/],
      ['lower="x"\n', 'a lower-case name', /line 1/],
      ['A="unterminated\n', 'an open quote', /line 1/],
      ['A="a"b"\n', 'an unescaped quote', /line 1/],
      ['A="a\\"\n', 'a quote escaped away', /line 1/],
      ['A=two words\n', 'a space without quotes', /line 1/],
      ['A=$(id)\n', 'shell syntax without quotes', /line 1/],
      ['A="x"\r\nB="y"\n', 'a CRLF line', /character other than printable ASCII/],
      ['A="x"\nB="nul\0byte"\n', 'a NUL byte', /character other than printable ASCII/],
      ['A="café-value-never-printed"\n', 'non-ASCII', /printable ASCII/],
      [`A="${'x'.repeat(70000)}"\n`, 'over 64 KiB', /larger than 64 KiB/],
    ]) {
      const run = refusedInstall(text, why, pattern);
      assert.ok(!run.stderr.includes('value-never-printed'), 'never the value');
    }
    // The same names as gateway-env.mjs: every refused name and family, never a name it writes.
    const upper = LOADER_NAMES.filter(name => name === name.toUpperCase());
    const names = [...new Set([...REFUSED_NAMES, ...upper, 'E2E_UPSTREAM_BASE', 'TRUST_PROXY', 'NODE_ENV',
      ...Object.keys(vars), ...list(ec2Job, 'REQUIRED_SECRETS'), ...list(ec2Job, 'OPTIONAL_SECRETS'), 'EXTRA_WEB_HOSTS', 'NODEJS_FLAG', 'PROXY_URL'])];
    // One file with every name: the installer lists all it refuses, and those are exactly the
    // names gateway-env.mjs refuses; without them, the file is accepted.
    const everyName = installer(['install'], names.map(name => `${name}="x"`).join('\n') + '\n');
    assert.equal(everyName.status, 2);
    const listedRefused = /not allowed in the gateway's environment \(gateway-env\.mjs\): (.+); nothing changed/.exec(everyName.stderr)?.[1].split(' ');
    assert.deepEqual(listedRefused, names.filter(refusedName), 'zerox-install-env and gateway-env.mjs refuse the same names');
    const allowedNames = names.filter(name => !refusedName(name));
    assert.ok(allowedNames.length > 30 && allowedNames.includes('EC2_PROXY_SECRET_ROTATION'));
    assert.equal(installer(['install'], allowedNames.map(name => `${name}="x"`).join('\n') + '\n').status, 0, 'and accept every other');
    assert.equal(installer(['restore']).status, 0);
    // The operator's gateway.env.next: checked the same way, kept until whoever wrote it removes it.
    writeFileSync(join(etc, 'gateway.env.next'), 'N="operator"\n');
    assert.equal(installer(['next']).status, 0);
    assert.deepEqual([etcFile('gateway.env'), etcFile('gateway.env.next')], ['N="operator"\n', 'N="operator"\n']);
    writeFileSync(join(etc, 'gateway.env.next'), 'NODE_TLS_REJECT_UNAUTHORIZED="0"\n');
    assert.equal(installer(['next']).status, 2, 'the operator\'s file is checked too');
    assert.equal(etcFile('gateway.env'), 'N="operator"\n');
    rmSync(join(etc, 'gateway.env.next'));
    assert.match(installer(['next']).stderr, /there is no .*gateway\.env\.next/);
    // restore: gateway.env.prev back (a failed activation), the previous file kept.
    const prev = etcFile('gateway.env.prev');
    assert.equal(installer(['restore']).status, 0);
    assert.deepEqual([etcFile('gateway.env'), etcFile('gateway.env.prev')], [prev, prev]);
    assert.equal(installer(['anything']).status, 2);
    // A link where the file should be (only deploy could once have made one): refused, never followed.
    const linked = spawnSync(shell.bash, ['-c', 'mv "$1/gateway.env" "$1/real" && ln -s "$1/real" "$1/gateway.env"', '_', posix(etc)], { env });
    assert.equal(linked.status, 0, String(linked.stderr));
    const throughLink = installer(['install'], 'A="1"\n');
    assert.equal(throughLink.status, 2);
    assert.match(throughLink.stderr, /gateway\.env is a link/);
    unlinkSync(join(etc, 'gateway.env'));
    spawnSync(shell.bash, ['-c', 'mv "$1/real" "$1/gateway.env"', '_', posix(etc)], { env });
    rmSync(join(etc, 'gateway.env'));
    rmSync(join(etc, 'gateway.env.prev'));

    const release = (id, { ready = true, commit, modules = true } = {}) => {
      const dir = join(root, 'releases', id);
      mkdirSync(join(dir, 'neuroncli/auth-server', modules ? 'node_modules' : ''), { recursive: true });
      writeFileSync(join(dir, 'neuroncli/auth-server/server.js'), '');
      writeFileSync(join(dir, 'REVISION'), `${id}\n`);
      if (!ready) writeFileSync(join(dir, 'not-ready'), '');
      if (commit) writeFileSync(join(dir, 'health-commit'), commit);
      return id;
    };
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    // Each activation gets a new environment file through --env (as CI's push passes it), unless told otherwise.
    const activateRun = (id, { args, vars = {} } = {}) => {
      rmSync(log, { force: true });
      if (!args) {
        writeFileSync(join(work, `env-${id}`), `N="${id}"\n`);
        args = ['--env', posix(join(work, `env-${id}`))];
      }
      const run = spawnSync(shell.bash, ['-s', '--', id, ...args], { input: activate, encoding: 'utf8', env: { ...env, ...vars } });
      for (const line of calls().filter(line => line.startsWith('sudo '))) assert.ok(sudoAllowed(line), `sudoers allows "${line}"`);
      return run;
    };
    const current = () => basename(posix(readlinkSync(join(root, 'current'))));
    const link = n => basename(posix(readlinkSync(join(root, `instance-${n}`))));
    const running = () => readdirSync(state).sort().map(name => `${name}:${basename(posix(readFileSync(join(state, name), 'utf8').trim()))}`);
    const envFile = name => readFileSync(join(etc, name), 'utf8').trim();
    const position = text => calls().findIndex(line => line.includes(text));
    const currentDuringChecks = () => calls().filter(line => line.startsWith('ready-check ')).map(line => line.slice('ready-check current='.length));

    const first = release('1111111');
    const firstRun = activateRun(first);
    assert.equal(firstRun.status, 0, `the first deploy (one release, nothing to prune) succeeds: ${firstRun.stdout}${firstRun.stderr}`);
    assert.match(firstRun.stdout, /is live/);
    assert.equal(current(), first);
    assert.deepEqual(running(), ['zerox-gateway@0.service:1111111'], 'nothing ran: instance 0 starts on the release');
    assert.deepEqual([link(0), link(1)], [first, first], 'both instances start on the live release (@0 at boot)');
    assert.deepEqual([...new Set(currentDuringChecks())], [''], '/opt/zerox/current appears only once the release passed its checks');
    assert.equal(envFile('gateway.env'), 'N="1111111"');
    assert.ok(calls().some(line => /^curl .*http:\/\/127\.0\.0\.1:8790\/ready$/.test(line)), 'readiness on instance 0\'s own port');

    const second = release('2222222');
    assert.equal(activateRun(second).status, 0);
    assert.deepEqual(running(), ['zerox-gateway@1.service:2222222'], 'the idle instance took the new release, the old one stopped');
    assert.ok(position('systemctl start zerox-gateway@1.service') < position('8791/ready') &&
      position('8791/ready') < position('systemctl stop zerox-gateway@0.service'),
    'the new instance is started and ready before the old one stops (zero downtime)');
    assert.deepEqual([...new Set(currentDuringChecks())], [first], 'cron, boot and operators keep the previous release while the new one is checked');
    assert.deepEqual([current(), link(0), link(1)], [second, second, second], 'then current flips, and the stopped instance\'s link follows');
    const ids = [first, second];
    for (const id of ['3333333', '4444444', '5555555', '6666666']) {
      ids.push(release(id));
      assert.equal(activateRun(id).status, 0, `deploy ${id}`);
    }
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), ids.slice(-4), 'the current release and the three most recent others are kept');
    assert.equal(envFile('gateway.env.prev'), 'N="5555555"');
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666']);

    // Not ready: the new instance stops, its link and the environment go back; the old instance
    // and /opt/zerox/current were never touched.
    const bad = release('7777777', { ready: false });
    const badRun = activateRun(bad);
    assert.equal(badRun.status, 1, 'a release that is not ready fails the deploy');
    assert.match(badRun.stdout, /zerox-gateway@1 never stopped; it serves 6666666/);
    assert.equal(current(), '6666666', 'current never left the previous release');
    assert.equal(link(0), '6666666', 'the idle instance\'s link is put back');
    assert.equal(envFile('gateway.env'), 'N="6666666"', 'and the environment');
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666'], 'the serving instance was never stopped');
    assert.ok(!calls().includes('systemctl stop zerox-gateway@1.service'));

    // The serving instance crashes during the checks of a bad release: systemd restarts it on its
    // own link, which still names the previous release (not the release being checked).
    const crash = release('7777770', { ready: false });
    const crashRun = activateRun(crash, { vars: { STUB_RESTART: '1' } });
    assert.equal(crashRun.status, 1);
    assert.deepEqual(running(), ['zerox-gateway@1.service:6666666'], 'restarted on the previous release');
    assert.match(crashRun.stdout, /it serves 6666666/);

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
    // The three releases that failed their checks never went live: pruned before any rollback target.
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), ['4444444', '5555555', '6666666', '9999999'],
      'releases that never went live are removed first; the three most recently activated stay');

    // Nothing running (after a crash or a reboot) and the new release is not ready: the previous one is started again.
    rmSync(join(state, 'zerox-gateway@1.service'));
    const cold = release('aaaaaaa', { ready: false });
    const coldRun = activateRun(cold);
    assert.equal(coldRun.status, 1);
    assert.match(coldRun.stdout, /previous release is live again/);
    assert.equal(current(), '9999999');
    assert.deepEqual(running(), ['zerox-gateway@1.service:9999999']);
    assert.deepEqual([link(0), link(1)], ['9999999', '9999999']);

    // The environment changes only with --env or --env-next. A gateway.env.next left behind is never
    // picked up; with --env-next root's installer takes it (whoever wrote it removes it once live:
    // push-release.sh). The previous environment comes back the same way (README.md, "Rollback").
    writeFileSync(join(etc, 'gateway.env.next'), 'N="operator"\n');
    assert.equal(activateRun('9999999', { args: [] }).status, 0, 'the same release again, environment unchanged');
    assert.equal(envFile('gateway.env'), 'N="9999999"', 'no --env: the environment stays');
    assert.ok(existsSync(join(etc, 'gateway.env.next')), 'and gateway.env.next is left alone');
    assert.equal(activateRun('9999999', { args: ['--env-next'] }).status, 0);
    assert.ok(calls().includes('sudo /usr/local/sbin/zerox-install-env next'));
    assert.equal(envFile('gateway.env'), 'N="operator"');
    rmSync(join(etc, 'gateway.env.next'));
    writeFileSync(join(etc, 'gateway.env.next'), readFileSync(join(etc, 'gateway.env.prev')));
    assert.equal(activateRun('9999999', { args: ['--env-next'] }).status, 0);
    assert.deepEqual([envFile('gateway.env'), envFile('gateway.env.prev')], ['N="9999999"', 'N="operator"'], 'the previous environment back');
    rmSync(join(etc, 'gateway.env.next'));
    assert.equal(activateRun('9999999', { args: ['--env-next', '--env', posix(join(work, 'env-9999999'))] }).status, 2, 'one source at a time');
    // A file the installer refuses stops the activation before any instance or link changes.
    const beforeRefused = [current(), link(0), link(1), envFile('gateway.env'), running()];
    writeFileSync(join(work, 'env-refused'), 'N="1"\nNODE_OPTIONS="--require /tmp/x.js"\n');
    const refusedEnv = activateRun('9999999', { args: ['--env', posix(join(work, 'env-refused'))] });
    assert.equal(refusedEnv.status, 2, `${refusedEnv.stdout}${refusedEnv.stderr}`);
    assert.match(refusedEnv.stderr, /not allowed in the gateway's environment \(gateway-env\.mjs\): NODE_OPTIONS;/);
    assert.match(refusedEnv.stdout, /the new environment was not installed .*nothing changed/);
    assert.ok(!calls().some(line => line.startsWith('sudo systemctl')), 'no instance started or stopped');
    assert.deepEqual([current(), link(0), link(1), envFile('gateway.env'), running()], beforeRefused, 'nothing changed');

    // The smoke test's single unit still in place (CI deploying before push-release.sh --setup):
    // refused before anything changes, whether the unit runs or only its /opt/zerox/gateway link is left.
    const untouched = () => [current(), link(0), link(1), envFile('gateway.env'), running()];
    const settled = untouched();
    writeFileSync(join(state, 'zerox-gateway.service'), '');
    const legacyRun = activateRun('9999999');
    assert.equal(legacyRun.status, 2, 'the single-instance unit running: refused');
    assert.match(legacyRun.stdout, /push-release\.sh --setup/);
    assert.ok(!calls().some(line => line.startsWith('sudo ')), 'no instance started or stopped');
    rmSync(join(state, 'zerox-gateway.service'));
    assert.deepEqual(untouched(), settled, 'nothing changed: links, environment, instances');
    const legacyLink = spawnSync(shell.bash, ['-c', 'ln -s "$1" "$2"', '_', posix(join(root, 'releases/9999999/neuroncli/auth-server')),
      posix(join(root, 'gateway'))], { env: { ...process.env, ...shell.env } });
    assert.equal(legacyLink.status, 0, String(legacyLink.stderr));
    assert.equal(activateRun('9999999').status, 2, 'only its /opt/zerox/gateway link left: refused too');
    assert.deepEqual(untouched(), settled);
    unlinkSync(join(root, 'gateway')); // the link only: rmSync refuses a directory link on Windows

    assert.equal(activateRun('not-a-sha').status, 2, 'a release id is a 7-character commit');
    const partial = release('bbbbbbb', { modules: false });
    assert.equal(activateRun(partial).status, 2, 'a release without its dependencies is refused');
    assert.equal(activateRun('9999999', { args: ['--env', posix(join(work, 'none'))] }).status, 2, 'a missing environment file is refused');
    assert.equal(activateRun('9999999', { args: ['--force'] }).status, 2, 'an unknown argument is refused');
    assert.equal(current(), '9999999');

    // zerox-gateway-refresh, which apt starts after every dpkg run: the current release is
    // activated again (as deploy) only when a running instance maps a system file an upgrade
    // replaced, so the idle instance takes the new node or library before the old one drains.
    const proc = join(work, 'proc');
    stub('runuser', 'echo "runuser $*" >> "$STUB_LOG"\n[ "$1 $2 $3" = "-u deploy --" ] || exit 9\nshift 3\nexec "$@"');
    mkdirSync(join(root, 'releases/9999999/deploy/aws'), { recursive: true });
    writeFileSync(join(root, 'releases/9999999/deploy/aws/activate-release.sh'), activate);
    const maps = lines => {
      for (const pid of [100, 101]) {
        mkdirSync(join(proc, String(pid)), { recursive: true });
        writeFileSync(join(proc, String(pid), 'maps'), `${lines.join('\n')}\n`);
      }
    };
    const refresh = () => {
      rmSync(log, { force: true });
      return spawnSync(shell.bash, [posix(join(repo, 'deploy/aws/zerox-gateway-refresh.sh'))], { encoding: 'utf8', env: { ...env, ZEROX_PROC: posix(proc) } });
    };
    const serving = running();
    maps(['aaaa0000-aaaa1000 r-xp 00000000 103:01 4242 /usr/bin/node', 'bbbb0000-bbbb1000 rw-s 00000000 00:01 77 /memfd:v8 (deleted)']);
    const quiet = refresh();
    assert.equal(quiet.status, 0, `${quiet.stdout}${quiet.stderr}`);
    assert.match(quiet.stdout, /no replaced file/);
    assert.ok(!calls().some(line => /^runuser /.test(line)) && running().join() === serving.join(), 'nothing replaced: nothing restarts');
    maps(['aaaa0000-aaaa1000 r-xp 00000000 103:01 4242 /usr/bin/node (deleted)']);
    const swapped = refresh();
    assert.equal(swapped.status, 0, `${swapped.stdout}${swapped.stderr}`);
    assert.ok(calls().some(line => /^runuser -u deploy -- bash \S+\/releases\/9999999\/deploy\/aws\/activate-release\.sh 9999999$/.test(line)),
      'the current release, activated again as deploy');
    assert.notDeepEqual(running(), serving, 'the other instance took over');
    assert.equal(running().length, 1);
    assert.equal(envFile('gateway.env'), 'N="9999999"', 'with the environment as it was');

    // Root reads nothing deploy controls. REVISION could be a link to the tunnel token or a host
    // key: its contents must never reach the refresh's output (the journal) or the arguments of
    // the deploy-side script. The id comes from the link's target, which must be a release.
    const MARKER = 'MARKER-tunnel-token-0f1e2d';
    const revisionFile = join(root, 'releases/9999999/REVISION');
    writeFileSync(revisionFile, `${MARKER}\n`);
    const leaked = refresh();
    const leakedCalls = calls();
    writeFileSync(revisionFile, '9999999\n');
    assert.ok(!`${leaked.stdout}${leaked.stderr}`.includes(MARKER), `REVISION's contents never printed: ${leaked.stdout}${leaked.stderr}`);
    assert.ok(!leakedCalls.some(line => line.includes(MARKER)), 'nor passed to the deploy-side script');
    assert.ok(leakedCalls.some(line => /^runuser -u deploy -- bash \S+\/releases\/9999999\/deploy\/aws\/activate-release\.sh 9999999$/.test(line)),
      'the id is the link target\'s name');
    assert.notEqual(leaked.status, 0, 'deploy\'s activate-release.sh then refuses the release (its REVISION does not match)');
    assert.match(leaked.stdout, /release 9999999 is incomplete/);
    // current pointing anywhere but a release directory: nothing runs.
    for (const target of [join(work, 'elsewhere', 'abcdef0'), join(root, 'releases/9999999/deploy')]) {
      mkdirSync(target, { recursive: true });
      const moved = spawnSync(shell.bash, ['-c', 'ln -sfn "$1" "$2"', '_', posix(target), posix(join(root, 'current'))], { env });
      assert.equal(moved.status, 0, String(moved.stderr));
      const outside = refresh();
      assert.equal(outside.status, 1, `${outside.stdout}${outside.stderr}`);
      assert.match(outside.stdout, /does not name a release/);
      assert.ok(!calls().some(line => /^runuser /.test(line)), 'nothing ran as deploy');
    }
    assert.equal(spawnSync(shell.bash, ['-c', 'ln -sfn "$1" "$2"', '_', posix(join(root, 'releases/9999999')), posix(join(root, 'current'))], { env }).status, 0);

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
      // and the smoke test's release link that unit runs, and its environment file (deploy's then).
      mkdirSync(sysPath('opt/zerox/releases/66f29a1/neuroncli/auth-server'), { recursive: true });
      writeFileSync(sysPath('opt/zerox/releases/66f29a1/neuroncli/auth-server/server.js'), '');
      writeFileSync(sysPath('etc/zerox/gateway.env'), 'SUPABASE_URL="https://smoke.invalid"\n');
      const legacyLink = spawnSync(shell.bash, ['-c', 'ln -s "$1" "$2"', '_', posix(sysPath('opt/zerox/releases/66f29a1/neuroncli/auth-server')),
        posix(sysPath('opt/zerox/gateway'))], { env: { ...process.env, ...shell.env } });
      assert.equal(legacyLink.status, 0, String(legacyLink.stderr));
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
      ['zerox-sysctl.conf', 'etc/sysctl.d/60-zerox.conf'], ['zerox-needrestart.conf', 'etc/needrestart/conf.d/60-zerox-gateway.conf'],
      ['zerox-apt-refresh.conf', 'etc/apt/apt.conf.d/80zerox-gateway-refresh'],
      ['zerox-gateway-refresh.service', 'etc/systemd/system/zerox-gateway-refresh.service'],
      ['zerox-gateway-refresh.sh', 'usr/local/sbin/zerox-gateway-refresh'], ['zerox-install-env.sh', 'usr/local/sbin/zerox-install-env']]) {
      assert.equal(readFileSync(sysPath(target), 'utf8'), read(`deploy/aws/${kit}`), `${target} installed`);
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(sysPath('etc/sudoers.d/zerox-deploy')).mode & 0o777, 0o440);
      assert.equal(statSync(sysPath('usr/local/sbin/zerox-gateway-refresh')).mode & 0o777, 0o755);
      assert.equal(statSync(sysPath('usr/local/sbin/zerox-install-env')).mode & 0o777, 0o755);
      assert.equal(statSync(sysPath('etc/zerox')).mode & 0o777, 0o700);
      assert.equal(statSync(sysPath('etc/zerox/gateway.env')).mode & 0o777, 0o600);
    }
    {
      const ownership = calls().filter(line => line.startsWith('chown '));
      const envdir = posix(sysPath('etc/zerox'));
      assert.ok(ownership.includes(`chown root:root ${envdir}`) && ownership.includes(`chown -hR root:root ${envdir}`),
        `/etc/zerox and the smoke test's environment file become root's: ${ownership.join('; ')}`);
      assert.ok(ownership.indexOf(`chown root:root ${envdir}`) < ownership.indexOf(`chown -hR root:root ${envdir}`), 'the directory first');
      assert.ok(ownership.some(line => /^chown -h deploy:zerox (?:.* )?\.\/66f29a1(?: |$)/.test(line)),
        `the smoke test's release becomes deploy's, so pruning it later works: ${ownership.join('; ')}`);
      assert.equal(readFileSync(sysPath('etc/zerox/gateway.env'), 'utf8'), 'SUPABASE_URL="https://smoke.invalid"\n', 'its content stays');
    }
    const cloudInitAfter = readFileSync(sysPath('etc/sudoers.d/90-cloud-init-users'), 'utf8');
    assert.ok(!/^deploy\s/m.test(cloudInitAfter) && /^ubuntu ALL=\(ALL\) NOPASSWD:ALL$/m.test(cloudInitAfter),
      'cloud-init\'s rule for deploy is gone, ubuntu\'s stays');
    assert.ok(!existsSync(sysPath('etc/systemd/system/zerox-gateway.service')), 'the single-instance unit is removed');
    let setupCalls = calls();
    assert.ok(setupCalls.includes('systemctl disable --now zerox-gateway.service'), 'and stopped (it drains first)');
    assert.ok(!readdirSync(sysPath('opt/zerox')).includes('gateway') && existsSync(sysPath('opt/zerox/releases/66f29a1/neuroncli/auth-server')),
      'its /opt/zerox/gateway link is removed, the release it named stays');
    assert.ok(setupCalls.some(line => /^visudo -cqf .*zerox-deploy\.sudoers$/.test(line)), 'the kit\'s sudoers checked before installing');
    assert.ok(setupCalls.some(line => /^visudo -cqf .*90-cloud-init-users\.zerox$/.test(line)), 'the edited cloud-init rules checked before replacing them');
    assert.ok(setupCalls.includes('visudo -cq'), 'the whole sudo configuration checked after');
    assert.ok(setupCalls.includes('systemctl daemon-reload'));
    assert.ok(setupCalls.includes('systemctl enable zerox-gateway@0.service'), 'instance 0 starts at boot');
    assert.ok(setupCalls.some(line => /^systemd-analyze verify .*zerox-gateway@0\.service.*zerox-gateway-refresh\.service/.test(line)));
    assert.ok(!setupCalls.some(line => /zerox-gateway-refresh/.test(line) && /\b(enable|start)\b/.test(line)), 'the refresh runs only when apt starts it');
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

    // The single unit running from a file installed elsewhere (not /etc/systemd/system): stopped
    // and disabled all the same, or every activation after this setup would refuse.
    freshSystem();
    rmSync(sysPath('etc/systemd/system/zerox-gateway.service'));
    writeFileSync(join(state, 'zerox-gateway.service'), '');
    const elsewhere = setupRun();
    assert.equal(elsewhere.status, 0, `host setup with the single unit installed elsewhere: ${elsewhere.stdout}${elsewhere.stderr}`);
    assert.ok(calls().includes('systemctl disable --now zerox-gateway.service'), 'a running single unit is stopped and disabled wherever its file is');
    assert.ok(!existsSync(join(state, 'zerox-gateway.service')));

    // A sudoers file visudo refuses is never installed, and cloud-init's rules stay as they were.
    freshSystem();
    const refused = setupRun({ STUB_VISUDO_FAIL: '1' });
    assert.equal(refused.status, 1);
    assert.ok(!existsSync(sysPath('etc/sudoers.d/zerox-deploy')));
    assert.equal(readFileSync(sysPath('etc/sudoers.d/90-cloud-init-users'), 'utf8'), cloudInitSudo);

    // Any other sudo rule for deploy fails the setup: zerox-deploy must be all deploy may run as root.
    freshSystem();
    writeFileSync(sysPath('etc/sudoers.d/99-extra'), '# added by hand\ndeploy ALL=(ALL) ALL\n');
    const extraRule = setupRun();
    assert.equal(extraRule.status, 1, 'another sudo rule names deploy');
    assert.match(extraRule.stderr, /other sudo rules name deploy: \S*99-extra/);

    // A link in /etc/zerox (deploy owned it until now: gateway.env pointing at the tunnel token, for
    // systemd to read as root) fails the setup before anything is installed; it is never followed.
    freshSystem();
    writeFileSync(sysPath('etc/cloudflared/token'), 'eyJ0b2tlbi1uZXZlci1yZWFkIn0');
    rmSync(sysPath('etc/zerox/gateway.env'));
    const planted = spawnSync(shell.bash, ['-c', 'ln -s "$1" "$2"', '_', posix(sysPath('etc/cloudflared/token')), posix(sysPath('etc/zerox/gateway.env'))],
      { env: { ...process.env, ...shell.env } });
    assert.equal(planted.status, 0, String(planted.stderr));
    const linkedEnv = setupRun();
    assert.equal(linkedEnv.status, 1, `${linkedEnv.stdout}${linkedEnv.stderr}`);
    assert.match(linkedEnv.stderr, /links in \/etc\/zerox, which only deploy could have made: \S*gateway\.env/);
    assert.ok(!`${linkedEnv.stdout}${linkedEnv.stderr}`.includes('eyJ0b2tlbi1uZXZlci1yZWFkIn0'), 'never read');
    assert.ok(!existsSync(sysPath('etc/sudoers.d/zerox-deploy')) && !calls().some(line => /^chown -hR/.test(line)), 'stopped before anything else');
    unlinkSync(sysPath('etc/zerox/gateway.env'));

    // The smoke-test VM: a tunnel running from a unit of its own (`cloudflared service install`
    // puts the token on its command line) and no token file yet. That unit stays until the file
    // exists: replaced earlier, the next restart or reboot would start the tunnel without a token.
    freshSystem();
    const legacyTunnel = '[Service]\nExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token eyJsZWdhY3kifQ\n';
    writeFileSync(sysPath('etc/systemd/system/cloudflared.service'), legacyTunnel);
    const keptTunnel = setupRun();
    assert.equal(keptTunnel.status, 0, `host setup with the smoke test's tunnel: ${keptTunnel.stdout}${keptTunnel.stderr}`);
    assert.equal(readFileSync(sysPath('etc/systemd/system/cloudflared.service'), 'utf8'), legacyTunnel, 'the running tunnel\'s unit is kept');
    assert.match(keptTunnel.stdout, /keeping the cloudflared\.service that runs now/);
    assert.ok(!calls().some(line => /cloudflared/.test(line) && /\b(enable|start|stop|restart|disable)\b/.test(line)), 'and left alone');
    assert.ok(!`${keptTunnel.stdout}${keptTunnel.stderr}`.includes('eyJsZWdhY3kifQ'), 'its token is never printed');
    assert.equal(readFileSync(sysPath('etc/systemd/system/zerox-gateway@.service'), 'utf8'), read('deploy/aws/zerox-gateway@.service'),
      'everything else is installed');
    writeFileSync(sysPath('etc/cloudflared/token'), 'eyJ0ZXN0IjoidG9rZW4ifQ');
    const tokenFile = setupRun();
    assert.equal(tokenFile.status, 0, `host setup once the token file exists: ${tokenFile.stdout}${tokenFile.stderr}`);
    assert.equal(readFileSync(sysPath('etc/systemd/system/cloudflared.service'), 'utf8'), read('deploy/aws/cloudflared.service'),
      'then the kit\'s unit, which reads the token file');

    // needrestart, reading conf.d as it does (Perl), never restarts a gateway instance and still restarts the rest.
    const perl = spawnSync(shell.bash, ['-c', 'command -v perl >/dev/null || exit 3; perl -e "$1" "$2" zerox-gateway@0.service zerox-gateway@1.service zerox-cron.service cloudflared.service',
      '_', 'our %nrconf; my $file = shift; defined(do $file) or die "$file: $@$!"; for my $unit (@ARGV) { my @hit = grep { $unit =~ /$_/ } keys %{$nrconf{override_rc}}; print "$unit=", (@hit ? $nrconf{override_rc}{$hit[0]} : "restart"), "\\n" }',
      posix(join(repo, 'deploy/aws/zerox-needrestart.conf'))], { encoding: 'utf8' });
    if (perl.status !== 3) {
      assert.equal(perl.status, 0, perl.stderr);
      assert.deepEqual(perl.stdout.trim().split('\n'), ['zerox-gateway@0.service=0', 'zerox-gateway@1.service=0', 'zerox-cron.service=restart', 'cloudflared.service=restart']);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ── package-release.sh, install-release.sh and push-release.sh, run: a fixture repository with
// the real .assetsignore and this deploy kit, stub aws, ssh (which runs the remote command
// locally), npm, sudo, systemctl and curl. ──
// .assetsignore read with gitignore rules, as wrangler applies them (the `ignore` package, which
// ignores case by default), independently of git: a pattern matches a path or one of its
// directories, case-insensitively; one with a slash before its end is anchored.
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
    return { re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}$`, 'i'), dirOnly };
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
  !ignored('videos/clip.mp4') && ignored('Assets/demo.mp4') && ignored('Assets/Demo.MP4') && ignored('Assets/whatsapp-chat.png'),
'the reading of .assetsignore');
// git applies the patterns with core.ignoreCase, which `git init` sets true on Windows and macOS and
// false on Linux: the scan sets it, so the laptop and CI ship the same files the Worker uploads.
assert.match(read('deploy/aws/package-release.sh'), /git -c core\.ignoreCase=true -c core\.quotePath=false --git-dir=\S+ --work-tree=\S+ ls-files --others/);
const GATEWAY_RUNTIME = ['neuroncli/auth-server/server.js', 'neuroncli/auth-server/package.json', 'neuroncli/auth-server/package-lock.json',
  'neuroncli/auth-server/src/index.js', 'neuroncli/auth-server/scripts/cron.mjs'];
const KIT = ['install-release.sh', 'activate-release.sh', 'host-setup.sh', 'zerox-gateway@.service', 'zerox-cron.service',
  'zerox-cron.timer', 'cloudflared.service', 'zerox-deploy.sudoers', 'zerox-sysctl.conf', 'zerox-needrestart.conf', 'zerox-apt-refresh.conf',
  'zerox-gateway-refresh.service', 'zerox-gateway-refresh.sh', 'zerox-install-env.sh'].map(name => `deploy/aws/${name}`);
const NOT_SHIPPED = /^neuroncli\/auth-server\/(check-|test\.js$|e2e-|fixtures\/|migrations\/|docs\/|wrangler[^/]*\.toml$|Dockerfile$|\.)|(^|\/)(output|tmp)\/|\.md$|(^|\/)\.(env|dev\.vars)/;
let packaged = false;
const fixture = mkdtempSync(join(tmpdir(), 'zerox-package-'));
try {
  if (ran) {
    packaged = true;
    const bash = (args, options = {}) => spawnSync(shell.bash, args, { encoding: 'utf8', ...options, env: { ...process.env, ...shell.env, ...options.env } });
    const tarList = file => bash(['-c', 'tar -tzf - < "$1"', '_', posix(file)]).stdout.trim().split('\n').sort();
    const fxRepo = join(fixture, 'repo');
    const canonical = '<link rel="canonical" href="https://zero-x.live/">';
    const files = {
      '.assetsignore': read('.assetsignore'), '.gitignore': 'node_modules/\n', 'index.html': `<!doctype html>${canonical}`, '404.html': '',
      'Assets/logo.png': 'png', 'Assets/RahulCIT.png': 'private', 'Assets/Pasted text.txt': 'notes', 'videos/clip.mp4': 'mp4',
      'Assets/Demo.MP4': 'mp4', 'Assets/whatsapp-chat.png': 'private', // excluded only when case is ignored, as wrangler does
      'releases/neuron/latest.json': '{}', 'neuroncli/callback/index.html': '', 'SEO_AUDIT.md': '# notes',
      // The sitemap as committed (its dates lag) and the builder job deploy runs.
      'seo-pages.json': JSON.stringify([{ url: 'https://zero-x.live/', file: 'index.html' }]),
      'sitemap.xml': '<urlset><url><loc>https://zero-x.live/</loc><lastmod>2001-01-01</lastmod></url></urlset>\n',
      'neuroncli/auth-server/build-sitemap.mjs': read('neuroncli/auth-server/build-sitemap.mjs'),
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
    // The sitemap is built for the commit, as job deploy builds the Worker's: lastmod from the history.
    const dated = git('log', '-1', '--format=%cs', head, '--', 'index.html').stdout.trim();
    const sitemap = bash(['-c', 'tar -xzOf - sitemap.xml < "$1"', '_', posix(out)]).stdout;
    assert.match(dated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(sitemap.includes(`<loc>https://zero-x.live/</loc>\n    <lastmod>${dated}</lastmod>`) && !sitemap.includes('2001-01-01'),
      `the release's sitemap.xml is built, not the committed copy: ${sitemap}`);
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
    // sudo as on the VM: root's zerox-install-env is the kit's script (on ZEROX_ETC), and host-setup.sh
    // (--setup) only says that it ran.
    stub('sudo', ['echo "sudo $*" >> "$STUB_LOG"', 'if [ "$1" = -u ]; then shift 2; fi',
      'if [ "$1" = /usr/local/sbin/zerox-install-env ]; then shift; exec bash "$STUB_INSTALL_ENV" "$@"; fi',
      'if [ "$1" = bash ] && [ "${2##*/}" = host-setup.sh ]; then echo "host-setup ran" >> "$STUB_LOG"; exit 0; fi', 'exec "$@"'].join('\n'));
    stub('sleep', 'exit 0');
    stub('npm', 'echo "npm $*" >> "$STUB_LOG"\n[ -z "$STUB_NPM_FAIL" ] || exit 1\nmkdir -p node_modules');
    stub('systemctl', [
      'echo "systemctl $*" >> "$STUB_LOG"',
      'n="${2#zerox-gateway@}"; n="${n%.service}"',
      'case "$1" in',
      '  start) readlink "$ZEROX_ROOT/instance-$n" > "$STUB_STATE/$2" || true ;;',
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
      STUB_LOG: posix(log), STUB_STATE: posix(state), STUB_DIR: posix(fixture), AWS_PROFILE: '',
      STUB_INSTALL_ENV: posix(join(fxRepo, 'deploy/aws/zerox-install-env.sh')) };
    const push = (...args) => {
      rmSync(log, { force: true });
      const vars = typeof args[0] === 'object' ? args.shift() : {};
      return bash([posix(join(fxRepo, 'deploy/aws/push-release.sh')), ...args], { cwd: fxRepo, env: { ...pushEnv, ...vars }, input: '' });
    };
    const pushCalls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    const etcFiles = () => readdirSync(etc).sort();
    const ci = push('--os-user', 'deploy', '--lookup', 'tags', '--env-file', posix(envSecret), '--known-hosts', posix(knownHosts));
    assert.equal(ci.status, 0, `push-release.sh as CI: ${ci.stdout}${ci.stderr}`);
    const released = join(root, 'releases', fxRelease);
    assert.equal(basename(posix(readlinkSync(join(root, 'current')))), fxRelease, 'the pushed release is current');
    assert.ok(existsSync(join(released, '.installed')) && existsSync(join(released, 'neuroncli/auth-server/node_modules')));
    assert.deepEqual(readdirSync(join(root, 'releases')), [fxRelease], 'no partial release left behind');
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), readFileSync(envSecret, 'utf8'), 'CI\'s environment file is in place');
    assert.deepEqual(etcFiles(), ['gateway.env', 'gateway.env.prev'], 'no copy of it left in /etc/zerox (it travels to activate-release.sh as --env)');
    assert.deepEqual(readdirSync(state), ['zerox-gateway@0.service']);
    // The remote side runs with umask 077: install-release.sh opens the release to the zerox group
    // (read only), or zerox could not read a file of it and the instance would never be ready.
    assert.match(read('deploy/aws/install-release.sh'), /^\s*chmod -R u=rwX,g=rX,o= -- "\$partial"$/m);
    if (process.platform !== 'win32') {
      for (const [path, mode] of [['neuroncli/auth-server/server.js', 0o640], ['neuroncli/auth-server', 0o750], ['REVISION', 0o640], ['index.html', 0o640]]) {
        assert.equal(statSync(join(released, path)).mode & 0o777, mode, `${path} is ${mode.toString(8)} in the release`);
      }
    }
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

    // An install that fails (npm here) changes no environment and leaves none behind for a later activation.
    writeFileSync(join(fxRepo, 'index.html'), `<!doctype html><title>2</title>${canonical}`);
    git('commit', '-q', '-am', 'second');
    const liveEnv = readFileSync(join(etc, 'gateway.env'), 'utf8');
    writeFileSync(envSecret, 'SUPABASE_URL="https://changed.invalid"\n');
    const npmFails = push({ STUB_NPM_FAIL: '1' }, '--os-user', 'deploy', '--lookup', 'tags', '--env-file', posix(envSecret), '--known-hosts', posix(knownHosts));
    assert.notEqual(npmFails.status, 0, 'a failed npm ci fails the push');
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), liveEnv, 'the live environment is untouched');
    assert.deepEqual(etcFiles(), ['gateway.env', 'gateway.env.prev'], 'and no gateway.env.next waits for a later activation');
    assert.equal(basename(posix(readlinkSync(join(root, 'current')))), fxRelease, 'the live release is untouched');
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
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), liveEnv, 'the laptop leaves the environment as it is');

    // A hand-written environment (README.md, "Environment file"): the operator writes gateway.env.next
    // on the VM (root's directory), then pushes with --env-next; root's installer takes it, it goes
    // live with a release check, then the push (ubuntu, who wrote it) removes it. Refused, it stays.
    writeFileSync(join(etc, 'gateway.env.next'), 'SUPABASE_URL="https://by-hand.invalid"\nNODE_TLS_REJECT_UNAUTHORIZED="0"\n');
    const byHandRefused = push('--known-hosts', posix(knownHosts), '--env-next');
    assert.notEqual(byHandRefused.status, 0, 'a refused hand-written file fails the push');
    assert.match(byHandRefused.stderr, /not allowed in the gateway's environment \(gateway-env\.mjs\): NODE_TLS_REJECT_UNAUTHORIZED;/);
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), liveEnv, 'the live environment stays');
    assert.ok(existsSync(join(etc, 'gateway.env.next')), 'and the operator\'s file stays, to be fixed');
    writeFileSync(join(etc, 'gateway.env.next'), 'SUPABASE_URL="https://by-hand.invalid"\n');
    const byHand = push('--known-hosts', posix(knownHosts), '--env-next');
    assert.equal(byHand.status, 0, `push-release.sh --env-next: ${byHand.stdout}${byHand.stderr}`);
    assert.ok(pushCalls().some(line => /^sudo -u deploy bash \S+install-release\.sh \S+ [0-9a-f]{7} --env-next$/.test(line)));
    assert.ok(pushCalls().includes('sudo /usr/local/sbin/zerox-install-env next'), 'root\'s installer reads the file, deploy never does');
    assert.equal(readFileSync(join(etc, 'gateway.env'), 'utf8'), 'SUPABASE_URL="https://by-hand.invalid"\n');
    assert.deepEqual(etcFiles(), ['gateway.env', 'gateway.env.prev']);
    assert.equal(push('--os-user', 'deploy', '--lookup', 'tags', '--known-hosts', posix(knownHosts), '--env-next', '--env-file', posix(envSecret)).status, 2,
      'one environment source per push');
    assert.equal(push('--os-user', 'deploy', '--lookup', 'tags', '--known-hosts', posix(knownHosts), '--env-next').status, 2,
      '--env-next is the operator\'s');

    // --setup-only (a new VM, before the tunnel token and the environment exist): host setup, and
    // no release installed or activated, so nothing fails a readiness check that cannot pass yet.
    const releasesBefore = readdirSync(join(root, 'releases')).sort();
    const setupOnly = push('--known-hosts', posix(knownHosts), '--setup-only');
    assert.equal(setupOnly.status, 0, `push-release.sh --setup-only: ${setupOnly.stdout}${setupOnly.stderr}`);
    assert.ok(pushCalls().includes('host-setup ran'));
    // (The ssh line carries the whole remote script, which names install-release.sh.)
    const setupCalls = pushCalls().filter(line => !line.startsWith('ssh ') && /install-release\.sh|^npm |^systemctl /.test(line));
    assert.deepEqual(setupCalls, [], 'no install, no activation');
    assert.match(setupOnly.stderr, /host setup done on i-0abc1234def567890 \(no release installed\)/);
    assert.deepEqual(readdirSync(join(root, 'releases')).sort(), releasesBefore);
    assert.equal(push('--known-hosts', posix(knownHosts), '--setup-only', '--env-next').status, 2, 'no environment without a release');
    assert.equal(push('--os-user', 'deploy', '--lookup', 'tags', '--known-hosts', posix(knownHosts), '--setup-only').status, 2, 'never as deploy');
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

console.log(`PASS: EC2 kit: env file from [vars], VM-only values and the Worker's secrets (systemd quoting, VM settings and the NODE_/LD_/BASH_/_PROXY families refused), job verify (kit included) before both deploys, the Worker and job ec2 approved together in production, OIDC only in job ec2, a read-only workflow token, pinned actions, npm ci without install scripts and checkouts without credentials, parity secrets required, CI role limited to the tunnel, the deploy key and two lookups, complete env template, two gateway instances on one port with their own readiness ports and release links, cron in the same sandbox and never enabled by setup, needrestart leaving the gateway to the refresh, exact deploy sudoers, /v1 base URLs, crons = [] at the cron step${commitChecked ? ', the commit check run (another commit or none fails)' : ''}${hostKeyChecked ? ', the host key step run (only the configured instance\x27s key, written under zerox-gateway)' : ''}${ran ? ', activation run (new instance ready before the old one stops, current flipped only after the checks, a crash meanwhile restarts on the old release, rollback without a gap, commit check, environment only with --env or --env-next through root\x27s installer, never-activated releases pruned first), root\x27s environment installer run (gateway-env.mjs\x27s names and quoting, printable ASCII, never a link, never a value), refresh run (only for a replaced /usr file; the id from current\x27s target, never REVISION\x27s contents), host setup run (/etc/zerox root\x27s and a link there refused, releases deploy\x27s, sudoers checked, cloud-init rule removed, other rules for deploy refused, upgrade files installed, idempotent)' : ''}${packaged ? ', release tarball (.assetsignore as wrangler reads it, case included, the sitemap built for the commit, gateway without tests, kit, REVISION, tracked secrets and working files refused), push and install through stub endpoint and ssh (CI with its env file under the lock, a failed install leaving none, the same commit again, the laptop without secrets, --env-next, --setup-only, host key required)' : ''}${packagedHead ? ', HEAD packaged' : ''}`);
