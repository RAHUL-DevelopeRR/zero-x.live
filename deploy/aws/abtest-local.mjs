// The A/B harness's local target (`abtest.mjs --target local`): both arms on this machine, nothing
// leaves it. The Worker entry (src/index.js) runs in two processes of its own behind a small HTTP
// adapter, arm A with no proxy switch (the full chat pipeline in that process) and arm B with
// EC2_PROXY_PREFIXES covering its host (every request forwarded); server.js runs as the EC2
// stand-in (production settings, the proxy secret, the loadtest probe); synth-upstream.mjs is the
// provider, reached through e2e-upstream-shim.mjs's fake Groq key. Workers CPU cannot be measured
// off Cloudflare, so each Worker process's own CPU per request stands in for it: what matters is
// that B's does not grow with the chat pipeline. The adapter (HTTP parsing, piping the answer)
// costs both arms the same.
//
// Run as a module by abtest.mjs; run as `node --import <shim> abtest-local.mjs --worker-host` it is
// one Worker process (AB_WORKER_ENV holds its env, AB_EC2_PORT the server's port).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSynth } from './synth-upstream.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, '../../neuroncli/auth-server');
const SHIM = pathToFileURL(join(gatewayDir, 'e2e-upstream-shim.mjs')).href;
// The visitor's host in the Worker's request URLs (never resolved: the adapter builds the URL),
// and EC2's, which only the adapter's fetch wrapper knows.
export const LOCAL_HOST = 'ab-local.zero-x.test';
const EC2_ORIGIN = 'https://aws-local.zero-x.test';
const PROXY_SECRET = 'abtest-local-proxy-secret-0123456789abcdef';
// The fake Groq key: e2e-upstream-shim.mjs sends calls carrying it to E2E_UPSTREAM_BASE; synth
// checks it as its bearer key.
const UPSTREAM_KEY = 'e2e-abtest-synth';
export const LOCAL_MODEL = 'groq/openai/gpt-oss-120b';
const PROVIDER = { GROQ_API_KEY: UPSTREAM_KEY, GROQ_MODELS: 'openai/gpt-oss-120b', ALLOW_ANONYMOUS_SESSIONS: 'true',
  ALLOW_UNKNOWN_COUNTRY: 'true', DISCOVERY_ENABLED: 'false' };
// Only what a child needs from this environment: nothing that could name a real database or key.
const baseEnv = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

function child(args, env, { ipc = false, cwd } = {}) {
  const proc = spawn(process.execPath, args, { cwd, env: { ...baseEnv(), ...env }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let log = '';
  const keep = data => { log = (log + data).slice(-8000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const port = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no port from ${args.at(-1)}: ${log}`)), 60000);
    const look = () => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(log);
      if (match) { clearTimeout(timer); proc.stdout.off('data', look); done(Number(match[1])); }
    };
    proc.stdout.on('data', look);
    proc.once('exit', code => { clearTimeout(timer); fail(new Error(`${args.at(-1)} exited with ${code}: ${log}`)); });
  });
  return { proc, port, log: () => log };
}

/** Starts synth, the EC2 stand-in and both Worker processes. */
export async function startLocal() {
  const work = mkdtempSync(join(tmpdir(), 'zerox-abtest-'));
  const synth = await startSynth({ key: UPSTREAM_KEY });
  const upstreamBase = `http://127.0.0.1:${synth.port}`;
  const ec2 = child(['--import', SHIM, '--import', pathToFileURL(join(here, 'loadtest-probe.mjs')).href, join(gatewayDir, 'server.js')], {
    ...PROVIDER, NODE_ENV: 'production', AUTH_HOST: '127.0.0.1', AUTH_PORT: '0', NEURON_API_ONLY: 'true', TRUST_CLOUDFLARE: 'true',
    EC2_PROXY_SECRET: PROXY_SECRET, EXTRA_WEB_HOSTS: LOCAL_HOST, E2E_UPSTREAM_BASE: upstreamBase,
    // The SSE keep-alive after 1 s of silence, so S7's quiet stream crosses it in seconds.
    SSE_HEARTBEAT_MS: '1000',
  }, { ipc: true, cwd: work });
  const ec2Port = await ec2.port;
  const worker = env => child(['--import', SHIM, fileURLToPath(import.meta.url), '--worker-host'], {
    E2E_UPSTREAM_BASE: upstreamBase, AB_EC2_PORT: String(ec2Port), AB_WORKER_ENV: JSON.stringify(env) }, { cwd: work });
  const workers = {
    A: worker(PROVIDER),
    B: worker({ ...PROVIDER, EC2_PROXY_PREFIXES: `${LOCAL_HOST}/`, EC2_PROXY_SECRET: PROXY_SECRET, EC2_PROXY_ORIGIN: EC2_ORIGIN }),
  };
  const ports = { A: await workers.A.port, B: await workers.B.port };
  const ask = type => new Promise(resolveAsk => {
    const listener = message => {
      if (message?.type === (type === 'mark' ? 'marked' : 'reading')) { ec2.proc.off('message', listener); resolveAsk(message); }
    };
    ec2.proc.on('message', listener);
    ec2.proc.send({ type });
  });
  const cpu = async arm => (await fetch(`http://127.0.0.1:${ports[arm]}/__abtest/cpu`)).json();
  return {
    arms: { A: { base: `http://127.0.0.1:${ports.A}`, path: '/v1/chat/completions' }, B: { base: `http://127.0.0.1:${ports.B}`, path: '/v1/chat/completions' } },
    model: LOCAL_MODEL, synth, cpu, ec2Mark: () => ask('mark'), ec2Read: () => ask('read'),
    logs: () => ({ ec2: ec2.log(), A: workers.A.log(), B: workers.B.log() }),
    async stop() {
      for (const proc of [workers.A.proc, workers.B.proc, ec2.proc]) proc.kill();
      synth.server.closeAllConnections();
      synth.server.close();
      await new Promise(done => setTimeout(done, 200));
      rmSync(work, { recursive: true, force: true });
    },
  };
}

// ── One Worker process: the Worker entry behind an HTTP adapter ──
async function workerHost() {
  const env = JSON.parse(process.env.AB_WORKER_ENV || '{}');
  const ec2Port = Number(process.env.AB_EC2_PORT);
  const shimmed = globalThis.fetch;
  // Cloudflare's edge and the tunnel for the Worker's subrequests to EC2_PROXY_ORIGIN, as
  // check-ec2-e2e.mjs carries them: the raw request to server.js's port with Host set, the body
  // streamed, the signal closing the connection. Everything else goes to the shim.
  globalThis.fetch = (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== EC2_ORIGIN) return shimmed(input, init);
    // The edge's work starts on a later turn, outside the Worker's own synchronous time.
    return new Promise(setImmediate).then(() => new Promise((resolveFetch, reject) => {
      const headers = { ...Object.fromEntries(request.headers), host: url.host };
      const req = http.request({ host: '127.0.0.1', port: ec2Port, method: request.method, path: url.pathname + url.search, headers,
        agent: false, signal: request.signal }, res => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const each of [value].flat()) responseHeaders.append(name, each);
        const empty = request.method === 'HEAD' || [204, 304].includes(res.statusCode);
        if (empty) res.resume();
        resolveFetch(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: responseHeaders }));
      });
      req.on('error', reject);
      if (request.body) Readable.fromWeb(request.body).pipe(req);
      else req.end();
    }));
  };
  const { default: app } = await import(pathToFileURL(join(gatewayDir, 'src/index.js')).href);
  let rays = 0;
  // What a Worker would be billed for, approximately: the process's CPU (coarse on Windows, about
  // 16 ms steps), its event-loop active time (fine-grained; the adapter's own work included, for
  // both arms alike), and the synchronous part of the Worker's fetch, which for a forward is the
  // whole forwarding decision (the edge's work is deferred above).
  let appSyncMs = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/__abtest/cpu') {
      const used = process.cpuUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ cpuMs: (used.user + used.system) / 1000,
        activeMs: performance.eventLoopUtilization().active, appSyncMs }));
      return;
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (name !== 'host') headers.set(name, [value].flat().join(', '));
    headers.set('cf-connecting-ip', '127.0.0.1');
    headers.set('cf-ray', `${(++rays).toString(16).padStart(16, '0')}-LCL`);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(`https://${LOCAL_HOST}${req.url}`, { method: req.method, headers, signal: controller.signal,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
    Object.defineProperty(request, 'cf', { value: { country: 'IN' } });
    try {
      const started = performance.now();
      const pending = app.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
      appSyncMs += performance.now() - started;
      const response = await pending;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      const body = Readable.fromWeb(response.body);
      body.on('error', () => res.destroy());
      res.on('close', () => body.destroy());
      body.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'adapter', name: error?.name } }));
      else res.destroy();
    }
  });
  server.listen(0, '127.0.0.1', () => console.log(`worker host listening on 127.0.0.1:${server.address().port}`));
}

if (process.argv.includes('--worker-host')) await workerHost();
