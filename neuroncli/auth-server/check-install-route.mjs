// The short install commands: GET https://zero-x.live/install.ps1 and /install.sh (src/install-scripts.js),
// offline through the Worker entry (src/index.js), the same app the Node server runs.
// - Each answers 200 text/plain with a bootstrap that runs the installer of one tagged GitHub release
//   with that version (and -AddToPath on Windows). Never releases/latest: every Neuron release is a
//   GitHub pre-release, so releases/latest and the latest-release API answer 404.
// - The release is wrangler.toml [vars] NEURON_INSTALL_VERSION, which must equal NEURON_VERSION in
//   src/neuron-release.js (the pages and the installer name one build); a bad value falls back to it.
// - Not a static file: the asset fallback (and its 404 page) never answers these paths, and the
//   security headers do not get in the way of irm or curl (no redirect, no HTML, a public cache).
//   node check-install-route.mjs           offline
//   node check-install-route.mjs --live    also fetch the tagged GitHub installers (follows redirects)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wranglerVars } from '../../deploy/aws/gateway-env.mjs';
import app from './src/index.js';
import {
  INSTALL_SCRIPT_MAX_AGE_SECONDS, INSTALL_SCRIPT_PATH, installVersion, installerUrl, posixInstallScript, windowsInstallScript,
} from './src/install-scripts.js';
import { NEURON_INSTALL, NEURON_VERSION } from './src/neuron-release.js';

const ok = name => console.log(`ok - ${name}`);
const vars = wranglerVars(readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8'));
assert.equal(vars.NEURON_INSTALL_VERSION, NEURON_VERSION, 'wrangler.toml NEURON_INSTALL_VERSION is the release the site names (src/neuron-release.js)');
ok('wrangler.toml NEURON_INSTALL_VERSION = NEURON_VERSION, and gateway-env.mjs passes it to the Node server');

// A static file server that would answer anything, to prove the route wins over the assets.
const ASSETS = { fetch: request => new Response('static ' + new URL(request.url).pathname, { headers: { 'Content-Type': 'application/octet-stream' } }) };
const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ASSETS, CSP_ENFORCE: 'true', ...vars };
const get = (url, extra = {}, method = 'GET') => app.fetch(new Request(url, { method }), { ...env, ...extra }, { waitUntil() {}, passThroughOnException() {} });

const tag = `v${NEURON_VERSION}`;
const PS1_URL = `https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/${tag}/install.ps1`;
const SH_URL = `https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/${tag}/install.sh`;
assert.equal(installerUrl(NEURON_VERSION, 'install.ps1'), PS1_URL);

for (const [path, url, expected] of [
  ['/install.ps1', PS1_URL, `& ([scriptblock]::Create($installer.TrimStart([char]0xFEFF))) -Version $neuronVersion -AddToPath`],
  ['/install.sh', SH_URL, `printf '%s\\n' "$installer" | sh -s -- --version "$version" "$@"`],
]) {
  for (const host of ['https://zero-x.live', 'https://neuron.zero-x.live', 'https://dashboard.zero-x.live']) {
    const response = await get(host + path);
    assert.equal(response.status, 200, `${host}${path}: 200`);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', `${host}${path}: plain text, which irm returns as a string`);
    assert.equal(response.headers.get('cache-control'), `public, max-age=${INSTALL_SCRIPT_MAX_AGE_SECONDS}`);
    assert.equal(response.headers.get('location'), null, 'no redirect');
    const body = await response.text();
    assert.ok(body.includes(`'${url}'`), `${path} fetches ${url}`);
    assert.ok(body.includes(`'${NEURON_VERSION}'`), `${path} names ${NEURON_VERSION}`);
    assert.ok(body.includes(expected), `${path} runs the installer with the version`);
    assert.doesNotMatch(body, /releases\/latest|api\.github\.com/, `${path}: never the latest release (pre-releases are not)`);
    assert.doesNotMatch(body, /static \//, 'not the static file');
    assert.doesNotMatch(body, /—/, 'no em dash');
  }
  // HEAD (curl -I) and the www host (a redirect to zero-x.live, which irm and curl -L follow).
  const head = await get('https://zero-x.live' + path, {}, 'HEAD');
  assert.equal(head.status, 200, `HEAD ${path}`);
  const www = await get('https://www.zero-x.live' + path);
  assert.ok([200, 301].includes(www.status), `www ${path}: ${www.status}`);
  if (www.status === 301) assert.equal(www.headers.get('location'), 'https://zero-x.live' + path);
}
ok('/install.ps1 and /install.sh answer 200 text/plain bootstraps on every host, pinned to the tagged release, never releases/latest');

// Windows bootstrap: safe under `irm | iex` in the caller's own window.
{
  const ps1 = windowsInstallScript(NEURON_VERSION);
  assert.doesNotMatch(ps1, /^\s*exit\b/m, 'never exits: under iex that would close the window');
  assert.match(ps1, /^& \{$/m, 'variables stay in a child scope');
  assert.match(ps1, /New-Object System\.Net\.WebClient/, 'downloads as text in PowerShell 5.1 and 7');
  assert.match(ps1, /Write-Host "Installing Neuron \$\{neuronVersion\}\. Downloading the installer from GitHub \.\.\."/, '${} keeps the colon-free text');
  assert.match(ps1, /more than 100 MB/, 'says the UI download is large');
  assert.ok(ps1.includes('https://zero-x.live/docs#troubleshooting'), 'points at troubleshooting when the download fails');
  assert.ok(ps1.includes(NEURON_INSTALL.powershell) && ps1.includes(NEURON_INSTALL.cmd), 'its header shows both Windows commands');
  const sh = posixInstallScript(NEURON_VERSION);
  assert.ok(sh.startsWith('#!/bin/sh\n') && sh.includes('\nset -eu\n'), 'sh, stopping at the first error');
  assert.match(sh, /\nmain "\$@"\n$/, 'runs only once fully downloaded');
  assert.ok(sh.includes(NEURON_INSTALL.shell), 'its header shows the command');
  assert.match(sh, /''\|0\|false\|no\) echo "The full-screen UI is a download of more than 100 MB/, "install.sh warns about the UI size by the installer's own NEURON_NO_TUI rule");
  ok('bootstraps: no exit under iex, child scope, text download, size note; install.sh runs only when complete');
}

// The Windows bootstrap, run for real under `iex` (Windows only) against a stub installer read through
// a file: URL. By default (and with NEURON_NO_TUI=0/false/no) it installs the UI too, after a size
// warning, and leaves NEURON_NO_TUI alone; any other value skips the UI without the warning.
if (process.platform === 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'zx-bootstrap-'));
  try {
    const stub = join(dir, 'install.ps1');
    writeFileSync(stub, 'param([string]$Version, [switch]$AddToPath)\nWrite-Host "stub version=$Version addToPath=$AddToPath noTui=[$env:NEURON_NO_TUI]"\n');
    const bootFile = join(dir, 'bootstrap.ps1');
    writeFileSync(bootFile, windowsInstallScript(NEURON_VERSION).replace(`'${PS1_URL}'`, `'${pathToFileURL(stub).href}'`));
    const run = noTui => {
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NEURON_NO_TUI'));
      if (noTui !== undefined) childEnv.NEURON_NO_TUI = noTui;
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Content -Raw '${bootFile}' | Invoke-Expression; "after=[$env:NEURON_NO_TUI]"`], { env: childEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    const SIZE = 'more than 100 MB and shows no progress';
    const ADD = "$env:NEURON_NO_TUI = '0'; irm https://zero-x.live/install.ps1 | iex";
    const plain = run(undefined);
    assert.ok(plain.includes(`stub version=${NEURON_VERSION} addToPath=True noTui=[]`), 'default: the installer installs the UI\n' + plain);
    assert.ok(plain.includes('after=[]'), 'default: NEURON_NO_TUI is left unset');
    assert.ok(plain.includes(SIZE) && !plain.includes(ADD), 'default: warns about the UI download size and prints no second step');
    for (const value of ['0', 'false', 'No']) {
      const out = run(value);
      assert.ok(out.includes(`noTui=[${value}]`) && out.includes(SIZE) && !out.includes(ADD), `NEURON_NO_TUI=${value}: the UI is installed, with the size warning\n${out}`);
      assert.ok(out.includes(`after=[${value}]`), `NEURON_NO_TUI=${value} is kept`);
    }
    for (const value of ['1', 'true', 'yes']) {
      const out = run(value);
      assert.ok(out.includes(`noTui=[${value}]`) && !out.includes(SIZE) && !out.includes(ADD), `NEURON_NO_TUI=${value}: the UI is skipped, no size warning\n${out}`);
    }
    ok("Windows bootstrap under iex: installs the UI by default with a size warning; NEURON_NO_TUI follows the installer's rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The version comes from NEURON_INSTALL_VERSION; anything that is not a version falls back to the site's.
{
  assert.equal(installVersion({ NEURON_INSTALL_VERSION: '7.0.0-alpha.6' }), '7.0.0-alpha.6');
  assert.equal(installVersion({ NEURON_INSTALL_VERSION: 'v7.1.0' }), '7.1.0');
  for (const bad of [undefined, '', 'latest', '7.0', '7.0.0/../../evil', "7.0.0'; Remove-Item", '7.0.0-alpha.5 x']) {
    assert.equal(installVersion({ NEURON_INSTALL_VERSION: bad }), NEURON_VERSION, `falls back for ${JSON.stringify(bad)}`);
  }
  const next = await (await get('https://zero-x.live/install.ps1', { NEURON_INSTALL_VERSION: '7.0.0-alpha.6' })).text();
  assert.ok(next.includes(`'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.6/install.ps1'`), 'a release bump is the one wrangler.toml line');
  ok('NEURON_INSTALL_VERSION picks the release; an invalid value falls back to NEURON_VERSION');
}

// Only these two paths; other install-like paths stay static files (or the 404 page).
assert.ok(INSTALL_SCRIPT_PATH.test('/install.ps1') && INSTALL_SCRIPT_PATH.test('/install.sh'));
for (const path of ['/install.ps1x', '/install', '/x/install.sh', '/install.SH']) assert.ok(!INSTALL_SCRIPT_PATH.test(path), path);
assert.equal(await (await get('https://zero-x.live/install.txt')).text(), 'static /install.txt', 'other files are static');
ok('only /install.ps1 and /install.sh are routes');

if (process.argv.includes('--live')) {
  for (const url of [PS1_URL, SH_URL]) {
    const response = await fetch(url, { redirect: 'follow' });
    assert.equal(response.status, 200, `${url}: ${response.status}`);
    const text = await response.text();
    assert.ok(text.length > 1000, `${url}: an installer`);
  }
  ok('live: the tagged GitHub installers answer 200 after redirects');
}
console.log('PASS: install routes');
