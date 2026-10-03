import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const pages = JSON.parse(await readFile(new URL('seo-pages.json', root), 'utf8'));
const docs = new Map(), titles = new Set(), descriptions = new Set();
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1],m[2]]));
const metadata = html => Object.fromEntries([...html.matchAll(/<meta\b[^>]*>/g)].map(m => {const a=attrs(m[0]);return [a.name||a.property,a.content];}));
for (const page of pages) {
  const html = await readFile(new URL(page.file, root), 'utf8'); docs.set(page.url, html);
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1], meta = metadata(html);
  assert.ok(title && !titles.has(title), 'Missing/duplicate title: '+page.file); titles.add(title);
  assert.ok(meta.description && !descriptions.has(meta.description), 'Missing/duplicate description: '+page.file); descriptions.add(meta.description);
  const canonicals = [...html.matchAll(/<link\b[^>]*>/g)].map(m=>attrs(m[0])).filter(a=>a.rel==='canonical');
  assert.deepEqual(canonicals.map(a=>a.href), [page.url], page.file);
  assert.equal((html.match(/<h1\b/g)||[]).length, 1, page.file);
  assert.ok(html.includes('<main') && html.includes('<header') && html.includes('<footer'), page.file);
  assert.ok(meta.robots && !meta.robots.includes('noindex'), page.file);
  for (const key of ['og:type','og:site_name','og:title','og:description','og:url','og:image','twitter:card','twitter:title','twitter:description','twitter:image']) assert.ok(meta[key],page.file+': '+key);
  assert.equal(meta['og:site_name'],'Zero-X'); assert.equal(meta['og:url'],page.url);
  assert.ok(!html.includes('https://www.zero-x.live'),page.file+': old host');
  const scripts=[...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length,page.file+': schema');
  for (const m of scripts) {assert.equal(JSON.parse(m[1])['@context'],'https://schema.org');assert.doesNotMatch(m[1],/"(?:aggregateRating|reviewCount|awards|foundingDate|numberOfEmployees)"/);}
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {const a=attrs(m[0]);assert.ok('alt' in a && Number(a.width)>0 && Number(a.height)>0,page.file+': image dimensions/alt');}
}
const home=docs.get('https://zero-x.live/');
const graph=JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
assert.equal(graph.find(n=>n['@type']==='WebSite').name,'Zero-X');
assert.equal(graph.find(n=>n['@type']==='SoftwareApplication').publisher['@id'],'https://zero-x.live/#organization');
assert.match(home,/NeuCockpit local AI/); assert.ok(!home.includes('location.replace('));
for (const page of pages) {
  for (const m of docs.get(page.url).matchAll(/<(?:a|link|img|source|script)\b[^>]*>/g)) {
    const a=attrs(m[0]), value=a.href||a.src;
    if (!value || !/^(https?:|\/|\.|#)/.test(value)) continue;
    const url=new URL(value,page.url);
    if (!['zero-x.live','neuron.zero-x.live'].includes(url.hostname) || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/neuroncli/')) continue;
    const target=url.origin+url.pathname;
    if (docs.has(target)) {if(url.hash)assert.ok(docs.get(target).includes(`id="${url.hash.slice(1)}"`),page.file+': broken fragment '+value);}
    else assert.ok((await stat(new URL('.'+url.pathname,root))).isFile(),page.file+': missing asset '+value);
  }
}
const robots=await readFile(new URL('robots.txt',root),'utf8'), sitemap=await readFile(new URL('sitemap.xml',root),'utf8');
assert.match(robots,/Allow: \/\r?\n/);assert.match(robots,/Sitemap: https:\/\/zero-x.live\/sitemap.xml/);
assert.doesNotMatch(robots,/Disallow: \/(?:Assets|assets|\*)/);
assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]),pages.map(p=>p.url));
assert.doesNotMatch(sitemap,/<loc>[^<]*(?:dashboard|auth\/|\.html|\?|localhost)/);
assert.match(sitemap,/<video:publication_date>2026-10-01T16:09:34Z<\/video:publication_date>/);
if (process.argv.includes('--live')) {
  for (const page of pages) {const r=await fetch(page.url);assert.equal(r.status,200,page.url);assert.equal(r.url,page.url);assert.ok(!r.headers.get('x-robots-tag')?.includes('noindex'));const html=await r.text();assert.equal(metadata(html)['og:url'],page.url);assert.ok(html.includes(`rel="canonical" href="${page.url}"`));}
  for (const [url,target] of [
    ['https://www.zero-x.live/','https://zero-x.live/'],
    ['https://zero-x.live/index.html','https://zero-x.live/'],
    ['https://www.zero-x.live/index.html?utm_source=test','https://zero-x.live/?utm_source=test'],
    ['https://zero-x.live/neucockpit','https://neuron.zero-x.live/'],
    ['https://zero-x.live/neuron.html','https://neuron.zero-x.live/'],
    ['https://zero-x.live/legacy.html','https://neuron.zero-x.live/'],
    ['https://zero-x.live/index2.html','https://zero-x.live/'],
    ['https://zero-x.live/about/','https://zero-x.live/about'],
    ['https://zero-x.live/privacy.html','https://zero-x.live/privacy'],
    ['https://www.zero-x.live/terms','https://zero-x.live/terms'],
    ['https://neuron.zero-x.live/find-files-by-content','https://zero-x.live/find-files-by-content'],
    ['https://zero-x.live/download','https://neuron.zero-x.live/#downloads'],
  ]) {const r=await fetch(url,{redirect:'manual'});assert.equal(r.status,301,url);assert.equal(r.headers.get('location'),target,url);}
  assert.ok((await fetch('https://dashboard.zero-x.live/')).headers.get('x-robots-tag')?.includes('noindex'));
  for(const path of ['/does-not-exist-seo-check','/neuroncli/auth-server/wrangler.toml'])assert.equal((await fetch('https://zero-x.live'+path)).status,404,path);
  for(const path of ['/robots.txt','/sitemap.xml','/Assets/neucockpit-semantic-search-480.webp','/videos/neucockpit-wheres-that-file.mp4'])assert.equal((await fetch('https://zero-x.live'+path,{method:'HEAD'})).status,200,path);
}
console.log('PASS: '+pages.length+' public pages, unique metadata, entity graph, links, images, robots and sitemap'+(process.argv.includes('--live')?'; live redirects, private noindex and source exclusion':''));
