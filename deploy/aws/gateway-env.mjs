#!/usr/bin/env node
// Builds the gateway's environment file (/etc/zerox/gateway.env on the VM) for job ec2 of
// .github/workflows/deploy.yml: the Worker's plain values from wrangler.toml [vars] (one source
// for the Worker and the VM), the VM-only plain values named in VM_VARS (EXTRA_WEB_HOSTS, from a
// repository variable; unset means the production default and is not written), and the secrets
// the Worker job binds to the Worker, read from this process's environment under the names in
// REQUIRED_SECRETS and OPTIONAL_SECRETS. Values are never printed; the names of optional secrets
// that are not set are.
//
//   node deploy/aws/gateway-env.mjs --wrangler neuroncli/auth-server/wrangler.toml --out "$RUNNER_TEMP/gateway.env"
//
// The file is in systemd's EnvironmentFile syntax: KEY="value" with \ " ` $ escaped, one per
// line. Settings that describe the VM itself (NODE_ENV, AUTH_HOST, TRUST_CLOUDFLARE, ...) are
// in zerox-gateway@.service and refused here, like the development switches.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

// [vars] of a wrangler.toml: single-line KEY = "string" entries only (what the file holds);
// anything else fails, so a value is never half-read.
export function wranglerVars(text) {
  const vars = {};
  let inVars = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inVars = line === '[vars]'; continue; }
    if (!inVars || !line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\["\\])*)"\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(`wrangler.toml [vars]: unsupported entry ${JSON.stringify(line.split('=')[0].trim())}`);
    vars[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
  }
  return vars;
}

// systemd unquotes \" \\ \` \$ inside double quotes and keeps every other character as is.
export function envLine(name, value) {
  if (!NAME.test(name)) throw new Error(`Invalid variable name ${JSON.stringify(name)}`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${name} contains a line break`);
  return `${name}="${value.replace(/[\\"`$]/g, char => `\\${char}`)}"`;
}

const names = list => String(list || '').split(/\s+/).filter(Boolean);

// systemd lets EnvironmentFile= override the unit's Environment=, so a [vars] entry or secret
// with one of these names would silently replace the VM's runtime settings (zerox-gateway@.service,
// NEURON_API_ONLY included: the VM serves the website) or switch on a development path. GIT_COMMIT
// comes from the release's REVISION file on the VM, so an environment file kept across a rollback
// can never report the wrong commit. EC2_PROXY_PREFIXES and EC2_PROXY_ORIGIN steer the Worker's
// forward to the VM; on the VM they could only make it forward to itself. They are refused instead.
// NODE_OPTIONS and LD_PRELOAD would load code into the gateway before server.js runs, and every
// TRUST_* name is a decision about which headers to believe, which belongs to the unit (the
// EC2 smoke test's environment workflow refused the same names).
const UNIT_SETTINGS = new Set(['NODE_ENV', 'AUTH_HOST', 'AUTH_PORT', 'AUTH_REUSE_PORT', 'READY_PORT', 'ASSETS_DIR',
  'NEURON_API_ONLY', 'TRUST_CLOUDFLARE', 'TRUST_CF_IPCOUNTRY', 'SHUTDOWN_GRACE_MS', 'GIT_COMMIT', 'NODE_OPTIONS', 'LD_PRELOAD']);
const WORKER_ONLY = new Set(['EC2_PROXY_PREFIXES', 'EC2_PROXY_ORIGIN']);
const DEVELOPMENT_ONLY = new Set(['DEV_AUTH_ENABLED', 'ALLOW_ANONYMOUS_SESSIONS', 'ALLOW_UNKNOWN_COUNTRY',
  'DATABASE_DRIVER', 'PGLITE_DATA_DIR', 'ALLOW_LOCAL_DATABASE', 'RAZORPAY_API_BASE', 'NEURON_RUNTIME']);
// server.js refuses to start with a shorter proxy secret (the only gate on the tunnel's public
// host); failing here keeps such a deploy from reaching the VM at all.
const MIN_LENGTH = { EC2_PROXY_SECRET: 32 };
function allowed(name) {
  if (UNIT_SETTINGS.has(name) || WORKER_ONLY.has(name) || DEVELOPMENT_ONLY.has(name) || name.startsWith('E2E_') || name.startsWith('TRUST_')) {
    throw new Error(`${name} is not allowed in the VM environment (zerox-gateway@.service or the release sets it, ` +
      'or it is Worker-only or development-only)');
  }
  return name;
}

// { text, skipped }: vars first, then the VM-only values and the secrets that are set. A
// required secret that is not set, a value that would replace a var, a refused name (above), a
// secret with a character other than printable ASCII (systemd refuses some Unicode in an
// EnvironmentFile and then logs the value to the journal; a space would also be trimmed on one
// runtime and not the other) or a proxy secret shorter than server.js accepts fails. Only names
// are ever reported, never values.
export function buildEnvFile({ vars, env, required, optional, vmVars = [] }) {
  const lines = ['# Written by job ec2 of .github/workflows/deploy.yml; local edits are replaced on the next deploy.'];
  for (const [name, value] of Object.entries(vars)) lines.push(envLine(allowed(name), value));
  for (const name of vmVars.map(allowed)) {
    if (Object.hasOwn(vars, name)) throw new Error(`${name} is both a wrangler var and a VM variable`);
    if (typeof env[name] === 'string' && env[name] !== '') lines.push(envLine(name, env[name]));
  }
  const skipped = [];
  for (const name of [...required, ...optional].map(allowed)) {
    if (Object.hasOwn(vars, name) || vmVars.includes(name)) throw new Error(`${name} is both a plain value and a secret`);
    const value = env[name];
    if (typeof value === 'string' && value !== '') {
      if (!/^[\x21-\x7e]+$/.test(value)) throw new Error(`Secret ${name} has characters other than printable ASCII (or a space)`);
      if (value.length < (MIN_LENGTH[name] || 0)) throw new Error(`Secret ${name} must be at least ${MIN_LENGTH[name]} characters`);
      lines.push(envLine(name, value));
    } else if (required.includes(name)) throw new Error(`Required secret ${name} is not set`);
    else skipped.push(name);
  }
  return { text: `${lines.join('\n')}\n`, skipped };
}

function main() {
  const { values } = parseArgs({ options: { wrangler: { type: 'string' }, out: { type: 'string' } } });
  if (!values.wrangler || !values.out) throw new Error('usage: gateway-env.mjs --wrangler <wrangler.toml> --out <file>');
  const { text, skipped } = buildEnvFile({
    vars: wranglerVars(readFileSync(values.wrangler, 'utf8')), env: process.env,
    required: names(process.env.REQUIRED_SECRETS), optional: names(process.env.OPTIONAL_SECRETS),
    vmVars: names(process.env.VM_VARS),
  });
  writeFileSync(values.out, text, { mode: 0o600 });
  for (const name of skipped) console.log(`::warning::Optional secret ${name} is not set; the feature that needs it stays disabled`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
