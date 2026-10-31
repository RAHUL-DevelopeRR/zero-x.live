// Streaming CPU checks (CPU-2): the client stream of createCompletionStream stays byte-identical
// to the golden fixture however the upstream groups its SSE events, enqueues at most once per
// upstream read, settles exactly once (also on an idle timeout and a client abort), and its warm
// per-event cost stays under 2x the recorded ratio to plain JSON parse/stringify work.
// `--record-golden` rewrites the output fixture, `--record-baseline` the CPU ratio.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SseEventReader, createCompletionStream } from './src/providers.js';
import { FailureKind } from './src/provider-health.js';
import { utf8Bytes } from './src/pricing.js';

const FIXTURE = new URL('./fixtures/stream-cpu-golden.json', import.meta.url);
const recordGolden = process.argv.includes('--record-golden');
const recordBaseline = process.argv.includes('--record-baseline');
const fixture = (() => {
  try { return JSON.parse(readFileSync(FIXTURE, 'utf8')); } catch { return {}; }
})();
const encoder = new TextEncoder();
const EVENTS = 3000;

// NVIDIA/vLLM gpt-oss style: reasoning tokens (Groq's `reasoning` too), a little content, two
// tool calls streamed as argument fragments, finish_reason, a usage chunk and [DONE]. Text covers
// quotes, backslashes, newlines, accents, emoji and an SSE comment.
function upstreamEvents() {
  const base = { id: 'chatcmpl-0123456789abcdef0123456789abcdef', object: 'chat.completion.chunk', created: 1793034000,
    model: 'openai/gpt-oss-20b' };
  const event = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra })}`;
  const words = [' tok', ' café', ' "quoted"', ' back\\slash', ' 😀', '\n', ' 日本'];
  const args0 = JSON.stringify({ path: 'src/app.js', content: 'const s = "é 😀";\n\tconsole.log(s, \'\\\\\');\n'.repeat(60) });
  const args1 = JSON.stringify({ path: 'README.md', note: 'naïve "x" \\ 🚀 '.repeat(40) });
  const fragments = (text, count) => Array.from({ length: count }, (_, i) =>
    text.slice(Math.floor(i * text.length / count), Math.floor((i + 1) * text.length / count)));
  const lines = [event({ role: 'assistant', content: '' })];
  for (let i = 0; i < 900; i++) lines.push(event({ reasoning_content: words[i % words.length] + (i % 97) }));
  lines.push(': keep-alive');
  for (let i = 0; i < 100; i++) lines.push(event({ reasoning: ` think${i}` }));
  for (let i = 0; i < 300; i++) lines.push(event({ content: words[i % words.length] }));
  lines.push(event({ tool_calls: [{ index: 0, id: 'chatcmpl-tool-abc123', type: 'function',
    function: { name: 'write_file', arguments: '' } }] }));
  const rest = EVENTS - lines.length - 4;
  for (const piece of fragments(args0, 1500)) lines.push(event({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
  lines.push(event({ tool_calls: [{ index: 1, id: 'chatcmpl-tool-def456', type: 'function',
    function: { name: 'read_file', arguments: '' } }] }));
  for (const piece of fragments(args1, rest - 1500)) lines.push(event({ tool_calls: [{ index: 1, function: { arguments: piece } }] }));
  lines.push(event({}, 'tool_calls'));
  lines.push(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 9000, completion_tokens: 2990, total_tokens: 11990 } })}`);
  lines.push('data: [DONE]');
  assert.equal(lines.length, EVENTS);
  return lines;
}

const LINES = upstreamEvents();

// Text the byte estimate must escape like JSON.stringify: control characters, lone surrogates,
// DEL and U+2028, plus a non-string tool name, object arguments and a Workers AI native event.
const ODD = ['\u0001\b\f\r\u001f', '\ud800', 'x\udc00y', '\ud83d', '\u007f ', 'ß€𝄞', '"\\'];
const ODD_LINES = [
  { choices: [{ index: 0, delta: { content: ODD.join('') } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call "1', type: 'function', function: { name: 'write\u0000', arguments: '' } }] } }] },
  ...ODD.map(text => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text } }] } }] })),
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 12, id: 'c2', function: { name: 42, arguments: { a: ODD[1] } } }] } }] },
  { response: ODD.join(''), tool_calls: [{ name: 'native', arguments: { q: '"x"' } }, { id: 'n2', name: 'two' }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map(value => `data: ${JSON.stringify(value)}`).concat('data: [DONE]');

// Upstream bodies: `per` events per read (LF), or CRLF text cut every `bytes` bytes, which splits
// CRLF pairs and UTF-8 sequences across reads.
function chunked({ per = 1, bytes = 0, lines = LINES } = {}) {
  if (bytes) {
    const all = encoder.encode(lines.map(line => `${line}\r\n\r\n`).join(''));
    const reads = [];
    for (let i = 0; i < all.length; i += bytes) reads.push(all.subarray(i, i + bytes));
    return reads;
  }
  const reads = [];
  for (let i = 0; i < lines.length; i += per) reads.push(encoder.encode(lines.slice(i, i + per).map(line => `${line}\n\n`).join('')));
  return reads;
}

function body(reads, { stallAfter = Infinity } = {}) {
  let i = 0;
  const stats = { reads: 0 };
  return {
    stats,
    stream: new ReadableStream({
      pull(controller) {
        if (i >= stallAfter) return new Promise(() => {});
        if (i < reads.length) {
          stats.reads++;
          controller.enqueue(reads[i++]);
        } else controller.close();
      },
    }, { highWaterMark: 0 }),
  };
}

async function open(reads, { stallAfter, idleMs = 90000, clientSignal = new AbortController().signal } = {}) {
  const upstream = body(reads, { stallAfter });
  const reader = new SseEventReader(upstream.stream);
  const first = await reader.next();
  const finishes = [];
  const controller = new AbortController();
  const stream = createCompletionStream({ reader, first, model: 'nvidia/openai/gpt-oss-20b', controller, clientSignal,
    timeouts: { ttfbMs: 45000, idleMs }, requestId: 'req_stream_cpu', env: {},
    onFinish: async outcome => { finishes.push(outcome); } });
  return { stream, finishes, upstream, controller };
}

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks++;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), chunks };
}

// Per-stream ids and timestamps vary between runs.
const stable = text => text.replace(/chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'chatcmpl-ID')
  .replace(/"created":\d+/g, '"created":0');
const digest = text => createHash('sha256').update(text).digest('hex');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
// The output estimate as originally computed: UTF-8 bytes of each client delta's content and
// reasoning plus its serialized tool_calls.
const estimatedOutputBytes = text => text.trim().split('\n\n').map(line => line.slice(6)).filter(data => data !== '[DONE]')
  .flatMap(data => JSON.parse(data).choices ?? []).reduce((sum, { delta = {} }) => sum + utf8Bytes(delta.content || '') +
    utf8Bytes(delta.reasoning_content || '') + (delta.tool_calls ? utf8Bytes(delta.tool_calls) : 0), 0);

// (a)-(c) Same client bytes and settlement for every upstream grouping; one enqueue per read at most.
const golden = { bytes: null, sha256: null, finish: null };
for (const [name, reads] of [['1 event per read', chunked({ per: 1 })], ['4 events per read', chunked({ per: 4 })],
  ['CRLF, 61-byte reads', chunked({ bytes: 61 })]]) {
  const { stream, finishes, upstream } = await open(reads);
  const { text, chunks } = await collect(stream);
  await settle();
  const output = stable(text);
  const finish = finishes.map(({ status, usage, outputBytes }) => ({ status, usage, outputBytes }));
  if (golden.sha256 === null) Object.assign(golden, { bytes: encoder.encode(output).byteLength, sha256: digest(output), finish });
  if (!recordGolden) {
    assert.ok(fixture.golden, 'golden fixture missing: run with --record-golden on the reference code');
    assert.equal(encoder.encode(output).byteLength, fixture.golden.bytes, `${name}: client byte count`);
    assert.equal(digest(output), fixture.golden.sha256, `${name}: client bytes differ from the golden fixture`);
    assert.deepEqual(finish, fixture.golden.finish, `${name}: onFinish runs once with the golden usage and outputBytes`);
  }
  assert.equal(finishes.length, 1, `${name}: onFinish runs once`);
  assert.equal(finishes[0].outputBytes, estimatedOutputBytes(text), `${name}: outputBytes`);
  if (!recordGolden) assert.ok(chunks <= upstream.stats.reads, `${name}: ${chunks} client chunks for ${upstream.stats.reads} upstream reads`);
  console.log(`ok - ${name}: ${upstream.stats.reads} upstream reads, ${chunks} client chunks, ${output.length} chars`);
}
if (recordGolden) fixture.golden = golden;

// (c) The tool-call byte count matches the serialized deltas for text JSON has to escape.
for (const per of [1, 3]) {
  const { stream, finishes } = await open(chunked({ per, lines: ODD_LINES }));
  const { text } = await collect(stream);
  await settle();
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].status, 'ok');
  assert.equal(finishes[0].outputBytes, estimatedOutputBytes(text), `${per} per read: outputBytes for escaped text`);
}
console.log('ok - outputBytes matches the serialized deltas for control characters, lone surrogates and native events');

// A malformed event inside one upstream read: the events before it still reach the client,
// then the upstream_error event, exactly as when each event arrives in its own read.
{
  const lines = [...LINES.slice(0, 6), 'data: {"choices":[', ...LINES.slice(6, 9)];
  const outputs = [];
  for (const per of [1, 4, 10]) {
    const { stream, finishes } = await open(chunked({ per, lines }));
    const { text } = await collect(stream);
    await settle();
    assert.equal(finishes.length, 1);
    assert.deepEqual([finishes[0].status, finishes[0].errorCode], ['error', 'upstream_error']);
    outputs.push(stable(text));
  }
  const events = outputs[0].trim().split('\n\n');
  assert.equal(events.length, 7, 'the six events before the malformed one, then the error event');
  assert.equal(JSON.parse(events.at(-1).slice(6)).error.code, 'upstream_error');
  assert.equal(outputs[1], outputs[0]);
  assert.equal(outputs[2], outputs[0]);
  console.log('ok - a malformed event inside a batch keeps the events before it and ends with upstream_error');
}

// (d) A stall after N events ends with the upstream_timeout event and one timeout settlement.
{
  const { stream, finishes, controller } = await open(chunked({ per: 1 }), { stallAfter: 40, idleMs: 30 });
  const { text } = await collect(stream);
  await settle();
  const events = text.trim().split('\n\n').map(line => line.slice(6));
  assert.equal(events.length, 41, 'the 40 events read before the stall, then the error event');
  assert.equal(JSON.parse(events.at(-1)).error.code, 'upstream_timeout');
  assert.equal(JSON.parse(events.at(-1)).error.request_id, 'req_stream_cpu');
  assert.equal(finishes.length, 1);
  assert.deepEqual([finishes[0].status, finishes[0].kind, finishes[0].phase, finishes[0].errorCode],
    ['error', FailureKind.TIMEOUT, 'idle', 'upstream_timeout']);
  assert.equal(controller.signal.reason?.name, 'UpstreamTimeoutError');
  console.log('ok - an idle upstream ends the stream with upstream_timeout and settles once');
}

// (d) A client abort while a read is pending errors the stream and settles once as ABORTED.
{
  const client = new AbortController();
  const { stream, finishes } = await open(chunked({ per: 1 }), { stallAfter: 40, clientSignal: client.signal });
  const reader = stream.getReader();
  for (let i = 0; i < 40; i++) assert.equal((await reader.read()).done, false);
  const pending = reader.read();
  await settle();
  client.abort();
  await assert.rejects(pending);
  await reader.cancel().catch(() => {});
  await settle();
  assert.equal(finishes.length, 1);
  assert.deepEqual([finishes[0].status, finishes[0].kind, finishes[0].errorCode], ['error', FailureKind.ABORTED, 'client_disconnected']);
  console.log('ok - a client abort mid-stream errors the stream and settles once');
}

// (e) Warm CPU per event against plain JSON work over the same events in the same process (the
// fastest of several runs, the least disturbed by other load).
{
  const reads = chunked({ per: 4 });
  const fastest = async (fn, runs = 9) => {
    await fn();
    let best = Infinity;
    for (let k = 0; k < runs; k++) {
      const started = performance.now();
      await fn();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const gateway = await fastest(async () => collect((await open(reads)).stream));
  const reference = await fastest(async () => {
    for (const line of LINES) if (line.startsWith('data: {')) JSON.stringify(JSON.parse(line.slice(6)));
  });
  const ratio = gateway / reference;
  console.log(`cpu - ${(gateway * 1000 / EVENTS).toFixed(2)} us/event at 4 events per read; ` +
    `${ratio.toFixed(2)}x JSON parse+stringify (recorded ${fixture.cpu?.ratio ?? 'none'})`);
  if (recordBaseline) fixture.cpu = { ratio: Number(ratio.toFixed(2)), usPerEvent: Number((gateway * 1000 / EVENTS).toFixed(2)) };
  else if (fixture.cpu) assert.ok(ratio < 2 * fixture.cpu.ratio, `streaming CPU ${ratio.toFixed(2)}x is over 2x the recorded ${fixture.cpu.ratio}x`);
}

if (recordGolden || recordBaseline) writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('PASS: streaming output, enqueue batching, settlement and CPU checks');
