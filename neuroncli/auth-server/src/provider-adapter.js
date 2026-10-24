import { normalizeProviderRequest } from './provider-request.js';

/**
 * ProviderAdapter - Common interface for upstream AI model providers.
 */
export class ProviderAdapter {
  constructor(id) {
    this.id = id;
  }

  capabilities() {
    return {
      tools: false,
      streaming: true,
      parallel_tools: false,
      vision: false,
      reasoning: false,
    };
  }

  isConfigured(env, session = {}) {
    throw new Error('Not implemented');
  }

  listModels(env, session = {}) {
    throw new Error('Not implemented');
  }

  async healthCheck(env) {
    throw new Error('Not implemented');
  }

  async chatCompletion(env, session, entry, payload, signal) {
    throw new Error('Not implemented');
  }

  normalizeError(status, errorPayload, requestId) {
    const message = errorPayload?.error?.message || errorPayload?.message || 'Upstream provider error';
    const type = status === 429 ? 'rate_limit_error' : status >= 500 ? 'upstream_error' : 'invalid_request_error';
    const code = status === 429 ? 'rate_limited' : errorPayload?.error?.code || 'upstream_failure';
    return {
      error: {
        message,
        type,
        code,
        request_id: requestId,
      },
    };
  }

  extractUsage(result) {
    return result?.usage || null;
  }
}

/**
 * OpenAICompatibleAdapter - Generic adapter for standard OpenAI-compatible HTTP providers.
 */
export class OpenAICompatibleAdapter extends ProviderAdapter {
  constructor(options) {
    super(options.id);
    this.keyVar = options.keyVar;
    this.modelsVar = options.modelsVar;
    this.toolModelsVar = options.toolModelsVar;
    this.defaultBase = options.defaultBase;
    this.customBaseResolver = options.customBaseResolver;
    this.providerPrefix = options.providerPrefix ?? false;
    this.defaultFallbackModels = options.defaultFallbackModels || [];
    this.supportsToolDiscovery = options.supportsToolDiscovery ?? true;
    this.freeOnlyFlag = options.freeOnlyFlag;
  }

  getBaseUrl(env) {
    if (this.customBaseResolver) {
      return this.customBaseResolver(env);
    }
    return this.defaultBase;
  }

  // A caller's own OpenRouter key (BYOK) is used only for sessions that are not
  // provisioned accounts; every hosted pool names its own server-side key variable.
  getApiKey(env, session = {}, pool = null) {
    if (this.id === 'openrouter' && !session.account_backed && session.openrouter_key &&
        (!pool || pool.tier === 'byok')) {
      return session.openrouter_key;
    }
    return env[pool?.key_var || this.keyVar];
  }

  isConfigured(env, session = {}) {
    if (session.owned_provider_only && !session.account_backed && this.id !== 'openrouter') {
      return false;
    }
    const key = this.getApiKey(env, session);
    if (!key) return false;
    if (this.id === 'azure') return !!env.AZURE_OPENAI_ENDPOINT;
    return !!this.getBaseUrl(env);
  }

  catalogSource(env) {
    if (this.modelsVar && env[this.modelsVar] !== undefined) return 'allowlist';
    if (this.id === 'azure') return 'allowlist';
    if (this.id === 'bedrock' && env.BEDROCK_ENDPOINT === 'runtime') return 'allowlist';
    return 'discovery';
  }

  parseModelIds(value, fallback = []) {
    return value === undefined ? fallback : String(value).split(',').map(id => id.trim()).filter(Boolean);
  }

  catalogEntry(env, upstream, metadata) {
    const id = this.providerPrefix ? `${this.id}/${upstream}` : upstream;
    const explicitTools = this.toolModelsVar ? this.parseModelIds(env[this.toolModelsVar]).includes(upstream) : false;
    let tools = false;
    if (metadata) {
      tools = explicitTools ||
        (Array.isArray(metadata.supported_parameters) && metadata.supported_parameters.includes('tools')) ||
        (metadata.capabilities?.tools === true);
    } else {
      tools = explicitTools || (
        !['omniroute', 'bedrock'].includes(this.id) &&
        (!this.toolModelsVar || env[this.toolModelsVar] === undefined)
      );
    }
    const contextWindow = Number(metadata?.context_length);
    const maxOutput = Number(metadata?.top_provider?.max_completion_tokens);
    return {
      id,
      upstream,
      upstream_model: upstream,
      provider: this.id,
      display_name: typeof metadata?.name === 'string' ? metadata.name.slice(0, 120) : upstream,
      tools,
      supports_tools: tools,
      supports_streaming: true,
      supports_parallel_tools: tools,
      context_window: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 131072,
      max_output_tokens: Number.isSafeInteger(maxOutput) && maxOutput > 0 ? maxOutput : 16384,
    };
  }

  listStaticModels(env, session = {}) {
    if (!this.isConfigured(env, session)) return [];
    const models = [];
    const fallback = this.id === 'openrouter' ? ['openrouter/free'] : this.defaultFallbackModels;
    const ids = this.parseModelIds(env[this.modelsVar], fallback);
    for (const upstream of ids) {
      models.push(this.catalogEntry(env, upstream));
    }
    return models;
  }

  async discoverModels(env, session = {}) {
    if (this.id === 'azure' || (this.id === 'bedrock' && env.BEDROCK_ENDPOINT === 'runtime')) {
      const models = this.listStaticModels(env, session);
      return {
        provider: this.id,
        status: models.length ? 'configured' : 'allowlist_required',
        discovery: false,
        models,
      };
    }
    const started = Date.now();
    const result = {
      provider: this.id,
      checked_at: new Date().toISOString(),
      discovery: true,
      models: [],
    };
    const baseUrl = this.getBaseUrl(env);
    const apiKey = this.getApiKey(env, session);
    if (!baseUrl || !apiKey) {
      return { ...result, status: 'not_configured', latency_ms: Date.now() - started };
    }
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      result.http_status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        return {
          ...result,
          status: response.status === 401 || response.status === 403
            ? 'unauthorized'
            : response.status === 429
            ? 'rate_limited'
            : 'unavailable',
          latency_ms: Date.now() - started,
        };
      }
      const data = await response.json();
      if (!Array.isArray(data.data)) throw new Error('Invalid provider catalog');
      result.models = data.data
        .filter(model => typeof model?.id === 'string' && model.id.trim().length > 0 && model.id.length <= 512 && model.active !== false)
        .filter(model => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'))
        .filter(model => {
          if (this.id !== 'openrouter') return true;
          if (env.OPENROUTER_FREE_ONLY === 'false') return true;
          if (model.id === 'openrouter/free') return true;
          return (
            model.pricing?.prompt != null &&
            model.pricing?.completion != null &&
            model.pricing.prompt !== '' &&
            model.pricing.completion !== '' &&
            Number(model.pricing.prompt) === 0 &&
            Number(model.pricing.completion) === 0
          );
        })
        .map(model => this.catalogEntry(env, model.id, model));
      return { ...result, status: 'reachable', latency_ms: Date.now() - started };
    } catch {
      return { ...result, status: 'unavailable', latency_ms: Date.now() - started };
    }
  }

  // `request.signatureFor` restores Gemini thought signatures (see provider-request.js).
  async chatCompletion(env, session, entry, payload, signal, pool = null, request = {}) {
    let url = `${this.getBaseUrl(env)}/chat/completions`;
    if (this.id === 'azure') {
      url = `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/models/chat/completions?api-version=${encodeURIComponent(env.AZURE_API_VERSION || '2024-05-01-preview')}`;
    }
    const key = this.getApiKey(env, session, pool);
    // Messages and tool calls in the subset this upstream accepts (provider-request.js).
    const body = {
      ...normalizeProviderRequest(this.id, payload, { signatureFor: request.signatureFor }),
      model: entry.upstream_model || entry.upstream || entry.id,
    };
    if (payload.stream) {
      // Usage is required for settlement; OpenAI-compatible upstreams send it on request.
      body.stream_options = { ...(payload.stream_options || {}), include_usage: true };
    } else {
      delete body.stream_options;
    }
    if (this.id === 'openrouter') {
      // Never route prompts to OpenRouter endpoints that retain or train on them.
      body.provider = { ...(payload.provider || {}), data_collection: 'deny' };
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
      // Never follow a redirect with the key attached. The Workers runtime rejects the 'error'
      // redirect mode, so a 3xx comes back as a non-ok response and fails the attempt.
      redirect: 'manual',
    });
  }
}
