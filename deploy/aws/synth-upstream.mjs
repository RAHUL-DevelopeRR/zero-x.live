// A deterministic OpenAI-compatible upstream for the Worker-vs-EC2 A/B harness (AB-TEST.md). The
// gateway reaches it as a provider (OmniRoute's base URL on staging, the fake Groq of
// e2e-upstream-shim.mjs locally), and each request says how to answer in its last user message
// (abtest-payloads.mjs directive): tokens and rate, a delay before the headers, a 503 or 429, a
// stall after N events, a quiet period, reasoning and tool-call fragments.
//
// It is also the witness: per request it records the nonce, who called (a Cloudflare Worker adds
// CF-Worker to every subrequest; the VM does not), when it arrived, the first byte, the tokens
// written, and when and why the connection ended. GET /stats returns those records. Every request
// needs the bearer key (SYNTH_KEY); nothing of the prompt is kept.
//
//   SYNTH_KEY=<key> node synth-upstream.mjs [--host 127.0.0.1] [--port 8899] [--log <file.jsonl>]
// On the staging VM it runs as zerox-synth.service behind the staging tunnel only.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The directive in a request the upstream received: the last `abtest:{...}` in any message.
export function readDirective(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => part?.text || '').join('\n') : '';
    const at = text.lastIndexOf('abtest:{');
    if (at < 0) continue;
    try { return JSON.parse(text.slice(at + 7).split('\n')[0]); } catch { return null; }
  }
  return null;
}

const KEEP_RECORDS = 5000;
const WORDS = [' the', ' gateway', ' streams', ' tokens', ' to', ' Neuron', ' while', ' it', ' counts', ' usage'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(String(value)).digest();

export function startSynth({ host = '127.0.0.1', port = 0, key, log = null } = {}) {
  if (!key || String(key).length < 6) throw new Error('synth-upstream: SYNTH_KEY (6+ characters) is required');
  const records = [];
  const record = entry => {
    records.push(entry);
    if (records.length > KEEP_RECORDS) records.shift();
    if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
  };
  const authorised = req => {
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return presented && timingSafeEqual(digest(presented), digest(key));
  };
  const server = createServer(async (req, res) => {
    if (!authorised(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"code":"unauthorized"}}'); return; }
    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ records }));
      return;
    }
    if (req.method !== 'POST' || !req.url.split('?')[0].endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const arrived = Date.now();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = JSON.parse(raw); } catch { /* answered as a default request */ }
    const spec = readDirective(body) || {};
    const entry = { nonce: spec.nonce ?? null, caller: req.headers['cf-worker'] ? 'worker' : 'vm', arrived, first_byte: null,
      tokens: 0, closed: null, reason: null, bytes_in: raw.length };
    let ended = false;
    res.on('close', () => {
      entry.closed = Date.now();
      entry.reason ??= ended ? 'done' : 'client_closed';
      record(entry);
    });
    const tokens = Math.max(0, Math.min(Number(spec.tokens ?? 16), 20000));
    const rate = Math.max(1, Math.min(Number(spec.rate ?? 50), 1000));
    if (spec.ttfb_ms) await sleep(Math.min(Number(spec.ttfb_ms), 120000));
    if (res.destroyed) return;
    if (spec.fail === 503 || spec.fail === 429) {
      entry.first_byte = Date.now();
      entry.reason = `fail_${spec.fail}`;
      ended = true;
      res.writeHead(spec.fail, { 'Content-Type': 'application/json', ...(spec.fail === 429 ? { 'Retry-After': '2' } : {}) })
        .end(JSON.stringify({ error: { message: 'synthetic failure', code: spec.fail === 429 ? 'rate_limited' : 'overloaded' } }));
      return;
    }
    const model = String(body?.model || 'synth');
    const created = Math.floor(arrived / 1000);
    const chunk = (delta, finish = null) => ({ id: `chatcmpl-synth-${entry.nonce ?? 'x'}`, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: tokens, total_tokens: Math.ceil(raw.length / 4) + tokens };
    if (body?.stream === false) {
      entry.first_byte = Date.now();
      await sleep(Math.round(tokens * 1000 / rate));
      entry.tokens = tokens;
      ended = true;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'chatcmpl-synth', object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: WORDS.slice(0, Math.max(1, Math.min(tokens, WORDS.length))).join('') },
          finish_reason: 'stop' }], usage }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const send = value => { if (!res.destroyed) res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`); };
    entry.first_byte = Date.now();
    send(chunk({ role: 'assistant', content: '' }));
    let events = 1;
    const stallAfter = spec.stall_after ?? Infinity;
    const tick = 1000 / rate;
    // Reasoning first, then a quiet period (a thinking phase that sends nothing), then tokens.
    for (let i = 0; i < Number(spec.reasoning || 0) && !res.destroyed; i++, events++) {
      if (events >= stallAfter) break;
      send(chunk({ reasoning_content: WORDS[i % WORDS.length] }));
      await sleep(tick);
    }
    if (spec.quiet_ms && !res.destroyed) await sleep(Math.min(Number(spec.quiet_ms), 120000));
    for (let i = 0; i < tokens && !res.destroyed; i++, events++) {
      if (events >= stallAfter) break;
      send(chunk({ content: WORDS[i % WORDS.length] }));
      entry.tokens++;
      await sleep(tick);
    }
    const frags = Number(spec.tool_frags || 0);
    for (let i = 0; i < frags && !res.destroyed && events < stallAfter; i++, events++) {
      send(chunk({ tool_calls: [{ index: 0, ...(i === 0 ? { id: 'call_synth', type: 'function', function: { name: 'read_file', arguments: '' } } : {}),
        function: { arguments: i === 0 ? '{"path":' : i === frags - 1 ? '"README.md"}' : '' } }] }));
      await sleep(tick);
    }
    if (events >= stallAfter) {
      // A stall: the connection stays open with nothing more until the gateway gives up.
      entry.reason = 'stalled';
      return;
    }
    send(chunk({}, frags ? 'tool_calls' : 'stop'));
    send({ ...chunk({}), choices: [], usage });
    send('[DONE]');
    ended = true;
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port, records }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
  const { port } = await startSynth({ host: option('host') || '127.0.0.1', port: Number(option('port') || 8899),
    key: process.env.SYNTH_KEY, log: option('log') || null });
  console.log(`synth-upstream listening on ${option('host') || '127.0.0.1'}:${port}`);
}
