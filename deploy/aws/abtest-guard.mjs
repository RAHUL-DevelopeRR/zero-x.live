// Safety core of the Worker-vs-EC2 A/B harness (abtest.mjs, AB-TEST.md), kept apart so
// check-abtest.mjs can test every rule. Nothing here can be switched off by a flag:
//   - targets come by name from the gitignored abtest-targets.local.json (or the built-in
//     "local"); a raw URL is never taken from the command line;
//   - every remote host must be https, without userinfo or port, not an IP, and its first label
//     must be "staging" or end in "-staging"; the production hosts are refused whatever the file
//     says, in every spelling (case, trailing dot, port, userinfo, IP, http);
//   - wrangler tail only ever names a staging script, never the production ones;
//   - the credential comes from a hidden prompt or ZEROX_AB_TOKEN, never argv, and is never
//     printed, logged or written;
//   - concurrency, stream length, requests per run and per UTC day, and the request rate are
//     capped by constants that flags can only lower;
//   - once installed, fetch reaches only the run's own origins and never follows a redirect.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';

// The production hosts: the Worker's Custom Domains, the relay and the production forward target.
export const PRODUCTION_HOSTS = Object.freeze(['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live',
  'relay.zero-x.live', 'aws.zero-x.live']);
// The production Worker scripts (wrangler.toml, wrangler.api.toml).
export const PRODUCTION_SCRIPTS = Object.freeze(['zero-x-callback-api', 'neuron-gateway']);

// Hard caps. A flag or a target may set less, never more.
export const CAPS = Object.freeze({
  concurrency: 64, // streams at once
  streamSeconds: 120, // longest stream a scenario may ask for
  requestsPerRun: 2000,
  requestsPerDay: 10000, // per UTC day, all runs on this machine (Workers Free: 100,000 a day, shared with production)
  ratePerSecond: 10, // new requests per second
  minRampMs: 2000, // concurrency ramps up over at least this long
});
export const DEFAULTS = Object.freeze({ concurrency: 4, requestsPerRun: 300, requestsPerDay: 3000, ratePerSecond: 2, rampMs: 2000 });

/** A cap from a flag: a positive number no larger than the hard cap (or the target's own). */
export function capped(name, value, { targetMax = Infinity } = {}) {
  const hard = Math.min(CAPS[name], targetMax);
  const fallback = Math.min(DEFAULTS[name] ?? hard, hard);
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name}: a positive number`);
  if (number > hard) throw new Error(`--${name} ${number} is above the cap of ${hard}`);
  return number;
}

// ── Hosts ──
export function normaliseHost(host) {
  const text = String(host ?? '').trim().toLowerCase().replace(/\.+$/, '');
  try {
    return new URL(`https://${text}`).hostname.replace(/\.+$/, '');
  } catch {
    return '';
  }
}

const isProduction = hostname => PRODUCTION_HOSTS.includes(hostname);

/**
 * Checks one remote base URL of a staging target. Returns its origin, or throws saying why.
 * Production is refused first, so no spelling of it gets through on another rule's account.
 */
export function stagingOrigin(value, what = 'url') {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error(`${what}: not a URL`);
  }
  const hostname = normaliseHost(url.hostname);
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isProduction(hostname)) throw new Error(`${what}: ${hostname} is a production host`);
  if (url.protocol !== 'https:') throw new Error(`${what}: https only`);
  if (url.username || url.password) throw new Error(`${what}: no userinfo`);
  if (url.port) throw new Error(`${what}: no port`);
  if (isIP(bare)) throw new Error(`${what}: no IP address`);
  const first = hostname.split('.')[0];
  if (!(first === 'staging' || first.endsWith('-staging'))) {
    throw new Error(`${what}: ${hostname} is not a staging host (its first label must be "staging" or end in "-staging")`);
  }
  return url.origin;
}

// The local target: loopback over http only.
export function loopbackOrigin(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error(`local: ${url.origin} is not a loopback http origin`);
  }
  return url.origin;
}

export function stagingScript(name) {
  const script = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(script)) throw new Error(`worker_script ${JSON.stringify(script)}: not a Worker name`);
  if (PRODUCTION_SCRIPTS.includes(script)) throw new Error(`worker_script ${script}: a production Worker`);
  if (!script.endsWith('-staging')) throw new Error(`worker_script ${script}: must end in -staging`);
  return script;
}

// ── Targets ──
// abtest-targets.local.json (gitignored): { "<name>": { arms: { A: {...}, B: {...} }, ... } }, see
// abtest-targets.example.json. Each arm names a Worker base URL and a chat path; B's Worker has
// EC2_PROXY_PREFIXES covering chat, A's has none.
export function loadTarget(name, { file, read = path => readFileSync(path, 'utf8') } = {}) {
  if (!name) throw new Error('--target <name> is required (a name from the targets file, or local)');
  if (/[/:]/.test(name)) throw new Error('--target takes a name from the targets file, never a URL');
  if (name === 'local') return { name: 'local', kind: 'local', database: 'none', allowRealUpstream: false, maxConcurrency: 16, maxRequestsPerRun: 400 };
  let all;
  try {
    all = JSON.parse(read(file));
  } catch (error) {
    throw new Error(`cannot read the targets file ${file}: ${error.code || error.message}`);
  }
  const raw = all?.[name];
  if (!raw || typeof raw !== 'object') throw new Error(`no target ${name} in ${file}`);
  const arms = {};
  for (const arm of ['A', 'B']) {
    const spec = raw.arms?.[arm];
    if (!spec) throw new Error(`target ${name}: arm ${arm} is missing`);
    const path = String(spec.path || '/v1/chat/completions');
    if (!/^\/[A-Za-z0-9/_.-]*$/.test(path)) throw new Error(`target ${name}: arm ${arm} path ${path}`);
    arms[arm] = { base: stagingOrigin(spec.worker_base, `${name}.arms.${arm}.worker_base`), path,
      script: spec.worker_script ? stagingScript(spec.worker_script) : null };
  }
  const database = raw.database === 'shared-production' ? 'shared-production' : 'staging';
  const target = {
    name, kind: 'staging', arms, database,
    ec2Origin: raw.ec2_origin ? stagingOrigin(raw.ec2_origin, `${name}.ec2_origin`) : null,
    synthBase: raw.synth_base ? stagingOrigin(raw.synth_base, `${name}.synth_base`) : null,
    accountEmail: String(raw.account_email || ''),
    model: String(raw.model || 'auto'),
    allowRealUpstream: raw.allow_real_upstream === true,
    maxConcurrency: Math.min(Number(raw.max_concurrency) || DEFAULTS.concurrency, CAPS.concurrency),
    maxRequestsPerRun: Math.min(Number(raw.max_requests_per_run) || DEFAULTS.requestsPerRun, CAPS.requestsPerRun),
    // Only printed in the operator's commands (S10-S12), never used to connect.
    vm: raw.vm ? {
      instanceId: /^i-[0-9a-f]{8,17}$/.test(raw.vm.instance_id) ? raw.vm.instance_id : null,
      knownHosts: /^[\w./~-]+$/.test(raw.vm.known_hosts || '') ? raw.vm.known_hosts : null,
      envFile: /^[\w./~-]+$/.test(raw.vm.env_file || '') ? raw.vm.env_file : null,
    } : null,
  };
  if (!target.accountEmail.includes('@')) throw new Error(`target ${name}: account_email (the dedicated test account) is required`);
  // The shared-production profile: a smoke test only (AB-TEST.md).
  if (database === 'shared-production') {
    target.maxConcurrency = Math.min(target.maxConcurrency, 2);
    target.maxRequestsPerRun = Math.min(target.maxRequestsPerRun, 50);
  }
  return target;
}

// ── Network guard ──
/**
 * Replaces globalThis.fetch with one that reaches only `origins`, never follows a redirect, and
 * refuses everything once the run ends. Returns the uninstall function.
 */
export function installFetchGuard(origins, { target = globalThis } = {}) {
  const allowed = new Set(origins);
  const original = target.fetch;
  target.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowed.has(url.origin)) return Promise.reject(new Error(`abtest guard: ${url.origin} is not one of this run's origins`));
    return original(input, { ...init, redirect: 'manual' });
  };
  return () => { target.fetch = original; };
}

// ── Credential ──
const API_KEY = /^nzx_[A-Za-z0-9_-]{43}$/;
const SESSION = /^ses_[A-Za-z0-9_-]{1,128}$/;
export const tokenLabel = token => `${String(token).slice(0, 12)}...`;

/** Refuses a credential on the command line (process lists and shell history keep it). */
export function refuseTokenArgs(argv) {
  for (const arg of argv) {
    if (/^--(?:token|key|api-key|session)(?:=|$)/i.test(arg) || /^(?:nzx|ses)_/.test(arg)) {
      throw new Error('a credential never goes on the command line: use the hidden prompt or ZEROX_AB_TOKEN (nzx_ keys only)');
    }
  }
}

/**
 * The run's credential: ZEROX_AB_TOKEN (an nzx_ API key only; PLATFORM_CONTRACT.md says never to
 * export a session token), or a hidden prompt (either kind).
 */
export async function readToken({ env = process.env, prompt } = {}) {
  const fromEnv = String(env.ZEROX_AB_TOKEN || '').trim();
  if (fromEnv) {
    if (SESSION.test(fromEnv)) throw new Error('ZEROX_AB_TOKEN holds a session token: type it at the hidden prompt instead');
    if (!API_KEY.test(fromEnv)) throw new Error('ZEROX_AB_TOKEN is not an nzx_ API key');
    return fromEnv;
  }
  if (!prompt) throw new Error('no credential: set ZEROX_AB_TOKEN (nzx_ key) or run on a terminal for the hidden prompt');
  const typed = String(await prompt('Test account credential (nzx_ or ses_, not echoed): ')).trim();
  if (!API_KEY.test(typed) && !SESSION.test(typed)) throw new Error('not an nzx_ key or a ses_ token');
  return typed;
}

/** A hidden prompt on a TTY (no echo). */
export function hiddenPrompt(stdin = process.stdin, stdout = process.stdout) {
  return question => new Promise((resolve, reject) => {
    if (!stdin.isTTY) { reject(new Error('no terminal for the hidden prompt (in Git Bash use winpty, or ZEROX_AB_TOKEN)')); return; }
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    const done = error => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

// ── Per-UTC-day ledger of requests sent to remote targets ──
export function ledgerPath(env = process.env) {
  const dir = env.LOCALAPPDATA || join(homedir(), '.local', 'share');
  return join(dir, 'zerox-abtest', 'ledger.json');
}

export function reserveRequests(count, { path = ledgerPath(), limit = DEFAULTS.requestsPerDay, now = new Date() } = {}) {
  if (limit > CAPS.requestsPerDay) throw new Error(`the daily limit is at most ${CAPS.requestsPerDay}`);
  const day = now.toISOString().slice(0, 10);
  let ledger = {};
  try { ledger = JSON.parse(readFileSync(path, 'utf8')); } catch { /* a new ledger */ }
  const used = Number(ledger[day] || 0);
  if (used + count > limit) throw new Error(`today's ledger (${used} sent) leaves no room for ${count} more requests (limit ${limit} per UTC day)`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ [day]: used + count }));
  return used + count;
}
