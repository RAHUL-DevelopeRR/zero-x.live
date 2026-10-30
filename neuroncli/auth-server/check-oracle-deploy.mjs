// The Oracle VM kit (deploy/oracle, .github/workflows/deploy-oracle.yml) stays in step with the
// gateway: the environment file builder (wrangler.toml [vars] plus secrets, systemd quoting, the
// VM's own settings refused), the workflow's secret set (deploy.yml's, the parity secrets
// required), actions pinned by commit, every variable the gateway reads listed in
// gateway.env.example, the units, tunnel config and activation script agreeing on paths, port
// and the shutdown grace, cloud-init's firewall and upgrade window, the tunnel's ingress, the
// phase 2 DNS cutover script against a fake Cloudflare API, and activate-release.sh run against
// a temporary tree. Values from wrangler.toml are never printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutover, lowerNegativeTtl } from '../../deploy/oracle/apex-cutover.mjs';
import { buildEnvFile, envLine, wranglerVars } from '../../deploy/oracle/gateway-env.mjs';

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
  'GIT_COMMIT', // the release's REVISION file on the VM (server.js), deploy.yml's --var on the Worker
  'HEALTH_CANARIES', // read by the HealthHub Durable Object, which only runs on the Worker
  'EC2_PROXY_PREFIXES', 'EC2_PROXY_ORIGIN', // the Worker's EC2 proxy switch (src/ec2-proxy.js), which never runs on Node
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', // Anthropic SDK variables the gateway pins
  'CATALOG_DB_MODELS', 'MAX_REQUESTS_PER_SESSION', 'OPENROUTER_CLIENT_ID', 'BEDROCK_TOOL_MODELS', // no longer read (warned or ignored)
]);
const template = read('deploy/oracle/gateway.env.example');
const listed = new Set([...template.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map(match => match[1]));
const missing = [...read_].filter(name => !NOT_CONFIGURATION.has(name) && !name.startsWith('E2E_') && !listed.has(name));
assert.deepEqual(missing, [], 'gateway.env.example lists every variable the gateway reads');
assert.ok(!/^[A-Z][A-Z0-9_]*=\S/m.test(template), 'the template holds names only');

// ── Units, tunnel and activation agree ──
const unit = read('deploy/oracle/zerox-gateway.service');
const cron = read('deploy/oracle/zerox-cron.service');
const timer = read('deploy/oracle/zerox-cron.timer');
const tunnel = read('deploy/oracle/cloudflared-config.yml');
const activate = read('deploy/oracle/activate-release.sh');
const port = /AUTH_PORT=(\d+)/.exec(unit)[1];
assert.match(unit, /AUTH_HOST=127\.0\.0\.1/);
assert.match(tunnel, new RegExp(`service: http://127\\.0\\.0\\.1:${port}\\n`));
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
const cloudInit = read('deploy/oracle/cloud-init.yaml');
assert.match(cloudInit, /systemctl restart zerox-gateway\.service/, 'the deploy user may restart the gateway');

// ── cloud-init: no UFW, upgrades and their restarts in the night window before the reboot ──
// Oracle: UFW on its Ubuntu images can remove the iptables rules that reach the boot volume, and
// the instance may not boot again. The image's /etc/iptables/rules.v4 is the firewall.
assert.ok(!/\bufw\b/.test(cloudInit.replace(/^\s*#.*$/gm, '')), 'cloud-init never installs or configures ufw');
const minutes = (h, m) => Number(h) * 60 + Number(m);
const upgradeAt = /OnCalendar=\*-\*-\* (\d\d):(\d\d)/.exec(cloudInit);
const upgradeDelay = Number(/RandomizedDelaySec=(\d+)m/.exec(cloudInit)[1]);
const rebootAt = /Automatic-Reboot-Time "(\d\d):(\d\d)"/.exec(cloudInit);
assert.match(cloudInit, /apt-daily-upgrade\.timer\.d/, 'apt-daily-upgrade.timer is moved off its 06:00 UTC default');
assert.ok(minutes(upgradeAt[1], upgradeAt[2]) >= minutes(20, 0) && minutes(upgradeAt[1], upgradeAt[2]) + upgradeDelay + 15 <= minutes(rebootAt[1], rebootAt[2]),
  'upgrades (and needrestart\'s service restarts) run at night and finish before the reboot time');
assert.match(cloudInit, /\$nrconf\{restart\} = 'a';/, 'needrestart restarts services in that window, deterministically');
assert.match(cloudInit, /pkg\.cloudflare\.com\/cloudflared any main/, 'Cloudflare\'s recommended apt suite');

// ── Tunnel ingress: what the CLI needs, nothing operator-only ──
// cloudflared takes the first rule whose hostname and path (a regular expression on the URL
// path) match. Phase 2's commented rules are tested uncommented.
function ingress(text) {
  const rules = [];
  for (const line of text.split('ingress:')[1].split('\n')) {
    const item = /^ {2}- (\w+): (.+)$/.exec(line);
    const more = /^ {4}(\w+): (.+)$/.exec(line);
    if (item) rules.push({ [item[1]]: item[2].trim() });
    else if (more && rules.length) rules.at(-1)[more[1]] = more[2].trim();
  }
  return (host, path) => rules.find(rule => (!rule.hostname || rule.hostname === host) &&
    (!rule.path || new RegExp(rule.path).test(path))).service;
}
const origin = `http://127.0.0.1:${port}`;
const phase1 = ingress(tunnel);
const phase2 = ingress(tunnel.replace(/^ {2}# ( {0,2}(?:- |\w+: ))/gm, '  $1'));
for (const route of [phase1, phase2]) {
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/models', '/v1/models/status', '/auth/device/code',
    '/auth/device/token', '/auth/session', '/api/account', '/health', '/ready']) {
    assert.equal(route('gw.zero-x.live', path), origin, `gw ${path}`);
  }
  for (const path of ['/admin/overview', '/admin/providers/keys', '/v1/providers/health', '/neuroncli/auth-server/admin/overview',
    '/auth/device/approve', '/relay/v1/ticket', '/releases/neuron/latest.json', '/webhooks/razorpay', '/api/billing/checkout', '/']) {
    assert.equal(route('gw.zero-x.live', path), 'http_status:404', `gw ${path} stays off the VM`);
  }
  assert.equal(route('other.zero-x.live', '/v1/models'), 'http_status:404');
}
assert.equal(phase1('zero-x.live', '/v1/models'), 'http_status:404', 'phase 1 leaves zero-x.live alone');
assert.equal(phase2('zero-x.live', '/v1/chat/completions'), origin);
for (const path of ['/', '/auth/device/code', '/v1/providers/health', '/admin/overview']) {
  assert.equal(phase2('zero-x.live', path), 'http_status:404', `phase 2 zero-x.live ${path} stays off the VM`);
}

// ── The CLI's base URL includes /v1 (it appends /chat/completions and /models to it) ──
for (const name of readdirSync(join(repo, 'deploy/oracle'))) {
  for (const [, base] of read(`deploy/oracle/${name}`).matchAll(/NEURON_API_BASE=([^\s`'")]+)/g)) {
    assert.match(base, /\/v1$/, `deploy/oracle/${name}: NEURON_API_BASE=${base} must end in /v1`);
  }
}

// ── apex-cutover.mjs: the Custom Domain and the tunnel CNAME swap back to back, undone on failure ──
const IDS = { account: 'a'.repeat(32), zone: 'b'.repeat(32), tunnel: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
  worker: 'zerox-gateway', hostname: 'zero-x.live' };
// failCname/failAttach: that many writes fail; lostCname/lostAttach: that many land, then report a
// failure (a timeout after Cloudflare applied the write).
function fakeCloudflare({ domain = true, cname = false, routes = true, failCname = 0, failAttach = 0, lostCname = 0, lostAttach = 0,
  soa = { min_ttl: 1800, ttl: 1800 } } = {}) {
  const calls = [];
  const logs = [];
  const world = {
    domain: domain ? { id: 'dom1', hostname: IDS.hostname, service: IDS.worker } : null,
    records: cname ? [{ id: 'rec1', type: 'CNAME', name: IDS.hostname, content: `${IDS.tunnel}.cfargotunnel.com`, proxied: true }] : [],
    routes: routes ? [{ id: 'r1', pattern: `${IDS.hostname}/*`, script: IDS.worker }, { id: 'r2', pattern: `${IDS.hostname}/v1/*` }] : [],
  };
  const api = async (method, path, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.includes('/workers/domains')) return world.domain ? [world.domain] : [];
    if (method === 'GET' && path.includes('/dns_records')) return world.records;
    if (method === 'GET' && path.endsWith('/dns_settings')) return { soa };
    if (method === 'PATCH' && path.endsWith('/dns_settings')) { soa = body.soa; return { soa }; }
    if (method === 'GET' && path.endsWith('/workers/routes')) return world.routes;
    if (method === 'DELETE' && path.includes('/workers/domains/')) { world.domain = null; return {}; }
    if (method === 'PUT' && path.endsWith('/workers/domains')) {
      if (failAttach-- > 0) throw new Error('PUT /workers/domains: 100117: hostname has a DNS record');
      world.domain = { id: 'dom2', hostname: body.hostname, service: body.service };
      if (lostAttach-- > 0) throw new Error('PUT /workers/domains: The operation was aborted due to timeout');
      return world.domain;
    }
    if (method === 'POST' && path.endsWith('/dns_records')) {
      if (failCname-- > 0) throw new Error('POST /dns_records: 81053: record already exists');
      world.records = [{ id: 'rec2', ...body }];
      if (lostCname-- > 0) throw new Error('POST /dns_records: The operation was aborted due to timeout');
      return world.records[0];
    }
    if (method === 'DELETE' && path.includes('/dns_records/')) { world.records = []; return {}; }
    if (method === 'POST' && path.endsWith('/workers/routes')) { world.routes.push({ id: `r${world.routes.length + 1}`, ...body }); return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls, logs, world, soa: () => soa, options: { log: line => logs.push(line), pause: async () => {} } };
}
const writes = calls => calls.filter(call => !call.startsWith('GET '));
{
  let cf = fakeCloudflare();
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: false, ...cf.options });
  assert.deepEqual(writes(cf.calls), [], 'a dry run only reads');
  assert.ok(cf.logs.some(line => /SOA/.test(line) && /1800/.test(line)), 'a long negative-caching TTL is flagged');

  cf = fakeCloudflare({ soa: { min_ttl: 60, ttl: 300 } });
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [`DELETE /accounts/${IDS.account}/workers/domains/dom1`, `POST /zones/${IDS.zone}/dns_records`]);
  assert.deepEqual(cf.calls.slice(-2), writes(cf.calls), 'nothing runs between the two writes');
  assert.deepEqual([cf.world.records[0].type, cf.world.records[0].content, cf.world.records[0].proxied],
    ['CNAME', `${IDS.tunnel}.cfargotunnel.com`, true]);
  assert.ok(!cf.logs.some(line => /SOA/.test(line)), 'a short negative-caching TTL is not flagged');

  cf = fakeCloudflare({ failCname: 2 });
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options });
  assert.equal(cf.world.records.length, 1, 'the CNAME is retried while the deleted record clears');

  cf = fakeCloudflare({ failCname: 99 });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options }), /Custom Domain restored/);
  assert.equal(cf.world.domain?.service, IDS.worker, 'a CNAME that never lands puts the Custom Domain back');

  cf = fakeCloudflare({ failCname: 99, failAttach: 99 });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options }),
    error => /undo failed too/.test(error.message) && /neither the Custom Domain nor the tunnel CNAME/.test(error.message) && !/restored/.test(error.message));
  assert.ok(!cf.logs.some(line => /restored/.test(line)), 'a failed undo never claims a restore');

  cf = fakeCloudflare({ failCname: 99, lostAttach: 1 });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options }), /\(Custom Domain restored\)/);
  assert.equal(cf.world.domain?.service, IDS.worker, 'an undo that landed but timed out counts as restored');

  cf = fakeCloudflare({ lostCname: 1 });
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [`DELETE /accounts/${IDS.account}/workers/domains/dom1`, `POST /zones/${IDS.zone}/dns_records`],
    'a CNAME that landed but timed out is not retried or undone');
  assert.equal(cf.world.domain, null);

  cf = fakeCloudflare({ routes: false });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options }), /routes/);
  assert.deepEqual(writes(cf.calls), [], 'without the routes the whole site would reach the tunnel: refused');
  cf = fakeCloudflare({ routes: false });
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, createRoutes: true, ...cf.options });
  assert.deepEqual(writes(cf.calls).slice(0, 2), [`DELETE /accounts/${IDS.account}/workers/domains/dom1`, `POST /zones/${IDS.zone}/dns_records`]);
  assert.deepEqual(cf.world.routes.map(route => [route.pattern, route.script]),
    [[`${IDS.hostname}/*`, IDS.worker], [`${IDS.hostname}/v1/*`, undefined]], '--create-routes adds them right after the CNAME');

  cf = fakeCloudflare();
  await assert.rejects(cutover(cf.api, { ...IDS, worker: 'another-worker', to: 'tunnel', apply: true, ...cf.options }), /serves zerox-gateway/);
  assert.deepEqual(writes(cf.calls), []);

  cf = fakeCloudflare({ domain: false, cname: true });
  await cutover(cf.api, { ...IDS, to: 'worker', apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [`DELETE /zones/${IDS.zone}/dns_records/rec1`, `PUT /accounts/${IDS.account}/workers/domains`]);
  assert.equal(cf.world.domain.service, IDS.worker, 'rollback: the Custom Domain is back');

  cf = fakeCloudflare({ domain: false, cname: true, failAttach: 99 });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'worker', apply: true, ...cf.options }), /tunnel CNAME restored/);
  assert.equal(cf.world.records[0]?.content, `${IDS.tunnel}.cfargotunnel.com`, 'a failed rollback puts the CNAME back');

  cf = fakeCloudflare({ domain: false, cname: true, failAttach: 99, failCname: 99 });
  await assert.rejects(cutover(cf.api, { ...IDS, to: 'worker', apply: true, ...cf.options }),
    error => /undo failed too/.test(error.message) && !/restored/.test(error.message));

  cf = fakeCloudflare({ domain: false, cname: true, lostAttach: 1 });
  await cutover(cf.api, { ...IDS, to: 'worker', apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [`DELETE /zones/${IDS.zone}/dns_records/rec1`, `PUT /accounts/${IDS.account}/workers/domains`],
    'a rollback attach that landed but timed out is not retried or undone');

  cf = fakeCloudflare({ domain: false, cname: true });
  await cutover(cf.api, { ...IDS, to: 'tunnel', apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [], 'already on the tunnel: nothing to do');

  // A day ahead: the zone's negative-caching TTL comes down, the rest of the SOA stays.
  cf = fakeCloudflare({ soa: { mname: 'ns.example', rname: 'dns.example', refresh: 10000, retry: 2400, expire: 604800, min_ttl: 1800, ttl: 1800 } });
  await lowerNegativeTtl(cf.api, { zone: IDS.zone, seconds: 60, apply: false, ...cf.options });
  assert.deepEqual(writes(cf.calls), [], 'a dry run only reads');
  await lowerNegativeTtl(cf.api, { zone: IDS.zone, seconds: 60, apply: true, ...cf.options });
  assert.deepEqual(writes(cf.calls), [`PATCH /zones/${IDS.zone}/dns_settings`]);
  assert.deepEqual(cf.soa(), { mname: 'ns.example', rname: 'dns.example', refresh: 10000, retry: 2400, expire: 604800, min_ttl: 60, ttl: 1800 });
  await assert.rejects(lowerNegativeTtl(cf.api, { zone: IDS.zone, seconds: 30, apply: true, ...cf.options }), /60 to 86400/);
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

console.log('PASS: Oracle kit: env file from [vars] and the deploy.yml secrets (systemd quoting, VM settings refused), parity secrets required, pinned manual workflow, complete env template, consistent units, no ufw and night-time upgrades, tunnel ingress limited to the CLI paths, /v1 base URLs, apex cutover back to back with undo, activation run (readiness gate, rollback, prune)');
