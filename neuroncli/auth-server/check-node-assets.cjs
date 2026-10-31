// The Node server's static site (C4) serves what the Worker's ASSETS binding serves and nothing
// else: an allow-list from .assetsignore (gitignore rules: anchors, directory-only, **, negation,
// no way back into an ignored directory, wrangler's own ignored files), exact file paths only
// (html_handling "none"; clean URLs and the 404 page are src/index.js's), cross-checked against
// git's own matcher on this checkout; the release's REVISION file is never served. Then the caching
// the Worker leaves to Cloudflare: a week for /Assets/, revalidation for the rest, a content ETag
// with 304s (one hash for simultaneous first requests), and byte ranges for the videos. An
// ASSETS_DIR reached through a link (the instance's /opt/zerox/instance-N) stays the release it named at start.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { asset, assetServer, ignoreRule, runtimeEnv, start } = require('./server.js');

// server.js loads a developer .env: nothing here may reach a real database or provider.
for (const name of Object.keys(process.env)) {
  if (/^(SUPABASE_|DATABASE_|PGLITE_|DEV_AUTH)|_API_KEY$|_HOSTED$|_MODELS$|^(TRUST_CLOUDFLARE|TRUST_CF_IPCOUNTRY|NODE_ENV|NEURON_API_ONLY|EC2_PROXY_SECRET|EXTRA_WEB_HOSTS|ASSETS_DIR|READY_PORT|AUTH_REUSE_PORT|GIT_COMMIT)$/.test(name)) {
    delete process.env[name];
  }
}

const repo = path.resolve(__dirname, '../..');
const get = (fetchAsset, pathname, init = {}) => fetchAsset(new Request('http://localhost' + pathname, init));
const status = async (fetchAsset, pathname, init) => (await get(fetchAsset, pathname, init)).status;

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerox-assets-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

(async () => {
  // ── gitignore rules, one pattern at a time ──
  const matches = (pattern, relative) => ignoreRule(pattern).regex.test(relative);
  assert.ok(matches('seo-pages.json', 'seo-pages.json') && matches('seo-pages.json', 'a/b/seo-pages.json'), 'no slash: any depth');
  assert.ok(matches('Assets/*.mp4', 'Assets/x.mp4') && !matches('Assets/*.mp4', 'Assets/sub/x.mp4') && !matches('Assets/*.mp4', 'x/Assets/x.mp4'),
    'a slash anchors, * stays in one segment');
  assert.ok(matches('/root.txt', 'root.txt') && !matches('/root.txt', 'a/root.txt'));
  assert.ok(matches('**/*.md', 'README.md') && matches('**/*.md', 'docs/a/b.md'));
  assert.ok(matches('**/node_modules/**', 'a/node_modules/x/y.js') && !matches('**/node_modules/**', 'a/node_modules'), 'a/** is what is inside');
  assert.ok(matches('a/**/b.txt', 'a/b.txt') && matches('a/**/b.txt', 'a/x/y/b.txt'));
  assert.ok(matches('Assets/Pasted text.txt', 'Assets/Pasted text.txt'));
  assert.ok(matches('[ab]x.txt', 'ax.txt') && !matches('[ab]x.txt', 'cx.txt') && matches('[!ab]x.txt', 'cx.txt'));
  assert.ok(matches('file?.txt', 'file1.txt') && !matches('file?.txt', 'file/.txt'));
  assert.ok(ignoreRule('dir/').dirOnly && ignoreRule('!keep').negate);
  for (const blank of ['', '   ', '# comment', '\r']) assert.equal(ignoreRule(blank), null);
  assert.ok(matches('trailing.txt   ', 'trailing.txt'), 'trailing spaces are not part of the pattern');

  // ── The allow-list over a tree ──
  const dir = tree({
    '.assetsignore': ['# comment', '*.secret', '!keep.secret', '/root-only.txt', 'docs/', '!docs/page.html', 'build/**',
      '**/deep.txt', 'notes', '[ab]x.txt', 'Assets/private*', '!REVISION', ''].join('\r\n'),
    // The deploy's own file at the release root: the Worker never uploads it, so it is never served.
    'REVISION': 'abc1234\n', 'sub/REVISION': 'served like any file the Worker uploads',
    'index.html': '<h1>home</h1>', 'about.html': '<h1>about</h1>', '404.html': '<h1>missing</h1>',
    'style.css': 'body { color: red }', 'x.secret': 's', 'sub/y.secret': 's', 'keep.secret': 'k', 'root-only.txt': 'r', 'sub/root-only.txt': 'r',
    'docs/page.html': 'd', 'sub/docs/page.html': 'd', 'build/app.js': 'b', 'build.js': 'b', 'sub/deep/deep.txt': 'd',
    'notes/n.html': 'n', 'sub/notes': 'n', 'ax.txt': 'a', 'cx.txt': 'c', 'Assets/private-key.png': 'p', 'Assets/logo.png': 'png',
    'Assets/Pasted text.txt': 'pasted', 'CNAME': 'zero-x.live', 'sub/index.html': 'sub', '_headers': 'h', 'sub/_headers': 'h',
    '.hidden.txt': 'h', '.well-known/security.txt': 'contact', 'node_modules/m.js': 'm', 'neuroncli/auth-server/server.js': 'src',
    'clip.mp4': Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251)),
  });
  try {
    const served = [...assetServer(dir).load().keys()].sort();
    assert.deepEqual(served, ['/404.html', '/Assets/Pasted text.txt', '/Assets/logo.png', '/CNAME', '/.well-known/security.txt',
      '/about.html', '/build.js', '/clip.mp4', '/cx.txt', '/index.html', '/keep.secret', '/style.css', '/sub/REVISION', '/sub/_headers',
      '/sub/index.html', '/sub/root-only.txt'].sort(),
      'negation re-includes a file, never one inside an ignored directory or /REVISION; wrangler ignores /_headers');

    const files = assetServer(dir).fetch;
    // Exact paths only: a directory is not its index.html, and a file has no trailing slash.
    assert.equal(await status(files, '/sub/'), 404);
    assert.equal(await status(files, '/sub'), 404);
    assert.equal(await status(files, '/index.html/'), 404);
    assert.equal(await status(files, '/about'), 404, 'clean URLs are src/index.js\'s');
    assert.equal(await status(files, '/sub/index.html'), 200);
    assert.equal(await status(files, '/Assets/Pasted%20text.txt'), 200, 'paths are matched decoded');
    assert.equal(await status(files, '/assets/logo.png'), 404, 'case-sensitive, like the Worker');
    for (const hidden of ['/x.secret', '/docs/page.html', '/build/app.js', '/.hidden.txt', '/node_modules/m.js',
      '/neuroncli/auth-server/server.js', '/.assetsignore', '/_headers', '/Assets/private-key.png', '/sub/a/../../x.secret', '/REVISION']) {
      assert.equal(await status(files, hidden), 404, hidden);
    }
    assert.equal(await status(files, '/%E0%A4%A'), 400, 'a malformed escape');

    // Types and caching. HTML revalidates and has no validator: src/index.js takes only a 200 from
    // ASSETS for a clean URL, so a 304 would become the 404 page.
    const home = await get(files, '/index.html');
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(home.headers.get('cache-control'), 'public, max-age=0, must-revalidate', 'HTML revalidates');
    assert.equal(home.headers.get('content-length'), '13');
    assert.equal(home.headers.get('etag'), null);
    assert.equal(await home.text(), '<h1>home</h1>');
    assert.equal(home.headers.get('accept-ranges'), null, 'ranges are for the videos');
    assert.equal(await status(files, '/index.html', { headers: { 'If-None-Match': '*' } }), 200, 'never a 304 for HTML');
    assert.equal((await get(files, '/Assets/logo.png')).headers.get('cache-control'), 'public, max-age=604800', '/Assets/ are cached for a week');
    assert.equal((await get(files, '/CNAME')).headers.get('content-type'), 'application/octet-stream', 'any file the Worker serves is served');

    // The ETag and conditional GET.
    const sheet = await get(files, '/style.css');
    assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(sheet.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    const etag = sheet.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    for (const value of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const unchanged = await get(files, '/style.css', { headers: { 'If-None-Match': value } });
      assert.equal(unchanged.status, 304, value);
      assert.equal(unchanged.headers.get('etag'), etag);
      assert.equal(unchanged.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
      assert.equal(await unchanged.text(), '');
    }
    assert.equal(await status(files, '/style.css', { headers: { 'If-None-Match': '"other"' } }), 200);
    const head = await get(files, '/style.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '19');
    assert.equal(head.headers.get('etag'), etag);
    assert.equal(await head.text(), '');
    const post = await get(files, '/style.css', { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    // A changed file gets a new ETag (releases and local edits alike).
    fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: blue }');
    const edited = await get(files, '/style.css', { headers: { 'If-None-Match': etag } });
    assert.equal(edited.status, 200);
    assert.notEqual(edited.headers.get('etag'), etag);
    assert.equal(await edited.text(), 'body { color: blue }');

    // Simultaneous first requests (after a deploy, a page full of video ranges) share one hash of
    // the file; a later request reuses it.
    const opened = [];
    const createReadStream = fs.createReadStream;
    fs.createReadStream = (file, ...rest) => {
      opened.push(file);
      return createReadStream(file, ...rest);
    };
    try {
      const cold = assetServer(dir).fetch;
      const heads = await Promise.all(Array.from({ length: 8 }, () => get(cold, '/clip.mp4', { method: 'HEAD' })));
      assert.ok(heads.every(response => response.status === 200));
      assert.equal(new Set(heads.map(response => response.headers.get('etag'))).size, 1);
      assert.equal(opened.length, 1, 'eight simultaneous first requests read the file once');
      await get(cold, '/clip.mp4', { method: 'HEAD' });
      assert.equal(opened.length, 1, 'and the next one not at all');
    } finally { fs.createReadStream = createReadStream; }

    // Byte ranges (206/416) for the mp4s.
    const bytes = fs.readFileSync(path.join(dir, 'clip.mp4'));
    const range = async (value, extra = {}) => {
      const response = await get(files, '/clip.mp4', { headers: { Range: value, ...extra } });
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    };
    const whole = await get(files, '/clip.mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    const clipTag = whole.headers.get('etag');
    for (const [value, start, end] of [['bytes=0-99', 0, 99], ['bytes=900-', 900, 999], ['bytes=-10', 990, 999],
      ['bytes=990-5000', 990, 999], ['bytes=-5000', 0, 999], ['bytes=10-10', 10, 10]]) {
      const part = await range(value);
      assert.equal(part.status, 206, value);
      assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/1000`, value);
      assert.equal(part.headers.get('content-length'), String(end - start + 1), value);
      assert.deepEqual(part.body, bytes.subarray(start, end + 1), value);
    }
    for (const value of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0']) {
      const refused = await range(value);
      assert.equal(refused.status, 416, value);
      assert.equal(refused.headers.get('content-range'), 'bytes */1000', value);
    }
    for (const value of ['bytes=50-10', 'bytes=0-1,5-6', 'items=0-5', 'bytes=-']) {
      const ignored = await range(value);
      assert.equal(ignored.status, 200, `${value} is ignored`);
      assert.equal(ignored.body.length, 1000);
    }
    assert.equal((await range('bytes=0-9', { 'If-Range': clipTag })).status, 206, 'If-Range with the current ETag');
    assert.equal((await range('bytes=0-9', { 'If-Range': '"older"' })).status, 200, 'If-Range with another ETag sends the whole file');
    assert.equal((await range('bytes=0-9', { 'If-None-Match': clipTag })).status, 304, 'a current copy beats the range');
    assert.equal((await get(files, '/index.html', { headers: { Range: 'bytes=0-1' } })).status, 200, 'other types ignore Range');

    // No .assetsignore: an incomplete release serves nothing rather than everything.
    fs.rmSync(path.join(dir, '.assetsignore'));
    assert.equal(await status(assetServer(dir).fetch, '/index.html'), 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ── ASSETS_DIR through a link (the instance's /opt/zerox/instance-N): should the link move under
  // a running instance, it keeps serving the release it started with (its allow-list, its files and
  // its REVISION all agree) ──
  const releases = fs.mkdtempSync(path.join(os.tmpdir(), 'zerox-releases-'));
  const release = (name, files) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(releases, name, file)), { recursive: true });
      fs.writeFileSync(path.join(releases, name, file), content);
    }
    return path.join(releases, name);
  };
  const first = release('aaaaaaa', { '.assetsignore': '', 'page.html': 'first', REVISION: 'aaaaaaa\n' });
  const second = release('bbbbbbb', { '.assetsignore': '', 'page.html': 'second', 'new.html': 'new', REVISION: 'bbbbbbb\n' });
  const current = path.join(releases, 'current');
  // A junction on Windows (no privilege needed); the type is ignored elsewhere.
  fs.symlinkSync(first, current, 'junction');
  try {
    process.env.ASSETS_DIR = current;
    const oldEnv = runtimeEnv('127.0.0.1');
    assert.equal(oldEnv.GIT_COMMIT, 'aaaaaaa');
    fs.unlinkSync(current);
    fs.symlinkSync(second, current, 'junction');
    assert.equal(await (await get(oldEnv.ASSETS.fetch, '/page.html')).text(), 'first', 'the old instance keeps its release');
    assert.equal(await status(oldEnv.ASSETS.fetch, '/new.html'), 404);
    const newEnv = runtimeEnv('127.0.0.1');
    assert.equal(newEnv.GIT_COMMIT, 'bbbbbbb');
    assert.equal(await (await get(newEnv.ASSETS.fetch, '/page.html')).text(), 'second');
    assert.equal(await status(newEnv.ASSETS.fetch, '/new.html'), 200);
    process.env.ASSETS_DIR = path.join(releases, 'missing');
    assert.equal(await status(runtimeEnv('127.0.0.1').ASSETS.fetch, '/page.html'), 404, 'a missing directory serves nothing');
  } finally {
    delete process.env.ASSETS_DIR;
    fs.rmSync(releases, { recursive: true, force: true });
  }

  // ── This repository: the same set as git's matcher applies to .assetsignore ──
  const served = [...assetServer(repo).load().keys()];
  for (const hidden of ['/Assets/RahulCIT.png', '/Assets/Pasted text.txt', '/neuroncli/auth-server/package.json',
    '/neuroncli/auth-server/src/index.js', '/neuroncli/auth-server/server.js', '/README.md', '/seo-pages.json', '/index2.html',
    '/neuroncli/auth-server/wrangler.toml', '/.git/config', '/.env', '/tailwind.config.cjs', '/.assetsignore']) {
    assert.ok(!served.includes(hidden), hidden);
    assert.equal((await asset(new Request('http://localhost' + encodeURI(hidden)))).status, 404, hidden);
  }
  for (const page of ['/index.html', '/404.html', '/robots.txt', '/neuroncli/login/index.html', '/Assets/zerox-share.png',
    '/videos/neucockpit-launch.mp4', '/releases/cli/latest.json', '/d1f1e91e36df5151a488ae0d0d338fcc.txt']) {
    assert.ok(served.includes(page), page);
  }
  const git = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const tracked = git(['ls-files', '-c', '-z']);
  if (tracked.status === 0) {
    const names = new Set(tracked.stdout.split('\0').filter(Boolean));
    const ignored = new Set(git(['ls-files', '-c', '-i', '-z', '--exclude-from=.assetsignore']).stdout.split('\0').filter(Boolean));
    // git does not know wrangler's own ignored files (/.assetsignore, a hidden name like every other
    // one that stays out on Node by design: today only /.gitattributes, which the Worker serves).
    const expected = [...names].filter(name => !ignored.has(name) && !name.split('/').some(part => part.startsWith('.')))
      .map(name => `/${name}`).sort();
    // Untracked files in a working checkout are served too (wrangler would upload them); a release
    // from git archive has none.
    assert.deepEqual(served.filter(name => names.has(name.slice(1))).sort(), expected, 'tracked files served = tracked files git does not ignore');
  } else console.log('git unavailable: the cross-check against git ls-files was skipped');

  // ── Through the server: src/index.js's clean URLs and 404 page over the allow-list ──
  const site = tree({
    '.assetsignore': 'secret.txt\n', 'index.html': '<h1>home</h1>', 'about.html': '<h1>about</h1>',
    '404.html': '<h1>missing</h1>', 'secret.txt': 'no', 'clip.mp4': Buffer.alloc(300, 7), 'site.css': 'p {}',
  });
  Object.assign(process.env, { AUTH_PORT: '0', ASSETS_DIR: site });
  const server = await start();
  try {
    if (!server.listening) await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await fetch(base + '/about')).text(), '<h1>about</h1>', 'clean URL');
    const missing = await fetch(base + '/nope');
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '<h1>missing</h1>', 'the branded 404 page');
    assert.equal((await fetch(base + '/secret.txt')).status, 404);
    const part = await fetch(base + '/clip.mp4', { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206, 'ranges pass through the app');
    assert.equal(part.headers.get('content-range'), 'bytes 100-199/300');
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const sheet = await fetch(base + '/site.css');
    const tag = sheet.headers.get('etag');
    assert.ok(tag);
    assert.equal((await fetch(base + '/site.css', { headers: { 'If-None-Match': tag } })).status, 304, 'a 304 passes through the app');
    const about = await fetch(base + '/about', { headers: { 'If-None-Match': '*' } });
    assert.equal(about.status, 200, 'a revalidated clean URL is still the page');
    assert.equal(await about.text(), '<h1>about</h1>');
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.ASSETS_DIR;
    fs.rmSync(site, { recursive: true, force: true });
  }

  // The real tree through the server: the two files the old adapter served are gone.
  const real = await start();
  try {
    if (!real.listening) await once(real, 'listening');
    const base = `http://127.0.0.1:${real.address().port}`;
    assert.equal((await fetch(base + '/Assets/RahulCIT.png')).status, 404);
    assert.equal((await fetch(base + '/Assets/Pasted%20text.txt')).status, 404);
    assert.equal((await fetch(base + '/neuroncli/auth-server/package.json')).status, 404);
    assert.equal((await fetch(base + '/neuroncli/login/')).status, 200, 'src/index.js maps the sign-in page');
    assert.equal((await fetch(base + '/Assets/zerox-share.png')).headers.get('cache-control'), 'public, max-age=604800');
  } finally { await new Promise(resolve => real.close(resolve)); }
  console.log('PASS: Node static files = the Worker\'s .assetsignore allow-list (gitignore rules, exact paths, git cross-check), week-long /Assets/ cache, ETag/304, mp4 ranges 206/416');
})().catch(error => { console.error(error); process.exitCode = 1; });
