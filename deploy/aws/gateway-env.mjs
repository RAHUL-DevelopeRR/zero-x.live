#!/usr/bin/env node
// Builds the gateway's environment file (/etc/zerox/gateway.env on the VM) for
// .github/workflows/deploy-oracle.yml: the Worker's plain values from wrangler.toml [vars] (one
// source for the Worker and the VM) plus the secrets deploy.yml binds to the Worker, read from
// this process's environment under the names in REQUIRED_SECRETS and OPTIONAL_SECRETS. Values
// are never printed; the names of optional secrets that are not set are.
//
//   node deploy/aws/gateway-env.mjs --wrangler neuroncli/auth-server/wrangler.toml --out "$RUNNER_TEMP/gateway.env"
//
// The file is in systemd's EnvironmentFile syntax: KEY="value" with \ " ` $ escaped, one per
// line. Settings that describe the VM itself (NODE_ENV, AUTH_HOST, TRUST_CLOUDFLARE, ...) are
// in zerox-gateway.service and refused here, like the development switches.
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
// with one of these names would silently replace the VM's runtime settings (zerox-gateway.service)
// or switch on a development path. They are refused instead.
const UNIT_SETTINGS = new Set(['NODE_ENV', 'AUTH_HOST', 'AUTH_PORT', 'NEURON_API_ONLY', 'TRUST_CLOUDFLARE',
  'TRUST_CF_IPCOUNTRY', 'SHUTDOWN_GRACE_MS']);
const DEVELOPMENT_ONLY = new Set(['DEV_AUTH_ENABLED', 'ALLOW_ANONYMOUS_SESSIONS', 'ALLOW_UNKNOWN_COUNTRY',
  'DATABASE_DRIVER', 'PGLITE_DATA_DIR', 'ALLOW_LOCAL_DATABASE', 'RAZORPAY_API_BASE', 'NEURON_RUNTIME']);
function allowed(name) {
  if (UNIT_SETTINGS.has(name) || DEVELOPMENT_ONLY.has(name) || name.startsWith('E2E_')) {
    throw new Error(`${name} is not allowed in the VM environment (zerox-gateway.service sets it, or it is development-only)`);
  }
  return name;
}

// { text, skipped }: vars first, then the secrets that are set. A required secret that is not
// set, a secret that would replace a var, or a refused name (above) fails.
export function buildEnvFile({ vars, env, required, optional }) {
  const lines = ['# Written by .github/workflows/deploy-oracle.yml; local edits are replaced on the next deploy.'];
  for (const [name, value] of Object.entries(vars)) lines.push(envLine(allowed(name), value));
  const skipped = [];
  for (const name of [...required, ...optional].map(allowed)) {
    if (Object.hasOwn(vars, name)) throw new Error(`${name} is both a wrangler var and a secret`);
    const value = env[name];
    if (typeof value === 'string' && value !== '') lines.push(envLine(name, value));
    else if (required.includes(name)) throw new Error(`Required secret ${name} is not set`);
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
