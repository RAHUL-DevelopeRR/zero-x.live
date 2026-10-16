import { provisionDevIdentity, rpc } from './account-store.js';
import { normalizePlanId } from './plan-policy.js';
import { sha256Hex, readRecord, deleteRecord, openSession, rearmRecord, sessionExpiry } from './session-store.js';

// ── OpenAI-shaped errors (docs/PLATFORM_CONTRACT.md §3.3) ──
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function errorType(status, code) {
  if (code === 'insufficient_quota' || code === 'insufficient_credits') return 'insufficient_quota';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function requestId(c) {
  let id = c.get('requestId');
  if (!id) {
    id = 'req_' + crypto.randomUUID().replace(/-/g, '');
    c.set('requestId', id);
  }
  return id;
}

export function errorResponse(c, status, code, message, extra = {}) {
  const id = requestId(c);
  const { param = null, headers = {}, ...fields } = extra;
  const body = { error: { message, type: errorType(status, code), code, param, request_id: id, ...fields } };
  if (Number.isFinite(fields.retry_after_seconds)) headers['Retry-After'] = String(Math.ceil(fields.retry_after_seconds));
  return c.json(body, status, { 'X-Request-Id': id, ...headers });
}

export const SERVICE_UNAVAILABLE = 'Zero-X is temporarily unavailable. Please retry shortly.';
export const INVALID_SESSION = 'Your Zero-X credential is missing, expired or revoked. Run `neuron auth login` (or sign in again at https://zero-x.live) and retry.';

export function sendApiError(c, error) {
  if (error instanceof ApiError) return errorResponse(c, error.status, error.code, error.message, error.extra);
  console.error('Zero-X API request failed', { name: error?.name, message: error?.message });
  return errorResponse(c, 503, 'service_unavailable', SERVICE_UNAVAILABLE);
}

export const invalidSession = () => new ApiError(401, 'invalid_session', INVALID_SESSION);

// Suspended accounts keep read access (account, usage, billing history) but cannot start new
// purchases or mint credentials; inference is refused by zerox_reserve_v2 itself. The account is
// read fresh (the caller's synced account may be cached for 60 s) and returned.
export async function requireActiveAccount(env, caller) {
  const account = await database(() => rpc(env, 'zerox_get_account', { p_user_id: caller.user_id }));
  if (!account) throw invalidSession();
  if (caller?.suspended || account.suspended === true) {
    throw new ApiError(403, 'account_suspended', 'This account is suspended. Contact support@zero-x.live.');
  }
  return account;
}
const unavailable = () => new ApiError(503, 'service_unavailable', SERVICE_UNAVAILABLE);

async function database(call) {
  try { return await call(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('Account database request failed', { message: error?.message });
    throw unavailable();
  }
}

// ── Credentials ──
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{8,4096}=*$/;
export function bearerToken(c) {
  const header = c.req.header('Authorization') || '';
  if (!header.startsWith('Bearer ')) return '';
  const token = header.slice(7).trim();
  return TOKEN_PATTERN.test(token) ? token : '';
}

export const SESSION_TOKEN_PATTERN = /^ses_[A-Za-z0-9_-]{1,128}$/;
export const API_KEY_PATTERN = /^nzx_[A-Za-z0-9_-]{43}$/;

// ── Local development identity (Node server on loopback only, never the Worker) ──
export function isWorkersRuntime() {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname); }
  catch { return false; }
}
// Never under NODE_ENV=production, even on loopback: a production server behind a same-host
// reverse proxy sees the proxy's loopback Host header.
export function devRuntimeEnabled(env) {
  return env?.DEV_AUTH_ENABLED === 'true' && env?.NEURON_RUNTIME === 'node' && !isWorkersRuntime() &&
    String(env?.NODE_ENV || '').trim().toLowerCase() !== 'production';
}
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
// Browsers send Origin with cross-origin requests. A page on another site must never use the
// (deterministic) dev identity, and with it the operator's provider keys, through the open /v1
// CORS policy: dev credentials are honoured only without an Origin or from a loopback origin.
export function devAuthEnabled(c) {
  if (!devRuntimeEnabled(c.env) || !isLoopbackHost(c.req.header('host') || new URL(c.req.url).host)) return false;
  const origin = c.req.header('origin');
  return !origin || LOOPBACK_ORIGIN.test(origin);
}

const EMAIL_PATTERN = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}$/;
export function devEmailFromToken(token) {
  if (typeof token !== 'string' || !/^dev_[A-Za-z0-9_-]{4,340}$/.test(token)) return null;
  try {
    const bytes = Uint8Array.from(atob(token.slice(4).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const email = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().toLowerCase();
    return EMAIL_PATTERN.test(email) ? email : null;
  } catch { return null; }
}
export function devToken(email) {
  const bytes = new TextEncoder().encode(email);
  return 'dev_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Deterministic RFC 9562 version-8 UUID: sha256('zerox-dev:' + email), version/variant bits set.
export async function devUserId(email) {
  const hex = await sha256Hex('zerox-dev:' + email);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function devProfile(email) {
  const local = email.split('@')[0];
  return { email, firstName: '', lastName: '', name: local, imageUrl: '', username: local, providers: ['dev'] };
}

// ── Supabase identity ──
export function readIdentityConfig(env) {
  let publicKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '').trim();
  if (!publicKey.startsWith('sb_publishable_')) {
    try {
      const payload = publicKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      if (JSON.parse(atob(payload)).role !== 'anon') publicKey = '';
    } catch { publicKey = ''; }
  }
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').trim(),
    supabaseKey: publicKey,
    providers: String(env.SUPABASE_AUTH_PROVIDERS || 'google,email,phone,azure,github')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    storageKey: String(env.SUPABASE_STORAGE_KEY || 'zerox-supabase-auth').trim(),
  };
}

export function identityProfileFromUser(user = {}) {
  const metadata = user.user_metadata || {};
  const appMetadata = user.app_metadata || {};
  const firstName = metadata.first_name || metadata.given_name || '';
  const lastName = metadata.last_name || metadata.family_name || '';
  const providers = Array.isArray(appMetadata.providers) ? appMetadata.providers
    : appMetadata.provider ? [appMetadata.provider] : [];
  return {
    email: user.email || metadata.email || '',
    firstName,
    lastName,
    name: metadata.full_name || metadata.name || [firstName, lastName].filter(Boolean).join(' '),
    imageUrl: metadata.avatar_url || metadata.picture || '',
    username: metadata.user_name || metadata.username || metadata.preferred_username || '',
    providers,
  };
}

// app_metadata is writable only with the service role, so it may seed a new account's plan.
export function claimsPlan(user) {
  const plan = String(user?.app_metadata?.plan || 'free').toLowerCase();
  return ['free', 'pro', 'max', 'ultrawork'].includes(plan) ? plan : 'free';
}

const CACHE_TTL_MS = 60000;
const CACHE_LIMIT = 5000;
const identityCache = new Map();
const accountCache = new Map();
function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) { cache.delete(key); return undefined; }
  return entry.value;
}
function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}
export function clearIdentityCaches() {
  identityCache.clear();
  accountCache.clear();
}

// Returns the Supabase user for a valid access token, null for a rejected token, and throws a
// 503 ApiError when identity is not configured or unreachable. Verified users are cached for
// 60 s keyed by sha256(project URL + token); rejected tokens are never cached.
export async function verifySupabaseToken(env, token) {
  const { supabaseUrl, supabaseKey } = readIdentityConfig(env);
  if (!supabaseUrl || !supabaseKey) {
    throw new ApiError(503, 'identity_not_configured', 'Sign-in is not configured on this gateway.');
  }
  const cacheKey = await sha256Hex(`${supabaseUrl}\n${token}`);
  const cached = cacheGet(identityCache, cacheKey);
  if (cached) return cached;
  let response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseKey },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ApiError(503, 'service_unavailable', 'The identity service is unreachable. Please retry shortly.');
  }
  if ([400, 401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new ApiError(503, 'service_unavailable', 'The identity service is unavailable. Please retry shortly.');
  const user = await response.json().catch(() => null);
  if (!user || typeof user.id !== 'string') return null;
  cacheSet(identityCache, cacheKey, user);
  return user;
}

export async function syncAccount(env, userId, profile, plan = 'free') {
  return rpc(env, 'zerox_sync_account', { p_user_id: userId, p_profile: profile, p_plan: plan });
}

// Local dev identities have no Supabase Auth user: on the PGlite driver the auth.users row is
// provisioned first (provisionDevIdentity is a no-op on every other driver).
export async function syncDevAccount(env, userId, email, profile = devProfile(email)) {
  await provisionDevIdentity(env, userId, email);
  return syncAccount(env, userId, profile, 'free');
}

async function cachedAccount(env, token, userId, profile, plan, devEmail = null) {
  const key = await sha256Hex(`account\n${userId}\n${token}`);
  const cached = cacheGet(accountCache, key);
  if (cached) return cached;
  const account = await database(() => devEmail
    ? syncDevAccount(env, userId, devEmail, profile) : syncAccount(env, userId, profile, plan));
  if (!account) throw unavailable();
  cacheSet(accountCache, key, account);
  return account;
}

export async function verifyApiKey(env, token) {
  if (!API_KEY_PATTERN.test(token)) return null;
  const row = await rpc(env, 'zerox_api_key_verify', { p_hash: await sha256Hex(token) });
  return row?.user_id ? { key_id: row.key_id ?? row.id ?? null, user_id: row.user_id } : null;
}

// Loads a CLI session record: hashed key first, raw-key fallback for older sessions.
// Expired records are removed. Returns the decrypted session or null.
export async function loadCliSession(env, token) {
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const stored = await readRecord(env, token);
  if (!stored || typeof stored !== 'object' || !Number.isFinite(stored.created)) return null;
  if (Date.now() >= sessionExpiry(env, stored)) {
    await deleteRecord(env, token);
    return null;
  }
  try { await rearmRecord(env, token, stored); }
  catch (error) { console.warn('Session lifetime could not be extended', { message: error?.message }); }
  return openSession(env, token, stored);
}

export function callerFromAccount(kind, account, fallback = {}) {
  const fullName = [account?.first_name, account?.last_name].filter(Boolean).join(' ');
  return {
    kind,
    user_id: account?.clerk_id ?? account?.user_id ?? account?.id ?? fallback.user_id,
    email: account?.email || fallback.email || '',
    name: account?.name || fullName || fallback.name || '',
    image_url: account?.image_url || fallback.image_url || '',
    plan: normalizePlanId(account?.plan),
    suspended: account?.suspended === true || account?.status === 'suspended',
    daily_requests: Number(account?.daily_requests) || 0,
    daily_tokens_used: Number(account?.daily_tokens_used) || 0,
  };
}

export const ALL_CREDENTIALS = Object.freeze(['session', 'api_key', 'supabase', 'dev']);
// Interactive credentials only: API keys can never manage keys, sessions or billing.
export const INTERACTIVE_CREDENTIALS = Object.freeze(['session', 'supabase', 'dev']);

// Resolves the Authorization header to a caller (docs/PLATFORM_CONTRACT.md §3.1):
// {kind, user_id, email, name, image_url, plan, suspended, session?, key_id?}.
// Throws ApiError: 401 invalid_session, 403 api_key_not_allowed, 503 when a backend is down.
export async function resolveCaller(c, { allow = ALL_CREDENTIALS } = {}) {
  const env = c.env;
  const token = bearerToken(c);
  if (!token) throw invalidSession();

  if (token.startsWith('dev_')) {
    if (!allow.includes('dev') || !devAuthEnabled(c)) throw invalidSession();
    const email = devEmailFromToken(token);
    if (!email) throw invalidSession();
    const userId = await devUserId(email);
    const profile = devProfile(email);
    const account = await cachedAccount(env, token, userId, profile, 'free', email);
    return callerFromAccount('dev', account, { user_id: userId, email, name: profile.name });
  }

  if (token.startsWith('nzx_')) {
    if (!allow.includes('api_key')) {
      throw new ApiError(403, 'api_key_not_allowed',
        'API keys cannot manage keys, sessions or billing. Sign in at https://zero-x.live/dashboard instead.');
    }
    const key = await database(() => verifyApiKey(env, token));
    if (!key) throw invalidSession();
    const account = await database(() => rpc(env, 'zerox_get_account', { p_user_id: key.user_id }));
    if (!account) throw invalidSession();
    return { ...callerFromAccount('api_key', account, { user_id: key.user_id }), key_id: key.key_id };
  }

  if (token.startsWith('ses_')) {
    if (!allow.includes('session')) throw invalidSession();
    const session = await database(() => loadCliSession(env, token));
    if (!session?.account_backed || typeof session.user_id !== 'string') throw invalidSession();
    const account = await database(() => rpc(env, 'zerox_get_account', { p_user_id: session.user_id }));
    if (!account) throw invalidSession();
    return { ...callerFromAccount('session', account, session), session };
  }

  if (!allow.includes('supabase')) throw invalidSession();
  const user = await verifySupabaseToken(env, token);
  if (!user) throw invalidSession();
  const profile = identityProfileFromUser(user);
  const account = await cachedAccount(env, token, user.id, profile, claimsPlan(user));
  return callerFromAccount('supabase', account, { user_id: user.id, email: profile.email, name: profile.name, image_url: profile.imageUrl });
}

// Wraps a route handler with credential resolution and uniform error handling.
export function withCaller(allow, handler) {
  return async c => {
    try {
      const caller = await resolveCaller(c, { allow });
      return await handler(c, caller);
    } catch (error) {
      return sendApiError(c, error);
    }
  };
}
