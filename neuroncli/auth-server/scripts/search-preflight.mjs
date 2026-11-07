#!/usr/bin/env node
// Read-only preflight for web search (POST /v1/search, docs/PLATFORM_CONTRACT.md section 17).
// Reports which backend is configured and whether the route would answer 200 instead of 503
// search_unavailable. It makes no network call, writes nothing and never prints a value: only the
// names SEARXNG_URL, BRAVE_API_KEY and EC2_PROXY_PREFIXES, their state and verdicts.
//
//   node scripts/search-preflight.mjs --target vm --from-file /etc/zerox/gateway.env
//   node scripts/search-preflight.mjs --target worker          # reads process.env
//   node scripts/search-preflight.mjs --target vm --json
//
// --target vm      the Node server on EC2: SearXNG and Brave, SearXNG first. The VM only receives
//                  /v1/search when the Worker forwards it (EC2_PROXY_PREFIXES covering /v1/).
// --target worker  the Cloudflare Worker serving the request itself: Brave only, because it cannot
//                  reach a private SearXNG (deploy.yml never binds SEARXNG_URL to it).
// (Not --env-file: node itself claims that flag.)
// Exit 0: search would work. 1: it would answer 503. 2: bad usage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searxngBase, searchBackends } from '../src/search.js';
import { parseProxyPrefixes } from '../src/ec2-proxy.js';

const NAMES = ['SEARXNG_URL', 'BRAVE_API_KEY', 'EC2_PROXY_PREFIXES'];
const SEARCH_PATH = 'zero-x.live/v1/search';

// KEY=VALUE lines of an env file, only for the wanted names. Comments, `export` and quotes handled.
export function parseEnvFile(text, wanted = NAMES) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !wanted.includes(match[1])) continue;
    const quoted = /^(["'])(.*)\1/.exec(match[2]);
    out[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '');
  }
  return out;
}

const isPrivateHost = host => host === 'localhost' || /^127\./.test(host) || /^10\./.test(host)
  || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.');

export function searchPreflight(env = {}, target = 'vm') {
  const problems = [];
  const warnings = [];
  const forwarded = parseProxyPrefixes(env.EC2_PROXY_PREFIXES).prefixes.some(prefix => SEARCH_PATH.startsWith(prefix));
  const set = name => String(env[name] || '').trim() !== '';
  // The Worker never sees SearXNG in production; on the VM both backends apply.
  const backends = searchBackends(target === 'worker' ? { ...env, SEARXNG_URL: undefined } : env);
  const braveUsable = searchBackends({ BRAVE_API_KEY: env.BRAVE_API_KEY }).includes('brave');
  const vars = {
    SEARXNG_URL: !set('SEARXNG_URL') ? 'unset' : searxngBase(env) ? 'set' : 'set-but-invalid',
    BRAVE_API_KEY: !set('BRAVE_API_KEY') ? 'unset' : braveUsable ? 'set' : 'set-but-invalid',
    EC2_PROXY_PREFIXES: forwarded ? 'covers /v1/search' : set('EC2_PROXY_PREFIXES') ? 'does not cover /v1/search' : 'unset',
  };

  if (vars.SEARXNG_URL === 'set-but-invalid') problems.push('SEARXNG_URL is set but not a usable base URL (http or https, no credentials, query or fragment).');
  if (vars.BRAVE_API_KEY === 'set-but-invalid') problems.push('BRAVE_API_KEY is set but not a usable token (8-256 visible ASCII characters).');
  if (vars.SEARXNG_URL === 'unset' && vars.BRAVE_API_KEY === 'unset') {
    problems.push('neither SEARXNG_URL nor BRAVE_API_KEY is set: /v1/search answers 503 search_unavailable.');
  }
  if (target === 'worker' && vars.SEARXNG_URL !== 'unset') {
    warnings.push('SEARXNG_URL is visible to the Worker, which cannot reach a private host: it would wait up to 8 s before each fallback. Keep it a VM-only secret.');
    if (!backends.length) problems.push('the Worker has no usable backend: it never uses SearXNG, so only BRAVE_API_KEY can serve search on the Worker.');
  }
  if (target === 'worker' && forwarded) warnings.push('The Worker forwards /v1/search to the VM: also check the VM with --target vm, that is what users will hit.');
  if (target === 'vm' && backends.includes('searxng') && !forwarded) {
    const text = 'SearXNG is reachable from the VM only, but EC2_PROXY_PREFIXES does not cover /v1/search, so the Worker answers every search itself and SearXNG is never asked.';
    if (backends.includes('brave')) warnings.push(`${text} Brave still answers.`);
    else problems.push(text);
  }
  const base = searxngBase(env);
  if (target === 'vm' && base) {
    const url = new URL(base);
    if (!isPrivateHost(url.hostname)) warnings.push('SEARXNG_URL does not look private: SearXNG must be reachable from the VM only, with no public port.');
  }
  if (vars.SEARXNG_URL === 'set' && vars.BRAVE_API_KEY === 'set') {
    warnings.push('Both backends are set: SearXNG answers first and Brave is the fallback (the go-live runbook suggests one; both is allowed).');
  }

  const ready = problems.length === 0 && backends.length > 0;
  return { target, ready, status: ready ? 200 : 503, backends, vars, problems, warnings,
    note: 'Config only: no request was made. Run the smoke test in docs/SEARCH_SETUP.md to prove a backend answers.' };
}

function main(argv) {
  const args = { target: 'vm', file: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--from-file') args.file = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else { console.error('unknown argument'); return 2; }
  }
  if (!['vm', 'worker'].includes(args.target)) { console.error('--target must be vm or worker'); return 2; }
  let env = process.env;
  if (args.file) {
    try { env = parseEnvFile(readFileSync(args.file, 'utf8')); } catch { console.error('cannot read the --from-file'); return 2; }
  }
  const report = searchPreflight(env, args.target);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`web search preflight (${report.target})`);
    for (const [name, state] of Object.entries(report.vars)) console.log(`  ${name}: ${state}`);
    console.log(`  backends in order: ${report.backends.join(', ') || 'none'}`);
    for (const text of report.problems) console.log(`  PROBLEM: ${text}`);
    for (const text of report.warnings) console.log(`  warning: ${text}`);
    console.log(`  verdict: ${report.ready ? 'POST /v1/search would answer 200' : 'POST /v1/search would answer 503 search_unavailable'}`);
    console.log(`  ${report.note}`);
  }
  return report.ready ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
