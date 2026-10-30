// Verification of an approved candidate: one live, streamed request that must come back with a
// well-formed tool call, sent through the same adapter (and request shaping) real traffic uses.
// It runs only for a provider whose key this deployment already holds; nothing signs up anywhere.
import { ADAPTERS, buildUpstreamPayload, upstreamErrorSummary } from '../providers.js';
import { OpenAICompatibleAdapter } from '../provider-adapter.js';
import { httpsUrl } from './policy.js';

// Candidate provider ids (provider database) served by an existing adapter and key.
export const BUILTIN_TARGETS = Object.freeze({
  openrouter: Object.freeze({ adapter: 'openrouter', keyVar: 'OPENROUTER_API_KEY' }),
  nvidia: Object.freeze({ adapter: 'nvidia', keyVar: 'NVIDIA_API_KEY' }),
  groq: Object.freeze({ adapter: 'groq', keyVar: 'GROQ_API_KEY' }),
  'google-gemini': Object.freeze({ adapter: 'gemini', keyVar: 'GEMINI_API_KEY' }),
});
const TIMEOUT_MS = 60_000;
const MAX_STREAM_BYTES = 1_000_000;
export const TEST_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'record_result', description: 'Records the result of a connectivity test.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] }, value: { type: 'integer' } },
      required: ['status', 'value'], additionalProperties: false },
  },
});

export const envSuffix = provider => String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const configured = value => typeof value === 'string' && value.trim().length > 0;

/**
 * How a candidate's provider can be called with a key this deployment holds, or null.
 * Built-in providers use the gateway's own secrets. Any other provider needs both
 * DISCOVERY_KEY_<ID> and DISCOVERY_BASE_<ID> (https) set by the operator: the base URL never
 * comes from discovered data, so a discovered record can never redirect a key.
 */
export function verificationTarget(env, provider) {
  const builtin = BUILTIN_TARGETS[provider];
  if (builtin) {
    return configured(env?.[builtin.keyVar])
      ? { kind: 'builtin', provider: builtin.adapter, keyVar: builtin.keyVar, adapter: ADAPTERS[builtin.adapter] } : null;
  }
  const keyVar = `DISCOVERY_KEY_${envSuffix(provider)}`;
  const base = httpsUrl(env?.[`DISCOVERY_BASE_${envSuffix(provider)}`]);
  if (!base || !configured(env?.[keyVar])) return null;
  return { kind: 'operator_key', provider: 'generic', keyVar,
    adapter: new OpenAICompatibleAdapter({ id: 'generic', keyVar, defaultBase: base.replace(/\/+$/, '') }) };
}

function mergeName(current, name) {
  if (!current || name.startsWith(current)) return name;
  return current.endsWith(name) ? current : current + name;
}

// Reads an OpenAI-style SSE stream; collects tool calls by index and the finish reason.
export async function readStream(response, started) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map();
  let buffer = '';
  let bytes = 0;
  let firstByteMs = null;
  let finish = null;
  let streamError = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    firstByteMs ??= Date.now() - started;
    bytes += value.byteLength;
    if (bytes > MAX_STREAM_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('stream longer than 1 MB');
    }
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event?.error) streamError = event.error;
      for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
        if (choice?.finish_reason) finish = choice.finish_reason;
        for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
          const key = Number.isInteger(call?.index) ? call.index : calls.size;
          const current = calls.get(key) || { name: '', arguments: '' };
          if (typeof call?.function?.name === 'string') current.name = mergeName(current.name, call.function.name);
          const args = call?.function?.arguments;
          if (args !== undefined && args !== null) current.arguments += typeof args === 'string' ? args : JSON.stringify(args);
          calls.set(key, current);
        }
      }
    }
  }
  return { calls: [...calls.values()], finish, firstByteMs, streamError };
}

/**
 * One streamed tool call for `candidate` ({ provider, model_id }). Never throws for upstream
 * failures: returns { passed, ... } for zerox_candidate_record_verification.
 */
export async function verifyCandidate(env, candidate, { timeoutMs = TIMEOUT_MS } = {}) {
  const target = verificationTarget(env, candidate.provider);
  const result = { checked_at: new Date().toISOString(), provider: candidate.provider, model: candidate.model_id,
    via: target?.kind ?? null, passed: false };
  if (!target) return { ...result, error: { message: 'No key is configured for this provider (signing up stays manual).' } };
  const entry = { id: `${candidate.provider}/${candidate.model_id}`, provider: target.provider,
    upstream_model: candidate.model_id, reasoning_efforts: [], supports_tools: true };
  const pool = { tier: 'free', key_var: target.keyVar };
  const payload = buildUpstreamPayload(entry, {
    messages: [
      { role: 'system', content: 'You are a connectivity test. Answer only by calling the record_result tool.' },
      { role: 'user', content: 'Call record_result with status "ok" and value 42.' },
    ],
    tools: [TEST_TOOL], tool_choice: 'auto', stream: true,
  }, 1024);
  const started = Date.now();
  try {
    const response = await target.adapter.chatCompletion(env, {}, entry, payload, AbortSignal.timeout(timeoutMs), pool);
    result.http_status = response.status;
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 8192);
      return { ...result, latency_ms: Date.now() - started,
        error: upstreamErrorSummary(response.status, text, { secrets: [env[target.keyVar]] }) };
    }
    const stream = await readStream(response, started);
    const call = stream.calls.find(item => item.name === TEST_TOOL.function.name);
    let args = null;
    try { args = call ? JSON.parse(call.arguments || '{}') : null; } catch { /* reported below */ }
    const passed = args?.status === 'ok';
    return {
      ...result, passed, latency_ms: Date.now() - started, first_byte_ms: stream.firstByteMs,
      finish_reason: stream.finish, tool_calls: stream.calls.length,
      tool_call: call ? { name: call.name, arguments: call.arguments.slice(0, 200), value_ok: args?.value === 42 } : null,
      ...(passed ? {} : { error: stream.streamError
        ? upstreamErrorSummary(null, JSON.stringify({ error: stream.streamError }), { secrets: [env[target.keyVar]] })
        : { message: call ? 'The tool call arguments were not valid.' : 'The stream ended without the test tool call.' } }),
    };
  } catch (error) {
    return { ...result, latency_ms: Date.now() - started,
      error: { message: error?.name === 'TimeoutError' ? `No complete answer within ${timeoutMs / 1000} s.` : 'The request failed.' } };
  }
}
