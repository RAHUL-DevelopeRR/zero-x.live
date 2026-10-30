#!/usr/bin/env node
// Capacity check for the gateway on the VM: N concurrent token streams through a gateway process
// (server.js, the code being deployed) against a fake upstream on loopback. Reports the gateway's
// CPU per request and per token, and the most streams it carried within the limits below.
//
//   cd neuroncli/auth-server && npm ci        # a checkout of the release, not /opt/zerox/gateway
//   node ../../deploy/aws/loadtest.mjs --streams 25,50,100,200 --tokens 300 --body-kb 100 --rate 50
//
// --body-kb pads each request with earlier turns (code and tool output, JSON-escaped like a
// coding agent's history) to about that size; the per-request cost (parsing, routing, the
// upstream request) grows with it, and short answers spread it over few tokens. The gateway
// under test is its own process on a random loopback port: no database (anonymous sessions in
// memory, development plan limits), the code catalog and a fake Groq key, with
// e2e-upstream-shim.mjs sending its upstream calls to the fake upstream served here, so nothing
// leaves the machine and the production service is not touched (it does share the CPU: run
// before go-live or with zerox-gateway stopped for clean numbers). Not measured, all of which
// add CPU per request in production: TLS to the upstream provider (here plain HTTP on loopback)
// and the Supabase RPCs over TLS (reservation, renewals, settlement, session reads).
//
// A step passes when every stream finished with [DONE], the gateway's event loop was busy under
// --max-elu of the time and its p99 event loop delay stayed under --max-lag-ms. Node runs the
// gateway's JavaScript on one core, so the estimate is per process: one core is the budget.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  'gateway-dir': { type: 'string', default: resolve(here, '../../neuroncli/auth-server') },
  streams: { type: 'string', default: '25,50,100,200' },
  tokens: { type: 'string', default: '1000' },
  rate: { type: 'string', default: '50' },
  'body-kb': { type: 'string', default: '0' },
  'ramp-ms': { type: 'string', default: '2000' },
  'max-elu': { type: 'string', default: '0.8' },
  'max-lag-ms': { type: 'string', default: '100' },
  json: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('usage: node loadtest.mjs [--streams 25,50,100,200] [--tokens 1000] [--rate 50] [--body-kb 0] [--ramp-ms 2000]\n' +
    '                   [--max-elu 0.8] [--max-lag-ms 100] [--gateway-dir <neuroncli/auth-server>] [--json <file>]');
  process.exit(0);
}
const steps = values.streams.split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
const TOKENS = Number(values.tokens);
const RATE = Number(values.rate);
const BODY_KB = Number(values['body-kb']);
if (!(BODY_KB >= 0)) throw new Error('--body-kb must be 0 or more');
const RAMP_MS = Number(values['ramp-ms']);
const MAX_ELU = Number(values['max-elu']);
const MAX_LAG_MS = Number(values['max-lag-ms']);
const gatewayDir = resolve(values['gateway-dir']);
if (!steps.length || !(TOKENS > 0) || !(RATE > 0)) throw new Error('--streams, --tokens and --rate must be positive');

const sleep = ms => new Promise(done => setTimeout(done, ms));
const percentile = (list, p) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
};

// ── Fake upstream (Groq's OpenAI-compatible path): `loadtest:<tokens>` in the prompt sets the
// stream length; one SSE event per token, written to every open stream on one shared ticker ──
const USAGE_PROMPT = 40;
const active = new Set();
const upstream = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (!request.url.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
  const tokens = Number(/loadtest:(\d+)/.exec(raw)?.[1] || 1);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const stream = { response, left: tokens, tokens };
  response.on('close', () => active.delete(stream));
  response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
  active.add(stream);
});
const created = Math.floor(Date.now() / 1000);
function chunk(delta, finish = null) {
  return { id: 'chatcmpl-loadtest', object: 'chat.completion.chunk', created, model: 'openai/gpt-oss-120b',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] };
}
const WORDS = [' the', ' gateway', ' streams', ' tokens', ' to', ' Neuron', ' while', ' it', ' counts', ' usage'];
let tick = 0;
const ticker = setInterval(() => {
  tick++;
  for (const stream of active) {
    const { response } = stream;
    if (stream.left > 0) {
      stream.left--;
      response.write(`data: ${JSON.stringify(chunk({ content: WORDS[(tick + stream.left) % WORDS.length] }))}\n\n`);
      continue;
    }
    active.delete(stream);
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: USAGE_PROMPT,
      completion_tokens: stream.tokens, total_tokens: USAGE_PROMPT + stream.tokens } })}\n\n`);
    response.end('data: [DONE]\n\n');
  }
}, 1000 / RATE);

// ── Gateway under test ──
async function startGateway(upstreamBase, cwd) {
  const args = ['--import', pathToFileURL(join(gatewayDir, 'e2e-upstream-shim.mjs')).href,
    '--import', pathToFileURL(join(here, 'loadtest-probe.mjs')).href, join(gatewayDir, 'server.js')];
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    AUTH_HOST: '127.0.0.1', AUTH_PORT: '0', NEURON_API_ONLY: 'true', ALLOW_ANONYMOUS_SESSIONS: 'true',
    ALLOW_UNKNOWN_COUNTRY: 'true', GROQ_API_KEY: 'e2e-loadtest', GROQ_MODELS: 'openai/gpt-oss-120b',
    DISCOVERY_ENABLED: 'false', E2E_UPSTREAM_BASE: upstreamBase,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let log = '';
  const keep = data => { log = (log + data).slice(-4000); };
  child.stderr.on('data', keep);
  child.stdout.on('data', keep);
  const port = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`gateway did not start: ${log}`)), 60000);
    const listening = () => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(log);
      if (match) { clearTimeout(timer); child.stdout.off('data', listening); done(Number(match[1])); }
    };
    child.stdout.on('data', listening);
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`gateway exited with ${code}: ${log}`)); });
  });
  child.on('exit', (code, signal) => {
    if (!child.stopping) console.error(`gateway exited during the run (${code ?? signal}); its last output:\n${log}`);
  });
  const ask = type => new Promise(done => {
    const listener = message => {
      if (message?.type === (type === 'mark' ? 'marked' : 'reading')) { child.off('message', listener); done(message); }
    };
    child.on('message', listener);
    child.send({ type });
  });
  return { child, base: `http://127.0.0.1:${port}`, mark: () => ask('mark'), read: () => ask('read') };
}

// Earlier turns of about --body-kb: a system prompt, then user and assistant turns carrying
// source code as tool output (quotes, backslashes and newlines, so JSON escaping costs what it
// does for an agent's history). Built once; every request sends the same body.
const SOURCE = 'export function handler(event) {\n  const { path = "/", headers = {} } = event;\n' +
  '  if (!path.startsWith("/v1/")) return { status: 404, body: "{\\"error\\":\\"not found\\"}" };\n  return route(path, headers);\n}\n';
function history(kb) {
  if (!kb) return [];
  const messages = [{ role: 'system', content: 'You are a coding agent. Read files with the tools before editing them.\n'.repeat(20) }];
  for (let turn = 0; Buffer.byteLength(JSON.stringify(messages)) < kb * 1024; turn++) {
    messages.push({ role: 'user', content: `Tool output, read_file src/module${turn}.js:\n${SOURCE.repeat(16)}` },
      { role: 'assistant', content: `I read src/module${turn}.js; next I edit it.` });
  }
  return messages;
}
const REQUEST_BODY = JSON.stringify({ model: 'groq/openai/gpt-oss-120b', stream: true, max_tokens: TOKENS + 64,
  messages: [...history(BODY_KB), { role: 'user', content: `loadtest:${TOKENS} Write a long answer.` }] });
const REQUEST_KB = +(Buffer.byteLength(REQUEST_BODY) / 1024).toFixed(1);

async function session(base) {
  const response = await fetch(base + '/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_fingerprint: `loadtest-${Math.random().toString(36).slice(2)}` }) });
  if (response.status !== 200) throw new Error(`session: HTTP ${response.status}`);
  return (await response.json()).session_token;
}

async function stream(base, token) {
  const started = performance.now();
  const result = { ok: false, ttfbMs: null, maxGapMs: 0, chunks: 0, status: null, streamMs: 0 };
  try {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: REQUEST_BODY,
    });
    result.status = response.status;
    if (response.status !== 200) { result.error = `HTTP ${response.status} ${(await response.text()).slice(0, 160)}`; return result; }
    const decoder = new TextDecoder();
    let last = null;
    let tail = '';
    for await (const bytes of response.body) {
      const now = performance.now();
      if (last === null) result.ttfbMs = now - started;
      else result.maxGapMs = Math.max(result.maxGapMs, now - last);
      last = now;
      result.chunks++;
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-64);
    }
    result.ok = tail.includes('data: [DONE]');
    result.streamMs = last - started - result.ttfbMs;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function runStep(gateway, count) {
  const tokens = await Promise.all(Array.from({ length: count }, () => session(gateway.base)));
  await sleep(500);
  await gateway.mark();
  const started = performance.now();
  const results = await Promise.all(tokens.map(async (token, index) => {
    await sleep(RAMP_MS * index / count);
    return stream(gateway.base, token);
  }));
  const wallS = (performance.now() - started) / 1000;
  const probe = await gateway.read();
  const ok = results.filter(result => result.ok).length;
  const cpuPerStreamMs = probe.cpuMs / count;
  const cpuPerToken = probe.cpuMs * 1000 / (count * TOKENS);
  // The rate the fake upstream reached (timer granularity can hold it under --rate, on Windows).
  const meanStreamS = results.reduce((sum, result) => sum + result.streamMs, 0) / Math.max(1, results.length) / 1000;
  const row = {
    streams: count, ok, failed: count - ok, tokens_per_stream: TOKENS, request_kb: REQUEST_KB, rate_tps: RATE,
    actual_rate_tps: +(TOKENS / meanStreamS).toFixed(1), wall_s: +wallS.toFixed(1),
    gateway_cpu_ms: Math.round(probe.cpuMs), cpu_ms_per_stream: +cpuPerStreamMs.toFixed(1),
    cpu_us_per_token: +cpuPerToken.toFixed(1),
    cpu_core_pct: +(100 * probe.cpuMs / (wallS * 1000)).toFixed(1), elu: +probe.elu.toFixed(3),
    lag_p99_ms: +probe.lagP99Ms.toFixed(1), lag_max_ms: +probe.lagMaxMs.toFixed(1),
    ttfb_p50_ms: Math.round(percentile(results.map(result => result.ttfbMs).filter(Number.isFinite), 50) ?? -1),
    ttfb_p95_ms: Math.round(percentile(results.map(result => result.ttfbMs).filter(Number.isFinite), 95) ?? -1),
    gap_p95_ms: Math.round(percentile(results.map(result => result.maxGapMs), 95) ?? -1),
    rss_mb: Math.round(probe.rssMb), max_rss_mb: Math.round(probe.maxRssMb),
    // Requests of this shape one core could start per second, tokens per second it could relay,
    // and concurrent streams at --rate, each using at most --max-elu of the core.
    est_requests_per_s_per_core: +(MAX_ELU * 1000 / cpuPerStreamMs).toFixed(1),
    est_tokens_per_s_per_core: Math.floor(MAX_ELU * 1e6 / cpuPerToken),
    est_streams_per_core: Math.floor(MAX_ELU * 1e6 / cpuPerToken / RATE),
  };
  row.pass = row.failed === 0 && row.elu <= MAX_ELU && row.lag_p99_ms <= MAX_LAG_MS;
  const errors = [...new Set(results.filter(result => !result.ok).map(result => result.error || `HTTP ${result.status}`))];
  if (errors.length) row.errors = errors.slice(0, 5);
  return row;
}

const workDir = await mkdtemp(join(tmpdir(), 'zerox-loadtest-'));
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const gateway = await startGateway(`http://127.0.0.1:${upstream.address().port}`, workDir);
const rows = [];
try {
  console.log(`gateway ${gateway.base} (node ${process.version}, ${process.platform}/${process.arch}); ` +
    `${REQUEST_KB} KB requests, ${TOKENS} tokens per stream at ${RATE} tokens/s (${TOKENS / RATE} s), ramp ${RAMP_MS} ms`);
  await runStep(gateway, Math.min(5, steps[0])); // warm-up, not reported
  for (const count of steps) {
    const row = await runStep(gateway, count);
    rows.push(row);
    console.log(JSON.stringify(row));
    if (!row.pass && row.failed > count / 2) break;
  }
} finally {
  clearInterval(ticker);
  gateway.child.stopping = true;
  gateway.child.kill();
  upstream.close();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}

const passed = rows.filter(row => row.pass);
const best = passed.at(-1);
console.log('\nstreams  ok    cpu ms/stream  us/token  req/s/core  core %   elu    lag p99  ttfb p95  gap p95  rss MB  pass');
for (const row of rows) {
  console.log([String(row.streams).padEnd(8), String(row.ok).padEnd(5), String(row.cpu_ms_per_stream).padEnd(14),
    String(row.cpu_us_per_token).padEnd(9), String(row.est_requests_per_s_per_core).padEnd(11), String(row.cpu_core_pct).padEnd(8),
    String(row.elu).padEnd(6), String(row.lag_p99_ms).padEnd(8), String(row.ttfb_p95_ms).padEnd(9), String(row.gap_p95_ms).padEnd(8),
    String(row.max_rss_mb).padEnd(7), row.pass ? 'yes' : 'NO'].join(' '));
}
const summary = {
  max_concurrency_passed: best?.streams ?? 0,
  request_kb: REQUEST_KB, tokens_per_stream: TOKENS,
  est_requests_per_s_per_core: best?.est_requests_per_s_per_core ?? null,
  est_tokens_per_s_per_core: best?.est_tokens_per_s_per_core ?? null,
  est_streams_per_core: best?.est_streams_per_core ?? null,
  note: `estimates from the gateway's CPU per request and per token (all its threads) for this request size and length: ` +
    `what one core carries at --max-elu ${MAX_ELU}, streams at ${RATE} tokens/s; no upstream TLS and no database`,
};
console.log(`\n${JSON.stringify(summary)}`);
if (values.json) await writeFile(values.json, JSON.stringify({ rows, summary }, null, 2));
process.exitCode = best ? 0 : 1;
