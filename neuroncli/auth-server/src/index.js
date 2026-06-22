import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clerkMiddleware, getAuth } from '@clerk/hono';
import { neon } from '@neondatabase/serverless';

const app = new Hono();
const api = new Hono();

// Hostname-based subdomain routing middleware
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const path = url.pathname;

  // Let Hono handle OPTIONS/CORS preflight
  if (c.req.method === 'OPTIONS') {
    return next();
  }

  // 1. Static asset paths (images, fonts, stylesheets, JS files)
  const isAsset = path.startsWith('/Assets/') || 
                  path.startsWith('/assets/') || 
                  (path.includes('.') && !path.endsWith('/'));
  
  if (isAsset) {
    if (c.env && c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
  }

  // 2. Subdomain and clean HTML path routing
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

  // 3. Continue Hono routing for API paths
  return next();
});

// Global sessions in-memory fallback (useful for dev/zero-config, ephemerally persists per isolate)
const sessions = new Map();

const PLAN_LIMITS = {
  free: { name: "Free", daily_tokens: 44000, daily_requests: 1000 },
  pro: { name: "Pro", daily_tokens: 1000000, daily_requests: 10000 },
  ultrawork: { name: "Ultrawork", daily_tokens: 5000000, daily_requests: 50000 },
};

const MODELS_BY_PLAN = {
  free: ["DeepSeek-V4-Flash", "Kimi-K2.5", "DeepSeek-V4-Pro"],
  pro: [
    "DeepSeek-V4-Flash",
    "Kimi-K2.5",
    "Kimi-K2.6",
    "DeepSeek-V4-Pro",
    "FW-DeepSeek-V3.2",
    "FW-MiniMax-M2.5",
    "model-router",
    "gpt-5.4-mini",
    "gpt-5.5-2",
  ],
  ultrawork: [
    "Kimi-K2.5",
    "Kimi-K2.6",
    "DeepSeek-V4-Flash",
    "DeepSeek-V4-Pro",
    "FW-DeepSeek-V3.2",
    "FW-MiniMax-M2.5",
    "model-router",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.5-2",
    "gpt-5.1-codex-max",
  ],
};

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

function authClaimsPlan(auth) {
  const claims = auth?.sessionClaims || {};
  return normalizePlan(
    claims?.public_metadata?.plan ||
    claims?.private_metadata?.plan ||
    claims?.metadata?.plan ||
    claims?.plan
  );
}

function clerkProfileFromBody(body = {}) {
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

async function ensureUserSchema(c) {
  if (!c.env.DATABASE_URL) return null;
  const sql = neon(c.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clerk_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL DEFAULT '',
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      name VARCHAR(255),
      username VARCHAR(255),
      image_url TEXT,
      plan VARCHAR(64) NOT NULL DEFAULT 'free',
      daily_tokens_used BIGINT NOT NULL DEFAULT 0,
      daily_requests BIGINT NOT NULL DEFAULT 0,
      last_usage_reset DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS image_url TEXT;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(64) NOT NULL DEFAULT 'free';`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_tokens_used BIGINT NOT NULL DEFAULT 0;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_requests BIGINT NOT NULL DEFAULT 0;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_usage_reset DATE NOT NULL DEFAULT CURRENT_DATE;`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;`;
  return sql;
}

async function loadUserRecord(c, clerkId) {
  const sql = await ensureUserSchema(c);
  if (!sql) return null;
  const rows = await sql`SELECT * FROM users WHERE clerk_id = ${clerkId} LIMIT 1`;
  return rows[0] || null;
}

async function syncUserRecord(c, auth, profile = {}) {
  const sql = await ensureUserSchema(c);
  if (!sql) return null;

  const existing = await loadUserRecord(c, auth.userId);
  const claimedPlan = authClaimsPlan(auth);
  const clientPlan = c.env.ALLOW_CLIENT_PLAN_OVERRIDE === "true" ? profile.plan : "";
  const plan = normalizePlan(existing?.plan || claimedPlan || clientPlan || "free");
  const email = profile.email || existing?.email || "";
  const firstName = profile.firstName || existing?.first_name || "";
  const lastName = profile.lastName || existing?.last_name || "";
  const name = profile.name || existing?.name || [firstName, lastName].filter(Boolean).join(" ") || email;
  const username = profile.username || existing?.username || "";
  const imageUrl = profile.imageUrl || existing?.image_url || "";

  const rows = await sql`
    INSERT INTO users (clerk_id, email, first_name, last_name, name, username, image_url, plan)
    VALUES (${auth.userId}, ${email}, ${firstName}, ${lastName}, ${name}, ${username}, ${imageUrl}, ${plan})
    ON CONFLICT (clerk_id)
    DO UPDATE SET
      email = ${email},
      first_name = ${firstName},
      last_name = ${lastName},
      name = ${name},
      username = ${username},
      image_url = ${imageUrl},
      plan = COALESCE(NULLIF(users.plan, ''), ${plan}),
      updated_at = CURRENT_TIMESTAMP,
      last_seen_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;
  return rows[0] || null;
}

function userResponse(user, fallbackUserId = "") {
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
    models: MODELS_BY_PLAN[plan] || MODELS_BY_PLAN.free,
    ...quota,
  };
}

async function recordUserUsage(c, userId, requests, tokens) {
  if (!userId || !c.env.DATABASE_URL) return;
  try {
    const sql = await ensureUserSchema(c);
    await sql`
      UPDATE users
      SET
        daily_requests = CASE WHEN last_usage_reset < CURRENT_DATE THEN ${requests} ELSE daily_requests + ${requests} END,
        daily_tokens_used = CASE WHEN last_usage_reset < CURRENT_DATE THEN ${tokens} ELSE daily_tokens_used + ${tokens} END,
        last_usage_reset = CURRENT_DATE,
        updated_at = CURRENT_TIMESTAMP,
        last_seen_at = CURRENT_TIMESTAMP
      WHERE clerk_id = ${userId};
    `;
  } catch (err) {
    console.warn("Usage update failed:", err.message);
  }
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

  const session = await getSession(c, token);
  if (!session) return null;

  const ttlHours = parseInt(c.env.SESSION_TTL_HOURS) || 24;
  const sessionTtlMs = ttlHours * 3600 * 1000;

  if (Date.now() - session.created > sessionTtlMs) {
    await deleteSession(c, token);
    return null;
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
  allowMethods: ['POST', 'GET', 'OPTIONS'],
}));

// ── Routes ──

// 1. Health check
api.get('/health', (c) => {
  return c.json({
    status: "ok",
    service: "neuroncli-gateway-worker",
    version: "2.0.0",
    azure_configured: !!c.env.AZURE_OPENAI_API_KEY,
    kv_bound: !!c.env.SESSIONS_KV,
  });
});

// 2. Session creation (main & legacy exchange)
const createSessionHandler = async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fp = body.machine_fingerprint || body.fingerprint;
  const version = body.version || "unknown";

  if (!fp) {
    return c.json({ error: "Missing machine_fingerprint" }, 400);
  }

  const plan = normalizePlan(body.plan || "free");
  const quota = planQuota(plan);
  const sessionToken = "ses_" + generateRandomString(24);
  const sessionData = {
    created: Date.now(),
    fingerprint: fp,
    version: version,
    user_id: body.user_id || null,
    email: body.email || "",
    name: body.name || "",
    image_url: body.image_url || "",
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
    models: MODELS_BY_PLAN[plan] || MODELS_BY_PLAN.free,
    quota: quota.quota,
    usage: quota.usage,
    limits: quota.limits,
    ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600,
  });
};

api.post('/auth/session', createSessionHandler);
api.post('/auth/azure/exchange', createSessionHandler);

const createClerkCliSessionHandler = async (c) => {
  const auth = getAuth(c);
  if (!auth || !auth.userId) {
    return c.json({ error: "Unauthorized", message: "Invalid Clerk session" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const fp = body.machine_fingerprint || body.fingerprint || "clerk-user";
  const profile = clerkProfileFromBody(body);
  let user = null;
  try {
    user = await syncUserRecord(c, auth, profile);
  } catch (err) {
    console.warn("Clerk CLI session sync failed:", err.message);
  }

  const account = userResponse(user, auth.userId);
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
    requests: 0,
    tokens_used: 0,
    provider_used: "azure",
  };

  await setSession(c, sessionToken, sessionData);

  return c.json({
    session_token: sessionToken,
    provider: "gateway",
    ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600,
    ...account,
  });
};

api.post('/auth/cli/session', clerkMiddleware(), createClerkCliSessionHandler);

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
    models: MODELS_BY_PLAN[normalizePlan(session.plan)] || MODELS_BY_PLAN.free,
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
    models: MODELS_BY_PLAN[plan] || MODELS_BY_PLAN.free,
    limits: PLAN_LIMITS[plan],
  });
});

// 3.5 Clerk user profile DB sync
api.post('/auth/sync', clerkMiddleware(), async (c) => {
  const auth = getAuth(c);
  if (!auth || !auth.userId) {
    return c.json({ error: "Unauthorized", message: "Invalid session" }, 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const user = await syncUserRecord(c, auth, clerkProfileFromBody(body));
    if (!user) {
      return c.json({ status: "skipped", message: "DATABASE_URL is not configured on the Worker" });
    }
    return c.json({ status: "success", ...userResponse(user, auth.userId) });
  } catch (err) {
    console.error("Database sync error:", err);
    return c.json({ error: "Internal Server Error", message: err.message }, 500);
  }
});

api.get('/auth/me', clerkMiddleware(), async (c) => {
  const auth = getAuth(c);
  if (!auth || !auth.userId) {
    return c.json({ error: "Unauthorized", message: "Invalid Clerk session" }, 401);
  }
  try {
    const user = await loadUserRecord(c, auth.userId);
    return c.json({ status: user ? "success" : "missing", ...userResponse(user, auth.userId) });
  } catch (err) {
    console.error("Account lookup error:", err);
    return c.json({ error: "Internal Server Error", message: err.message }, 500);
  }
});

// 4. LLM Streaming Proxy
const chatCompletionsHandler = async (c) => {
  const valid = await validateSession(c);
  if (!valid) {
    return c.json({ error: "Invalid or expired session token" }, 401);
  }

  const { token, session } = valid;
  const azureApiKey = c.env.AZURE_OPENAI_API_KEY;

  if (!azureApiKey) {
    return c.json({
      error: "Provider not configured",
      hint: "Azure credentials not set on worker variables",
    }, 503);
  }

  const body = await c.req.json().catch(() => ({}));
  const { model, messages, max_tokens, stream, tools, tool_choice, temperature, top_p } = body;

  if (!model || !messages) {
    return c.json({ error: "Missing model or messages" }, 400);
  }

  // Rate limiting
  session.requests++;
  const plan = normalizePlan(session.plan);
  const maxRequests = Number(PLAN_LIMITS[plan]?.daily_requests || parseInt(c.env.MAX_REQUESTS_PER_SESSION) || 1000);
  if (session.requests > maxRequests) {
    return c.json({ error: "Daily request limit exceeded" }, 429);
  }

  session.provider_used = "azure";
  await setSession(c, token, session);

  // Build Azure request body
  const azureBody = { model, messages, max_tokens: max_tokens || 16384 };
  if (stream) azureBody.stream = true;
  if (tools) azureBody.tools = tools;
  if (tool_choice) azureBody.tool_choice = tool_choice;
  if (temperature !== undefined) azureBody.temperature = temperature;
  if (top_p !== undefined) azureBody.top_p = top_p;

  const azureEndpoint = c.env.AZURE_OPENAI_ENDPOINT || "https://rahul-mok8ryyn-eastus2.services.ai.azure.com";
  const azureUrl = `${azureEndpoint}/models/chat/completions?api-version=${c.env.AZURE_API_VERSION || '2024-05-01-preview'}`;

  try {
    const azureRes = await fetch(azureUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${azureApiKey}`,
      },
      body: JSON.stringify(azureBody),
    });

    if (!azureRes.ok) {
      const errorText = await azureRes.text();
      return new Response(errorText, {
        status: azureRes.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    await recordUserUsage(c, session.user_id, 1, 0);

    if (!stream) {
      const responseText = await azureRes.text();
      let usageTokens = 0;
      try {
        const parsed = JSON.parse(responseText);
        usageTokens = Number(parsed?.usage?.total_tokens || 0);
      } catch { /* pass through non-JSON providers */ }
      if (usageTokens > 0) {
        session.tokens_used = Number(session.tokens_used || 0) + usageTokens;
        await setSession(c, token, session);
        await recordUserUsage(c, session.user_id, 0, usageTokens);
      }
      return new Response(responseText, {
        status: azureRes.status,
        headers: {
          "Content-Type": azureRes.headers.get("content-type") || "application/json",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Cloudflare Workers natively stream the response body
    return new Response(azureRes.body, {
      status: azureRes.status,
      headers: {
        "Content-Type": azureRes.headers.get("content-type") || "application/json",
        "Cache-Control": "no-cache",
        ...(azureRes.headers.get("transfer-encoding") ? { "Transfer-Encoding": azureRes.headers.get("transfer-encoding") } : {}),
      },
    });
  } catch (err) {
    return c.json({ error: "Proxy error", message: err.message }, 502);
  }
};

api.post('/v1/chat/completions', chatCompletionsHandler);
api.post('/auth/azure/proxy', chatCompletionsHandler);
api.post('/auth/azure/chat/completions', chatCompletionsHandler);

// 5. Models listing
api.get('/v1/models', (c) => {
  const models = [
    { id: "Kimi-K2.5", aliases: ["default", "kimi"], type: "Global Standard" },
    { id: "Kimi-K2.6", aliases: ["max", "reasoning"], type: "Global Standard" },
    { id: "DeepSeek-V4-Flash", aliases: ["power", "deepseek", "fast", "flash"], type: "Global Standard" },
    { id: "FW-DeepSeek-V3.2", aliases: ["code", "coder"], type: "Data Zone" },
    { id: "FW-MiniMax-M2.5", aliases: ["minimax", "mm"], type: "Data Zone" },
    { id: "model-router", aliases: ["router", "auto"], type: "Global Standard" },
    { id: "gpt-5.4-pro", aliases: ["gpt54", "gpt-5.4"], type: "Global Standard" },
    { id: "gpt-5.4-mini", aliases: ["gpt54m"], type: "Global Standard" },
    { id: "gpt-5.5-2", aliases: ["gpt5", "gpt55", "gpt-5.5"], type: "Global Standard" },
    { id: "gpt-5.1-codex-max", aliases: ["codex", "codex-max"], type: "Global Standard" },
  ];

  return c.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Date.now(),
      owned_by: "azure-ai-foundry",
      aliases: m.aliases,
      type: m.type,
    })),
  });
});

// 6. OpenRouter OAuth Start
api.get('/auth/openrouter/start', async (c) => {
  const verifier = generateRandomString(32);
  const challenge = await sha256(verifier);
  const state = generateRandomString(16);

  const cliPort = c.req.query("cli_port") || "4545";

  await setSession(c, `pkce:${state}`, {
    verifier,
    created: Date.now(),
    cliPort,
  });

  const clientId = c.env.OPENROUTER_CLIENT_ID || "neuroncli";
  const callbackUrl = c.env.OPENROUTER_CALLBACK_URL || "https://zero-x.live/neuroncli/callback/";

  const authUrl = new URL("https://openrouter.ai/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid");
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
  if (!pkceSession) {
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  try {
    const tokenRes = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pkceSession.verifier,
        redirect_uri: c.env.OPENROUTER_CALLBACK_URL || "https://zero-x.live/neuroncli/callback/",
      }),
    }).then(res => res.json());

    const apiKey = tokenRes.key;

    if (!apiKey) {
      return c.json({ error: "Token exchange failed" }, 500);
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
    };

    await setSession(c, sessionToken, sessionData);
    await deleteSession(c, `pkce:${state}`);

    const cliPort = pkceSession.cliPort;
    try {
      fetch(`http://localhost:${cliPort}/oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: sessionToken, provider: "openrouter" }),
      });
    } catch { /* CLI may not be listening */ }

    return c.html(successPage(sessionToken, "OpenRouter"));
  } catch (err) {
    return c.json({ error: "OAuth exchange failed", message: err.message }, 500);
  }
});

// Success page helper HTML
function successPage(sessionToken, provider) {
  const masked = sessionToken.slice(0, 12) + "..." + sessionToken.slice(-6);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>NeuronCLI — Authentication Complete</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,sans-serif; background:#0a0a0f; color:#e0e0e8; display:flex; justify-content:center; align-items:center; min-height:100vh; }
    .card { background:rgba(20,20,30,0.9); border:1px solid rgba(100,120,255,0.2); border-radius:16px; padding:48px; max-width:520px; text-align:center; }
    .icon { font-size:48px; margin-bottom:16px; color:#2D8C3C; }
    h1 { font-size:24px; margin-bottom:8px; color:#8cf; }
    p { color:#aab; margin-bottom:16px; line-height:1.5; }
    .code-box { background:#111118; border:1px solid #333; border-radius:8px; padding:12px; font-family:monospace; font-size:12px; color:#7f8; margin:16px 0; }
    .hint { font-size:12px; color:#667; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Authentication Successful</h1>
    <p>Connected via <strong>${provider}</strong>.</p>
    <p>Your session has been forwarded to NeuronCLI.</p>
    <div class="code-box">${masked}</div>
    <p class="hint">You can close this tab. Your terminal is ready.</p>
  </div>
</body>
</html>`;
}

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
