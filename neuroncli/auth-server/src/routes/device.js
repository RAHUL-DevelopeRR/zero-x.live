// Device sign-in for `neuron login` (docs/PLATFORM_CONTRACT.md section 3.8, RFC 8628 shape).
//
//   CLI  POST /auth/device/code   -> device_code (secret, polled) + user_code (shown)
//   web  POST /auth/device/lookup -> what is asking to sign in, plus an approval nonce
//   web  POST /auth/device/approve
//   CLI  POST /auth/device/token  -> authorization_pending | slow_down | ... | a ses_ session
//
// The page that approves is https://neuron.zero-x.live/device: the user is signed in there
// with the website identity (Supabase), so no localhost callback is involved and the token
// never appears in a URL. Grants live in Postgres (migrations/20261019000000_device_auth.sql)
// because single use needs an atomic conditional update.
import { devAuthEnabled, errorResponse, isLoopbackHost } from '../auth-context.js';
import { databaseConfigured, rpcRows } from '../account-store.js';
import { sha256Hex } from '../session-store.js';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no accidental words
const CODE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
const MAX_PENDING_PER_IP = 5;
const NONCE_TTL_MS = 5 * 60 * 1000;
const DEVICE_CODE_PATTERN = /^zdc_[A-Za-z0-9_-]{43}$/;
const PAGE_ORIGINS = ['https://neuron.zero-x.live', 'https://zero-x.live'];

const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newDeviceCode() {
  return `zdc_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// 8 letters from a 20-letter alphabet (~34.6 bits), drawn without modulo bias.
export function newUserCode() {
  let code = '';
  while (code.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < 8) code += USER_CODE_ALPHABET[byte % 20];
    }
  }
  return code;
}

export function normalizeUserCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
  return code.length === 8 && [...code].every(char => USER_CODE_ALPHABET.includes(char)) ? code : null;
}

export const formatUserCode = code => `${code.slice(0, 4)}-${code.slice(4)}`;

// Client-reported text: printable, single line, bounded. It is shown on the approval page as
// "reported by the device", never trusted for anything else.
function clientText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);
  return text || null;
}

// Fixed-window limiter per key, per isolate (exact global limits are not needed here: the
// database also caps pending grants per IP). Returns seconds to wait, or 0.
function windowLimiter(limit, windowMs) {
  const windows = new Map();
  return key => {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || entry.reset <= now) {
      if (windows.size >= 10000) windows.delete(windows.keys().next().value);
      windows.set(key, { count: 1, reset: now + windowMs });
      return 0;
    }
    if (entry.count >= limit) return Math.ceil((entry.reset - now) / 1000);
    entry.count++;
    return 0;
  };
}
const codeLimiter = windowLimiter(10, 10 * 60 * 1000);
const lookupLimiter = windowLimiter(10, 60 * 1000);

function approvalSecret(c) {
  if (c.env?.DEVICE_APPROVAL_SECRET) return c.env.DEVICE_APPROVAL_SECRET;
  return devAuthEnabled(c) ? 'dev-only-device-approval-secret' : null;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

// Binds an approval to the grant and the signed-in user for five minutes.
async function approvalNonce(secret, grantId, userId, expiresAt) {
  return `${expiresAt}.${await hmac(secret, `${grantId}|${userId}|${expiresAt}`)}`;
}

async function nonceValid(secret, nonce, grantId, userId) {
  const [expiresText, signature] = String(nonce || '').split('.');
  const expiresAt = Number(expiresText);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = await hmac(secret, `${grantId}|${userId}|${expiresAt}`);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return diff === 0;
}

// The local Node server's request URL carries no port, so its origin comes from Host.
function loopbackOrigin(c) {
  const url = new URL(c.req.url);
  const host = c.req.header('Host') || url.host;
  return isLoopbackHost(host) ? `${url.protocol}//${host}` : null;
}

function verificationUri(c) {
  if (c.env?.DEVICE_VERIFICATION_URL) return c.env.DEVICE_VERIFICATION_URL;
  const local = loopbackOrigin(c);
  return local ? `${local}/neuroncli/device/` : 'https://neuron.zero-x.live/device';
}

// The approval endpoints answer only the approval page: same-origin JSON with a bearer
// header (no cookie authenticates them), which a cross-site form or fetch cannot produce.
function pageRequestRefused(c) {
  const origin = c.req.header('Origin');
  const local = loopbackOrigin(c);
  const allowed = PAGE_ORIGINS.includes(origin) || (local !== null && origin === local);
  if (!allowed) return 'This request must come from the Zero-X device sign-in page.';
  const site = c.req.header('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return 'This request must come from the Zero-X device sign-in page.';
  if (!/^application\/json\b/i.test(c.req.header('Content-Type') || '')) return 'Send a JSON body.';
  return null;
}

const databaseMessage = 'Device sign-in is temporarily unavailable. Please retry shortly.';

// Operator diagnostics for a failed step: the error's code and message, never a user code,
// device code or token. The database only sees codes as parameters or hashes, and anything
// shaped like a code or credential is masked in case a message ever quotes one.
function logStepFailure(step, error) {
  const message = String(error?.message || error || '').slice(0, 200)
    .replace(/\b(zdc|ses|nzx|dev)_[A-Za-z0-9_-]+/g, '$1_…')
    .replace(/\b[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}\b/g, '…');
  console.error('Device sign-in step failed', { step, code: error?.code ?? null, message });
}

// Seconds until the requester's oldest pending grant expires and frees a slot (the database
// reports it with too_many_pending); the whole code lifetime when it does not say.
function pendingRetryAfter(error) {
  const match = /retry_after_seconds=(\d+)/.exec(`${error?.detail ?? ''} ${error?.message ?? ''}`);
  const seconds = match ? Number(match[1]) : 0;
  return seconds >= 1 && seconds <= CODE_TTL_SECONDS ? seconds : CODE_TTL_SECONDS;
}

export function registerDeviceRoutes(api, deps) {
  const { getIdentityAuth, sendIdentityFailure, syncUserRecord, loadUserRecord, userResponse, mintCliSession,
    dropCliSession, clientAddress } = deps;

  api.post('/auth/device/code', async c => {
    if (!databaseConfigured(c.env)) return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    const ip = clientAddress(c);
    const wait = codeLimiter(ip);
    if (wait) {
      return errorResponse(c, 429, 'rate_limited', 'Too many sign-in codes requested. Wait and try again.',
        { retry_after_seconds: wait });
    }
    const body = await c.req.json().catch(() => ({}));
    const cf = c.req.raw.cf || {};
    const client = {
      name: clientText(body.client_id, 64) || 'neuron-cli', version: clientText(body.client_version, 64),
      device_name: clientText(body.device_name, 128), os: clientText(body.os, 64),
    };
    const requester = {
      ip, country: clientText(cf.country, 8), region: clientText(cf.region, 128), city: clientText(cf.city, 128),
      network: clientText(cf.asOrganization, 128),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const deviceCode = newDeviceCode();
      const userCode = newUserCode();
      try {
        const [grant] = await rpcRows(c.env, 'zerox_device_create', {
          p_device_code_hash: await sha256Hex(deviceCode), p_user_code: userCode, p_client: client,
          p_requester: requester, p_ttl_seconds: CODE_TTL_SECONDS, p_interval_seconds: POLL_INTERVAL_SECONDS,
          p_max_pending: MAX_PENDING_PER_IP,
        });
        if (!grant) throw new Error('no grant returned');
        const uri = verificationUri(c);
        c.header('Cache-Control', 'no-store');
        return c.json({
          device_code: deviceCode,
          user_code: formatUserCode(userCode),
          verification_uri: uri,
          verification_uri_complete: `${uri}?user_code=${formatUserCode(userCode)}`,
          expires_in: CODE_TTL_SECONDS,
          interval: grant.interval_seconds ?? POLL_INTERVAL_SECONDS,
        });
      } catch (error) {
        const message = String(error?.message || '');
        if (message.includes('too_many_pending')) {
          const retryAfter = pendingRetryAfter(error);
          return errorResponse(c, 429, 'rate_limited',
            `Too many sign-in codes are waiting. Use one of them or try again in ${Math.ceil(retryAfter / 60)} min.`,
            { retry_after_seconds: retryAfter });
        }
        if (!/duplicate|unique/i.test(message)) {
          logStepFailure('create', error);
          return errorResponse(c, 503, 'service_unavailable', databaseMessage);
        }
      }
    }
    return errorResponse(c, 503, 'service_unavailable', databaseMessage);
  });

  api.post('/auth/device/lookup', async c => {
    const refused = pageRequestRefused(c);
    if (refused) return errorResponse(c, 403, 'forbidden', refused);
    const auth = await getIdentityAuth(c);
    if (!auth.ok) return sendIdentityFailure(c, auth);
    const wait = lookupLimiter(auth.userId);
    if (wait) return errorResponse(c, 429, 'rate_limited', 'Too many codes tried. Wait a minute.', { retry_after_seconds: wait });
    const secret = approvalSecret(c);
    if (!secret) {
      console.error('DEVICE_APPROVAL_SECRET is not set');
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    const body = await c.req.json().catch(() => ({}));
    const userCode = normalizeUserCode(body.user_code);
    if (!userCode) return errorResponse(c, 400, 'invalid_request', 'Enter the 8-letter code shown in your terminal.', { param: 'user_code' });
    let grant;
    try {
      [grant] = await rpcRows(c.env, 'zerox_device_lookup', { p_user_code: userCode });
    } catch (error) {
      logStepFailure('lookup', error);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    if (!grant) {
      return errorResponse(c, 404, 'not_found', 'That code is wrong or has expired. Check your terminal, or run neuron login again.');
    }
    const expiresAt = Date.now() + NONCE_TTL_MS;
    c.header('Cache-Control', 'no-store');
    return c.json({
      grant_id: grant.id,
      user_code: formatUserCode(userCode),
      account: { email: auth.user?.email || '' },
      client: { name: grant.client_name, version: grant.client_version, device_name: grant.device_name, os: grant.device_os },
      requester: { ip: grant.requester_ip, country: grant.requester_country, region: grant.requester_region,
        city: grant.requester_city, network: grant.requester_network },
      browser_country: clientText(c.req.raw.cf?.country, 8),
      created_at: grant.created_at,
      expires_at: grant.expires_at,
      approval_nonce: await approvalNonce(secret, grant.id, auth.userId, expiresAt),
    });
  });

  api.post('/auth/device/approve', async c => {
    const refused = pageRequestRefused(c);
    if (refused) return errorResponse(c, 403, 'forbidden', refused);
    const auth = await getIdentityAuth(c);
    if (!auth.ok) return sendIdentityFailure(c, auth);
    const secret = approvalSecret(c);
    if (!secret) {
      console.error('DEVICE_APPROVAL_SECRET is not set');
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    const body = await c.req.json().catch(() => ({}));
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : null;
    if (!decision) return errorResponse(c, 400, 'invalid_request', 'decision must be "approve" or "deny".', { param: 'decision' });
    if (typeof body.grant_id !== 'string' || !await nonceValid(secret, body.approval_nonce, body.grant_id, auth.userId)) {
      return errorResponse(c, 400, 'invalid_request', 'This approval expired. Reload the page and try again.', { param: 'approval_nonce' });
    }
    // Both decisions record the user on the grant, which references the account; a first visit
    // to this page may not have synced it yet. An approved grant's session is also built from it.
    try {
      if (!await syncUserRecord(c, auth)) throw new Error('no account');
    } catch (error) {
      logStepFailure(`${decision}_sync_account`, error);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    try {
      const [row] = await rpcRows(c.env, 'zerox_device_decide', {
        p_grant_id: body.grant_id, p_user_id: auth.userId, p_decision: decision,
      });
      return c.json({ status: row?.status || (decision === 'approve' ? 'approved' : 'denied') });
    } catch (error) {
      if (String(error?.message || '').includes('grant_not_pending')) {
        return errorResponse(c, 409, 'grant_not_pending', 'This code was already used, denied or has expired.');
      }
      logStepFailure(decision, error);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
  });

  api.post('/auth/device/token', async c => {
    const body = await c.req.json().catch(() => ({}));
    if (body.grant_type !== DEVICE_GRANT_TYPE) {
      return errorResponse(c, 400, 'unsupported_grant_type', `grant_type must be ${DEVICE_GRANT_TYPE}.`, { param: 'grant_type' });
    }
    if (!DEVICE_CODE_PATTERN.test(body.device_code || '')) {
      return errorResponse(c, 400, 'invalid_grant', 'Unknown device code. Run neuron login again.', { param: 'device_code' });
    }
    let grant;
    try {
      [grant] = await rpcRows(c.env, 'zerox_device_poll', { p_device_code_hash: await sha256Hex(body.device_code) });
    } catch (error) {
      logStepFailure('poll', error);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    c.header('Cache-Control', 'no-store');
    if (!grant || grant.status === 'redeemed') {
      return errorResponse(c, 400, 'invalid_grant', 'This sign-in code was already used or is unknown. Run neuron login again.');
    }
    if (grant.expired) return errorResponse(c, 400, 'expired_token', 'The sign-in code expired. Run neuron login again.');
    if (grant.status === 'denied') return errorResponse(c, 400, 'access_denied', 'Sign-in was denied in the browser.');
    if (grant.status === 'pending') {
      return grant.slow_down
        ? errorResponse(c, 400, 'slow_down', 'Polling too fast.', { interval: grant.interval_seconds })
        : errorResponse(c, 400, 'authorization_pending', 'Waiting for approval in the browser.', { interval: grant.interval_seconds });
    }

    // Approved: build the session first, then redeem. Only one poll can redeem; a loser drops
    // the session it built, so a device_code yields exactly one session.
    let account;
    try {
      const user = await loadUserRecord(c, grant.user_id);
      if (!user) throw new Error('no account');
      account = await userResponse(c, user, grant.user_id);
    } catch (error) {
      logStepFailure('load_user', error);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    const minted = await mintCliSession(c, account, { fingerprint: 'device-flow', version: 'neuron-cli' });
    if (!minted) {
      logStepFailure('mint_session', 'no session was stored');
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    let redeemed;
    try {
      [redeemed] = await rpcRows(c.env, 'zerox_device_redeem', { p_grant_id: grant.id });
    } catch (error) {
      logStepFailure('redeem', error);
      await dropCliSession(c, minted.token);
      return errorResponse(c, 503, 'service_unavailable', databaseMessage);
    }
    if (!redeemed) {
      await dropCliSession(c, minted.token);
      return errorResponse(c, 400, 'invalid_grant', 'This sign-in code was already used. Run neuron login again.');
    }
    return c.json({
      access_token: minted.token,
      token_type: 'Bearer',
      expires_in: minted.ttlSeconds,
      expires_at: new Date(minted.expires).toISOString(),
      // Same field the browser login returns, for clients that read session_token.
      session_token: minted.token,
      ...account,
    });
  });
}
