import { accountRpc } from './account-store.js';
import { resolveModelCatalog, requestCompletion, normalizeCompletion, completionStream, estimatePromptTokens } from './providers.js';
import { globalRouter } from './router.js';
import { globalHealthTracker } from './provider-health.js';

export function createChatHandler({ validateSession, setSession, getSession, planLimits, router = globalRouter, healthTracker = globalHealthTracker }) {
  return async c => {
    const requestId = 'req_' + crypto.randomUUID().replace(/-/g, '');
    let valid;
    try {
      valid = await validateSession(c);
    } catch {
      return c.json({ error: { message: 'Neuron is temporarily unavailable. Retry shortly.', type: 'service_unavailable' } }, 503);
    }
    if (!valid) {
      return c.json({ error: { message: 'Invalid or expired session token', type: 'authentication_error' } }, 401);
    }
    const { token, session } = valid;
    const body = await c.req.json().catch(() => null);
    if (body && JSON.stringify(body).length > 1048576) {
      return c.json({ error: 'Completion request exceeds 1 MiB' }, 413);
    }
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length ||
        body.messages.some(message => !message || !['system','developer','user','assistant','tool'].includes(message.role))) {
      return c.json({ error: { message: 'Provide a model and valid messages', type: 'invalid_request_error' } }, 400);
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return c.json({ error: 'stream must be a boolean' }, 400);
    }
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type !== 'function' || !tool.function?.name))) {
      return c.json({ error: 'tools must contain function definitions' }, 400);
    }

    const catalog = await resolveModelCatalog(c.env, session);
    const candidateSelection = router.selectCandidates({
      requestedModel: body.model,
      needsTools: Boolean(body.tools?.length),
      catalog,
      allowFailover: true,
    });

    if (candidateSelection.error === 'model_not_found') {
      return c.json({ error: { message: 'The requested model is unavailable. Select another model or retry shortly.', type: 'model_not_found', code: 'model_not_found' } }, 404);
    }
    if (candidateSelection.error === 'capability_unsupported' || (body.tools?.length && !candidateSelection.primary?.tools)) {
      return c.json({ error: { message: 'This model does not support tools; choose a tool-capable model', type: 'invalid_request_error' } }, 400);
    }
    if (!candidateSelection.primary) {
      return c.json({ error: { message: 'The requested model is unavailable. Select another model or retry shortly.', type: 'model_not_found', code: 'model_not_found' } }, 404);
    }

    const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 4096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
      return c.json({ error: 'max_tokens must be between 1 and 32768' }, 400);
    }

    const reserved = estimatePromptTokens(body.messages, body.tools) + maxTokens;
    let day = new Date().toISOString().slice(0, 10);
    try {
      if (session.account_backed) {
        const account = await accountRpc(c.env, 'zerox_reserve_usage', { p_user_id: session.user_id, p_tokens: reserved });
        if (!account) {
          return c.json({ error: { message: 'This request exceeds your remaining daily Neuron allocation. It resets at midnight UTC.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429);
        }
        day = account.last_usage_reset || day;
        session.requests = Number(account.daily_requests);
        session.tokens_used = Number(account.daily_tokens_used);
      } else {
        const policies = await planLimits(c.env);
        const limits = policies[session.plan] || policies.free;
        if (Number(session.requests || 0) >= limits.daily_requests || Number(session.tokens_used || 0) + reserved > limits.daily_tokens) {
          return c.json({ error: { message: 'This request exceeds your remaining daily Neuron allocation. It resets at midnight UTC.', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429);
        }
        session.requests = Number(session.requests || 0) + 1;
        session.tokens_used = Number(session.tokens_used || 0) + reserved;
      }
      session.provider_used = candidateSelection.primary.provider;
      await setSession(c, token, session);
    } catch {
      console.error('Neuron allocation reservation unavailable');
      return c.json({ error: 'Neuron is temporarily unavailable. Retry shortly.' }, 503);
    }

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

    const candidatesToTry = [candidateSelection.primary, ...candidateSelection.fallbacks];

    for (let i = 0; i < candidatesToTry.length; i++) {
      const entry = candidatesToTry[i];
      const attemptId = 'att_' + crypto.randomUUID().replace(/-/g, '');
      const payload = { model: entry.id, messages: body.messages, max_tokens: maxTokens, stream: Boolean(body.stream) };
      for (const key of ['tools','tool_choice','temperature','top_p','parallel_tool_calls','response_format','seed','frequency_penalty','presence_penalty']) {
        if (body[key] !== undefined) payload[key] = body[key];
      }

      const controller = new AbortController();
      const signal = AbortSignal.any([c.req.raw.signal, controller.signal, AbortSignal.timeout(120000)]);
      const startMs = Date.now();

      try {
        const upstream = await requestCompletion(c.env, session, entry, payload, signal);
        const latencyMs = Date.now() - startMs;

        if (!upstream.ok) {
          await upstream.body?.cancel();
          const retryAfter = upstream.headers.get('retry-after');
          const retryAfterSec = retryAfter ? parseInt(retryAfter, 10) || 30 : 30;
          healthTracker.recordAttempt(entry.provider, {
            success: false,
            status: upstream.status,
            latencyMs,
            retryAfterSeconds: retryAfterSec,
          });

          console.error('Neuron upstream rejected request', { provider: entry.provider, status: upstream.status, attemptId });

          // If auto route with another candidate, try next candidate
          if (i < candidatesToTry.length - 1) {
            continue;
          }

          // Terminal failure: settle with 0 tokens
          await settle({ total_tokens: 0 });
          const responseHeaders = retryAfter ? { 'Retry-After': retryAfter } : {};
          responseHeaders['X-Request-Id'] = requestId;
          return c.json({
            error: {
              message: 'Generation is temporarily unavailable. Retry shortly.',
              type: 'upstream_error',
            },
          }, upstream.status === 429 ? 429 : 502, responseHeaders);
        }

        healthTracker.recordAttempt(entry.provider, { success: true, status: upstream.status, latencyMs });

        if (payload.stream) {
          if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
            throw new Error('Provider did not return SSE');
          }
          return new Response(completionStream(upstream.body, {
            model: entry.id,
            messages: body.messages,
            tools: body.tools,
            onUsage: settle,
            signal,
            cancelUpstream: () => controller.abort(),
          }), {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-store',
              'X-Request-Id': requestId,
            },
          });
        }

        const completion = normalizeCompletion(await upstream.json(), entry.id, body.messages, body.tools);
        await settle(completion.usage);
        c.header('X-Request-Id', requestId);
        return c.json(completion);

      } catch (err) {
        controller.abort();
        const latencyMs = Date.now() - startMs;
        healthTracker.recordAttempt(entry.provider, { success: false, status: 500, latencyMs });
        console.error('Neuron upstream request failed', { provider: entry.provider, attemptId, error: err.message });

        if (i < candidatesToTry.length - 1) {
          continue;
        }

        // Unknown transport failures retain reservation to guard quota
        return c.json({
          error: {
            message: 'Generation failed or timed out. Retry your request.',
            type: 'upstream_error',
          },
        }, 502, { 'X-Request-Id': requestId });
      }
    }
  };
}
