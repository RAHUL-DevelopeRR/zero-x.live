// Ask IndexNow search engines (Bing, Yandex, Seznam, Naver and others) to recrawl public pages after a deploy.
// Google does not use IndexNow; it reads the sitemap. Usage:
//   node submit-indexnow.mjs [--since <git sha>] [--dry-run]
// With --since, only pages whose files changed after that commit are sent; otherwise every page in seo-pages.json.
import {readFile, readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root = new URL('../../', import.meta.url);
const pages = JSON.parse(await readFile(new URL('seo-pages.json', root), 'utf8'));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

// The key file at the site root (<key>.txt containing the key) proves we own the host.
const keyFiles = (await readdir(root)).filter(name => /^[0-9a-f]{32}\.txt$/.test(name));
if (keyFiles.length !== 1) throw new Error('Expected one IndexNow key file at the site root, found ' + keyFiles.length);
const key = keyFiles[0].slice(0, -4);
if ((await readFile(new URL(keyFiles[0], root), 'utf8')).trim() !== key) throw new Error('IndexNow key file content does not match its name');

let urls = pages.map(page => page.url);
const since = arg('--since');
if (since && !/^0+$/.test(since)) {
  try {
    const changed = execFileSync('git', ['diff', '--name-only', since, 'HEAD'], {cwd: root, encoding: 'utf8'}).split('\n');
    urls = pages.filter(page => changed.includes(page.file)).map(page => page.url);
  } catch { /* Unknown commit (for example after a force push): send every page. */ }
}
if (!urls.length) { console.log('IndexNow: no public pages changed.'); process.exit(0); }

const body = {host: 'zero-x.live', key, keyLocation: `https://zero-x.live/${key}.txt`, urlList: urls};
if (process.argv.includes('--dry-run')) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: {'Content-Type': 'application/json; charset=utf-8'}, body: JSON.stringify(body),
});
// 200 = accepted, 202 = accepted while the key is being verified.
console.log(`IndexNow: ${response.status} for ${urls.length} URL(s)`);
if (!response.ok) process.exit(1);
