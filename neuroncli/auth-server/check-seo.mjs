import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['index.html', 'https://www.zero-x.live/'],
  ['neuron.html', 'https://neuron.zero-x.live/'],
  ['find-files-by-content.html', 'https://www.zero-x.live/find-files-by-content'],
  ['wheres-that-file.html', 'https://www.zero-x.live/wheres-that-file'],
];
for (const [file, canonical] of pages) {
  const html = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.equal((html.match(/<h1\b/g) || []).length, 1, file);
  const matches = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
  assert.equal(matches.length, 1, file);
  assert.equal(matches[0][1], canonical, file);
  assert.ok(!html.includes('content="noindex'), file);
  assert.ok(/<title>[^<]+<\/title>/.test(html), file);
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(match[1]);
}
const sitemap = await readFile(new URL('../../sitemap.xml', import.meta.url), 'utf8');
assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]), pages.map(p => p[1]));
assert.match(sitemap, /<video:content_loc>https:\/\/www\.zero-x\.live\/videos\/neucockpit-wheres-that-file\.mp4<\/video:content_loc>/);
const watchPage = await readFile(new URL('../../wheres-that-file.html', import.meta.url), 'utf8');
assert.match(watchPage, /<video\b[\s\S]*?<source src="\.\/videos\/neucockpit-wheres-that-file\.mp4"/);
assert.equal(JSON.parse(watchPage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]).duration, 'PT15.5S');
if (process.argv.includes('--live')) {
  for (const [, url] of pages) {
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.url, url, url);
    assert.ok(!response.headers.get('x-robots-tag')?.includes('noindex'), url);
    const html = await response.text();
    assert.ok(html.includes(`rel="canonical" href="${url}"`), url);
  }
  for (const [url, target] of [
    ['https://zero-x.live/', 'https://www.zero-x.live/'],
    ['https://www.zero-x.live/index.html', 'https://www.zero-x.live/'],
    ['https://www.zero-x.live/neuron.html', 'https://neuron.zero-x.live/'],
    ['https://neuron.zero-x.live/index.html', 'https://neuron.zero-x.live/'],
    ['https://www.zero-x.live/find-files-by-content.html', 'https://www.zero-x.live/find-files-by-content'],
    ['https://www.zero-x.live/wheres-that-file.html', 'https://www.zero-x.live/wheres-that-file'],
    ['https://neuron.zero-x.live/wheres-that-file', 'https://www.zero-x.live/wheres-that-file'],
  ]) {
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 301, url);
    assert.equal(response.headers.get('location'), target, url);
  }
  const privatePage = await fetch('https://dashboard.zero-x.live/');
  assert.ok(privatePage.headers.get('x-robots-tag')?.includes('noindex'));
  assert.equal((await fetch('https://www.zero-x.live/does-not-exist-seo-check')).status, 404);
}
console.log('PASS: public page metadata and sitemap' + (process.argv.includes('--live') ? ', live canonical redirects, private noindex, and real 404' : ''));
