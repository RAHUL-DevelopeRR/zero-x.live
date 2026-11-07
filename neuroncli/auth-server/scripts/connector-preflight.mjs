#!/usr/bin/env node
// Hosted connectors preflight: which environment names are set (names and states only, never a value).
//
//   node scripts/connector-preflight.mjs                    reads this process's environment
//   node scripts/connector-preflight.mjs --env-file .env.staging   reads KEY=value lines of a file
//   node scripts/connector-preflight.mjs --gh [--env E] [--repo O/R]   names GitHub holds (gh CLI)
//   options: --strict (exit 1 unless the flag is on, the key is valid and a connector is ready),
//            --json (machine readable)
//
// "ready" for a connector means its client id, client secret and every URL or scope list the
// catalog has no default for are present. It does not call any vendor.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_CONNECTORS } from '../src/connector-catalog.js';

const fail = message => { console.error(`error: ${message}`); process.exit(1); };
const envName = (id, field) => `CONNECTOR_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
const SHARED = ['HOSTED_CONNECTORS', 'CONNECTOR_TOKENS_KEK', 'CONNECTORS_CALLBACK_URL', 'CONNECTORS_RETURN_URL',
  'HOSTED_CONNECTORS_BASE_URL', 'EC2_PROXY_PREFIXES', 'EXTRA_WEB_HOSTS'];
const OPTIONAL_FIELDS = ['REVOKE_URL', 'SCOPES', 'MCP_URL', 'AUTHORIZE_URL', 'TOKEN_URL'];

// Names a connector needs from the operator; fields the catalog already defaults are not needed.
export function requiredFields(connector) {
  const fields = ['CLIENT_ID', 'CLIENT_SECRET'];
  if (!connector.mcp_url) fields.push('MCP_URL');
  if (!connector.authorize_url) fields.push('AUTHORIZE_URL');
  if (!connector.token_url) fields.push('TOKEN_URL');
  if (connector.scopes === null) fields.push('SCOPES');
  return fields;
}

function parseOptions(argv) {
  const opts = { strict: false, json: false, gh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--gh') opts.gh = true;
    else if (['--env-file', '--env', '--repo'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      opts[arg === '--env-file' ? 'envFile' : arg.slice(2)] = value;
      i += 1;
    } else fail(`unknown argument ${arg}`);
  }
  if (opts.env !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.env)) fail('--env is not a valid environment name');
  if (opts.repo !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) fail('--repo must be owner/repo');
  return opts;
}

function parseEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { fail('cannot read that env file'); }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

// Names only, from the gh CLI. Variable and secret values are never requested.
function ghNames(opts) {
  const names = new Set();
  for (const kind of ['secret', 'variable']) {
    const args = [kind, 'list', '--json', 'name'];
    if (opts.env) args.push('--env', opts.env);
    if (opts.repo) args.push('--repo', opts.repo);
    const res = spawnSync('gh', args, { encoding: 'utf8' });
    if (res.error || res.status !== 0) fail(`gh ${kind} list failed (is gh installed and signed in?)`);
    try { for (const row of JSON.parse(res.stdout)) if (typeof row?.name === 'string') names.add(row.name); }
    catch { fail(`gh ${kind} list returned something unexpected`); }
  }
  return names;
}

const isBase64Key = value => /^[A-Za-z0-9+/]{43}=$/.test(String(value).trim()) && Buffer.from(String(value).trim(), 'base64').length === 32;

export function evaluate({ names, values }) {
  const has = name => names.has(name) && (values === null || String(values[name] ?? '').trim() !== '');
  const flag = values === null ? (names.has('HOSTED_CONNECTORS') ? 'unknown' : 'off')
    : String(values.HOSTED_CONNECTORS ?? '').trim() === 'true' ? 'on' : 'off';
  let kek = has('CONNECTOR_TOKENS_KEK') ? 'set' : 'unset';
  if (kek === 'set' && values !== null && !isBase64Key(values.CONNECTOR_TOKENS_KEK)) kek = 'set but invalid';
  const reused = values !== null && kek === 'set' && has('PROVIDER_KEYS_KEK')
    && String(values.PROVIDER_KEYS_KEK).trim() === String(values.CONNECTOR_TOKENS_KEK).trim();
  const connectors = HOSTED_CONNECTORS.map(connector => {
    const required = requiredFields(connector).map(field => envName(connector.id, field));
    const fields = [...new Set([...requiredFields(connector), ...OPTIONAL_FIELDS, 'CLIENT_ID', 'CLIENT_SECRET'])]
      .map(field => envName(connector.id, field));
    const state = Object.fromEntries(fields.map(name => [name, has(name) ? 'set' : 'unset']));
    const missing = required.filter(name => !has(name));
    return { id: connector.id, ready: missing.length === 0, missing, required, state };
  });
  const shared = Object.fromEntries(SHARED.map(name => [name, has(name) ? 'set' : 'unset']));
  const warnings = [];
  if (flag === 'on' && kek !== 'set') warnings.push('HOSTED_CONNECTORS is on without a valid CONNECTOR_TOKENS_KEK: every connector route answers 503 connectors_unavailable.');
  if (flag === 'off' && kek === 'set') warnings.push('A key is set while HOSTED_CONNECTORS is off: every connector route still answers 404 (expected until switch-on).');
  if (reused) warnings.push('CONNECTOR_TOKENS_KEK reuses PROVIDER_KEYS_KEK: generate a separate key.');
  if (flag === 'on' && !connectors.some(c => c.ready)) warnings.push('No connector is ready: /api/account reports hosted: [] and the Connectors tab shows every vendor unavailable.');
  return { hosted_connectors: flag, connector_tokens_kek: kek, shared, connectors, warnings };
}

function render(result) {
  const pad = name => name.padEnd(42);
  const lines = ['Hosted connectors preflight (names and states only)', ''];
  lines.push(`${pad('HOSTED_CONNECTORS')}${result.hosted_connectors}`);
  lines.push(`${pad('CONNECTOR_TOKENS_KEK')}${result.connector_tokens_kek}`);
  for (const name of SHARED.slice(2)) lines.push(`${pad(name)}${result.shared[name]}`);
  for (const connector of result.connectors) {
    lines.push('', `${connector.id}`);
    for (const [name, state] of Object.entries(connector.state)) {
      lines.push(`  ${pad(name).slice(0, 44)}${state}${connector.required.includes(name) ? '' : ' (optional)'}`);
    }
    lines.push(`  ${`${connector.id}`.padEnd(11)}${connector.ready ? 'ready' : `not ready (missing ${connector.missing.join(', ')})`}`);
  }
  if (result.warnings.length) lines.push('', ...result.warnings.map(w => `warning: ${w}`));
  return lines.join('\n');
}

function main() {
  const opts = parseOptions(process.argv.slice(2));
  let source;
  if (opts.gh) source = { names: ghNames(opts), values: null };
  else {
    const values = opts.envFile ? parseEnvFile(opts.envFile) : { ...process.env };
    source = { names: new Set(Object.keys(values)), values };
  }
  const result = evaluate(source);
  console.log(opts.json ? JSON.stringify(result, null, 2) : render(result));
  if (opts.strict) {
    const good = result.hosted_connectors === 'on' && result.connector_tokens_kek === 'set'
      && result.connectors.some(c => c.ready) && !result.warnings.some(w => /reuses/.test(w));
    if (!good) process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
