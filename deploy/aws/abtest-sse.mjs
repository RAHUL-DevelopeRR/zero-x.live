// The A/B harness's client (abtest.mjs): one chat completion request, timed from the caller's
// side. Records when the headers arrive, the first SSE data event, the first generated token (the
// first delta with content, reasoning or a tool call: not the role-only delta), the end, whether
// [DONE] came, the largest gap between events, heartbeat comments, and what identifies the answer
// (status, error code, Retry-After, x-request-id, x-zerox-runtime, cf-ray and its colo,
// Server-Timing). A non-stream answer is read up to 2 KB, enough to tell the gateway's JSON from an
// HTML error page (Cloudflare's 1102 when the Worker runs out of CPU). Nothing of the prompt or the
// answer's text is kept: counts and timings only.
const HTML_SNIFF_BYTES = 2048;

function identity(response) {
  const ray = response.headers.get('cf-ray');
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    retryAfter: response.headers.get('retry-after'),
    requestId: response.headers.get('x-request-id'),
    runtime: response.headers.get('x-zerox-runtime'),
    refused: response.headers.get('x-zerox-refused'),
    ray,
    colo: /-([A-Z]{3})$/.exec(ray || '')?.[1] || null,
    serverTiming: response.headers.get('server-timing'),
  };
}

const generated = delta => !!(delta && ((typeof delta.content === 'string' && delta.content) ||
  (typeof delta.reasoning_content === 'string' && delta.reasoning_content) || (typeof delta.reasoning === 'string' && delta.reasoning) ||
  (Array.isArray(delta.tool_calls) && delta.tool_calls.length)));

/**
 * Sends one request and measures it. `abortAfterMs` aborts it from the client side (S8); the
 * result then says aborted_by_harness. Never throws: a network error is recorded as `error`.
 */
export async function measureStream({ url, headers = {}, body, signal, abortAfterMs, fetchImpl = globalThis.fetch, now = () => performance.now() }) {
  const controller = new AbortController();
  const timers = [];
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  if (abortAfterMs) timers.push(setTimeout(() => controller.abort(), abortAfterMs));
  const started = now();
  const result = {
    status: null, headersMs: null, firstEventMs: null, firstTokenMs: null, totalMs: null, done: false,
    events: 0, comments: 0, tokens: 0, maxGapMs: 0, bytes: 0, errorCode: null, errorEvent: null,
    htmlError: false, truncated: false, abortedByHarness: false, error: null,
  };
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body, signal: controller.signal, redirect: 'manual' });
    result.headersMs = now() - started;
    Object.assign(result, identity(response));
    if (!/^text\/event-stream\b/i.test(result.contentType || '')) {
      const reader = response.body?.getReader();
      let text = '';
      const decoder = new TextDecoder();
      while (reader && text.length < HTML_SNIFF_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        result.bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      await reader?.cancel().catch(() => {});
      result.htmlError = /^\s*<(?:!doctype|html)/i.test(text) || /error code:?\s*1102/i.test(text);
      try { result.errorCode = JSON.parse(text).error?.code ?? null; } catch { /* not JSON */ }
      result.totalMs = now() - started;
      return result;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let last = null;
    for await (const bytes of response.body) {
      const at = now();
      result.bytes += bytes.byteLength;
      buffer += decoder.decode(bytes, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) { result.comments++; continue; }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          result.events++;
          if (last !== null) result.maxGapMs = Math.max(result.maxGapMs, at - last);
          last = at;
          result.firstEventMs ??= at - started;
          if (data === '[DONE]') { result.done = true; continue; }
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event?.error) result.errorEvent = event.error.code ?? 'error';
          for (const choice of event?.choices || []) {
            if (generated(choice.delta)) {
              result.tokens++;
              result.firstTokenMs ??= at - started;
            }
          }
        }
      }
    }
    result.totalMs = now() - started;
    result.truncated = !result.done && !result.errorEvent;
  } catch (error) {
    result.totalMs = now() - started;
    if (controller.signal.aborted) result.abortedByHarness = true;
    else result.error = error?.name || 'Error';
    result.truncated = !result.done && !result.errorEvent && result.status === 200;
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
  return result;
}

// p-th percentile of a list of numbers (nulls ignored), or null.
export function percentile(values, p) {
  const list = values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(p / 100 * list.length))];
}

// Least-squares slope of y against x.
export function slope(points) {
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length < 2) return null;
  const mx = valid.reduce((sum, [x]) => sum + x, 0) / valid.length;
  const my = valid.reduce((sum, [, y]) => sum + y, 0) / valid.length;
  const sxx = valid.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  return sxx ? valid.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx : null;
}
