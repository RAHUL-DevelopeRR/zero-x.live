const assert = require('node:assert/strict');
const { once } = require('node:events');
const { start } = require('./server.js');

(async () => {
  process.env.AUTH_PORT = '0';
  process.env.NEURON_API_ONLY = 'true';
  const server = await start();
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/neuroncli/login/')).status, 404);
    assert.equal((await fetch(base + '/src/index.js')).status, 404);
    assert.equal((await fetch(base + '/auth/cli/session', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/v1/providers/health')).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: standalone Node API works without website assets and guards user/operator endpoints');
})().catch(error => { console.error(error); process.exitCode = 1; });
