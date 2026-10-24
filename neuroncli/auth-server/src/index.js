import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { accountRpc, databaseConfigured } from './account-store.js';
import { modelCatalog, resolveModelCatalog, providerHealth, providerConfiguration } from './providers.js';
import { callerCountry, catalogWarnings, inheritCallerCountry } from './catalog.js';
import { globalHealthTracker } from './provider-health.js';
import { createChatHandler } from './chat-handler.js';
import { loadPlanLimits } from './plan-policy.js';
import { isOperator } from './operator-auth.js';
import {
  persistentSessionStore, readRecord, writeRecord, deleteRecord, sealSession, sessionExpiry, sessionTtlSeconds,
  sessionEncryptionConfigured,
} from './session-store.js';
import {
  ApiError, bearerToken, claimsPlan, devAuthEnabled, devEmailFromToken, devRuntimeEnabled, devUserId, errorResponse,
  identityProfileFromUser, INVALID_SESSION, isLoopbackHost, loadCliSession, readIdentityConfig, resolveCaller,
  SERVICE_UNAVAILABLE, SESSION_TOKEN_PATTERN, syncAccount, syncDevAccount, verifySupabaseToken,
} from './auth-context.js';
import { razorpayConfigured, webhookConfigured } from './billing/razorpay.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAdminRoutes, runScheduledMaintenance } from './routes/admin.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerPlanRoutes, v1ModelsPayload, v1ModelStatusPayload } from './routes/plans.js';
import { registerSessionIndex, registerSessionRoutes, unregisterSessionIndex } from './routes/sessions.js';
import { registerDeviceRoutes } from './routes/device.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { runDiscoveryTick } from './discovery/jobs.js';
// Durable Object classes are exported from the Worker entry (wrangler.toml [[durable_objects]]).
export { HealthHub } from './health-hub.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

const SERVICE = 'neuroncli-gateway-worker';
const VERSION = '2.0.0';
const API_MOUNT = '/neuroncli/auth-server';
const app = new Hono();
const api = new Hono();

app.onError((error, c) => {
  console.error('Neuron service request failed', { name: error.name });
  return errorResponse(c, 503, 'service_unavailable', SERVICE_UNAVAILABLE);
});

// Paths are served both at the root and under the legacy /neuroncli/auth-server mount.
const routePath = pathname => pathname.startsWith(API_MOUNT + '/') ? pathname.slice(API_MOUNT.length) : pathname;
const isApiRoute = path => ['/auth/', '/api/', '/v1/', '/admin/', '/webhooks/'].some(prefix => path.startsWith(prefix)) ||
  path === '/health' || path === '/ready';

// ── Security headers ──
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com https://cdn.fontshare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.fontshare.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.supabase.co https://api.razorpay.com https://lumberjack.razorpay.com",
  'frame-src https://api.razorpay.com https://checkout.razorpay.com',
  "form-action 'self' http://127.0.0.1:*",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const path = routePath(url.pathname);
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  if (url.protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // The Neuron sign-in pages carry session tokens, so their policy is always enforced; the
  // rest of the site stays report-only until CSP_ENFORCE=true.
  const signInPage = url.pathname.startsWith('/neuroncli/') ||
    ((url.hostname === 'neuron.zero-x.live' || isLoopbackHost(url.host)) && url.pathname.startsWith('/device'));
  const enforceCsp = c.env?.CSP_ENFORCE === 'true' || signInPage;
  c.header(enforceCsp ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', CONTENT_SECURITY_POLICY);
  if (path.startsWith('/auth/') || signInPage) {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', url.pathname.startsWith('/neuroncli/login/') ? 'origin' : 'no-referrer');
  }
  if (['/api/', '/admin/', '/webhooks/'].some(prefix => path.startsWith(prefix)) && path !== '/api/plans') {
    c.header('Cache-Control', 'no-store');
  }
  if (url.hostname === 'dashboard.zero-x.live' || url.pathname.startsWith('/neuroncli/') || path === '/health' ||
      ['/auth/', '/api/', '/v1/', '/admin/', '/webhooks/'].some(prefix => path.startsWith(prefix))) {
    c.header('X-Robots-Tag', 'noindex, nofollow');
  }
});

// ── Custom 404 page (404.html from ASSETS, served with status 404) ──
async function notFoundPage(c) {
  if (!c.env?.ASSETS || !['GET', 'HEAD'].includes(c.req.method)) return null;
  try {
    const page = await c.env.ASSETS.fetch(new Request(new URL('/404.html', c.req.url), { method: c.req.method, headers: c.req.raw.headers }));
    if (page.status !== 200) return null;
    return new Response(page.body, { status: 404, headers: page.headers });
  } catch { return null; }
}

// Pages served from https://zero-x.live/<page> (clean URLs).
const SITE_PAGES = ['/about', '/privacy', '/terms', '/find-files-by-content', '/wheres-that-file',
  '/pricing', '/neuron-cli', '/docs', '/refund', '/contact', '/shipping'];

// Hostname-based subdomain routing middleware
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const path = url.pathname;
  // The local Node server keeps visitors on the loopback origin (relative redirects).
  const loopback = isLoopbackHost(url.host);

  // Let Hono handle OPTIONS/CORS preflight
  if (c.req.method === 'OPTIONS') {
    return next();
  }

  if (url.protocol === 'http:' && ['zero-x.live','www.zero-x.live','neuron.zero-x.live','dashboard.zero-x.live'].includes(hostname)) {
    url.protocol = 'https:';
    return c.redirect(url.toString(), 308);
  }

  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    if (hostname === 'dashboard.zero-x.live' && path === '/robots.txt')
      return c.text('User-agent: *\nDisallow: /\n');
    if (path === '/neuroncli/callback/' && c.env?.ASSETS) {
      return c.env.ASSETS.fetch(new Request(new URL('/neuroncli/callback/index.html', url), c.req.raw));
    }
    if (path === '/neuroncli/login/' && c.env?.ASSETS) {
      return c.env.ASSETS.fetch(new Request(new URL('/neuroncli/login/index.html', url), c.req.raw));
    }
    // Device sign-in approval page: https://neuron.zero-x.live/device (also /neuroncli/device/,
    // and /device on the local Node server, whose request URLs carry the loopback host).
    if (c.env?.ASSETS && (path === '/neuroncli/device/' ||
        ((hostname === 'neuron.zero-x.live' || loopback) && (path === '/device' || path === '/device/')))) {
      return c.env.ASSETS.fetch(new Request(new URL('/neuroncli/device/index.html', url), c.req.raw));
    }
    let target = null;
    let fragment = '';
    const site = loopback ? '' : 'https://zero-x.live';
    const clean = path.replace(/\.html$/, '').replace(/\/$/, '');
    if (loopback && ['/dashboard', '/neuron'].includes(clean)) {
      if (path !== clean) target = clean;
    }
    else if (['/neuron','/neucockpit','/legacy'].includes(clean)) target = 'https://neuron.zero-x.live/';
    else if (['/start','/download'].includes(clean)) { target = 'https://neuron.zero-x.live/'; fragment = '#downloads'; }
    else if (clean === '/features') { target = 'https://neuron.zero-x.live/'; fragment = '#features'; }
    else if (clean === '/dashboard') target = 'https://dashboard.zero-x.live/';
    else if (clean === '/neuroncli') target = site + '/neuron-cli';
    else if (['/index','/index2'].includes(clean)) target = loopback ? '/' : `https://${hostname === 'www.zero-x.live' ? 'zero-x.live' : hostname}/`;
    else if (SITE_PAGES.includes(clean)) {
      if (loopback ? path !== clean : hostname !== 'zero-x.live' || path !== clean) target = site + clean;
    } else if (hostname === 'www.zero-x.live' && path !== '/health' && !isApiRoute(path) && !path.startsWith('/neuroncli/') &&
               !path.startsWith('/Assets/') && !path.startsWith('/assets/') && !/\.(css|js|png|ico|webp|svg|jpg|mp4|woff2)$/.test(path))
      target = 'https://zero-x.live' + path;
    if (target) return c.redirect(target + url.search + fragment, 301);
  }

  // Resolve host-specific index pages before generic static assets.
  if (hostname === 'dashboard.zero-x.live') {
    if (path === '/' || path === '/index.html') {
      if (c.env && c.env.ASSETS) {
        const newUrl = new URL('/dashboard.html', c.req.url);
        const newReq = new Request(newUrl.toString(), c.req.raw);
        return c.env.ASSETS.fetch(newReq);
      }
    }
  } else if (hostname === 'neuron.zero-x.live') {
    if (path === '/' || path === '/index.html') {
      if (c.env && c.env.ASSETS) {
        const newUrl = new URL('/neuron.html', c.req.url);
        const newReq = new Request(newUrl.toString(), c.req.raw);
        return c.env.ASSETS.fetch(newReq);
      }
    }
  } else if (hostname === 'zero-x.live' || hostname === 'www.zero-x.live') {
    if (path === '/' || path === '/index.html') {
      if (c.env && c.env.ASSETS) {
        const newUrl = new URL('/index.html', c.req.url);
        const newReq = new Request(newUrl.toString(), c.req.raw);
        return c.env.ASSETS.fetch(newReq);
      }
    }
  }

  const isAsset = path.startsWith('/Assets/') || path.startsWith('/assets/') ||
    (path.includes('.') && !path.endsWith('/'));
  if (isAsset && c.env?.ASSETS) {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 404 && path.endsWith('.html')) return (await notFoundPage(c)) || response;
    return response;
  }

  return next();
});

// ── CORS: identity routes accept only the Zero-X origins; the OpenAI surface stays open ──
const IDENTITY_ORIGINS = ['https://zero-x.live', 'https://www.zero-x.live', 'https://dashboard.zero-x.live'];
const DEV_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const CORS_HEADERS = ['Content-Type', 'Authorization'];
const CORS_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];
const identityCors = cors({
  origin: (origin, c) => IDENTITY_ORIGINS.includes(origin) || (devRuntimeEnabled(c.env) && DEV_ORIGIN.test(origin)) ? origin : null,
  allowHeaders: CORS_HEADERS, allowMethods: CORS_METHODS, maxAge: 600,
});
const openCors = cors({
  origin: '*', allowHeaders: CORS_HEADERS, allowMethods: CORS_METHODS, maxAge: 600,
  exposeHeaders: ['X-Request-Id', 'X-Neuron-Plan', 'X-Neuron-Model', 'X-Neuron-Quota-Remaining-Requests',
    'X-Neuron-Quota-Remaining-Tokens', 'Retry-After'],
});
app.use('*', async (c, next) => {
  const path = routePath(new URL(c.req.url).pathname);
  if (path.startsWith('/auth/') || path.startsWith('/api/')) return identityCors(c, next);
  if (path.startsWith('/v1/') || path === '/health' || path === '/ready') return openCors(c, next);
  return next();
});

async function availableModels(c, session = {}) {
  return (await resolveModelCatalog(c.env, session)).map(model => model.id);
}

function normalizePlan(plan) {
  const key = String(plan || "free").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return ["free", "pro", "max", "ultrawork"].includes(key) ? key : "free";
}

async function planQuota(c, plan, used = 0, requests = 0) {
  const key = normalizePlan(plan);
  const policies = await loadPlanLimits(c.env);
  const limits = policies[key] || (key === 'ultrawork' && policies.pro) || policies.free;
  return {
    plan: key,
    plan_name: limits.name,
    quota: {
      daily_limit: limits.daily_tokens,
      used,
      remaining: Math.max(0, limits.daily_tokens - used),
      resets_at: new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString(),
    },
    usage: {
      requests,
      tokens_used: used,
    },
    limits: {
      tokens: limits.daily_tokens,
      requests: limits.daily_requests,
    },
  };
}

const identityFailure = (status, code, message) => ({ ok: false, status, code, message });
const sendIdentityFailure = (c, auth) => errorResponse(c, auth.status, auth.code, auth.message);

// Identity for minting/syncing accounts: a Supabase access token, or a local dev identity.
// CLI sessions and API keys can never mint further credentials.
async function getIdentityAuth(c) {
  const token = bearerToken(c);
  if (!token) return identityFailure(401, 'invalid_session', 'Missing access token. Sign in at https://zero-x.live and retry.');
  if (token.startsWith('dev_')) {
    const email = devAuthEnabled(c) ? devEmailFromToken(token) : null;
    if (!email) return identityFailure(401, 'invalid_session', INVALID_SESSION);
    const userId = await devUserId(email);
    return { ok: true, kind: 'dev', userId, user: { id: userId, email, user_metadata: { name: email.split('@')[0] }, app_metadata: { provider: 'dev' } } };
  }
  if (token.startsWith('ses_') || token.startsWith('nzx_')) {
    return identityFailure(401, 'invalid_session', 'Sign in with your Zero-X account (not a CLI session or API key) and retry.');
  }
  try {
    const user = await verifySupabaseToken(c.env, token);
    if (!user) return identityFailure(401, 'invalid_session', 'Your sign-in expired. Sign in again at https://zero-x.live and retry.');
    return { ok: true, kind: 'supabase', userId: user.id, user };
  } catch (error) {
    if (error instanceof ApiError) return identityFailure(error.status, error.code, error.message);
    return identityFailure(503, 'service_unavailable', SERVICE_UNAVAILABLE);
  }
}

async function loadUserRecord(c, userId) {
  return accountRpc(c.env, 'zerox_get_account', { p_user_id: userId });
}

async function syncUserRecord(c, auth) {
  // The profile comes only from the verified identity, never from the request body.
  if (auth.kind === 'dev') return syncDevAccount(c.env, auth.userId, auth.user.email);
  return syncAccount(c.env, auth.userId, identityProfileFromUser(auth.user), claimsPlan(auth.user));
}

async function userResponse(c, user, fallbackUserId = "") {
  const plan = normalizePlan(user?.plan || "free");
  const tokensUsed = Number(user?.daily_tokens_used || 0);
  const requests = Number(user?.daily_requests || 0);
  const quota = await planQuota(c, plan, tokensUsed, requests);
  return {
    user_id: user?.clerk_id || fallbackUserId,
    email: user?.email || "",
    name: user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(" "),
    first_name: user?.first_name || "",
    last_name: user?.last_name || "",
    username: user?.username || "",
    image_url: user?.image_url || "",
    plan,
    models: await availableModels(c),
    ...quota,
  };
}

// ── Session persistence: hashed keys (raw-key read fallback), sealed provider keys ──
async function getSession(c, token) {
  return loadCliSession(c.env, token);
}

async function setSession(c, token, session) {
  const remaining = (sessionExpiry(c.env, session) - Date.now()) / 1000;
  if (!(remaining > 0)) return deleteRecord(c.env, token);
  await writeRecord(c.env, token, await sealSession(c.env, token, session), remaining);
}

async function deleteSession(c, token) {
  await deleteRecord(c.env, token);
}

function newSessionToken() {
  return "ses_" + generateRandomString(24);
}

function newSessionTimes(env) {
  const ttlSeconds = sessionTtlSeconds(env);
  const created = Date.now();
  return { created, expires: created + ttlSeconds * 1000, ttlSeconds };
}

// API keys and dev identities authenticate per request; they have no stored session.
async function credentialSession(c, token, kind) {
  let caller;
  try { caller = await resolveCaller(c, { allow: [kind] }); }
  catch (error) {
    if (error instanceof ApiError && error.status < 500) return null;
    throw error;
  }
  return {
    token,
    session: {
      created: Date.now(), credential: kind, key_id: caller.key_id ?? null, account_backed: true,
      user_id: caller.user_id, email: caller.email, name: caller.name, image_url: caller.image_url, plan: caller.plan,
      requests: Number(caller.daily_requests || 0), tokens_used: Number(caller.daily_tokens_used || 0), provider_used: null,
    },
  };
}

// Resolves ses_ sessions (and, with apiKeys, nzx_ keys) plus dev identities. Returns null for an
// invalid credential and throws when a backing store is unavailable.
async function validateSession(c, { apiKeys = false } = {}) {
  const token = bearerToken(c);
  if (!token) return null;
  if (token.startsWith('nzx_')) return apiKeys ? credentialSession(c, token, 'api_key') : null;
  if (token.startsWith('dev_')) return devAuthEnabled(c) ? credentialSession(c, token, 'dev') : null;
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;

  const session = await loadCliSession(c.env, token);
  if (!session) return null;
  if (!session.account_backed) {
    if (session.openrouter_key) session.owned_provider_only = true;
    else if (c.env.ALLOW_ANONYMOUS_SESSIONS !== 'true') return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!session.account_backed && session.usage_day !== today) {
    session.usage_day = today; session.requests = 0; session.tokens_used = 0;
  }

  if (session.account_backed) {
    const user = await loadUserRecord(c, session.user_id);
    if (!user) return null;
    session.plan = user.plan;
    session.requests = Number(user.daily_requests);
    session.tokens_used = Number(user.daily_tokens_used);
  }
  return { token, session };
}

const validateInferenceCredential = c => validateSession(c, { apiKeys: true });
// Only stored CLI sessions are persisted; API-key and dev credentials are per request.
const persistSession = (c, token, session) => SESSION_TOKEN_PATTERN.test(token) ? setSession(c, token, session) : undefined;

// ── Web Crypto Helpers for PKCE ──
function generateRandomString(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── Simple per-IP limiter for unauthenticated OAuth starts (per isolate) ──
const PKCE_TTL_SECONDS = 600;
const PKCE_STARTS_PER_WINDOW = 10;
const pkceStarts = new Map();
function clientAddress(c) {
  // server.js sets x-neuron-client-ip from the socket; Cloudflare sets cf-connecting-ip.
  const header = c.env?.NEURON_RUNTIME === 'node' ? 'x-neuron-client-ip' : 'cf-connecting-ip';
  return (c.req.header(header) || 'unknown').slice(0, 64);
}
function takePkceStart(address) {
  const now = Date.now();
  const entry = pkceStarts.get(address);
  if (!entry || entry.reset <= now) {
    if (pkceStarts.size >= 10000) pkceStarts.delete(pkceStarts.keys().next().value);
    pkceStarts.set(address, { count: 1, reset: now + PKCE_TTL_SECONDS * 1000 });
    return 0;
  }
  if (entry.count >= PKCE_STARTS_PER_WINDOW) return Math.ceil((entry.reset - now) / 1000);
  entry.count++;
  return 0;
}

// ── Routes ──

// 1. Health check: anonymous callers learn only that the service is up.
api.get('/health', async (c) => {
  const status = { status: "ok", service: SERVICE, version: VERSION };
  if (!await isOperator(c)) return c.json(status);
  const { supabaseUrl, supabaseKey } = readIdentityConfig(c.env);
  c.header('Cache-Control', 'no-store');
  return c.json({
    ...status,
    providers: [...new Set(modelCatalog(c.env).map(model => model.provider))],
    supabase_configured: !!(supabaseUrl && supabaseKey),
    kv_bound: !!c.env.SESSIONS_KV,
    database_configured: databaseConfigured(c.env),
    billing_configured: razorpayConfigured(c.env),
    webhook_configured: webhookConfigured(c.env),
    session_encryption: sessionEncryptionConfigured(c.env),
    csp_enforced: c.env.CSP_ENFORCE === 'true',
  });
});

api.get('/ready', async c => {
  await loadPlanLimits(c.env);
  const store = persistentSessionStore(c.env);
  if (!store) return c.json({ ready: false }, 503);
  await store.get('readiness');
  const models = await resolveModelCatalog(c.env);
  return c.json({ ready: models.some(model => model.tools) }, models.some(model => model.tools) ? 200 : 503);
});

// Supabase provider settings are cached for 60 s (10 s after a failed lookup).
const identitySettingsCache = new WeakMap();
async function identitySettings(env, { supabaseUrl, supabaseKey, providers }) {
  let cache = identitySettingsCache.get(env);
  if (!cache) identitySettingsCache.set(env, cache = new Map());
  const key = `${supabaseUrl}\n${supabaseKey}\n${providers.join(',')}`;
  const cached = cache.get(key);
  if (cached?.expires > Date.now()) return cached.value;
  let value = { available: false, providers: [] };
  let ttl = 10000;
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: supabaseKey }, signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const settings = await response.json();
      value = { available: true, providers: providers.filter(provider => settings.external?.[provider] === true) };
      ttl = 60000;
    }
  } catch { /* Provider availability is checked again after the short failure TTL. */ }
  if (cache.size >= 16) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
}

api.get('/auth/config', async (c) => {
  if (devAuthEnabled(c)) return c.json({ provider: 'dev', configured: true, dev: true, providers: ['dev'] });
  const config = readIdentityConfig(c.env);
  const { supabaseUrl, supabaseKey, storageKey } = config;
  const settings = supabaseUrl && supabaseKey ? await identitySettings(c.env, config) : { available: false, providers: [] };
  return c.json({
    provider: "supabase",
    configured: !!(supabaseUrl && supabaseKey && settings.available),
    supabase_url: supabaseUrl,
    supabase_key: supabaseKey,
    providers: settings.providers,
    storage_key: storageKey,
  });
});

// 2. Session creation (main & legacy exchange)
const createSessionHandler = async (c) => {
  if (c.env.ALLOW_ANONYMOUS_SESSIONS !== 'true') {
    return errorResponse(c, 403, 'authentication_required', 'Account sign-in required. Run `neuron auth login`.',
      { login_url: 'https://zero-x.live/neuroncli/login/' });
  }
  const body = await c.req.json().catch(() => ({}));
  const fp = body.machine_fingerprint || body.fingerprint;
  const version = body.version || "unknown";

  if (typeof fp !== 'string' || !fp.trim() || fp.length > 256) {
    return errorResponse(c, 400, 'invalid_request', 'Missing machine_fingerprint', { param: 'machine_fingerprint' });
  }

  const plan = 'free';
  const quota = await planQuota(c, plan);
  const sessionToken = newSessionToken();
  const { created, expires, ttlSeconds } = newSessionTimes(c.env);
  const sessionData = {
    created,
    expires,
    fingerprint: fp,
    version: version,
    user_id: null,
    email: "",
    name: "",
    image_url: "",
    plan,
    requests: 0,
    tokens_used: 0,
    provider_used: null,
  };

  await setSession(c, sessionToken, sessionData);

  return c.json({
    session_token: sessionToken,
    user_id: sessionData.user_id,
    email: sessionData.email,
    name: sessionData.name,
    image_url: sessionData.image_url,
    plan,
    provider: "gateway",
    models: await availableModels(c),
    quota: quota.quota,
    usage: quota.usage,
    limits: quota.limits,
    ttl_seconds: ttlSeconds,
    expires_at: new Date(expires).toISOString(),
  });
};

api.post('/auth/session', createSessionHandler);
api.post('/auth/azure/exchange', createSessionHandler);

const createIdentityCliSessionHandler = async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) return sendIdentityFailure(c, auth);

  const body = await c.req.json().catch(() => ({}));
  const fp = typeof body.machine_fingerprint === 'string' ? body.machine_fingerprint.slice(0, 256)
    : typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 256) : "supabase-user";
  let user = null;
  try {
    user = await syncUserRecord(c, auth);
  } catch (err) {
    console.warn("Account session sync failed:", err.message);
    return errorResponse(c, 503, 'service_unavailable', 'Account database unavailable. Please retry shortly.');
  }

  if (!user) return errorResponse(c, 503, 'service_unavailable', 'Account database returned no record. Please retry shortly.');
  const account = await userResponse(c, user, auth.userId);
  const minted = await mintCliSession(c, account, {
    fingerprint: fp, version: typeof body.version === 'string' ? body.version : 'unknown',
  });
  if (!minted) return errorResponse(c, 503, 'service_unavailable', 'Sign-in could not be completed. Please retry shortly.');

  return c.json({
    session_token: minted.token,
    provider: "gateway",
    ttl_seconds: minted.ttlSeconds,
    expires_at: new Date(minted.expires).toISOString(),
    ...account,
  });
};

// Stores a new account-backed ses_ session for `account` (a userResponse) and indexes it for
// revoke-all. Shared by the browser login and the device flow. Returns null when the index
// write fails: a session missing from the index could not be signed out by revoke-all, so it
// is dropped and sign-in fails (the client retries).
async function mintCliSession(c, account, { fingerprint, version }) {
  const token = newSessionToken();
  const { created, expires, ttlSeconds } = newSessionTimes(c.env);
  await setSession(c, token, {
    created,
    expires,
    fingerprint: String(fingerprint || 'supabase-user').slice(0, 256),
    version: String(version || 'unknown').slice(0, 64),
    user_id: account.user_id,
    email: account.email,
    name: account.name,
    image_url: account.image_url,
    plan: account.plan,
    account_backed: true,
    requests: account.usage.requests,
    tokens_used: account.usage.tokens_used,
    provider_used: null,
  });
  if (!await registerSessionIndex(c.env, account.user_id, token, expires)) {
    await deleteSession(c, token).catch(() => {});
    return null;
  }
  return { token, created, expires, ttlSeconds };
}

async function dropCliSession(c, token) {
  await deleteSession(c, token).catch(() => {});
  await unregisterSessionIndex(c.env, token).catch(() => {});
}

api.post('/auth/cli/session', createIdentityCliSessionHandler);

const invalidSessionResponse = c => errorResponse(c, 401, 'invalid_session', INVALID_SESSION);
const sessionUnavailableResponse = c => errorResponse(c, 503, 'service_unavailable', SERVICE_UNAVAILABLE);

// 3. Verify session (main & legacy verify)
const verifySessionHandler = async (c) => {
  const valid = await validateSession(c);
  if (!valid) return invalidSessionResponse(c);

  const { session } = valid;
  const stored = !session.credential;
  const expiresAt = stored ? sessionExpiry(c.env, session) : null;
  const quota = await planQuota(c, session.plan, Number(session.tokens_used || 0), Number(session.requests || 0));

  return c.json({
    created: new Date(session.created).toISOString(),
    expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    fingerprint: session.fingerprint,
    user_id: session.user_id,
    email: session.email,
    name: session.name,
    image_url: session.image_url,
    plan: normalizePlan(session.plan),
    models: await availableModels(c, session),
    requests: session.requests,
    tokens_used: session.tokens_used,
    quota: quota.quota,
    usage: quota.usage,
    limits: quota.limits,
    provider_used: session.provider_used,
    ttl_remaining_seconds: expiresAt === null ? null : Math.max(0, (expiresAt - Date.now()) / 1000),
  });
};

api.get('/auth/session', verifySessionHandler);
api.get('/auth/azure/session', verifySessionHandler);
api.delete('/auth/session', async c => {
  const token = bearerToken(c);
  if (!SESSION_TOKEN_PATTERN.test(token)) return errorResponse(c, 401, 'invalid_session', 'Missing or invalid session token');
  // Revocation must remain available during an account database outage.
  await deleteSession(c, token);
  await unregisterSessionIndex(c.env, token);
  return c.json({ status: 'signed_out' });
});

api.get('/auth/usage', async (c) => {
  const valid = await validateSession(c);
  if (!valid) return invalidSessionResponse(c);
  const session = valid.session;
  const quota = await planQuota(c, normalizePlan(session.plan), Number(session.tokens_used || 0), Number(session.requests || 0));
  return c.json({ user_id: session.user_id, ...quota });
});

api.get('/auth/plan', async (c) => {
  const valid = await validateSession(c);
  if (!valid) return invalidSessionResponse(c);
  const session = valid.session;
  const plan = normalizePlan(session.plan);
  const policies = await loadPlanLimits(c.env);
  const limits = policies[plan] || (plan === 'ultrawork' && policies.pro) || policies.free;
  return c.json({
    user_id: session.user_id,
    plan,
    plan_name: limits.name,
    models: await availableModels(c, session),
    limits,
  });
});

// 3.5 Identity profile DB sync
api.post('/auth/sync', async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) return sendIdentityFailure(c, auth);

  try {
    const user = await syncUserRecord(c, auth);
    if (!user) {
      return c.json({ status: "skipped", message: "Account database returned no record" });
    }
    return c.json({ status: "success", ...(await userResponse(c, user, auth.userId)) });
  } catch (err) {
    console.error("Database sync error:", err.message);
    return errorResponse(c, 503, 'service_unavailable', 'Account service temporarily unavailable. Please try again shortly.');
  }
});

api.get('/auth/me', async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) return sendIdentityFailure(c, auth);
  try {
    const user = await loadUserRecord(c, auth.userId) || await syncUserRecord(c, auth);
    return c.json({ status: user ? "success" : "missing", ...(await userResponse(c, user, auth.userId)) });
  } catch (err) {
    console.error("Account lookup error:", err.message);
    return errorResponse(c, 503, 'service_unavailable', 'Account service temporarily unavailable. Please try again shortly.');
  }
});

const chatCompletionsHandler = createChatHandler({
  validateSession: validateInferenceCredential, setSession: persistSession, getSession, planLimits: loadPlanLimits,
});
api.post('/v1/chat/completions', chatCompletionsHandler);
api.post('/auth/azure/proxy', chatCompletionsHandler);
api.post('/auth/azure/chat/completions', chatCompletionsHandler);

// Anonymous callers get the free plan's view; a bad credential is an error, not anonymous.
async function modelsCaller(c) {
  if (!c.req.header('Authorization')) return { session: {} };
  try {
    const valid = await validateInferenceCredential(c);
    return valid ? { session: valid.session } : { response: invalidSessionResponse(c) };
  } catch { return { response: sessionUnavailableResponse(c) }; }
}

api.get('/v1/models', async (c) => {
  const caller = await modelsCaller(c);
  if (caller.response) return caller.response;
  c.header('Cache-Control', 'no-store');
  return c.json(await v1ModelsPayload(c, caller.session));
});

api.get('/v1/models/status', async (c) => {
  const caller = await modelsCaller(c);
  if (caller.response) return caller.response;
  const { etag, body } = await v1ModelStatusPayload(c, caller.session);
  c.header('Cache-Control', 'no-cache');
  c.header('ETag', etag);
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json(body);
});

api.get('/v1/providers/health', async (c) => {
  if (!await isOperator(c)) return errorResponse(c, 401, 'invalid_session', 'Operator authentication required.');
  c.header('Cache-Control', 'no-store');
  // pools: per-pool circuit state of this isolate (provider:upstream_model:tier).
  return c.json({ provider_configuration: providerConfiguration(c.env), providers: await providerHealth(c.env),
    pools: globalHealthTracker.getSnapshot(), catalog_warnings: catalogWarnings(c.env) });
});

// Inference probes use the same authentication, quota accounting and caller country (geo rules)
// as a normal completion; the Origin header is passed on so the dev-identity origin rule holds.
api.post('/v1/models/health', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.model !== 'string') return errorResponse(c, 400, 'invalid_request', 'Provide a model', { param: 'model' });
  const started = Date.now();
  const forwarded = Object.fromEntries(['host', 'origin', 'x-neuron-client-ip']
    .filter(name => c.req.header(name)).map(name => [name, c.req.header(name)]));
  const probe = inheritCallerCountry(new Request(new URL('/v1/chat/completions', c.req.url), {
    method: 'POST', headers: { ...forwarded, Authorization: c.req.header('Authorization') || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: body.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8 }),
    signal: c.req.raw.signal,
  }), callerCountry(c.req.raw, c.env));
  const response = await app.fetch(probe, c.env);
  const result = await response.json();
  if (!response.ok) return c.json({ model: body.model, status: 'unavailable', error: result.error, latency_ms: Date.now() - started }, response.status);
  const validCompletion = result.choices?.some(choice => choice.message?.content || choice.message?.tool_calls?.length);
  return c.json({ model: result.model, status: validCompletion ? 'healthy' : 'invalid_completion', inference_checked: true,
    latency_ms: Date.now() - started, usage: result.usage }, validCompletion ? 200 : 502);
});

// 6. OpenRouter OAuth Start (unauthenticated: short-lived PKCE records, rate limited per IP)
api.get('/auth/openrouter/start', async (c) => {
  const retryAfter = takePkceStart(clientAddress(c));
  if (retryAfter) {
    return errorResponse(c, 429, 'rate_limited', 'Too many sign-in attempts. Retry shortly.', { retry_after_seconds: retryAfter });
  }
  const verifier = generateRandomString(32);
  const challenge = await sha256(verifier);
  const state = generateRandomString(16);

  await writeRecord(c.env, `pkce:${state}`, { verifier, created: Date.now() }, PKCE_TTL_SECONDS);

  const callbackUrl = c.env.OPENROUTER_CALLBACK_URL || "https://zero-x.live/neuroncli/callback/";

  const authUrl = new URL("https://openrouter.ai/auth");
  authUrl.searchParams.set("callback_url", callbackUrl);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  return c.json({
    auth_url: authUrl.toString(),
    state,
  });
});

// 7. OpenRouter OAuth Callback
api.get('/auth/openrouter/callback', async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state || code.length > 512 || !/^[A-Za-z0-9_-]{8,64}$/.test(state)) {
    return errorResponse(c, 400, 'invalid_request', 'Missing or invalid code or state parameter');
  }

  const pkceSession = await readRecord(c.env, `pkce:${state}`);
  if (!pkceSession || Date.now() - pkceSession.created > PKCE_TTL_SECONDS * 1000) {
    if (pkceSession) await deleteRecord(c.env, `pkce:${state}`);
    return errorResponse(c, 400, 'invalid_request', 'Invalid or expired state. Restart sign-in.');
  }

  await deleteRecord(c.env, `pkce:${state}`);
  try {
    const exchange = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pkceSession.verifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!exchange.ok) return errorResponse(c, 502, 'upstream_error', 'Token exchange failed');
    const tokenRes = await exchange.json();
    const apiKey = tokenRes.key;

    if (typeof apiKey !== 'string' || !apiKey) {
      return errorResponse(c, 502, 'upstream_error', 'Token exchange failed');
    }

    const sessionToken = newSessionToken();
    const { created, expires, ttlSeconds } = newSessionTimes(c.env);
    const sessionData = {
      created,
      expires,
      fingerprint: "openrouter-pkce",
      version: "6.2.4",
      requests: 0,
      tokens_used: 0,
      provider_used: "openrouter",
      openrouter_key: apiKey,
      plan: "free",
      owned_provider_only: true,
      usage_day: new Date().toISOString().slice(0, 10),
    };

    await setSession(c, sessionToken, sessionData);
    return c.json({ session_token: sessionToken, provider: 'gateway', plan: 'free',
      models: await availableModels(c, sessionData), ...(await planQuota(c, 'free')),
      ttl_seconds: ttlSeconds, expires_at: new Date(expires).toISOString() });
  } catch {
    return errorResponse(c, 502, 'upstream_error', 'OAuth exchange failed');
  }
});

// Accounts, usage, API keys, sessions, billing, webhooks and admin (docs/PLATFORM_CONTRACT.md §3.4-3.6)
registerPlanRoutes(api);
registerAccountRoutes(api);
registerKeyRoutes(api);
registerSessionRoutes(api);
registerDeviceRoutes(api, {
  getIdentityAuth, sendIdentityFailure, syncUserRecord, loadUserRecord, userResponse, mintCliSession, dropCliSession,
  clientAddress,
});
registerBillingRoutes(api);
registerWebhookRoutes(api);
registerAdminRoutes(api);
registerDiscoveryRoutes(api);

app.route(API_MOUNT, api);
app.route('/', api);

// Unmatched routes fall back to static assets (supporting clean URLs like /about -> /about.html)
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const path = url.pathname;

  if (isApiRoute(routePath(path))) return errorResponse(c, 404, 'not_found', 'Unknown API route.');

  if (c.env && c.env.ASSETS) {
    // With html_handling=none, we must manually resolve / to the correct HTML file
    if (path === '/' || path === '') {
      let targetHtml = '/index.html';
      if (hostname === 'dashboard.zero-x.live') targetHtml = '/dashboard.html';
      else if (hostname === 'neuron.zero-x.live') targetHtml = '/neuron.html';

      const htmlUrl = new URL(targetHtml, c.req.url);
      const htmlReq = new Request(htmlUrl.toString(), c.req.raw);
      return c.env.ASSETS.fetch(htmlReq);
    }

    // Clean URL support: /about -> /about.html
    if (!path.includes('.')) {
      const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
      const htmlUrl = new URL(`${cleanPath}.html`, c.req.url);
      const htmlReq = new Request(htmlUrl.toString(), c.req.raw);
      const res = await c.env.ASSETS.fetch(htmlReq);
      if (res.status === 200) {
        return res;
      }
    }

    // Direct asset fetch, then the custom 404 page
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 404) return (await notFoundPage(c)) || response;
    return response;
  }

  return c.text('Not Found', 404);
});

// Cloudflare cron trigger (wrangler.toml [triggers]). Provider discovery (src/discovery/jobs.js)
// runs beside maintenance: it records its own failures and never fails the maintenance run,
// and the invocation lasts until both are done.
app.scheduled = (controller, env, ctx) => {
  const discovery = runDiscoveryTick(env).catch(error => {
    console.warn('Discovery tick failed', { message: String(error?.message).slice(0, 200) });
  });
  const task = Promise.allSettled([runScheduledMaintenance(env), discovery]).then(([maintenance]) => {
    if (maintenance.status === 'rejected') throw maintenance.reason;
    return maintenance.value;
  });
  ctx?.waitUntil?.(task.catch(() => {}));
  return task;
};

export default app;
