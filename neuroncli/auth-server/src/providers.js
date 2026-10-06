const CF_DEFAULTS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const CF_TOOL_MODELS = new Set([CF_DEFAULTS[0]]);
const HTTP_PROVIDERS = {
  openrouter: { key: 'OPENROUTER_API_KEY', models: 'OPENROUTER_MODELS', base: 'https://openrouter.ai/api/v1' },
  groq: { key: 'GROQ_API_KEY', models: 'GROQ_MODELS', base: 'https://api.groq.com/openai/v1' },
  gemini: { key: 'GEMINI_API_KEY', models: 'GEMINI_MODELS', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  nvidia: { key: 'NVIDIA_API_KEY', models: 'NVIDIA_MODELS', base: 'https://integrate.api.nvidia.com/v1' },
  omniroute: { key: 'OMNIROUTE_API_KEY', models: 'OMNIROUTE_MODELS' },
  bedrock: { key: 'BEDROCK_API_KEY', models: 'BEDROCK_MODELS' },
  azure: { key: 'AZURE_OPENAI_API_KEY', models: 'AZURE_MODELS' },
};

function providerBase(env, provider) {
  if (provider === 'omniroute') {
    if (!env.OMNIROUTE_BASE_URL) return null;
    try {
      const url = new URL(env.OMNIROUTE_BASE_URL);
      if (url.username || url.password || url.search || url.hash ||
          !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return null;
      return url.toString().replace(/\/$/, '');
    } catch { return null; }
  }
  if (provider === 'bedrock') {
    const region = env.BEDROCK_REGION || env.AWS_REGION;
    if (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return null;
    return env.BEDROCK_ENDPOINT === 'runtime'
      ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`
      : `https://bedrock-mantle.${region}.api.aws/v1`;
  }
  return HTTP_PROVIDERS[provider]?.base;
}

function configuredProviders(env, session = {}) {
  return Object.entries(HTTP_PROVIDERS).filter(([provider, config]) => {
    if (session.owned_provider_only && provider !== 'openrouter') return false;
    if (!(provider === 'openrouter' ? session.openrouter_key || env[config.key] : env[config.key])) return false;
    return provider === 'azure' ? !!env.AZURE_OPENAI_ENDPOINT : !!providerBase(env, provider);
  });
}

function providerKey(env, session, provider, config) {
  return provider === 'openrouter' ? session.openrouter_key || env[config.key] : env[config.key];
}

function catalogEntry(env, provider, upstream, metadata) {
  const id = ['groq', 'gemini', 'nvidia', 'omniroute', 'bedrock'].includes(provider) ? `${provider}/${upstream}` : upstream;
  const explicitTools = modelIds(env[`${provider.toUpperCase()}_TOOL_MODELS`]).includes(upstream);
  return { id, upstream, provider, tools: metadata
    ? explicitTools || Array.isArray(metadata.supported_parameters) && metadata.supported_parameters.includes('tools') || metadata.capabilities?.tools === true
    : explicitTools || (!['omniroute', 'bedrock'].includes(provider) && env[`${provider.toUpperCase()}_TOOL_MODELS`] === undefined) };
}

export function providerConfiguration(env, session = {}) {
  const configured = configuredProviders(env, session).map(([provider]) => provider);
  return Object.entries(HTTP_PROVIDERS).map(([provider, config]) => ({ provider, configured: configured.includes(provider),
    catalog_source: env[config.models] !== undefined || provider === 'azure' || provider === 'bedrock' && env.BEDROCK_ENDPOINT === 'runtime' ? 'allowlist' : 'discovery' }));
}

function modelIds(value, fallback = []) {
  return value === undefined ? fallback : String(value).split(',').map(id => id.trim()).filter(Boolean);
}

// Provider/model allowlists are operator configuration, never inferred from model substrings.
export function modelCatalog(env, session = {}) {
  const catalog = [];
  if (!session.owned_provider_only && (env.AI || (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN))) {
    for (const id of modelIds(env.CLOUDFLARE_MODELS, CF_DEFAULTS)) {
      if (!id.startsWith('@cf/') && !id.startsWith('@hf/')) continue;
      catalog.push({ id, provider: 'cloudflare', tools: CF_TOOL_MODELS.has(id) || modelIds(env.CLOUDFLARE_TOOL_MODELS).includes(id) });
    }
  }
  for (const [provider, config] of configuredProviders(env, session)) {
    // Session-owned OpenRouter keys can use its maintained free-model router without publishing stale model IDs.
    const fallback = provider === 'openrouter' ? ['openrouter/free'] : [];
    for (const upstream of modelIds(env[config.models], fallback)) {
      const entry = catalogEntry(env, provider, upstream);
      if (catalog.some(model => model.id === entry.id)) continue;
      catalog.push(entry);
    }
  }
  return catalog;
}

// Cache by environment and credential so one user's provider key cannot populate another user's catalog.
const discoveryCache = new WeakMap();
async function discoverProvider(env, session, provider, config) {
  if (provider === 'azure' || (provider === 'bedrock' && env.BEDROCK_ENDPOINT === 'runtime')) {
    const models = modelCatalog(env, session).filter(model => model.provider === provider);
    return { provider, status: models.length ? 'configured' : 'allowlist_required', discovery: false, models };
  }
  let cache = discoveryCache.get(env);
  if (!cache) { cache = new Map(); discoveryCache.set(env, cache); }
  const key = `${provider}:${providerBase(env, provider)}:${providerKey(env, session, provider, config)}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    const started = Date.now();
    const result = { provider, checked_at: new Date().toISOString(), discovery: true, models: [] };
    try {
      const response = await fetch(`${providerBase(env, provider)}/models`, {
        headers: { Authorization: `Bearer ${providerKey(env, session, provider, config)}` },
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      result.http_status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        return { ...result, status: response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : 'unavailable', latency_ms: Date.now() - started };
      }
      const data = await response.json();
      if (!Array.isArray(data.data)) throw new Error('Invalid provider catalog');
      result.models = data.data.filter(model => typeof model?.id === 'string' && model.id.trim().length > 0 && model.id.length <= 512 && model.active !== false)
        .filter(model => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'))
        .filter(model => provider !== 'openrouter' || env.OPENROUTER_FREE_ONLY === 'false' || model.id === 'openrouter/free' ||
          model.pricing?.prompt != null && model.pricing?.completion != null &&
          model.pricing.prompt !== '' && model.pricing.completion !== '' && Number(model.pricing.prompt) === 0 && Number(model.pricing.completion) === 0)
        .map(model => catalogEntry(env, provider, model.id, model));
      return { ...result, status: 'reachable', latency_ms: Date.now() - started };
    } catch { return { ...result, status: 'unavailable', latency_ms: Date.now() - started }; }
  })();
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + 60000, promise });
  return promise;
}

export async function resolveModelCatalog(env, session = {}) {
  const catalog = modelCatalog(env, session);
  const providers = configuredProviders(env, session).filter(([, config]) => env[config.models] === undefined);
  const discovered = await Promise.all(providers.map(([provider, config]) => discoverProvider(env, session, provider, config)));
  for (const result of discovered) {
    for (const entry of result.models) if (!catalog.some(model => model.id === entry.id)) catalog.push(entry);
  }
  return catalog;
}

export async function providerHealth(env, session = {}) {
  const configured = configuredProviders(env, session);
  const states = await Promise.all(configured.map(([provider, config]) => discoverProvider(env, session, provider, config)));
  const health = Object.keys(HTTP_PROVIDERS).map(provider => {
    const state = states.find(item => item.provider === provider);
    return state ? { ...state, models: undefined, configured: true, model_count: state.models.length,
      inference_checked: false } : { provider, configured: false, status: 'not_configured', inference_checked: false };
  });
  health.unshift({ provider: 'cloudflare', configured: !session.owned_provider_only && !!(env.AI || env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
    status: modelCatalog(env, session).some(model => model.provider === 'cloudflare') ? 'binding_configured' : 'not_configured', inference_checked: false });
  return health;
}

export function publicModel(model) {
  return { id: model.id, object: 'model', created: 0, owned_by: model.provider,
    capabilities: { tools: model.tools, streaming: true }, aliases: [], type: model.provider };
}

export function estimatePromptTokens(messages) {
  return Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
}

function normalizeCalls(calls = [], streaming = false) {
  return calls.map((call, index) => {
    const fn = call.function || { name: call.name, arguments: call.arguments };
    return { ...(streaming ? { index: call.index ?? index } : {}),
      id: call.id || `call_${crypto.randomUUID().replace(/-/g, '')}`, type: 'function',
      function: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) } };
  });
}

export function normalizeCompletion(result, model, messages) {
  if (Array.isArray(result?.choices)) return { ...result, model };
  if (!result || typeof result !== 'object') throw new Error('Provider returned an invalid completion');
  const calls = normalizeCalls(result.tool_calls);
  const content = result.response ?? result.text ?? '';
  const completion = Math.ceil((content.length + JSON.stringify(calls).length) / 4);
  const usage = result.usage || { prompt_tokens: estimatePromptTokens(messages), completion_tokens: completion,
    total_tokens: estimatePromptTokens(messages) + completion, estimated: true };
  return { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: calls.length && !content ? null : content,
      ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage };
}

export async function requestCompletion(env, session, entry, body, signal) {
  const payload = { ...body, model: entry.upstream || entry.id };
  if (entry.provider === 'cloudflare') {
    // The binding's native tool schema omits the OpenAI wrapper.
    if (payload.tools) payload.tools = payload.tools.map(tool => tool.function);
    delete payload.stream_options;
    if (env.AI) {
      const result = await env.AI.run(entry.id, payload);
      if (body.stream) {
        if (typeof result?.getReader !== 'function') throw new Error('Workers AI did not return a stream');
        return new Response(result, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json(normalizeCompletion(result, entry.id, body.messages));
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${entry.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal, redirect: 'error',
    });
    if (!response.ok || body.stream) return response;
    const result = await response.json();
    if (result.success === false) throw new Error('Cloudflare returned an unsuccessful completion');
    return Response.json(normalizeCompletion(result.result || result, entry.id, body.messages));
  }
  const config = HTTP_PROVIDERS[entry.provider];
  let url = `${providerBase(env, entry.provider)}/chat/completions`;
  if (entry.provider === 'azure') {
    url = `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/models/chat/completions?api-version=${encodeURIComponent(env.AZURE_API_VERSION || '2024-05-01-preview')}`;
  }
  if (body.stream) payload.stream_options = { include_usage: true };
  const key = providerKey(env, session, entry.provider, config);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload), signal, redirect: 'error' });
}

// Parse complete SSE events rather than network chunks; UTF-8 and CRLF may cross reads.
export function completionStream(upstream, { model, messages, onUsage, signal, cancelUpstream }) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '', usage, outputChars = 0, finished = false, sawFinish = false, sawDone = false;
  const abortReader = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abortReader, { once: true });
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }] });
  const tally = async (incomplete = false) => {
    if (finished) return;
    finished = true;
    await onUsage(usage || (incomplete ? {} : { total_tokens: estimatePromptTokens(messages) + Math.ceil(outputChars / 4), estimated: true }));
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
          while ((boundary = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
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
          try { send({ error: { message: 'Provider stream interrupted', type: 'upstream_error' } }); controller.close(); } catch { /* consumer already closed */ }
        } else { try { controller.error(error); } catch { /* consumer already closed */ } }
      } finally { signal?.removeEventListener('abort', abortReader); reader.releaseLock(); }
    },
    async cancel() { cancelUpstream?.(); await reader.cancel().catch(() => {}); await tally(true); },
  });
}
