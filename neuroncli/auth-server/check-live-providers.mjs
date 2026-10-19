// Manual live smoke test (not part of npm test): drives the real gateway app with the
// provider keys in .dev.vars (or, with --env, the process environment) through one streamed
// tool call per hosted catalog model. Never prints credential values.
//   node check-live-providers.mjs [--env]
import { readFile } from 'node:fs/promises';
import app from './src/index.js';
import { offeredEntries, poolConfigured } from './src/catalog.js';

const PROVIDER_KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY'];

function parseDevVars(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    vars[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

let vars;
if (process.argv.includes('--env')) {
  vars = Object.fromEntries(PROVIDER_KEYS.filter(name => process.env[name]).map(name => [name, process.env[name]]));
} else {
  try {
    vars = parseDevVars(await readFile(new URL('./.dev.vars', import.meta.url), 'utf8'));
  } catch {
    console.error('SKIP: neuroncli/auth-server/.dev.vars is missing; it must hold the provider keys (or use --env).');
    process.exit(2);
  }
}
const secrets = Object.values(vars).filter(value => value.length >= 8);
const redact = text => secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), String(text));

// Count real upstream calls and refuse to exceed the budget.
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (input, options) => {
  if (++upstreamCalls > MAX_UPSTREAM_CALLS) throw new Error('Live smoke call budget exceeded');
  return originalFetch(input, options);
};

const kv = new Map();
// Operator settings from wrangler.toml for the hosted catalog.
const hosting = { NVIDIA_HOSTED: 'true', OPENROUTER_HOSTED: 'true',
  OPENROUTER_MODELS: 'cohere/north-mini-code:free,minimax/minimax-m3.1-flash:free', ALLOW_UNKNOWN_COUNTRY: 'true' };
const models = offeredEntries({ ...vars, ...hosting })
  .filter(entry => entry.pools.some(pool => pool.tier === 'free' && poolConfigured({ ...vars, ...hosting }, entry, pool)));
const MAX_UPSTREAM_CALLS = models.length + 4;
const env = {
  ...vars,
  ALLOW_ANONYMOUS_SESSIONS: 'true',
  ...hosting,
  SESSIONS_KV: {
    get: async key => kv.get(key) ?? null,
    put: async (key, value) => { kv.set(key, value); },
    delete: async key => { kv.delete(key); },
  },
};

const tools = [{ type: 'function', function: {
  name: 'read_file', description: 'Read a file from the workspace and return its contents.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' } }, required: ['path'] },
} }];
const messages = [
  { role: 'system', content: 'You are a coding agent. Always use tools to inspect files; never guess file contents.' },
  { role: 'user', content: 'Read the file README.md using the read_file tool.' },
];

async function anonymousSession() {
  const response = await app.request('http://127.0.0.1:8787/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_fingerprint: 'live-smoke', version: 'live-smoke' }),
  }, env);
  if (!response.ok) throw new Error(`anonymous session failed (${response.status})`);
  return (await response.json()).session_token;
}

async function streamedToolCall(label, token, model) {
  const started = Date.now();
  const result = { label, model, ok: false };
  try {
    const response = await app.request('http://127.0.0.1:8787/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: true, max_tokens: 1024 }),
    }, env);
    result.status = response.status;
    result.served_by = response.headers.get('x-neuron-model');
    result.request_id = response.headers.get('x-request-id');
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))).error || {};
      result.error = `${error.code || 'unknown'}: ${redact(error.message || '')}`;
      return result;
    }
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean).map(event => event.replace(/^data: /, ''));
    result.done = events.includes('[DONE]');
    const chunks = events.filter(event => event !== '[DONE]').map(event => JSON.parse(event));
    const streamError = chunks.find(chunk => chunk.error);
    if (streamError) {
      result.error = `stream ${streamError.error.code}: ${redact(streamError.error.message)}`;
      return result;
    }
    const calls = new Map();
    let indexed = true;
    for (const chunk of chunks) {
      if (chunk.usage) result.usage = chunk.usage.total_tokens;
      for (const choice of chunk.choices || []) {
        if (choice.finish_reason) result.finish = choice.finish_reason;
        if (choice.delta?.reasoning_content) result.reasoning = true;
        for (const delta of choice.delta?.tool_calls || []) {
          if (!Number.isInteger(delta.index)) indexed = false;
          const call = calls.get(delta.index) || { name: '', arguments: '' };
          call.name += delta.function?.name || '';
          call.arguments += delta.function?.arguments || '';
          calls.set(delta.index, call);
        }
      }
    }
    const [call] = calls.values();
    result.tool_calls = calls.size;
    result.every_delta_indexed = indexed;
    result.tool = call?.name;
    try { result.arguments_json = Boolean(call && JSON.parse(call.arguments || '{}')); } catch { result.arguments_json = false; }
    result.ok = result.done && calls.size > 0 && indexed && result.arguments_json && call.name === 'read_file';
    if (!result.ok && !result.error) result.error = calls.size ? 'tool call incomplete' : `no tool call (finish ${result.finish})`;
    return result;
  } catch (error) {
    result.error = redact(error.message);
    return result;
  } finally {
    result.latency_ms = Date.now() - started;
  }
}

const checks = [];
const required = [];
const run = async (label, token, model, { optional = false } = {}) => {
  const result = await streamedToolCall(label, token, model);
  result.optional = optional;
  checks.push(result);
  if (!optional) required.push(result);
};

try {
  const token = await anonymousSession();
  for (const entry of models) await run(entry.provider, token, entry.id, { optional: entry.provider === 'openrouter' });
  await run('auto', token, 'auto');
} finally {
  globalThis.fetch = originalFetch;
}

for (const check of checks) {
  const outcome = check.ok ? 'PASS' : check.optional ? 'WARN' : 'FAIL';
  const detail = check.ok
    ? `tool=${check.tool} calls=${check.tool_calls} indexed=${check.every_delta_indexed} finish=${check.finish} usage=${check.usage ?? 'n/a'} reasoning=${Boolean(check.reasoning)}`
    : `status=${check.status ?? 'n/a'} ${check.error}`;
  console.log(`${outcome} ${check.label} ${check.model} -> ${check.served_by ?? '-'} (${check.latency_ms} ms) ${detail}`);
}
console.log(`Upstream calls: ${upstreamCalls}/${MAX_UPSTREAM_CALLS}`);
process.exitCode = required.length && required.every(check => check.ok) ? 0 : 1;
