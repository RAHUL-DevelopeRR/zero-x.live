// The one way the gateway reaches the Claude API (Anthropic Messages API): the native adapter
// (src/anthropic-adapter.js) and the weekly discovery research and credits jobs
// (src/discovery/research.js, src/discovery/credits.js) all build their client here.
//
// Every fetch goes to https://api.anthropic.com/v1/… only and never follows a redirect, and
// carries exactly one credential: x-api-key with the key the gateway chose. Wherever
// globalThis.process exists (the Node server, server.js; often a shell that also runs Claude Code)
// the SDK would otherwise take its base URL from ANTHROPIC_BASE_URL, add a bearer from
// ANTHROPIC_AUTH_TOKEN, and merge ANTHROPIC_CUSTOM_HEADERS into every request after the auth
// headers (replacing x-api-key, adding Authorization or an anthropic-beta), and set up
// OpenTelemetry from ANTHROPIC_OPEN_TELEMETRY*. All of these are pinned here.
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC } from './anthropic-request.js';

// Only https://api.anthropic.com/v1/… is ever fetched with the key.
export function isAnthropicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === ANTHROPIC.host && !url.port && !url.username &&
    !url.password && url.pathname.startsWith('/v1/');
}

/**
 * The fetch the SDK uses. x-api-key is a custom header that a followed cross-origin redirect
 * would keep, so redirects are never followed (Workers rejects the 'error' mode; a 3xx comes
 * back as a failed call). With `apiKey`, the outgoing headers carry exactly that key as x-api-key
 * and no Authorization header, whatever the SDK assembled. With `liveness`, successful bodies are
 * piped through a tap that signals it on every chunk, because the SDK swallows `ping` events.
 */
export function anthropicFetch(liveness = null, { apiKey = null } = {}) {
  return async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!isAnthropicUrl(href)) throw new Error('Refused a Claude API call to a host other than api.anthropic.com');
    let headers = init.headers;
    if (apiKey) {
      headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.set('x-api-key', apiKey);
    }
    const response = await globalThis.fetch(href, { ...init, headers, redirect: 'manual' });
    if (!liveness || !response.ok || !response.body) return response;
    const tap = new TransformStream({
      transform(chunk, controller) {
        liveness.bytes();
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(tap),
      { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// Headers the SDK sets itself that a request cannot go without: kept at the SDK's value when
// ANTHROPIC_CUSTOM_HEADERS names them.
const SDK_HEADERS = Object.freeze({ 'anthropic-version': '2023-06-01' });

// defaultHeaders that undo ANTHROPIC_CUSTOM_HEADERS. The SDK parses it (one `name: value` per line)
// into defaultHeaders under our own; a name given here wins, and null removes the header. So every
// name it sets is removed (request-level headers such as the adapter's betas still apply), except
// x-api-key (the gateway's key) and the SDK's own required headers.
function customHeaderOverrides(apiKey) {
  const raw = globalThis.process?.env?.ANTHROPIC_CUSTOM_HEADERS;
  if (typeof raw !== 'string' || !raw) return undefined;
  const overrides = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.substring(0, colon).trim();
    const lower = name.toLowerCase();
    overrides[name] = lower === 'x-api-key' ? apiKey : SDK_HEADERS[lower] ?? null;
  }
  return overrides;
}

/**
 * An SDK client for `apiKey`. authToken null: an ANTHROPIC_AUTH_TOKEN in the environment must not
 * add a second credential header. baseURL is pinned; ANTHROPIC_CUSTOM_HEADERS is undone
 * (customHeaderOverrides) and the fetch sets the one credential again; OpenTelemetry is off
 * whatever ANTHROPIC_OPEN_TELEMETRY* say; logging is off (no prompts, headers or keys in logs).
 * maxRetries 0: the router owns failover, and a retried timeout could bill twice.
 */
export function anthropicClient(apiKey, { timeout, liveness = null } = {}) {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC.baseURL, maxRetries: 0, timeout,
    logLevel: 'off', defaultHeaders: customHeaderOverrides(apiKey), openTelemetry: { propagation: false, traces: false },
    fetch: anthropicFetch(liveness, { apiKey }) });
}
