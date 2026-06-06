/**
 * NeuronCLI Auth Gateway Server — Production Grade
 *
 * Central gateway between CLI clients and LLM providers.
 * ALL API keys stay server-side. Client only holds a session token.
 *
 * Architecture:
 *   Client ←→ zero-x.live ←→ Azure AI Foundry (primary)
 *                           ←→ OpenRouter (fallback)
 *
 * Endpoints:
 *   POST /auth/session           — Create session (open, Google OAuth later)
 *   GET  /auth/session           — Verify session (Bearer token)
 *   POST /v1/chat/completions    — Streaming proxy to Azure (main LLM endpoint)
 *   GET  /auth/openrouter/start  — Start OpenRouter PKCE flow
 *   GET  /auth/openrouter/callback — Handle PKCE callback
 *   GET  /health                 — Health check
 *   GET  /v1/models              — List available models
 *
 * Run locally:  node server.js           (port 19284)
 * Production:   deploy to zero-x.live
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Configuration ─────────────────────────────────────────────
const PORT = process.env.AUTH_PORT || 19284;

// Azure AI Foundry — server-side only, NEVER sent to client
const AZURE_ENDPOINT =
  process.env.AZURE_OPENAI_ENDPOINT ||
  "https://rahul-mok8ryyn-eastus2.services.ai.azure.com";
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AZURE_API_VERSION = "2024-05-01-preview";

// OpenRouter OAuth
const OPENROUTER_CLIENT_ID = process.env.OPENROUTER_CLIENT_ID || "neuroncli";
const OPENROUTER_CALLBACK_URL =
  process.env.OPENROUTER_CALLBACK_URL ||
  "https://zero-x.live/neuroncli/callback/";

// Session config
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_HOURS, 10) || 24) * 60 * 60 * 1000;
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS_PER_SESSION, 10) || 1000;

// Azure model deployments (from AI Foundry dashboard)
const AZURE_MODELS = [
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

// ── Session Store ─────────────────────────────────────────────
// In-memory for local dev. Use Redis/DB in production.
const sessions = new Map();

function generateSessionToken() {
  return "ses_" + crypto.randomBytes(24).toString("hex");
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.created > SESSION_TTL_MS) {
      sessions.delete(token);
    }
  }
}

function validateSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.replace("Bearer ", "");
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

// ── Middleware: Request logging (mask secrets) ────────────────
app.use((req, _res, next) => {
  if (req.path !== "/health") {
    const masked = req.headers.authorization
      ? `Bearer ${req.headers.authorization.slice(7, 15)}...`
      : "none";
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} auth=${masked}`);
  }
  next();
});

// ══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "neuroncli-gateway",
    version: "2.0.0",
    azure_configured: !!AZURE_API_KEY,
    models_available: AZURE_MODELS.length,
    active_sessions: sessions.size,
    uptime: process.uptime(),
  });
});

// ══════════════════════════════════════════════════════════════
// AUTH: SESSION MANAGEMENT (open for now, Google OAuth later)
// ══════════════════════════════════════════════════════════════

// Create a new session — client sends fingerprint, gets session token
app.post("/auth/session", (req, res) => {
  const { machine_fingerprint, fingerprint, version } = req.body || {};
  const fp = machine_fingerprint || fingerprint;

  if (!fp) {
    return res.status(400).json({ error: "Missing machine_fingerprint" });
  }

  cleanExpiredSessions();

  const sessionToken = generateSessionToken();
  sessions.set(sessionToken, {
    created: Date.now(),
    fingerprint: fp,
    version: version || "unknown",
    requests: 0,
    tokens_used: 0,
    provider_used: null,
  });

  console.log(
    `[auth] Session created: fp=${fp.slice(0, 12)}... token=${sessionToken.slice(0, 12)}...`
  );

  res.json({
    session_token: sessionToken,
    models: AZURE_MODELS.map((m) => m.id),
    quota: {
      daily_limit: 500000,
      remaining: 500000,
    },
    ttl_seconds: SESSION_TTL_MS / 1000,
  });
});

// Legacy endpoint — CLI's try_auth_server_session calls this
app.post("/auth/azure/exchange", (req, res) => {
  // Redirect to new /auth/session endpoint
  req.url = "/auth/session";
  app.handle(req, res);
});

// Verify session
app.get("/auth/session", (req, res) => {
  const valid = validateSession(req);
  if (!valid) return res.status(401).json({ error: "Invalid or expired session" });

  const { session } = valid;
  res.json({
    created: new Date(session.created).toISOString(),
    fingerprint: session.fingerprint,
    requests: session.requests,
    tokens_used: session.tokens_used,
    provider_used: session.provider_used,
    ttl_remaining_seconds: Math.max(
      0,
      (SESSION_TTL_MS - (Date.now() - session.created)) / 1000
    ),
  });
});

// Legacy endpoint — CLI calls GET /auth/azure/session
app.get("/auth/azure/session", (req, res) => {
  req.url = "/auth/session";
  app.handle(req, res);
});

// ══════════════════════════════════════════════════════════════
// LLM PROXY: /v1/chat/completions (main endpoint)
// Streams Azure responses directly to client.
// Client sends: Bearer session_token + model + messages
// Server injects: Azure API key + routes to Azure endpoint
// ══════════════════════════════════════════════════════════════

app.post("/v1/chat/completions", async (req, res) => {
  const valid = validateSession(req);
  if (!valid) {
    return res.status(401).json({ error: "Invalid or expired session token" });
  }

  const { session } = valid;

  if (!AZURE_API_KEY) {
    return res.status(503).json({
      error: "Provider not configured",
      hint: "Azure credentials not set on server",
    });
  }

  const { model, messages, max_tokens, stream, tools, tool_choice, temperature, top_p } = req.body;

  if (!model || !messages) {
    return res.status(400).json({ error: "Missing model or messages" });
  }

  // Rate limiting
  session.requests++;
  if (session.requests > MAX_REQUESTS) {
    return res.status(429).json({ error: "Daily request limit exceeded" });
  }

  session.provider_used = "azure";

  console.log(
    `[proxy] model=${model} stream=${!!stream} session=${valid.token.slice(0, 12)}... req#${session.requests}`
  );

  // Build Azure request body
  const azureBody = { model, messages, max_tokens: max_tokens || 16384 };
  if (stream) azureBody.stream = true;
  if (tools) azureBody.tools = tools;
  if (tool_choice) azureBody.tool_choice = tool_choice;
  if (temperature !== undefined) azureBody.temperature = temperature;
  if (top_p !== undefined) azureBody.top_p = top_p;

  const azureUrl = `${AZURE_ENDPOINT}/models/chat/completions?api-version=${AZURE_API_VERSION}`;
  const bodyStr = JSON.stringify(azureBody);

  try {
    const parsedUrl = new URL(azureUrl);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const proxyReq = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AZURE_API_KEY}`,
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (proxyRes) => {
        // Build response headers — don't set undefined values
        const responseHeaders = {
          "Content-Type": proxyRes.headers["content-type"] || "application/json",
          "Cache-Control": "no-cache",
        };
        if (stream) {
          responseHeaders["Transfer-Encoding"] = "chunked";
        }
        res.writeHead(proxyRes.statusCode, responseHeaders);

        let totalData = 0;
        proxyRes.on("data", (chunk) => {
          totalData += chunk.length;
          res.write(chunk);
        });

        proxyRes.on("end", () => {
          // Track approximate token usage from response size
          session.tokens_used += Math.ceil(totalData / 4);
          res.end();
        });

        proxyRes.on("error", (err) => {
          console.error("[proxy] Response stream error:", err.message);
          res.end();
        });
      }
    );

    proxyReq.on("error", (err) => {
      console.error("[proxy] Request error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Azure request failed", message: err.message });
      }
    });

    proxyReq.setTimeout(120000, () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: "Azure request timeout" });
      }
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  } catch (err) {
    console.error("[proxy] Error:", err.message);
    res.status(502).json({ error: "Proxy error", message: err.message });
  }
});

// Legacy endpoint — CLI's openai_compat sends to /auth/azure/proxy
app.post("/auth/azure/proxy", (req, res) => {
  req.url = "/v1/chat/completions";
  app.handle(req, res);
});

// Also handle the path that openai_compat appends: /auth/azure/chat/completions
app.post("/auth/azure/chat/completions", (req, res) => {
  req.url = "/v1/chat/completions";
  app.handle(req, res);
});

// ══════════════════════════════════════════════════════════════
// MODELS: List available models
// ══════════════════════════════════════════════════════════════

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: AZURE_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Date.now(),
      owned_by: "azure-ai-foundry",
      aliases: m.aliases,
      type: m.type,
    })),
  });
});

// ══════════════════════════════════════════════════════════════
// OPENROUTER PKCE OAUTH
// ══════════════════════════════════════════════════════════════

function generatePKCEPair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// Step 1: CLI calls this to get the OAuth URL
app.get("/auth/openrouter/start", (req, res) => {
  const { verifier, challenge } = generatePKCEPair();
  const state = crypto.randomBytes(16).toString("hex");

  sessions.set(`pkce:${state}`, {
    verifier,
    created: Date.now(),
    cliPort: req.query.cli_port || "4545",
  });

  const authUrl = new URL("https://openrouter.ai/auth");
  authUrl.searchParams.set("client_id", OPENROUTER_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", OPENROUTER_CALLBACK_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log(`[openrouter] PKCE start → state=${state.slice(0, 8)}...`);

  res.json({
    auth_url: authUrl.toString(),
    state,
  });
});

// Step 2: OpenRouter redirects here after user approves
app.get("/auth/openrouter/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).json({ error: "Missing code or state parameter" });
  }

  const pkceSession = sessions.get(`pkce:${state}`);
  if (!pkceSession) {
    return res.status(400).json({ error: "Invalid or expired state" });
  }

  console.log(`[openrouter] Callback → state=${state.slice(0, 8)}...`);

  try {
    const tokenRes = await fetchJSON("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pkceSession.verifier,
        redirect_uri: OPENROUTER_CALLBACK_URL,
      }),
    });

    const apiKey = tokenRes.key;

    if (!apiKey) {
      console.error("[openrouter] Token exchange failed:", tokenRes);
      return res.status(500).json({ error: "Token exchange failed" });
    }

    // Key stays server-side — create a session that uses OpenRouter
    const sessionToken = generateSessionToken();
    sessions.set(sessionToken, {
      created: Date.now(),
      fingerprint: "openrouter-pkce",
      version: "6.2.4",
      requests: 0,
      tokens_used: 0,
      provider_used: "openrouter",
      openrouter_key: apiKey, // Stored server-side only
    });

    console.log(`[openrouter] Key obtained, session created: ${sessionToken.slice(0, 12)}...`);

    const cliPort = pkceSession.cliPort;
    sessions.delete(`pkce:${state}`);

    // Forward session token to CLI
    try {
      await fetchJSON(`http://localhost:${cliPort}/oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: sessionToken, provider: "openrouter" }),
      });
    } catch { /* CLI may not be listening */ }

    res.send(successPage(sessionToken, "OpenRouter"));
  } catch (err) {
    console.error("[openrouter] Exchange error:", err.message);
    res.status(500).json({ error: "OAuth exchange failed", message: err.message });
  }
});

// ── HTTP helpers ──────────────────────────────────────────────

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body;
    delete options.body;
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = transport.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data, status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Success page ──────────────────────────────────────────────

function successPage(sessionToken, provider) {
  // Show session token (NOT the API key) — safe to display
  const masked = sessionToken.slice(0, 12) + "..." + sessionToken.slice(-6);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>NeuronCLI — Authentication Complete</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,sans-serif; background:#0a0a0f; color:#e0e0e8; display:flex; justify-content:center; align-items:center; min-height:100vh; }
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
  <script>
    fetch('http://localhost:4545/oauth/callback', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_token:'${sessionToken}',provider:'${provider}'})
    }).catch(()=>{});
  </script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════════════════╗");
  console.log("  ║  NeuronCLI Gateway Server v2.0                  ║");
  console.log(`  ║  http://localhost:${PORT}                          ║`);
  console.log("  ╠══════════════════════════════════════════════════╣");
  console.log(`  ║  Azure:      ${AZURE_API_KEY ? "✓ configured" : "✗ not set"}                       ║`);
  console.log(`  ║  Models:     ${AZURE_MODELS.length} deployments                     ║`);
  console.log(`  ║  OpenRouter: PKCE ready                         ║`);
  console.log("  ╚══════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Endpoints:");
  console.log("    GET  /health                  Health check");
  console.log("    POST /auth/session            Create session");
  console.log("    GET  /auth/session            Verify session");
  console.log("    POST /v1/chat/completions     LLM proxy (streaming)");
  console.log("    GET  /v1/models               List models");
  console.log("    GET  /auth/openrouter/start   Start PKCE");
  console.log("    GET  /auth/openrouter/callback  PKCE callback");
  console.log("");
});
