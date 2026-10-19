// Candidate policy for the discovery pipeline (src/discovery/jobs.js). Pure functions shared by
// the cron jobs, the research agent and the seed generator (scripts/discovery-seed.mjs).
//
// Nothing here enables anything: a candidate is only ever queued ('new'), filtered out
// ('rejected' with no reviewer) or excluded. Approval, verification and promotion are operator
// actions (src/routes/discovery.js).

// A coding agent needs room for its system prompt, tools and a working conversation.
export const MIN_CONTEXT = 65536;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Exact API model ids: printable, no whitespace, at most 256 characters.
const MODEL_PATTERN = /^[\x21-\x7e]{1,256}$/;

export function providerId(value) {
  const id = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return ID_PATTERN.test(id) ? id : null;
}

export function modelId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return MODEL_PATTERN.test(id) ? id : null;
}

export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 2 ** 31 - 1 ? number : null;
}

export const bool = value => (value === true || value === false ? value : null);

// ── Exclusion filter ──
// Access that depends on CAPTCHA solving, scraping a consumer chat website, spoofing a client
// or reusing another product's login is never offered. Matching is on purpose broad: a false
// positive only hides a candidate, a false negative could put one in front of a reviewer.

// Consumer chat front ends (not APIs).
const CONSUMER_CHAT_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'bard.google.com', 'claude.ai', 'copilot.microsoft.com',
  'duckduckgo.com', 'duck.ai', 'huggingface.co/chat', 'chat.deepseek.com', 'kimi.moonshot.cn', 'kimi.com',
  'yuanbao.tencent.com', 'chat.qwen.ai', 'tongyi.aliyun.com', 'chat.z.ai', 'chatglm.cn', 'lmarena.ai',
  't3.chat', 'poe.com', 'perplexity.ai', 'chat.mistral.ai', 'meta.ai', 'grok.com', 'you.com', 'doubao.com',
];
// Methods the research agent may report (see research.js); the first group is never offered.
export const EXCLUDED_ACCESS = Object.freeze({
  captcha: 'Access needs CAPTCHA solving.',
  web_session: 'Access scrapes a consumer chat website session.',
  spoofed_client: 'Access needs a spoofed client.',
  other_product_login: "Access reuses another product's login.",
});

// Phrases that negate a match ("no CAPTCHA required") are removed before matching.
const NEGATION = /\b(?:no|not|never|without|doesn't|does not|isn't|is not)\s+(?:need(?:s|ed)?\s+|require[sd]?\s+|use[sd]?\s+|involve[sd]?\s+|an?\s+|any\s+)*(?:captcha|cookies?|spoof\w*|scrap\w*)\b/gi;
const RULES = [
  [/\bcaptcha\b|proof[- ]of[- ]work|request signer/i, EXCLUDED_ACCESS.captcha],
  [/\bexport(?:ed|ing)?\s+(?:all\s+|the\s+|your\s+)?cookies?\b|\bcookie[- ](?:auth|session|scrap\w*|replay\w*)|\bsession[- ]scrap\w*|\bscrap\w*\s+(?:the\s+|a\s+)?(?:consumer\s+)?(?:web\s*)?(?:chat|site|website|ui|frontend|session)|consumer\s+(?:web[- ])?chat|web[- ]?chat\s+session|headless\s+browser|reverse[- ]engineered\s+(?:\w+\s+){0,3}(?:protocol|playground|web)/i,
    EXCLUDED_ACCESS.web_session],
  [/\bspoof\w*|\bimpersonat\w*|fake\s+(?:client|user[- ]agent|browser)|client\s+fingerprint|rejects\s+non[- ]browser|emulat\w*\s+(?:the\s+)?(?:site|client|browser|official)/i,
    EXCLUDED_ACCESS.spoofed_client],
  [/\breus\w*\s+(?:the\s+|an?\s+)?[\w./-]+(?:\s+[\w./-]+){0,2}\s+(?:product\s+|cli\s+|ide\s+|app\s+)?(?:login|credential|oauth|subscription|session)|\breplay\w*\s+(?:\w+\s+){0,4}(?:login|oauth|cli)\s+tokens?|\b(?:oauth|login)\s+tokens?\s+(?:of|from)\s+(?:another|a different|an?\s+\w+\s+(?:cli|ide|app))|official[- ]client[- ]only/i,
    EXCLUDED_ACCESS.other_product_login],
];

// The consumer front end itself (or www.), never an API subdomain such as api.meta.ai.
function consumerChatHost(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.toLowerCase();
  return CONSUMER_CHAT_HOSTS.find(item => {
    const [itemHost, ...rest] = item.split('/');
    const itemPath = rest.length ? `/${rest.join('/')}` : '';
    return host === itemHost && (!itemPath || path === itemPath || path.startsWith(`${itemPath}/`));
  }) ?? null;
}

function textOf(value, depth = 0) {
  if (value === null || value === undefined || depth > 3) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  return Object.values(value).map(item => textOf(item, depth + 1)).join(' \n ');
}

/**
 * Why a provider record (SCHEMA.json shape, or a list/catalog row) must never be offered, or
 * null. Reads the explicit fields first, then the free text of auth, signup and notes.
 */
export function exclusionReason(record = {}) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.excluded_reason === 'string' && record.excluded_reason.trim()) return record.excluded_reason.trim().slice(0, 500);
  if (record.free_status === 'excluded_evasion') return 'Listed as access evasion in the provider database.';
  if (Object.hasOwn(EXCLUDED_ACCESS, record.access_method)) return EXCLUDED_ACCESS[record.access_method];
  if (/^\s*cookie\b/i.test(String(record.auth ?? ''))) return EXCLUDED_ACCESS.web_session;
  for (const url of [record.base_url, record.chat_url, ...(Array.isArray(record.base_urls) ? record.base_urls : [])]) {
    const host = consumerChatHost(url);
    if (host) return `${EXCLUDED_ACCESS.web_session} (${host})`;
  }
  const text = [record.auth, record.signup, record.access_notes, record.notes, record.free_status_note,
    record.free_models_note, record.reliability_notes].map(item => textOf(item)).join(' \n ').replace(NEGATION, ' ');
  for (const [pattern, reason] of RULES) if (pattern.test(text)) return reason;
  return null;
}

// ── Candidate policy ──

/**
 * Status for one model offer: { status: 'new' | 'rejected' | 'excluded', reason }.
 *  - lists (daily job) publish metadata, so unknown tools or context fail ('strict');
 *  - OmniRoute and the research agent report claims without metadata, so unknown passes and
 *    the reviewer sees "capabilities unknown"; anything known to fail is filtered.
 * 'rejected' here is a policy filter (no reviewer): newer evidence can lift it back to 'new'.
 */
export function evaluateOffer({ free = true, tools = null, context = null, exclusion = null } = {}, { strict = true } = {}) {
  if (exclusion) return { status: 'excluded', reason: exclusion };
  if (free === false) return { status: 'rejected', reason: 'not free' };
  if (tools === false) return { status: 'rejected', reason: 'no tool calling' };
  if (context !== null && context < MIN_CONTEXT) return { status: 'rejected', reason: `context ${context} < ${MIN_CONTEXT}` };
  if (strict && tools !== true) return { status: 'rejected', reason: 'tool calling not published' };
  if (strict && context === null) return { status: 'rejected', reason: 'context window not published' };
  const unknown = [tools === null && 'tool calling', context === null && 'context window'].filter(Boolean);
  return { status: 'new', reason: unknown.length ? `${unknown.join(' and ')} unknown: check before approving` : null };
}

const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * One row for zerox_candidates_upsert. `offer` holds the normalized model facts; `policy`
 * comes from evaluateOffer. Invalid ids return null (the row is dropped).
 */
export function candidateRow({ source, provider, model = '', displayName = null, context = null, maxOutput = null,
  tools = null, vision = null, evidenceUrl = null, notes = null, record = {} }, policy) {
  const providerKey = providerId(provider);
  const model_id = model === '' ? '' : modelId(model);
  if (!providerKey || model_id === null || !/^[a-z0-9][a-z0-9:._-]{0,63}$/.test(source)) return null;
  const reasons = [policy.reason, notes].filter(Boolean).join('; ');
  return {
    source, provider: providerKey, model_id,
    display_name: clip(displayName, 200),
    context_window: positiveInt(context), max_output_tokens: positiveInt(maxOutput),
    supports_tools: bool(tools), supports_vision: bool(vision),
    evidence_url: httpsUrl(evidenceUrl),
    status: policy.status,
    excluded_reason: policy.status === 'excluded' ? clip(policy.reason, 500) : null,
    notes: clip(reasons, 4000),
    record: record && typeof record === 'object' && !Array.isArray(record) ? record : {},
  };
}
