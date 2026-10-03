import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root = new URL('../../', import.meta.url);
const pages = JSON.parse(await readFile(new URL('seo-pages.json', root), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n';
for (const page of pages) {
  const html = await readFile(new URL(page.file, root), 'utf8');
  if (html.includes('content="noindex')) throw new Error('Private page in sitemap: ' + page.file);
  if (!html.includes(`rel="canonical" href="${page.url}"`)) throw new Error('Canonical mismatch: ' + page.file);
  let modified = '';
  try { modified = execFileSync('git', ['log','-1','--format=%cs','--',page.file], {cwd:root, encoding:'utf8'}).trim(); } catch { /* Omit lastmod when Git history is unavailable. */ }
  xml += `  <url>\n    <loc>${escape(page.url)}</loc>\n`;
  if (modified) xml += `    <lastmod>${modified}</lastmod>\n`;
  if (page.video) {
    const v = page.video;
    xml += '    <video:video>\n' + [
      ['thumbnail_loc',v.thumbnail],['title',v.title],['description',v.description],
      ['content_loc',v.content],['publication_date',v.published],['duration',v.duration],
    ].map(([key,value]) => `      <video:${key}>${escape(value)}</video:${key}>\n`).join('') + '    </video:video>\n';
  }
  xml += '  </url>\n';
}
xml += '</urlset>\n';
await writeFile(new URL('sitemap.xml', root), xml);
console.log('Generated sitemap for ' + pages.length + ' canonical public pages.');
