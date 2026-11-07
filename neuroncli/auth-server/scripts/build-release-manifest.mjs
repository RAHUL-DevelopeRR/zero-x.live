#!/usr/bin/env node
// Builds releases/cli/latest.json (docs/RELEASE_MANIFESTS.md) from a published GitHub release of
// the Neuron repository: the real asset names and sizes, and the sha256 of every binary from the
// release's SHA256SUMS. Read-only against GitHub (`gh release view`, `gh release download -O -`),
// and idempotent: the same release always yields the same file.
//
//   node scripts/build-release-manifest.mjs                       write releases/cli/latest.json for the site's release
//   node scripts/build-release-manifest.mjs --tag v7.0.0-alpha.4  name the release
//   node scripts/build-release-manifest.mjs --check               exit 1 when the committed file differs
//   node scripts/build-release-manifest.mjs --out -               print instead of writing
//
// Needs the GitHub CLI (`gh`), signed in. A binary without a checksum, a checksum without its
// asset, or a GitHub digest that disagrees with SHA256SUMS stops the run: nothing is guessed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NEURON_INSTALL, NEURON_REPOSITORY, NEURON_VERSION } from '../src/neuron-release.js';
import { validateReleaseManifest } from '../src/routes/releases.js';

const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64'];
const BINARY = /^neuron-(tui-)?(linux-x64|linux-arm64|macos-arm64|macos-x64|windows-x64|windows-arm64)(\.exe)?$/;
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const OUTPUT = fileURLToPath(new URL('../../../releases/cli/latest.json', import.meta.url));

// "<64 hex>  <file>" lines (sha256sum output; a leading "*" marks binary mode). Other lines are ignored.
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

// release: { tag, publishedAt, assets: [{ name, size, digest? }], sums: SHA256SUMS text }
export function buildCliManifest({ tag, publishedAt, assets, sums }) {
  if (!TAG.test(String(tag))) throw new Error(`tag "${tag}" is not a release tag such as v7.0.0-alpha.4`);
  const checksums = parseSha256Sums(sums);
  const attached = new Map((assets || []).map(asset => [asset.name, asset]));
  for (const file of checksums.keys()) {
    if (BINARY.test(file) && !attached.has(file)) throw new Error(`SHA256SUMS lists ${file}, which is missing from the release assets`);
  }
  const base = `https://github.com/${NEURON_REPOSITORY}/releases`;
  const downloads = [...attached.values()].filter(asset => BINARY.test(asset.name)).map(asset => {
    const [, tui, platform] = BINARY.exec(asset.name);
    const sha256 = checksums.get(asset.name);
    if (!sha256) throw new Error(`no checksum for ${asset.name} in SHA256SUMS`);
    const digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '').toLowerCase() : null;
    if (digest && digest !== sha256) throw new Error(`the GitHub digest of ${asset.name} does not match SHA256SUMS`);
    return { platform, kind: tui ? 'tui' : 'cli', file: asset.name, url: `${base}/download/${tag}/${asset.name}`, sha256, size: asset.size };
  }).sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.kind.localeCompare(b.kind));
  const manifest = {
    schema_version: 1, product: 'cli', channel: 'stable', version: tag.slice(1),
    released_at: new Date(publishedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    notes_url: `${base}/tag/${tag}`, minimum_version: null, downloads,
    checksums_url: `${base}/download/${tag}/SHA256SUMS`,
    install: { npm: NEURON_INSTALL.npm, pip: NEURON_INSTALL.pip, powershell: NEURON_INSTALL.powershell, shell: NEURON_INSTALL.shell },
  };
  const problems = validateReleaseManifest(manifest, 'cli');
  if (problems.length) throw new Error(`the generated manifest is invalid: ${problems.slice(0, 5).join('; ')}`);
  return manifest;
}

const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export function fetchRelease(tag) {
  const view = JSON.parse(gh(['release', 'view', tag, '--repo', NEURON_REPOSITORY, '--json', 'assets,publishedAt,isDraft']));
  if (view.isDraft) throw new Error(`${tag} is a draft release`);
  const sums = gh(['release', 'download', tag, '--repo', NEURON_REPOSITORY, '-p', 'SHA256SUMS', '-O', '-']);
  return { tag, publishedAt: view.publishedAt, assets: view.assets, sums };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { tag: { type: 'string', default: `v${NEURON_VERSION}` }, out: { type: 'string', default: OUTPUT }, check: { type: 'boolean', default: false } } });
  const text = JSON.stringify(buildCliManifest(fetchRelease(values.tag)), null, 2) + '\n';
  if (values.check) {
    const current = readFileSync(values.out, 'utf8').replace(/\r\n/g, '\n');
    if (current !== text) { console.error(`${values.out} is out of date: run node scripts/build-release-manifest.mjs`); process.exit(1); }
    console.log(`${values.out} matches ${values.tag}`);
  } else if (values.out === '-') process.stdout.write(text);
  else { writeFileSync(values.out, text); console.log(`wrote ${values.out} for ${values.tag}`); }
}
