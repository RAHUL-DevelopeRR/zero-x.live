import { ProviderAdapter } from './provider-adapter.js';
import { normalizeProviderRequest } from './provider-request.js';

// Workers AI binding errors are thrown as plain Errors whose message starts with the platform
// error code (e.g. "3036: Account limited: ..."). Only that leading code is read (the rest can
// quote the request); it becomes a REST-shaped error response so the gateway classifies it
// like any other upstream failure (3036/3040 are rate limits; other known codes map through
// WORKERS_AI_ERRORS in providers.js; unknown 3xxx codes are 5xx, unknown 5xxx request errors).
const BINDING_ERROR_CODE = /^\s*(?:[A-Za-z]*Error:\s*)?(\d{4})\b/;
export function bindingErrorResponse(error) {
  const match = BINDING_ERROR_CODE.exec(String(error?.message ?? ''));
  const code = match ? Number(match[1]) : null;
  const status = code !== null && code >= 5000 ? 400 : 500;
  return Response.json({ success: false, errors: [{ code: code ?? 0, message: 'Workers AI request failed' }] }, { status });
}

// Workers AI accepts only these chat parameters (the rest are dropped upstream of here).
const WORKERS_AI_PARAMS = ['messages', 'tools', 'max_tokens', 'stream', 'temperature', 'top_p', 'seed',
  'presence_penalty', 'frequency_penalty'];

export class CloudflareWorkersAIAdapter extends ProviderAdapter {
  constructor() {
    super('cloudflare');
  }

  capabilities() {
    return { ...super.capabilities(), tools: true };
  }

  isConfigured(env, session = {}) {
    if (session.owned_provider_only && !session.account_backed) return false;
    return Boolean(env.AI || (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN));
  }

  catalogSource() {
    return 'allowlist';
  }

  requestBody(payload) {
    const body = {};
    const normalized = normalizeProviderRequest(this.id, payload);
    for (const name of WORKERS_AI_PARAMS) if (normalized[name] !== undefined) body[name] = normalized[name];
    // Workers AI takes bare function definitions instead of OpenAI tool wrappers.
    if (body.tools) body.tools = body.tools.map(tool => tool.function);
    return body;
  }

  async chatCompletion(env, session, entry, payload, signal, normalizeCompletion) {
    const model = entry.upstream_model || entry.upstream || entry.id;
    const body = this.requestBody(payload);

    if (env.AI) {
      let result;
      try {
        result = await env.AI.run(model, body);
      } catch (error) {
        return bindingErrorResponse(error);
      }
      // The binding takes no abort signal: when the attempt was abandoned (first-byte timeout
      // or client disconnect) while run() was pending, stop the generation it started.
      if (signal?.aborted) {
        if (typeof result?.cancel === 'function') result.cancel().catch(() => {});
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }
      if (payload.stream) {
        if (typeof result?.getReader !== 'function') {
          throw new Error('Workers AI did not return a stream');
        }
        return new Response(result, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json(normalizeCompletion(result, entry.id, payload.messages, payload.tools));
    }

    // Model ids can come from catalog rows: each path segment is encoded and dot segments are
    // refused (the catalog guardrails already allow nothing but @cf/<org>/<model>), so no id can
    // reach another API path.
    const segments = String(model).split('/');
    if (segments.some(segment => !segment || /^(?:\.|%2e){1,2}$/i.test(segment))) {
      throw new Error('Refused a Workers AI model id that is not a plain model path');
    }
    const path = segments.map(segment => encodeURIComponent(segment).replace(/^%40/, '@')).join('/');
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'manual',
      }
    );
    if (!response.ok || payload.stream) return response;
    const result = await response.json();
    if (result.success === false) {
      throw new Error('Cloudflare returned an unsuccessful completion');
    }
    return Response.json(normalizeCompletion(result.result || result, entry.id, payload.messages, payload.tools));
  }
}
