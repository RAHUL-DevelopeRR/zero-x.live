// The one way the gateway reaches the Claude API (Anthropic Messages API): the native adapter
// (src/anthropic-adapter.js) and the weekly discovery research and credits jobs
// (src/discovery/research.js, src/discovery/credits.js) all build their client here.
//
// Every fetch goes to https://api.anthropic.com/v1/… only and never follows a redirect. The SDK
// would otherwise take its base URL from ANTHROPIC_BASE_URL and add a second credential from
// ANTHROPIC_AUTH_TOKEN wherever globalThis.process exists (the Node server, server.js), so both
// are pinned here: x-api-key can never reach another host.
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
 * back as a failed call). With `liveness`, successful bodies are piped through a tap that
 * signals it on every chunk, because the SDK swallows `ping` events.
 */
export function anthropicFetch(liveness = null) {
  return async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!isAnthropicUrl(href)) throw new Error('Refused a Claude API call to a host other than api.anthropic.com');
    const response = await globalThis.fetch(href, { ...init, redirect: 'manual' });
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

/**
 * An SDK client for `apiKey`. authToken null: an ANTHROPIC_AUTH_TOKEN in the environment must not
 * add a second credential header. baseURL is pinned; logging is off (no prompts, headers or keys
 * in logs). maxRetries 0: the router owns failover, and a retried timeout could bill twice.
 */
export function anthropicClient(apiKey, { timeout, liveness = null } = {}) {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC.baseURL, maxRetries: 0, timeout,
    logLevel: 'off', fetch: anthropicFetch(liveness) });
}
