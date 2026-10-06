import { CloudflareWorkersAIAdapter } from './cloudflare-adapter.js';
import { OpenAICompatibleAdapter } from './provider-adapter.js';

function omnirouteBaseResolver(env) {
  if (!env.OMNIROUTE_BASE_URL) return null;
  try {
    const url = new URL(env.OMNIROUTE_BASE_URL);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function bedrockBaseResolver(env) {
  const region = env.BEDROCK_REGION || env.AWS_REGION;
  if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return null;
  return env.BEDROCK_ENDPOINT === 'runtime'
    ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`
    : `https://bedrock-mantle.${region}.api.aws/v1`;
}

export const ADAPTERS = {
  cloudflare: new CloudflareWorkersAIAdapter(),
  openrouter: new OpenAICompatibleAdapter({
    id: 'openrouter',
    keyVar: 'OPENROUTER_API_KEY',
    modelsVar: 'OPENROUTER_MODELS',
    defaultBase: 'https://openrouter.ai/api/v1',
    defaultFallbackModels: ['openrouter/free'],
  }),
  groq: new OpenAICompatibleAdapter({
    id: 'groq',
    keyVar: 'GROQ_API_KEY',
    modelsVar: 'GROQ_MODELS',
    toolModelsVar: 'GROQ_TOOL_MODELS',
    defaultBase: 'https://api.groq.com/openai/v1',
    providerPrefix: true,
  }),
  gemini: new OpenAICompatibleAdapter({
    id: 'gemini',
    keyVar: 'GEMINI_API_KEY',
    modelsVar: 'GEMINI_MODELS',
    toolModelsVar: 'GEMINI_TOOL_MODELS',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
    providerPrefix: true,
  }),
  nvidia: new OpenAICompatibleAdapter({
    id: 'nvidia',
    keyVar: 'NVIDIA_API_KEY',
    modelsVar: 'NVIDIA_MODELS',
    toolModelsVar: 'NVIDIA_TOOL_MODELS',
    defaultBase: 'https://integrate.api.nvidia.com/v1',
    providerPrefix: true,
  }),
  omniroute: new OpenAICompatibleAdapter({
    id: 'omniroute',
    keyVar: 'OMNIROUTE_API_KEY',
    modelsVar: 'OMNIROUTE_MODELS',
    toolModelsVar: 'OMNIROUTE_TOOL_MODELS',
    providerPrefix: true,
    customBaseResolver: omnirouteBaseResolver,
  }),
  bedrock: new OpenAICompatibleAdapter({
    id: 'bedrock',
    keyVar: 'BEDROCK_API_KEY',
    modelsVar: 'BEDROCK_MODELS',
    toolModelsVar: 'BEDROCK_TOOL_MODELS',
    providerPrefix: true,
    customBaseResolver: bedrockBaseResolver,
  }),
  azure: new OpenAICompatibleAdapter({
    id: 'azure',
    keyVar: 'AZURE_OPENAI_API_KEY',
    modelsVar: 'AZURE_MODELS',
    defaultBase: '',
  }),
};

const HTTP_PROVIDER_KEYS = ['openrouter', 'groq', 'gemini', 'nvidia', 'omniroute', 'bedrock', 'azure'];

export function providerConfiguration(env, session = {}) {
  return HTTP_PROVIDER_KEYS.map(provider => {
    const adapter = ADAPTERS[provider];
    return {
      provider,
      configured: adapter ? adapter.isConfigured(env, session) : false,
      catalog_source: adapter ? adapter.catalogSource(env) : 'discovery',
    };
  });
}

export function modelCatalog(env, session = {}) {
  const catalog = [];
  if (ADAPTERS.cloudflare.isConfigured(env, session)) {
    catalog.push(...ADAPTERS.cloudflare.listStaticModels(env, session));
  }
  for (const id of HTTP_PROVIDER_KEYS) {
    const adapter = ADAPTERS[id];
    if (adapter && adapter.isConfigured(env, session)) {
      for (const entry of adapter.listStaticModels(env, session)) {
        if (!catalog.some(m => m.id === entry.id)) {
          catalog.push(entry);
        }
      }
    }
  }
  return catalog;
}

const discoveryCache = new WeakMap();

async function discoverProviderCached(env, session, provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return { provider, status: 'unavailable', models: [] };

  if (adapter.catalogSource(env) === 'allowlist') {
    const models = adapter.listStaticModels(env, session);
    return {
      provider,
      status: models.length ? 'configured' : 'allowlist_required',
      discovery: false,
      models,
    };
  }

  let cache = discoveryCache.get(env);
  if (!cache) {
    cache = new Map();
    discoveryCache.set(env, cache);
  }

  const key = `${provider}:${adapter.getBaseUrl(env)}:${adapter.getApiKey(env, session)}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.promise;
  }

  const promise = adapter.discoverModels(env, session);
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(key, { promise, expires: Date.now() + 60000 });
  return promise;
}

export async function resolveModelCatalog(env, session = {}) {
  const catalog = [];
  if (ADAPTERS.cloudflare.isConfigured(env, session)) {
    catalog.push(...ADAPTERS.cloudflare.listStaticModels(env, session));
  }

  for (const provider of HTTP_PROVIDER_KEYS) {
    const adapter = ADAPTERS[provider];
    if (!adapter || !adapter.isConfigured(env, session)) continue;

    if (adapter.catalogSource(env) === 'allowlist') {
      for (const entry of adapter.listStaticModels(env, session)) {
        if (!catalog.some(m => m.id === entry.id)) catalog.push(entry);
      }
    } else {
      const discovery = await discoverProviderCached(env, session, provider);
      for (const entry of discovery.models) {
        if (!catalog.some(m => m.id === entry.id)) catalog.push(entry);
      }
    }
  }

  return catalog;
}

export async function providerHealth(env) {
  const healthList = [];
  for (const provider of HTTP_PROVIDER_KEYS) {
    const adapter = ADAPTERS[provider];
    if (!adapter || !adapter.isConfigured(env)) continue;

    const item = await discoverProviderCached(env, {}, provider);
    healthList.push({
      ...item,
      inference_checked: false,
      model_count: item.models.length,
    });
  }
  return healthList;
}

export function publicModel(model) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.provider,
    capabilities: { tools: model.tools, streaming: true },
    aliases: [],
    type: model.provider,
  };
}

export function estimatePromptTokens(messages, tools) {
  const serialized = JSON.stringify({ messages, tools });
  return Math.max(1, Math.ceil(new TextEncoder().encode(serialized).byteLength / 4));
}

function normalizeCalls(calls = [], streaming = false) {
  return calls.map((call, index) => {
    const fn = call.function || { name: call.name, arguments: call.arguments };
    return {
      ...(streaming ? { index: call.index ?? index } : {}),
      id: call.id || `call_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    };
  });
}

export function normalizeCompletion(result, model, messages, tools) {
  if (Array.isArray(result?.choices)) return { ...result, model };
  if (!result || typeof result !== 'object') throw new Error('Provider returned an invalid completion');
  const calls = normalizeCalls(result.tool_calls);
  const content = result.response ?? result.text ?? '';
  const completion = Math.ceil((content.length + JSON.stringify(calls).length) / 4);
  const promptTokens = estimatePromptTokens(messages, tools);
  const usage = result.usage || {
    prompt_tokens: promptTokens,
    completion_tokens: completion,
    total_tokens: promptTokens + completion,
    estimated: true,
  };
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: calls.length && !content ? null : content,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: calls.length ? 'tool_calls' : 'stop',
    }],
    usage,
  };
}

export async function requestCompletion(env, session, entry, body, signal) {
  const adapter = ADAPTERS[entry.provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${entry.provider}`);
  }
  if (entry.provider === 'cloudflare') {
    return adapter.chatCompletion(env, session, entry, body, signal, normalizeCompletion);
  }
  return adapter.chatCompletion(env, session, entry, body, signal);
}

export function completionStream(upstream, { model, messages, tools, onUsage, signal, cancelUpstream }) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '', usage, outputChars = 0, finished = false, sawFinish = false, sawDone = false;
  const abortReader = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abortReader, { once: true });
  const chunk = (delta, finish_reason = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const tally = async (incomplete = false) => {
    if (finished) return;
    finished = true;
    await onUsage(usage || (incomplete ? {} : {
      total_tokens: estimatePromptTokens(messages, tools) + Math.ceil(outputChars / 4),
      estimated: true,
    }));
  };
  return new ReadableStream({
    async start(controller) {
      const send = event => controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`));
      const event = text => {
        const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        if (data === '[DONE]') { sawDone = true; return; }
        const value = JSON.parse(data);
        if (value.error) throw new Error('Upstream provider reported a streaming error');
        if (value.usage?.total_tokens !== undefined) usage = value.usage;
        if (Array.isArray(value.choices)) {
          for (const choice of value.choices) {
            outputChars += (choice.delta?.content || '').length + (choice.delta?.tool_calls ? JSON.stringify(choice.delta.tool_calls).length : 0);
            if (choice.finish_reason) sawFinish = true;
          }
          send({ ...value, model });
        } else {
          const content = value.response ?? value.text ?? '';
          const calls = value.tool_calls ? normalizeCalls(value.tool_calls, true) : [];
          outputChars += content.length + (calls.length ? JSON.stringify(calls).length : 0);
          if (content || calls.length) send(chunk({ ...(content ? { content } : {}), ...(calls.length ? { tool_calls: calls } : {}) }));
          if (calls.length) { send(chunk({}, 'tool_calls')); sawFinish = true; }
        }
      };
      try {
        while (!signal?.aborted) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            event(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
          if (buffer.length > 1048576) throw new Error('Provider SSE event exceeds size limit');
          if (done) break;
        }
        if (signal?.aborted) throw new Error('Completion interrupted');
        if (buffer.trim()) event(buffer);
        if (!sawDone && !sawFinish) throw new Error('Provider stream ended before completion');
        if (!sawFinish) send(chunk({}, 'stop'));
        await tally();
        send('[DONE]');
        controller.close();
      } catch (error) {
        const interruptedByClient = signal?.aborted;
        cancelUpstream?.();
        await reader.cancel().catch(() => {});
        await tally(true).catch(() => {});
        if (!interruptedByClient) {
          try {
            send({ error: { message: 'Generation interrupted. Retry your request.', type: 'upstream_error' } });
            controller.close();
          } catch { /* consumer already closed */ }
        } else {
          try { controller.error(error); } catch { /* consumer already closed */ }
        }
      } finally {
        signal?.removeEventListener('abort', abortReader);
        reader.releaseLock();
      }
    },
    async cancel() {
      cancelUpstream?.();
      await reader.cancel().catch(() => {});
      await tally(true);
    },
  });
}
