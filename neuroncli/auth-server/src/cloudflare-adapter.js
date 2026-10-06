import { ProviderAdapter } from './provider-adapter.js';

const CF_DEFAULTS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const CF_TOOL_MODELS = new Set([CF_DEFAULTS[0]]);

export class CloudflareWorkersAIAdapter extends ProviderAdapter {
  constructor() {
    super('cloudflare');
  }

  isConfigured(env, session = {}) {
    if (session.owned_provider_only && !session.account_backed) return false;
    return Boolean(env.AI || (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN));
  }

  catalogSource() {
    return 'allowlist';
  }

  parseModelIds(value, fallback = []) {
    return value === undefined ? fallback : String(value).split(',').map(id => id.trim()).filter(Boolean);
  }

  listStaticModels(env, session = {}) {
    if (!this.isConfigured(env, session)) return [];
    const models = [];
    const configuredModels = this.parseModelIds(env.CLOUDFLARE_MODELS, CF_DEFAULTS);
    const toolModels = this.parseModelIds(env.CLOUDFLARE_TOOL_MODELS);
    for (const id of configuredModels) {
      if (!id.startsWith('@cf/') && !id.startsWith('@hf/')) continue;
      models.push({
        id,
        upstream: id,
        provider: 'cloudflare',
        tools: CF_TOOL_MODELS.has(id) || toolModels.includes(id),
        supports_streaming: true,
        supports_parallel_tools: CF_TOOL_MODELS.has(id) || toolModels.includes(id),
      });
    }
    return models;
  }

  async discoverModels(env, session = {}) {
    return {
      provider: 'cloudflare',
      status: 'binding_configured',
      discovery: false,
      models: this.listStaticModels(env, session),
    };
  }

  async chatCompletion(env, session, entry, payload, signal, normalizeCompletion) {
    const body = { ...payload, model: entry.upstream || entry.id };
    if (body.tools) {
      body.tools = body.tools.map(tool => tool.function);
    }
    delete body.stream_options;

    if (env.AI) {
      const result = await env.AI.run(entry.id, body);
      if (payload.stream) {
        if (typeof result?.getReader !== 'function') {
          throw new Error('Workers AI did not return a stream');
        }
        return new Response(result, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json(normalizeCompletion(result, entry.id, payload.messages, payload.tools));
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${entry.id}`,
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
