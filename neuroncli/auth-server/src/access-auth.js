/**
 * Cloudflare Access in front of the operator pages (docs/PLATFORM_CONTRACT.md section 11.1).
 *
 * Access signs every request it lets through with a JWT in the Cf-Access-Jwt-Assertion header.
 * When CF_ACCESS_TEAM_DOMAIN (`<team>.cloudflareaccess.com`) and CF_ACCESS_AUD (the Access
 * application's audience tag) are set, the admin page and the provider key API verify that JWT
 * here too: RS256 signature against the team's published keys, audience, issuer and expiry. A
 * request that reaches the Worker without passing Access (another hostname, workers.dev, a
 * misconfigured Access path) is then refused even with the operator token.
 */
const TEAM_DOMAIN = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,256}$/;
const CERTS_TTL_MS = 600_000;
const CERTS_REFRESH_MIN_MS = 60_000; // an unknown key id refetches the keys at most once a minute
const SKEW_SECONDS = 60;

const encoder = new TextEncoder();
const certCache = new Map(); // team -> { fetchedAt, keys: Promise<Map<kid, CryptoKey>> }

const team = env => String(env?.CF_ACCESS_TEAM_DOMAIN || '').trim().toLowerCase();
const audience = env => String(env?.CF_ACCESS_AUD || '').trim();

export function accessConfigured(env) {
  return TEAM_DOMAIN.test(team(env)) && AUDIENCE.test(audience(env));
}

function base64url(text) {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '='));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const decodeJson = part => JSON.parse(new TextDecoder().decode(base64url(part)));

function signingKeys(domain, fetchImpl, now) {
  const cached = certCache.get(domain);
  if (cached && now - cached.fetchedAt < CERTS_TTL_MS) return cached;
  const entry = { fetchedAt: now, keys: (async () => {
    const response = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Access certs answered ${response.status}`);
    const body = await response.json();
    const keys = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
      keys.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    return keys;
  })() };
  entry.keys.catch(() => { if (certCache.get(domain) === entry) certCache.delete(domain); });
  if (certCache.size >= 8) certCache.delete(certCache.keys().next().value);
  certCache.set(domain, entry);
  return entry;
}

// The verified identity ({email, sub}) or null. Never throws.
export async function verifyAccessJwt(env, token, { fetchImpl = (...args) => fetch(...args), now = Date.now() } = {}) {
  if (!accessConfigured(env) || typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !payload || typeof payload !== 'object') return null;
    const domain = team(env);
    let cached = signingKeys(domain, fetchImpl, now);
    let key = (await cached.keys).get(header.kid);
    if (!key && now - cached.fetchedAt >= CERTS_REFRESH_MIN_MS) {
      certCache.delete(domain); // keys rotated since they were fetched
      cached = signingKeys(domain, fetchImpl, now);
      key = (await cached.keys).get(header.kid);
    }
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const seconds = now / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience(env)) || payload.iss !== `https://${domain}`) return null;
    if (!(Number(payload.exp) + SKEW_SECONDS > seconds)) return null;
    if (payload.nbf !== undefined && Number(payload.nbf) - SKEW_SECONDS > seconds) return null;
    return { email: typeof payload.email === 'string' ? payload.email : null, sub: typeof payload.sub === 'string' ? payload.sub : null };
  } catch {
    return null;
  }
}

// True when the request may reach an Access-protected operator surface: Access is not
// configured, or the request carries a valid Access JWT.
export async function passedAccess(c, options) {
  if (!accessConfigured(c.env)) return true;
  return Boolean(await verifyAccessJwt(c.env, c.req.header('Cf-Access-Jwt-Assertion'), options));
}

// Test hook.
export function resetAccessCache() {
  certCache.clear();
}
