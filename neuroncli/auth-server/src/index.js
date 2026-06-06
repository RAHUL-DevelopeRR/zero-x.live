import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
const api = new Hono();

// Global sessions in-memory fallback (useful for dev/zero-config, ephemerally persists per isolate)
const sessions = new Map();

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

  const sessionToken = "ses_" + generateRandomString(24);
  const sessionData = {
    created: Date.now(),
    fingerprint: fp,
    version: version,
    requests: 0,
    tokens_used: 0,
    provider_used: null,
  };

  await setSession(c, sessionToken, sessionData);

  return c.json({
    session_token: sessionToken,
    models: [
      "Kimi-K2.5",
      "Kimi-K2.6",
      "DeepSeek-V4-Flash",
      "FW-DeepSeek-V3.2",
      "FW-MiniMax-M2.5",
      "model-router",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.5-2",
      "gpt-5.1-codex-max"
    ],
    quota: {
      daily_limit: 500000,
      remaining: 500000,
    },
    ttl_seconds: (parseInt(c.env.SESSION_TTL_HOURS) || 24) * 3600,
  });
};

api.post('/auth/session', createSessionHandler);
api.post('/auth/azure/exchange', createSessionHandler);

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
    requests: session.requests,
    tokens_used: session.tokens_used,
    provider_used: session.provider_used,
    ttl_remaining_seconds: Math.max(
      0,
      (sessionTtlMs - (Date.now() - session.created)) / 1000
    ),
  });
};

api.get('/auth/session', verifySessionHandler);
api.get('/auth/azure/session', verifySessionHandler);

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
  const maxRequests = parseInt(c.env.MAX_REQUESTS_PER_SESSION) || 1000;
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

export default app;
