const CF_DEFAULTS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const CF_TOOL_MODELS = new Set([CF_DEFAULTS[0]]);
const HTTP_PROVIDERS = {
  openrouter: { key: 'OPENROUTER_API_KEY', models: 'OPENROUTER_MODELS', url: 'https://openrouter.ai/api/v1/chat/completions' },
  groq: { key: 'GROQ_API_KEY', models: 'GROQ_MODELS', url: 'https://api.groq.com/openai/v1/chat/completions' },
  gemini: { key: 'GEMINI_API_KEY', models: 'GEMINI_MODELS', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  nvidia: { key: 'NVIDIA_API_KEY', models: 'NVIDIA_MODELS', url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  azure: { key: 'AZURE_OPENAI_API_KEY', models: 'AZURE_MODELS' },
};

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
  for (const [provider, config] of Object.entries(HTTP_PROVIDERS)) {
    if (session.owned_provider_only && provider !== 'openrouter') continue;
    if (!(provider === 'openrouter' ? session.openrouter_key || env[config.key] : env[config.key])) continue;
    if (provider === 'azure' && !env.AZURE_OPENAI_ENDPOINT) continue;
    // Session-owned OpenRouter keys can use its maintained free-model router without publishing stale model IDs.
    const fallback = provider === 'openrouter' ? ['openrouter/free'] : [];
    for (const upstream of modelIds(env[config.models], fallback)) {
      const id = ['groq', 'gemini', 'nvidia'].includes(provider) ? `${provider}/${upstream}` : upstream;
      if (catalog.some(model => model.id === id)) continue;
      catalog.push({ id, upstream, provider, tools: true });
    }
  }
  return catalog;
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
      body: JSON.stringify(payload), signal,
    });
    if (!response.ok || body.stream) return response;
    const result = await response.json();
    if (result.success === false) throw new Error('Cloudflare returned an unsuccessful completion');
    return Response.json(normalizeCompletion(result.result || result, entry.id, body.messages));
  }
  const config = HTTP_PROVIDERS[entry.provider];
  let url = config.url;
  if (entry.provider === 'azure') {
    url = `${env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/models/chat/completions?api-version=${encodeURIComponent(env.AZURE_API_VERSION || '2024-05-01-preview')}`;
  }
  if (body.stream) payload.stream_options = { include_usage: true };
  const key = entry.provider === 'openrouter' ? session.openrouter_key || env[config.key] : env[config.key];
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload), signal });
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
