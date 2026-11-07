#!/usr/bin/env node
// Makes CONNECTOR_TOKENS_KEK (32 random bytes, base64) for hosted connectors without ever printing it.
//
//   node scripts/connector-kek.mjs --out <path>            write to a file outside the repository
//   node scripts/connector-kek.mjs --gh-secret [--env E] [--repo O/R] [--name NAME]
//                                                          pipe to `gh secret set` (owner runs this)
//   node scripts/connector-kek.mjs --gh-secret --dry-run   print the gh command, make no key
//   node scripts/connector-kek.mjs --check <path>          say whether a file holds a valid key
//
// --out and --gh-secret may be combined (one key, both places). An existing file is kept unless
// --force. The file is created owner-only (mode 0600; on Windows the ACL is reduced to the current
// user with icacls, best effort). A key inside the repository is refused. Never reuse
// PROVIDER_KEYS_KEK: this script refuses that secret name. Keep the file as the only backup: losing
// the key makes every linked connector account unreadable (users connect again).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_NAME = 'CONNECTOR_TOKENS_KEK';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const fail = message => { console.error(`error: ${message}`); process.exit(1); };

function parseArgs(argv) {
  const opts = { force: false, dryRun: false, ghSecret: false, name: DEFAULT_NAME };
  const takes = new Set(['--out', '--check', '--env', '--repo', '--name']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--gh-secret') opts.ghSecret = true;
    else if (takes.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else fail(`unknown argument ${arg}`);
  }
  return opts;
}

export function insideRepository(path, root = REPO_ROOT) {
  const target = resolve(path);
  // Resolve the nearest existing parent so a symlinked folder cannot hide a repository path.
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = resolve(realpathSync(probe), relative(probe, target));
  const rel = relative(realpathSync(root), real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isValidKek(text) {
  const raw = String(text).trim();
  return /^[A-Za-z0-9+/]{43}=$/.test(raw) && Buffer.from(raw, 'base64').length === 32;
}

function restrict(path) {
  try { chmodSync(path, 0o600); } catch { /* not supported on this file system */ }
  if (process.platform !== 'win32') return 'mode 0600';
  const user = process.env.USERNAME || userInfo().username;
  const res = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { encoding: 'utf8' });
  return res.status === 0 ? `ACL limited to ${user}` : 'could not limit the ACL: check the file permissions yourself';
}

function ghArgs(opts) {
  const args = ['secret', 'set', opts.name];
  if (opts.env) args.push('--env', opts.env);
  if (opts.repo) args.push('--repo', opts.repo);
  return args;
}

function validate(opts) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(opts.name)) fail('--name must be an upper-case secret name');
  if (opts.name === 'PROVIDER_KEYS_KEK') fail('never reuse PROVIDER_KEYS_KEK for connector tokens');
  if (opts.env !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.env)) fail('--env is not a valid environment name');
  if (opts.repo !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) fail('--repo must be owner/repo');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  validate(opts);

  if (opts.check !== undefined) {
    let text;
    try { text = readFileSync(opts.check, 'utf8'); } catch { fail('cannot read that file'); }
    if (!isValidKek(text)) fail('not a valid key: expected 32 bytes of base64');
    console.log('valid: 32 bytes of base64 (value not shown)');
    return;
  }

  if (opts.out === undefined && !opts.ghSecret) {
    fail('choose a destination: --out <path> and/or --gh-secret (nothing is printed to the terminal)');
  }

  if (opts.dryRun) {
    if (opts.out !== undefined) console.log(`would write a new key to ${resolve(opts.out)}`);
    if (opts.ghSecret) console.log(`would run: gh ${ghArgs(opts).join(' ')}  (key on stdin)`);
    return;
  }

  if (opts.out !== undefined) {
    if (insideRepository(opts.out)) fail('refusing to write a key inside the repository; choose a path outside it');
    if (existsSync(opts.out) && !opts.force) fail(`${opts.out} exists; use --force to replace it`);
  }

  const key = randomBytes(32).toString('base64');
  if (opts.out !== undefined) {
    try { writeFileSync(opts.out, `${key}\n`, { mode: 0o600, flag: 'w' }); } catch { fail('cannot write that path'); }
    console.log(`wrote a new ${opts.name} to ${resolve(opts.out)} (${restrict(opts.out)}); the value is not shown`);
  }
  if (opts.ghSecret) {
    const res = spawnSync('gh', ghArgs(opts), { input: key, encoding: 'utf8' });
    if (res.error || res.status !== 0) fail('gh secret set failed (is gh installed and signed in?)');
    console.log(`set ${opts.name} with gh${opts.env ? ` in environment ${opts.env}` : ''}; the value is not shown`);
  }
  console.log('next: run the same key on every runtime that serves /mcp/ (Worker and EC2); back the file up somewhere safe.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
