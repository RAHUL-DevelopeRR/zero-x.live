import { ProviderAdapter } from './provider-adapter.js';

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
    for (const name of WORKERS_AI_PARAMS) if (payload[name] !== undefined) body[name] = payload[name];
    // Workers AI takes bare function definitions instead of OpenAI tool wrappers.
    if (body.tools) body.tools = body.tools.map(tool => tool.function);
    return body;
  }

  async chatCompletion(env, session, entry, payload, signal, normalizeCompletion) {
    const model = entry.upstream_model || entry.upstream || entry.id;
    const body = this.requestBody(payload);

    if (env.AI) {
      const result = await env.AI.run(model, body);
      if (payload.stream) {
        if (typeof result?.getReader !== 'function') {
          throw new Error('Workers AI did not return a stream');
        }
        return new Response(result, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json(normalizeCompletion(result, entry.id, payload.messages, payload.tools));
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
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
