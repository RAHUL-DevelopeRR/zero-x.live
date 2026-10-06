import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { accountRpc, databaseConfigured } from './account-store.js';
import { modelCatalog, resolveModelCatalog, providerHealth, providerConfiguration, publicModel } from './providers.js';
import { createChatHandler } from './chat-handler.js';

const app = new Hono();
const api = new Hono();

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/neuroncli/')) {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', url.pathname.startsWith('/neuroncli/login/') ? 'origin' : 'no-referrer');
  }
  if (url.hostname === 'dashboard.zero-x.live' || url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/neuroncli/') || url.pathname.startsWith('/v1/') || url.pathname === '/health') {
    c.header('X-Robots-Tag', 'noindex, nofollow');
  }
});

// Hostname-based subdomain routing middleware
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const path = url.pathname;

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
    let target = null;
    let fragment = '';
    const clean = path.replace(/\.html$/, '').replace(/\/$/, '');
    if (['/neuron','/neucockpit','/legacy'].includes(clean)) target = 'https://neuron.zero-x.live/';
    else if (['/start','/download'].includes(clean)) { target = 'https://neuron.zero-x.live/'; fragment = '#downloads'; }
    else if (clean === '/features') { target = 'https://neuron.zero-x.live/'; fragment = '#features'; }
    else if (clean === '/dashboard') target = 'https://dashboard.zero-x.live/';
    else if (['/index','/index2'].includes(clean)) target = `https://${hostname === 'www.zero-x.live' ? 'zero-x.live' : hostname}/`;
    else if (['/about','/privacy','/terms','/find-files-by-content','/wheres-that-file'].includes(clean)) {
      if (hostname !== 'zero-x.live' || path !== clean) target = 'https://zero-x.live' + clean;
    } else if (hostname === 'www.zero-x.live' && path !== '/health' && !path.startsWith('/v1/') && !path.startsWith('/api/') && !path.startsWith('/auth/') && !path.startsWith('/neuroncli/') &&
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
  if (isAsset && c.env?.ASSETS) return c.env.ASSETS.fetch(c.req.raw);

  return next();
});

// Global sessions in-memory fallback (useful for dev/zero-config, ephemerally persists per isolate)
const sessions = new Map();

const PLAN_LIMITS = {
  free: { name: "Free", daily_tokens: 256000, daily_requests: 2000, price_usd: 0 },
  pro: { name: "Pro", daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
  // Legacy Fallback mapping for existing DB accounts
  ultrawork: { name: "Pro (Legacy Ultrawork)", daily_tokens: 2000000, daily_requests: 20000, price_usd: 10 },
};

function availableModels(c, session = {}) {
  return modelCatalog(c.env, session).map(model => model.id);
}

function normalizePlan(plan) {
  const key = String(plan || "free").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return PLAN_LIMITS[key] ? key : "free";
}

function planQuota(plan, used = 0, requests = 0) {
  const key = normalizePlan(plan);
  const limits = PLAN_LIMITS[key];
  return {
    plan: key,
    plan_name: limits.name,
    quota: {
      daily_limit: limits.daily_tokens,
      used,
      remaining: Math.max(0, limits.daily_tokens - used),
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

function readIdentityConfig(c) {
  let publicKey = String(c.env.SUPABASE_PUBLISHABLE_KEY || c.env.SUPABASE_ANON_KEY || "").trim();
  if (!publicKey.startsWith('sb_publishable_')) {
    try {
      const payload = publicKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      if (JSON.parse(atob(payload)).role !== 'anon') publicKey = '';
    } catch { publicKey = ''; }
  }
  return {
    supabaseUrl: String(c.env.SUPABASE_URL || "").trim(),
    supabaseKey: publicKey,
    providers: String(c.env.SUPABASE_AUTH_PROVIDERS || "google,email,phone,azure,github")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    storageKey: String(c.env.SUPABASE_STORAGE_KEY || "zerox-supabase-auth").trim(),
  };
}

function authClaimsPlan(auth) {
  const claims = auth?.sessionClaims || {};
  const appMeta = claims?.app_metadata || auth?.user?.app_metadata || {};
  return normalizePlan(appMeta?.plan);
}

function identityProfileFromBody(body = {}) {
  const firstName = body.firstName || body.first_name || "";
  const lastName = body.lastName || body.last_name || "";
  const name = body.name || body.fullName || [firstName, lastName].filter(Boolean).join(" ");
  return {
    email: body.email || body.emailAddress || "",
    firstName,
    lastName,
    name,
    imageUrl: body.imageUrl || body.image_url || "",
    username: body.username || "",
  };
}

function identityProfileFromUser(user = {}) {
  const metadata = user.user_metadata || {};
  const appMetadata = user.app_metadata || {};
  const firstName = metadata.first_name || metadata.given_name || "";
  const lastName = metadata.last_name || metadata.family_name || "";
  const providerList = Array.isArray(appMetadata.providers)
    ? appMetadata.providers
    : appMetadata.provider
      ? [appMetadata.provider]
      : [];
  return {
    email: user.email || metadata.email || "",
    firstName,
    lastName,
    name:
      metadata.full_name ||
      metadata.name ||
      [firstName, lastName].filter(Boolean).join(" "),
    imageUrl: metadata.avatar_url || metadata.picture || "",
    username:
      metadata.user_name ||
      metadata.username ||
      metadata.preferred_username ||
      "",
    providers: providerList,
  };
}

function mergeIdentityProfiles(base = {}, override = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

async function getIdentityAuth(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized",
      message: "Missing access token",
    };
  }

  const { supabaseUrl, supabaseKey } = readIdentityConfig(c);
  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      status: 503,
      error: "Identity provider not configured",
      message: "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY).",
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseKey,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: 401,
        error: "Unauthorized",
        message: "Invalid Supabase session",
      };
    }

    const user = await response.json();
    return {
      ok: true,
      userId: user.id,
      user,
      sessionClaims: {
        app_metadata: user.app_metadata || {},
        user_metadata: user.user_metadata || {},
        email: user.email || "",
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: "Identity lookup failed",
      message: err.message,
    };
  }
}

async function loadUserRecord(c, userId) {
  return accountRpc(c.env, 'zerox_get_account', { p_user_id: userId });
}

async function syncUserRecord(c, auth) {
  return accountRpc(c.env, 'zerox_sync_account', {
    p_user_id: auth.userId,
    p_profile: identityProfileFromUser(auth.user),
    p_plan: authClaimsPlan(auth),
  });
}

function userResponse(c, user, fallbackUserId = "") {
  const plan = normalizePlan(user?.plan || "free");
  const tokensUsed = Number(user?.daily_tokens_used || 0);
  const requests = Number(user?.daily_requests || 0);
  const quota = planQuota(plan, tokensUsed, requests);
  return {
    user_id: user?.clerk_id || fallbackUserId,
    email: user?.email || "",
    name: user?.name || [user?.first_name, user?.last_name].filter(Boolean).join(" "),
    first_name: user?.first_name || "",
    last_name: user?.last_name || "",
    username: user?.username || "",
    image_url: user?.image_url || "",
    plan,
    models: availableModels(c),
    ...quota,
  };
}

// ── Session persistence helpers (Support Cloudflare KV with in-memory fallback) ──
async function getSession(c, token) {
  if (c.env && c.env.SESSIONS_KV) {
    const data = await c.env.SESSIONS_KV.get(token);
    return data ? JSON.parse(data) : null;
  }
  return sessions.get(token);
}

async function setSession(c, token, session) {
  if (c.env && c.env.SESSIONS_KV) {
    const ttlHours = parseInt(c.env.SESSION_TTL_HOURS) || 24;
    await c.env.SESSIONS_KV.put(token, JSON.stringify(session), { expirationTtl: ttlHours * 3600 });
  } else {
    sessions.set(token, session);
  }
}

async function deleteSession(c, token) {
  if (c.env && c.env.SESSIONS_KV) {
    await c.env.SESSIONS_KV.delete(token);
  } else {
    sessions.delete(token);
  }
}

async function validateSession(c) {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.replace("Bearer ", "");

  if (!/^ses_[A-Za-z0-9_-]+$/.test(token)) return null;
  const stored = await getSession(c, token);
  if (!stored || !Number.isFinite(stored.created)) return null;
  const session = { ...stored };
  if (!session.account_backed) {
    if (session.openrouter_key) session.owned_provider_only = true;
    else if (c.env.ALLOW_ANONYMOUS_SESSIONS !== 'true') return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!session.account_backed && session.usage_day !== today) {
    session.usage_day = today; session.requests = 0; session.tokens_used = 0;
  }

  const ttlHours = parseInt(c.env.SESSION_TTL_HOURS) || 24;
  const sessionTtlMs = ttlHours * 3600 * 1000;

  if (Date.now() - session.created > sessionTtlMs) {
    await deleteSession(c, token);
    return null;
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

// ── Global CORS Configuration ──
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
}));

// ── Routes ──

// 1. Health check
api.get('/health', (c) => {
  const { supabaseUrl, supabaseKey } = readIdentityConfig(c);
  return c.json({
    status: "ok",
    service: "neuroncli-gateway-worker",
    version: "2.0.0",
    providers: [...new Set(modelCatalog(c.env).map(model => model.provider))],
    provider_configuration: providerConfiguration(c.env),
    supabase_configured: !!(supabaseUrl && supabaseKey),
    kv_bound: !!c.env.SESSIONS_KV,
    database_configured: databaseConfigured(c.env),
  });
});

api.get('/auth/config', async (c) => {
  const { supabaseUrl, supabaseKey, providers, storageKey } = readIdentityConfig(c);
  let enabledProviders = [];
  let available = false;
  if (supabaseUrl && supabaseKey) {
    try {
      const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: supabaseKey }, signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const settings = await response.json();
        enabledProviders = providers.filter(provider => settings.external?.[provider] === true);
        available = true;
      }
    } catch { /* Provider availability is checked again on the next request. */ }
  }
  return c.json({
    provider: "supabase",
    configured: !!(supabaseUrl && supabaseKey && available),
    supabase_url: supabaseUrl,
    supabase_key: supabaseKey,
    providers: enabledProviders,
    storage_key: storageKey,
  });
});

// 2. Session creation (main & legacy exchange)
const createSessionHandler = async (c) => {
  if (c.env.ALLOW_ANONYMOUS_SESSIONS !== 'true') {
    return c.json({ error: 'Account sign-in required', code: 'authentication_required', login_url: 'https://zero-x.live/neuroncli/login/' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const fp = body.machine_fingerprint || body.fingerprint;
  const version = body.version || "unknown";

  if (typeof fp !== 'string' || !fp.trim() || fp.length > 256) {
    return c.json({ error: "Missing machine_fingerprint" }, 400);
  }

  const plan = 'free';
  const quota = planQuota(plan);
  const sessionToken = "ses_" + generateRandomString(24);
  const sessionData = {
    created: Date.now(),
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
    models: availableModels(c),
    quota: quota.quota,
    usage: quota.usage,
    limits: quota.limits,
    ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600,
  });
};

api.post('/auth/session', createSessionHandler);
api.post('/auth/azure/exchange', createSessionHandler);

const createIdentityCliSessionHandler = async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  const body = await c.req.json().catch(() => ({}));
  const fp = body.machine_fingerprint || body.fingerprint || "supabase-user";
  const profile = mergeIdentityProfiles(
    identityProfileFromUser(auth.user),
    identityProfileFromBody(body),
  );
  let user = null;
  try {
    user = await syncUserRecord(c, auth, profile);
  } catch (err) {
    console.warn("Account session sync failed:", err.message);
    return c.json({ error: "Account database unavailable" }, 503);
  }

  if (!user) return c.json({ error: 'Account database returned no record' }, 503);
  const account = userResponse(c, user, auth.userId);
  const sessionToken = "ses_" + generateRandomString(24);
  const sessionData = {
    created: Date.now(),
    fingerprint: fp,
    version: body.version || "unknown",
    user_id: account.user_id,
    email: account.email,
    name: account.name,
    image_url: account.image_url,
    plan: account.plan,
    account_backed: true,
    requests: account.usage.requests,
    tokens_used: account.usage.tokens_used,
    provider_used: null,
  };

  await setSession(c, sessionToken, sessionData);

  return c.json({
    session_token: sessionToken,
    provider: "gateway",
    ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600,
    ...account,
  });
};

api.post('/auth/cli/session', createIdentityCliSessionHandler);

// 3. Verify session (main & legacy verify)
const verifySessionHandler = async (c) => {
  const valid = await validateSession(c);
  if (!valid) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const { session } = valid;
  const ttlHours = parseInt(c.env.SESSION_TTL_HOURS) || 24;
  const sessionTtlMs = ttlHours * 3600 * 1000;

  return c.json({
    created: new Date(session.created).toISOString(),
    fingerprint: session.fingerprint,
    user_id: session.user_id,
    email: session.email,
    name: session.name,
    image_url: session.image_url,
    plan: normalizePlan(session.plan),
    models: availableModels(c, session),
    requests: session.requests,
    tokens_used: session.tokens_used,
    quota: planQuota(normalizePlan(session.plan), Number(session.tokens_used || 0), Number(session.requests || 0)).quota,
    usage: planQuota(normalizePlan(session.plan), Number(session.tokens_used || 0), Number(session.requests || 0)).usage,
    limits: planQuota(normalizePlan(session.plan), Number(session.tokens_used || 0), Number(session.requests || 0)).limits,
    provider_used: session.provider_used,
    ttl_remaining_seconds: Math.max(
      0,
      (sessionTtlMs - (Date.now() - session.created)) / 1000
    ),
  });
};

api.get('/auth/session', verifySessionHandler);
api.get('/auth/azure/session', verifySessionHandler);
api.delete('/auth/session', async c => {
  const authorization = c.req.header('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!/^ses_[A-Za-z0-9_-]+$/.test(token)) return c.json({ error: 'Missing or invalid session token' }, 401);
  // Revocation must remain available during an account database outage.
  await deleteSession(c, token);
  return c.json({ status: 'signed_out' });
});

api.get('/auth/usage', async (c) => {
  const valid = await validateSession(c);
  if (!valid) return c.json({ error: "Invalid or expired session" }, 401);
  const session = valid.session;
  const quota = planQuota(normalizePlan(session.plan), Number(session.tokens_used || 0), Number(session.requests || 0));
  return c.json({ user_id: session.user_id, ...quota });
});

api.get('/auth/plan', async (c) => {
  const valid = await validateSession(c);
  if (!valid) return c.json({ error: "Invalid or expired session" }, 401);
  const session = valid.session;
  const plan = normalizePlan(session.plan);
  return c.json({
    user_id: session.user_id,
    plan,
    plan_name: PLAN_LIMITS[plan].name,
    models: availableModels(c, session),
    limits: PLAN_LIMITS[plan],
  });
});

// 3.5 Identity profile DB sync
api.post('/auth/sync', async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const profile = mergeIdentityProfiles(
      identityProfileFromUser(auth.user),
      identityProfileFromBody(body),
    );
    const user = await syncUserRecord(c, auth, profile);
    if (!user) {
      return c.json({ status: "skipped", message: "Account database returned no record" });
    }
    return c.json({ status: "success", ...userResponse(c, user, auth.userId) });
  } catch (err) {
    console.error("Database sync error:", err);
    return c.json({ error: "Internal Server Error", message: err.message }, 500);
  }
});

api.get('/auth/me', async (c) => {
  const auth = await getIdentityAuth(c);
  if (!auth.ok || !auth.userId) {
    return c.json({ error: auth.error, message: auth.message }, auth.status);
  }
  try {
    const user = await loadUserRecord(c, auth.userId);
    return c.json({ status: user ? "success" : "missing", ...userResponse(c, user, auth.userId) });
  } catch (err) {
    console.error("Account lookup error:", err);
    return c.json({ error: "Internal Server Error", message: err.message }, 500);
  }
});

const chatCompletionsHandler = createChatHandler({ validateSession, setSession, getSession, planLimits: PLAN_LIMITS });
api.post('/v1/chat/completions', chatCompletionsHandler);
api.post('/auth/azure/proxy', chatCompletionsHandler);
api.post('/auth/azure/chat/completions', chatCompletionsHandler);

api.get('/v1/models', async (c) => {
  let session = {};
  if (c.req.header('Authorization')) {
    try { const valid = await validateSession(c); if (!valid) return c.json({ error: 'Invalid session' }, 401); session = valid.session; }
    catch { return c.json({ error: 'Account database unavailable' }, 503); }
  }
  return c.json({ object: 'list', data: (await resolveModelCatalog(c.env, session)).map(publicModel) });
});

api.get('/v1/providers/health', async (c) => {
  let valid;
  try { valid = await validateSession(c); }
  catch { return c.json({ error: 'Account database unavailable' }, 503); }
  if (!valid) return c.json({ error: 'Invalid or expired session token' }, 401);
  c.header('Cache-Control', 'no-store');
  return c.json({ providers: await providerHealth(c.env, valid.session) });
});

// Inference probes use the same authentication and quota accounting as a normal completion.
api.post('/v1/models/health', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.model !== 'string') return c.json({ error: 'Provide a model' }, 400);
  const started = Date.now();
  const response = await app.fetch(new Request(new URL('/v1/chat/completions', c.req.url), {
    method: 'POST', headers: { Authorization: c.req.header('Authorization') || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: body.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8 }),
    signal: c.req.raw.signal,
  }), c.env);
  const result = await response.json();
  if (!response.ok) return c.json({ model: body.model, status: 'unavailable', error: result.error, latency_ms: Date.now() - started }, response.status);
  const validCompletion = result.choices?.some(choice => choice.message?.content || choice.message?.tool_calls?.length);
  return c.json({ model: result.model, status: validCompletion ? 'healthy' : 'invalid_completion', inference_checked: true,
    latency_ms: Date.now() - started, usage: result.usage }, validCompletion ? 200 : 502);
});

// 6. OpenRouter OAuth Start
api.get('/auth/openrouter/start', async (c) => {
  const verifier = generateRandomString(32);
  const challenge = await sha256(verifier);
  const state = generateRandomString(16);

  await setSession(c, `pkce:${state}`, {
    verifier,
    created: Date.now(),
  });

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

  if (!code || !state) {
    return c.json({ error: "Missing code or state parameter" }, 400);
  }

  const pkceSession = await getSession(c, `pkce:${state}`);
  if (!pkceSession || Date.now() - pkceSession.created > 10 * 60 * 1000) {
    if (pkceSession) await deleteSession(c, `pkce:${state}`);
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  await deleteSession(c, `pkce:${state}`);
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
    if (!exchange.ok) return c.json({ error: 'Token exchange failed' }, 502);
    const tokenRes = await exchange.json();
    const apiKey = tokenRes.key;

    if (typeof apiKey !== 'string' || !apiKey) {
      return c.json({ error: "Token exchange failed" }, 502);
    }

    const sessionToken = "ses_" + generateRandomString(24);
    const sessionData = {
      created: Date.now(),
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
      models: availableModels(c, sessionData), ...planQuota('free'),
      ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600 });
  } catch {
    return c.json({ error: "OAuth exchange failed" }, 502);
  }
});

app.route('/neuroncli/auth-server', api);
app.route('/', api);

// Unmatched routes fall back to static assets (supporting clean URLs like /about -> /about.html)
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const path = url.pathname;

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

    // Direct asset fetch
    return c.env.ASSETS.fetch(c.req.raw);
  }
  
  return c.text('Not Found', 404);
});

export default app;
