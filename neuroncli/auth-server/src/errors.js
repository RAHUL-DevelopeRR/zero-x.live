// OpenAI-shaped error bodies (docs/PLATFORM_CONTRACT.md §3.3).

export const DEFAULT_PRICING_URL = 'https://zero-x.live/pricing';

export const ERROR_CODES = Object.freeze({
  invalid_request: { status: 400, type: 'invalid_request_error',
    message: 'The request body is invalid.' },
  context_length_exceeded: { status: 400, type: 'invalid_request_error',
    message: 'The request is too large for every available model. Shorten the conversation or lower max_tokens.' },
  model_not_found: { status: 404, type: 'invalid_request_error',
    message: 'The requested model is not available. List models with GET /v1/models.' },
  invalid_session: { status: 401, type: 'authentication_error',
    message: 'Your Neuron session is missing, expired or revoked. Run `neuron auth login` to sign in again.' },
  insufficient_credits: { status: 402, type: 'insufficient_quota', upgrade: true,
    message: 'This request needs paid capacity and your credit balance is too low. Add credits to continue.' },
  upgrade_required: { status: 403, type: 'permission_error', upgrade: true,
    message: 'This model is not included in your plan. Upgrade to use it.' },
  region_unavailable: { status: 403, type: 'permission_error',
    message: 'This model is not available in your region on the free tier.' },
  policy_restricted: { status: 403, type: 'permission_error',
    message: 'No provider of this model meets your data policy. Allow more trust tiers or training, or choose another model.' },
  account_suspended: { status: 403, type: 'permission_error',
    message: 'This account is suspended. Contact support@zero-x.live.' },
  insufficient_quota: { status: 429, type: 'insufficient_quota', upgrade: true,
    message: 'You have used your daily Neuron allocation. It resets at midnight UTC; upgrade for a larger allocation.' },
  rate_limited: { status: 429, type: 'rate_limit_error',
    message: 'Too many requests at once. Retry after the indicated delay.' },
  capacity_exhausted: { status: 503, type: 'server_error', upgrade: true,
    message: 'Shared free capacity is exhausted right now. Retry later or upgrade for dedicated capacity.' },
  upstream_error: { status: 502, type: 'server_error',
    message: 'Generation is temporarily unavailable. Retry shortly.' },
  upstream_timeout: { status: 504, type: 'server_error',
    message: 'The model did not respond in time. Retry your request.' },
  service_unavailable: { status: 503, type: 'server_error',
    message: 'Neuron is temporarily unavailable. Retry shortly.' },
});

export function newRequestId() {
  return 'req_' + crypto.randomUUID().replace(/-/g, '');
}

export function pricingUrl(env = {}) {
  const value = String(env?.PRICING_URL || '').trim();
  try {
    if (value && new URL(value).protocol === 'https:') return value;
  } catch { /* fall back to the public pricing page */ }
  return DEFAULT_PRICING_URL;
}

function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.ceil(number)) : null;
}

export function errorStatus(code) {
  return (ERROR_CODES[code] || ERROR_CODES.service_unavailable).status;
}

// `upgrade` overrides whether the code carries an upgrade_url; `upgradeUrl` sets it explicitly.
export function errorBody(code, { message, requestId = null, env, retryAfterSeconds, resetsAt, upgradeUrl, upgrade } = {}) {
  const spec = ERROR_CODES[code] || ERROR_CODES.service_unavailable;
  const error = {
    message: message || spec.message,
    type: spec.type,
    code: ERROR_CODES[code] ? code : 'service_unavailable',
    param: null,
    request_id: requestId,
  };
  if (upgradeUrl !== undefined ? upgradeUrl : upgrade ?? spec.upgrade) error.upgrade_url = upgradeUrl || pricingUrl(env);
  const retry = seconds(retryAfterSeconds);
  if (retry) error.retry_after_seconds = retry;
  const resets = resetsAt ? new Date(resetsAt) : null;
  if (resets && !Number.isNaN(resets.getTime())) error.resets_at = resets.toISOString();
  return { error };
}

// Builds the complete JSON error response, including Retry-After and x-request-id.
export function errorResponse(code, options = {}) {
  const body = errorBody(code, options);
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (options.requestId) headers.set('x-request-id', options.requestId);
  if (body.error.retry_after_seconds) headers.set('Retry-After', String(body.error.retry_after_seconds));
  return new Response(JSON.stringify(body), { status: options.status || errorStatus(code), headers });
}

// Streamed failures after the first byte are reported as one SSE data event.
export function errorEvent(code, options = {}) {
  return errorBody(code, options);
}
