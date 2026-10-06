import { accountRpc } from './account-store.js';
import { resolveModelCatalog, requestCompletion, normalizeCompletion, completionStream } from './providers.js';

export function createChatHandler({ validateSession, setSession, getSession, planLimits }) {
  return async c => {
    let valid;
    try { valid = await validateSession(c); }
    catch { return c.json({ error: { message: 'Account database unavailable', type: 'service_unavailable' } }, 503); }
    if (!valid) return c.json({ error: { message: 'Invalid or expired session token', type: 'authentication_error' } }, 401);
    const { token, session } = valid;
    const body = await c.req.json().catch(() => null);
    if (body && JSON.stringify(body).length > 1048576) return c.json({ error: 'Completion request exceeds 1 MiB' }, 413);
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length ||
        body.messages.some(message => !message || !['system','developer','user','assistant','tool'].includes(message.role))) {
      return c.json({ error: { message: 'Provide a model and valid messages', type: 'invalid_request_error' } }, 400);
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return c.json({ error: 'stream must be a boolean' }, 400);
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type !== 'function' || !tool.function?.name))) {
      return c.json({ error: 'tools must contain function definitions' }, 400);
    }
    const catalog = await resolveModelCatalog(c.env, session);
    const entry = ['auto', 'default'].includes(body.model)
      ? catalog.find(model => model.tools) || catalog[0] : catalog.find(model => model.id === body.model);
    if (!entry) return c.json({ error: { message: 'Model is unavailable in the configured provider catalog', type: 'model_not_found', code: 'model_not_found' } }, 404);
    if (body.tools?.length && !entry.tools) return c.json({ error: { message: 'This model does not support tools; choose a tool-capable model', type: 'invalid_request_error' } }, 400);
    const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 4096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) return c.json({ error: 'max_tokens must be between 1 and 32768' }, 400);
    const payload = { model: entry.id, messages: body.messages, max_tokens: maxTokens, stream: !!body.stream };
    for (const key of ['tools','tool_choice','temperature','top_p','parallel_tool_calls','response_format','seed','frequency_penalty','presence_penalty']) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    // Bytes give a conservative budget across tokenizers and include the tool definitions.
    const reserved = new TextEncoder().encode(JSON.stringify({ messages: body.messages, tools: body.tools })).byteLength + maxTokens;
    let day = new Date().toISOString().slice(0, 10);
    const limits = planLimits[session.plan] || planLimits.free;
    try {
      if (session.account_backed) {
        const account = await accountRpc(c.env, 'zerox_reserve_usage', { p_user_id: session.user_id, p_tokens: reserved });
        if (!account) return c.json({ error: 'Daily request or token limit exceeded' }, 429);
        day = account.last_usage_reset || day;
        session.requests = Number(account.daily_requests); session.tokens_used = Number(account.daily_tokens_used);
      } else {
        if (Number(session.requests || 0) >= limits.daily_requests || Number(session.tokens_used || 0) + reserved > limits.daily_tokens) {
          return c.json({ error: 'Daily request or token limit exceeded' }, 429);
        }
        session.requests = Number(session.requests || 0) + 1;
        session.tokens_used = Number(session.tokens_used || 0) + reserved;
      }
      session.provider_used = entry.provider;
      await setSession(c, token, session);
    } catch { return c.json({ error: 'Quota accounting unavailable; apply the quota reservation migration' }, 503); }
    let settled = false;
    const settle = async usage => {
      if (settled) return;
      settled = true;
      const total = Number(usage?.total_tokens);
      const actual = Number.isFinite(total) && total >= 0 ? Math.ceil(total) : reserved;
      if (session.account_backed) {
        await accountRpc(c.env, 'zerox_settle_usage', { p_user_id: session.user_id, p_reserved: reserved, p_actual: actual, p_day: day });
      } else {
        const current = await getSession(c, token);
        if (current) {
          if (current.usage_day === day) current.tokens_used = Math.max(0, Number(current.tokens_used || 0) + actual - reserved);
          await setSession(c, token, current);
        }
      }
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal, AbortSignal.timeout(120000)]);
    try {
      const upstream = await requestCompletion(c.env, session, entry, payload, signal);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        await settle({ total_tokens: 0 });
        return c.json({ error: { message: `Provider ${entry.provider} rejected the request (${upstream.status})`, type: 'upstream_error', provider: entry.provider, upstream_status: upstream.status } }, upstream.status === 429 ? 429 : 502,
          upstream.headers.get('retry-after') ? { 'Retry-After': upstream.headers.get('retry-after') } : {});
      }
      if (payload.stream) {
        if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Provider did not return SSE');
        return new Response(completionStream(upstream.body, { model: entry.id, messages: body.messages, onUsage: settle,
          signal, cancelUpstream: () => controller.abort() }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
      }
      const completion = normalizeCompletion(await upstream.json(), entry.id, body.messages);
      await settle(completion.usage);
      return c.json(completion);
    } catch {
      // Unknown transport failures can incur upstream work; retain the reservation.
      controller.abort();
      return c.json({ error: { message: 'Provider request failed or timed out', type: 'upstream_error', provider: entry.provider } }, 502);
    }
  };
}
