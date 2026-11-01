// Request bodies for the A/B harness (abtest.mjs). The realistic one is a real Neuron 6.2.5
// request (neuroncli/auth-server/fixtures/neuron-chat-request.json: model auto, a stream, 22
// tools, about 21 KB); the others scale one dimension each: a tiny prompt, a large prompt, a long
// history, many tools. Every body ends in a user message carrying the synthetic upstream's
// directive (synth-upstream.mjs): `abtest:{"nonce":...,"tokens":...}`, which says how to answer
// and lets the upstream's witness log name the request.
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../../neuroncli/auth-server/fixtures/neuron-chat-request.json', import.meta.url), 'utf8'));

// Source code as tool output: quotes, backslashes and newlines, so JSON escaping costs what it does
// for an agent's history (as loadtest.mjs builds it).
const SOURCE = 'export function handler(event) {\n  const { path = "/", headers = {} } = event;\n' +
  '  if (!path.startsWith("/v1/")) return { status: 404, body: "{\\"error\\":\\"not found\\"}" };\n  return route(path, headers);\n}\n';

/** The directive line for synth-upstream.mjs. Only the keys it knows are sent. */
export function directive({ nonce, tokens = 64, rate = 50, ttfbMs = 0, fail = null, stallAfter = null, quietMs = 0,
  toolFrags = 0, reasoning = 0 } = {}) {
  const spec = { nonce: String(nonce), tokens, rate, ttfb_ms: ttfbMs, quiet_ms: quietMs, tool_frags: toolFrags, reasoning };
  if (fail) spec.fail = fail;
  if (stallAfter !== null) spec.stall_after = stallAfter;
  return `abtest:${JSON.stringify(spec)}`;
}

/** Earlier turns of about `kb` KB (loadtest.mjs's generator). */
export function history(kb) {
  const messages = [{ role: 'system', content: 'You are a coding agent. Read files with the tools before editing them.\n'.repeat(20) }];
  for (let turn = 0; Buffer.byteLength(JSON.stringify(messages)) < kb * 1024; turn++) {
    messages.push({ role: 'user', content: `Tool output, read_file src/module${turn}.js:\n${SOURCE.repeat(16)}` },
      { role: 'assistant', content: `I read src/module${turn}.js; next I edit it.` });
  }
  return messages;
}

// The fixture's tools `times` over (renamed, so names stay unique) plus one tool with a 40 KB schema
// (the gateway takes at most 128 tools).
function manyTools(times) {
  const tools = [];
  for (let copy = 0; copy < times; copy++) {
    for (const tool of fixture.tools) tools.push({ ...tool, function: { ...tool.function, name: `${tool.function.name}_${copy}` } });
  }
  const properties = {};
  for (let i = 0; Buffer.byteLength(JSON.stringify(properties)) < 40 * 1024; i++) {
    properties[`field_${i}`] = { type: 'string', description: `Field ${i} of the generated record. ${'Describes the value in detail. '.repeat(4)}` };
  }
  tools.push({ type: 'function', function: { name: 'large_schema', description: 'A tool with a large schema.',
    parameters: { type: 'object', properties } } });
  return tools;
}

const base = (model, tokens) => ({ model, stream: true, max_tokens: tokens + 64 });

/**
 * The body for a payload kind: tiny, realistic, large (with `kb`), history (with `kb`) or tools.
 * Returns the JSON text, so its size is what goes on the wire.
 */
export function buildBody(kind, { model = 'auto', kb = 256, ...spec } = {}) {
  const line = directive(spec);
  const tokens = spec.tokens ?? 64;
  let body;
  switch (kind) {
    case 'tiny':
      body = { ...base(model, tokens), messages: [{ role: 'user', content: `${line}\nSay hello.` }] };
      break;
    case 'realistic':
      body = { ...fixture, ...base(model, tokens), messages: [...fixture.messages, { role: 'user', content: line }] };
      break;
    case 'large': {
      const filler = SOURCE.repeat(Math.ceil(kb * 1024 / SOURCE.length)).slice(0, kb * 1024);
      body = { ...base(model, tokens), messages: [{ role: 'user', content: `Review this file:\n${filler}\n${line}` }] };
      break;
    }
    case 'history':
      body = { ...base(model, tokens), messages: [...history(kb), { role: 'user', content: line }] };
      break;
    case 'tools':
      body = { ...base(model, tokens), tools: manyTools(5), tool_choice: 'auto',
        messages: [...fixture.messages, { role: 'user', content: line }] };
      break;
    default:
      throw new Error(`unknown payload ${kind}`);
  }
  return JSON.stringify(body);
}

// The upstream reads the directive back (synth-upstream.mjs, which needs nothing else on the VM).
export { readDirective } from './synth-upstream.mjs';
