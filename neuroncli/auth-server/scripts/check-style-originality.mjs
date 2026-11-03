// Local originality check for the house style preface (src/house-style.js): fails when the text
// shares any run of four words with the skill files of the projects NOTICE credits (Ponytail,
// gstack, anti-slop), which the Neuron client bundles. It is a local script, not part of
// `npm test` or CI: those skill files live in the neuron repository, not in this one.
//
//   node scripts/check-style-originality.mjs <skills-dir> [<skills-dir> ...]
//   ZEROX_BUNDLED_SKILLS="<dir>" node scripts/check-style-originality.mjs      (path-delimiter separated)
//
// Reads *.md files below each directory and nothing else; sends nothing anywhere. With no
// directory it says so and exits 0 (nothing was compared). Exit 1 means a shared shingle: reword.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_STYLE_TEXT } from '../src/house-style.js';

export const SHINGLE_WORDS = 4;

const words = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Every run of `size` consecutive words, as space-joined strings.
export function shingles(text, size = SHINGLE_WORDS) {
  const all = words(text);
  const found = new Set();
  for (let index = 0; index + size <= all.length; index++) found.add(all.slice(index, index + size).join(' '));
  return found;
}

// The shingles of `text` that appear in any of `sources` ({ name, text }), with where they came from.
export function sharedShingles(text, sources, size = SHINGLE_WORDS) {
  const mine = shingles(text, size);
  const shared = new Map();
  for (const source of sources) {
    for (const shingle of shingles(source.text, size)) {
      if (!mine.has(shingle)) continue;
      shared.set(shingle, [...(shared.get(shingle) ?? []), source.name]);
    }
  }
  return [...shared].map(([shingle, names]) => ({ shingle, sources: [...new Set(names)] }));
}

function markdownFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(directory, name);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...markdownFiles(path));
    else if (info.isFile() && /\.md$/i.test(name)) files.push(path);
  }
  return files;
}

export function loadSources(directories) {
  return directories.flatMap(directory => markdownFiles(directory).map(path => ({ name: path, text: readFileSync(path, 'utf8') })));
}

export function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const directories = argv.length ? argv : String(env.ZEROX_BUNDLED_SKILLS ?? '').split(delimiter).filter(Boolean);
  if (!directories.length) {
    out.log('SKIPPED: pass the skills directory (argument or ZEROX_BUNDLED_SKILLS); nothing was compared.');
    return 0;
  }
  const sources = loadSources(directories);
  if (!sources.length) {
    out.error('No .md files found in: ' + directories.join(', '));
    return 2;
  }
  const shared = sharedShingles(HOUSE_STYLE_TEXT, sources);
  if (shared.length) {
    for (const item of shared) out.error(`shared ${SHINGLE_WORDS}-word run "${item.shingle}" with ${item.sources.length} file(s), e.g. ${item.sources[0]}`);
    out.error(`FAIL: ${shared.length} shared ${SHINGLE_WORDS}-word run(s); reword the preface.`);
    return 1;
  }
  out.log(`PASS: no ${SHINGLE_WORDS}-word run of the preface appears in ${sources.length} skill file(s).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
