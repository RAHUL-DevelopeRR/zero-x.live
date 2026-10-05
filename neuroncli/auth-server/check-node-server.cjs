const assert = require('node:assert/strict');
const { once } = require('node:events');
const { start, asset } = require('./server.js');

(async () => {
  for (const pathname of ['/neuroncli/auth-server/src/index.js', '/.env', '/.git/config', '/neuroncli/auth-server/package.json']) {
    assert.equal((await asset(new Request('http://localhost' + pathname))).status, 404, pathname);
  }
  assert.equal((await asset(new Request('http://localhost/neuroncli/login/'))).status, 200);
  process.env.AUTH_PORT = '0';
  const server = await start();
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/v1/models')).status, 200);
    assert.equal((await fetch(base + '/auth/cli/session', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status, 401);
    const login = await fetch(base + '/neuroncli/login/');
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Connect/);
    assert.equal((await fetch(base + '/neuroncli/auth-server/src/index.js')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: Node adapter shares Worker routes, serves login, guards auth and excludes source/secrets');
})().catch(error => { console.error(error); process.exitCode = 1; });
