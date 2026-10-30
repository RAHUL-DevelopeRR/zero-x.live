// The Oracle VM kit (deploy/oracle, .github/workflows/deploy-oracle.yml) stays in step with the
// gateway: the environment file builder (wrangler.toml [vars] plus secrets, systemd quoting),
// the workflow's secret set equal to deploy.yml's, actions pinned by commit, every variable the
// gateway reads listed in gateway.env.example, and the units, tunnel config and activation
// script agreeing on paths, port and the shutdown grace. Values from wrangler.toml are never
// printed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ── Workflow: same secrets as deploy.yml, nothing else, actions pinned ──
const deploy = read('.github/workflows/deploy.yml');
const oracle = read('.github/workflows/deploy-oracle.yml');
const list = (text, name) => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(text)?.[1].trim().split(/\s+/);
assert.deepEqual(list(oracle, 'REQUIRED_SECRETS'), list(deploy, 'REQUIRED_SECRETS'));
assert.deepEqual(list(oracle, 'OPTIONAL_SECRETS'), list(deploy, 'OPTIONAL_SECRETS'));
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
assert.match(activate, new RegExp(`http://127\\.0\\.0\\.1:${port}/health`));
const serverJs = readFileSync(join(here, 'server.js'), 'utf8');
const graceMs = Number(/SHUTDOWN_GRACE_MS, (\d+)\)/.exec(serverJs)[1]);
assert.ok(Number(/TimeoutStopSec=(\d+)/.exec(unit)[1]) * 1000 > graceMs + 1000, 'systemd waits for the drain');
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
assert.match(read('deploy/oracle/cloud-init.yaml'), /systemctl restart zerox-gateway\.service/, 'the deploy user may restart the gateway');

console.log('PASS: Oracle kit: env file from [vars] and the deploy.yml secrets (systemd quoting), pinned manual workflow, complete env template, consistent units, tunnel and activation');
