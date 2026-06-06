/**
 * NeuronCLI Gateway Server — Test Suite
 * Tests each endpoint individually, then coordination.
 * Run: node test.js (requires server running on :19284)
 */

const http = require("http");

const BASE = "http://localhost:19284";
let passed = 0;
let failed = 0;
let sessionToken = null;

async function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}  ${detail}`);
    failed++;
  }
}

async function testHealthCheck() {
  console.log("\n── Test 1: Health Check ──");
  const res = await request("GET", "/health");
  assert("Status 200", res.status === 200);
  assert("Has status field", res.body?.status === "ok");
  assert("Has azure_configured", typeof res.body?.azure_configured === "boolean");
  assert("Has models_available", res.body?.models_available >= 10, `got ${res.body?.models_available}`);
}

async function testCreateSession() {
  console.log("\n── Test 2: Create Session ──");
  const res = await request("POST", "/auth/session", {
    machine_fingerprint: "test-machine-12345",
    version: "6.2.4",
  });
  assert("Status 200", res.status === 200);
  assert("Has session_token", !!res.body?.session_token);
  assert("Token starts with ses_", res.body?.session_token?.startsWith("ses_"));
  assert("Has models array", Array.isArray(res.body?.models));
  assert("Has 10 models", res.body?.models?.length === 10, `got ${res.body?.models?.length}`);
  assert("Has quota", !!res.body?.quota);
  sessionToken = res.body?.session_token;
}

async function testCreateSessionMissingFingerprint() {
  console.log("\n── Test 3: Create Session (no fingerprint) ──");
  const res = await request("POST", "/auth/session", {});
  assert("Status 400", res.status === 400);
  assert("Has error message", !!res.body?.error);
}

async function testVerifySession() {
  console.log("\n── Test 4: Verify Session ──");
  if (!sessionToken) { console.log("  SKIP (no session)"); return; }
  const res = await request("GET", "/auth/session", null, {
    Authorization: `Bearer ${sessionToken}`,
  });
  assert("Status 200", res.status === 200);
  assert("Has fingerprint", res.body?.fingerprint === "test-machine-12345");
  assert("Has requests count", typeof res.body?.requests === "number");
  assert("Has ttl_remaining_seconds", res.body?.ttl_remaining_seconds > 0);
}

async function testVerifyInvalidSession() {
  console.log("\n── Test 5: Verify Invalid Session ──");
  const res = await request("GET", "/auth/session", null, {
    Authorization: "Bearer invalid_token_12345",
  });
  assert("Status 401", res.status === 401);
  assert("Has error", !!res.body?.error);
}

async function testListModels() {
  console.log("\n── Test 6: List Models ──");
  const res = await request("GET", "/v1/models");
  assert("Status 200", res.status === 200);
  assert("Has data array", Array.isArray(res.body?.data));
  assert("Has 10 models", res.body?.data?.length === 10, `got ${res.body?.data?.length}`);
  const modelIds = res.body?.data?.map((m) => m.id) || [];
  assert("Has Kimi-K2.5", modelIds.includes("Kimi-K2.5"));
  assert("Has gpt-5.5-2", modelIds.includes("gpt-5.5-2"));
  assert("Has model-router", modelIds.includes("model-router"));
}

async function testProxyNoAuth() {
  console.log("\n── Test 7: Proxy without auth ──");
  const res = await request("POST", "/v1/chat/completions", {
    model: "Kimi-K2.5",
    messages: [{ role: "user", content: "ping" }],
  });
  assert("Status 401", res.status === 401);
  assert("Has error", !!res.body?.error);
}

async function testProxyMissingModel() {
  console.log("\n── Test 8: Proxy missing model ──");
  if (!sessionToken) { console.log("  SKIP (no session)"); return; }
  const res = await request("POST", "/v1/chat/completions", {
    messages: [{ role: "user", content: "ping" }],
  }, { Authorization: `Bearer ${sessionToken}` });
  assert("Status 400", res.status === 400);
}

async function testLegacyExchangeEndpoint() {
  console.log("\n── Test 9: Legacy /auth/azure/exchange ──");
  const res = await request("POST", "/auth/azure/exchange", {
    machine_fingerprint: "legacy-test-client",
    version: "6.2.1",
  });
  assert("Status 200", res.status === 200);
  assert("Has session_token", !!res.body?.session_token);
}

async function testLegacySessionEndpoint() {
  console.log("\n── Test 10: Legacy /auth/azure/session ──");
  if (!sessionToken) { console.log("  SKIP (no session)"); return; }
  const res = await request("GET", "/auth/azure/session", null, {
    Authorization: `Bearer ${sessionToken}`,
  });
  assert("Status 200", res.status === 200);
  assert("Has fingerprint", !!res.body?.fingerprint);
}

async function testOpenRouterStart() {
  console.log("\n── Test 11: OpenRouter PKCE Start ──");
  const res = await request("GET", "/auth/openrouter/start");
  assert("Status 200", res.status === 200);
  assert("Has auth_url", !!res.body?.auth_url);
  assert("Auth URL has openrouter.ai", res.body?.auth_url?.includes("openrouter.ai"));
  assert("Has state", !!res.body?.state);
}

// ── Run all tests ─────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  NeuronCLI Gateway — Test Suite              ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Target: ${BASE}`);

  try {
    await testHealthCheck();
    await testCreateSession();
    await testCreateSessionMissingFingerprint();
    await testVerifySession();
    await testVerifyInvalidSession();
    await testListModels();
    await testProxyNoAuth();
    await testProxyMissingModel();
    await testLegacyExchangeEndpoint();
    await testLegacySessionEndpoint();
    await testOpenRouterStart();

    console.log("\n══════════════════════════════════════════════");
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log("══════════════════════════════════════════════\n");

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`\n  ✗ Test runner error: ${err.message}`);
    console.error("  Is the server running? Start with: node server.js\n");
    process.exit(1);
  }
}

main();
