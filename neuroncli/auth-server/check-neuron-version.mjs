// Keeps the website on the Neuron release named in src/neuron-release.js. Fails when a page,
// llms.txt, a site script, a release manifest or the Worker source:
//   - names another Neuron 7.0.0 build (7.0.0-alpha.N, v7.0.0-alpha.N, or PyPI's 7.0.0aN);
//   - shows an install.sh, install.ps1 or Command Prompt installer that is not the current one;
//   - shows a pip install of neuroncli without --pre while Neuron 7 is a pre-release (plain pip
//     installs the old, unsupported 6.2.4), or an unpinned releases/latest installer;
//   - still says npm or PyPI do not have Neuron 7;
//   - has a Neuron JSON-LD block whose softwareVersion or downloadUrl is not the current release.
// Run: node check-neuron-version.mjs (part of check:production and check:web).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEURON_INSTALL, NEURON_PRERELEASE, NEURON_PYPI_VERSION, NEURON_RELEASE_URL, NEURON_VERSION,
} from './src/neuron-release.js';
import { unreleasedManifest } from './src/routes/releases.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SITE_EXTENSIONS = /\.(?:html|js|json|txt|xml)$/;
// Not part of the site: tooling, media, the VM kit, and the gateway's own checks and docs. The
// gateway's src/ (the Worker and the Node server) is scanned.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', '.claude', 'Assets', 'videos', 'anti-slop', 'deploy', 'output', 'tmp']);
const GATEWAY = join('neuroncli', 'auth-server');
const SKIP_FILES = new Set([join(GATEWAY, 'src', 'neuron-release.js')]);

function siteFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(ROOT, path);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (rel === GATEWAY) { siteFiles(join(path, 'src'), found); continue; }
      siteFiles(path, found);
    } else if (SITE_EXTENSIONS.test(entry.name) && !SKIP_FILES.has(rel)) {
      found.push(rel);
    }
  }
  return found;
}

const decode = text => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const problems = [];
const report = (file, text, index, message) => {
  const line = text.slice(0, index).split('\n').length;
  problems.push(`${file.split(sep).join('/')}:${line}: ${message}`);
};

const files = siteFiles();
assert.ok(files.includes('index.html') && files.includes('llms.txt') && files.includes(join(GATEWAY, 'src', 'index.js')), 'the scan reaches the pages, llms.txt and the Worker');

const OTHER_BUILD = /(?<![\d.])7\.0\.0(?:-(?:alpha|beta|rc)\.\d+|(?:a|b|rc)\d+)(?!\d)/g;
const PIP_INSTALL = /\bpip(?:x|3)?\s+install\b[^\n<`"']*?\bneuroncli\b/g;
const STALE_WORDING = /not on npm or pip yet|not yet: (?:npm|pypi)|(?:npm|pypi) still serves/gi;
const INSTALLERS = [
  ['install.ps1', /&(?:amp;)? \(\[scriptblock\]::Create\(\(irm [^)\s]*\/install\.ps1\)\)\)[^<\n`"]*/g, NEURON_INSTALL.powershell],
  ['install.sh', /curl -fsSL [^\s<`"]*\/install\.sh[^<\n`"]*/g, NEURON_INSTALL.shell],
  ['Command Prompt', /powershell(?:\.exe)? -NoProfile[^<\n`]*/g, NEURON_INSTALL.cmd],
];

for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  for (const match of text.matchAll(OTHER_BUILD)) {
    if (match[0] !== NEURON_VERSION && match[0] !== NEURON_PYPI_VERSION) {
      report(file, text, match.index, `names Neuron ${match[0]}; the current release is ${NEURON_VERSION} (src/neuron-release.js)`);
    }
  }
  if (NEURON_PRERELEASE) {
    for (const match of text.matchAll(PIP_INSTALL)) {
      if (!/(?:^|\s)--pre(?:\s|$)/.test(match[0])) report(file, text, match.index, `"${match[0]}" needs --pre while Neuron 7 is a pre-release (plain pip installs the unsupported 6.2.4)`);
    }
    for (const match of text.matchAll(/releases\/latest\/download\/install\./g)) {
      report(file, text, match.index, 'unpinned installer: a pre-release is never the latest release, so name the version');
    }
  }
  for (const match of text.matchAll(STALE_WORDING)) {
    report(file, text, match.index, `"${match[0]}": npm and PyPI serve Neuron ${NEURON_VERSION}`);
  }
  for (const [name, pattern, expected] of INSTALLERS) {
    for (const match of text.matchAll(pattern)) {
      const shown = decode(match[0]).trimEnd();
      if (shown !== expected) report(file, text, match.index, `${name} command differs from src/neuron-release.js:\n    shown:    ${shown}\n    expected: ${expected}`);
    }
  }
  if (file.endsWith('.html')) {
    for (const block of text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const data = JSON.parse(block[1]);
      for (const node of [data, ...(data['@graph'] || [])]) {
        if (node['@id'] !== 'https://zero-x.live/#neuron' && node.name !== 'Neuron CLI') continue;
        if (node.softwareVersion !== undefined && node.softwareVersion !== NEURON_VERSION) report(file, text, block.index, `JSON-LD softwareVersion ${node.softwareVersion}, not ${NEURON_VERSION}`);
        if (node.downloadUrl !== undefined && node.downloadUrl !== NEURON_RELEASE_URL) report(file, text, block.index, `JSON-LD downloadUrl ${node.downloadUrl}, not ${NEURON_RELEASE_URL}`);
      }
    }
  }
}

// The update manifests the CLI and the /download page read: the committed one and the Worker's
// built-in fallback offer the same npm and pip commands as the pages.
const committed = JSON.parse(readFileSync(join(ROOT, 'releases', 'cli', 'latest.json'), 'utf8'));
for (const [label, manifest] of [['releases/cli/latest.json', committed], ['unreleasedManifest("cli")', unreleasedManifest('cli')]]) {
  for (const method of ['npm', 'pip']) {
    if (manifest.install?.[method] !== NEURON_INSTALL[method]) problems.push(`${label}: install.${method} is "${manifest.install?.[method]}", not "${NEURON_INSTALL[method]}"`);
  }
}

// The checks themselves: each pattern catches what it is for.
assert.deepEqual(['v7.0.0-alpha.2/install.sh', 'Neuron 7.0.0-alpha.3.', '7.0.0a3', '7.0.0-alpha.41'].map(s => s.match(OTHER_BUILD)?.[0]),
  ['7.0.0-alpha.2', '7.0.0-alpha.3', '7.0.0a3', '7.0.0-alpha.41']);
assert.equal('version 17.0.0-alpha.2'.match(OTHER_BUILD), null, 'another product version is not a Neuron build');
assert.deepEqual(['python -m pip install neuroncli', 'pip install --upgrade --pre neuroncli</code>'].map(s => s.match(PIP_INSTALL)?.[0]),
  ['pip install neuroncli', 'pip install --upgrade --pre neuroncli']);
assert.equal('Not on npm or pip yet: npm still serves 6.2.0. Not yet: PyPI 6.2.4.'.match(STALE_WORDING).length, 3);
assert.ok(NEURON_INSTALL.cmd.startsWith('powershell -NoProfile ') && NEURON_INSTALL.cmd.includes(`"${NEURON_INSTALL.powershell}"`), 'the Command Prompt command runs the PowerShell one');
assert.ok(NEURON_INSTALL.powershell.endsWith(' -AddToPath'), 'the PowerShell installer puts neuron on PATH');

assert.equal(problems.length, 0, `${problems.length} stale Neuron install mention(s):\n  ${problems.join('\n  ')}`);
console.log(`PASS: ${files.length} site files name Neuron ${NEURON_VERSION} only, with the current installers, pip --pre and JSON-LD; manifests offer the same npm and pip commands`);
