// Model identity (docs/PLATFORM_CONTRACT.md section 14): who made a catalog model, its clean
// name, and the family id that names the model whatever route serves it.
//
// A catalog entry is a route: one upstream model behind one provider type ("groq/openai/gpt-oss-120b"
// is GPT-OSS 120B served by Groq). Several routes can serve the same model, so the public list
// groups them by family ("openai/gpt-oss-120b") and the router picks the best healthy route of a
// family (src/router.js). Identity is derived from the upstream id, so database rows get it too;
// FAMILY_OVERRIDES fixes the few ids the rules below cannot name well.

// Companies that make models: slug -> display name. The website and clients pick logos by slug.
export const MAKERS = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  meta: 'Meta',
  alibaba: 'Alibaba',
  nvidia: 'NVIDIA',
  stepfun: 'StepFun',
  cohere: 'Cohere',
  zhipu: 'Z.ai',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot AI',
  mistral: 'Mistral AI',
  xai: 'xAI',
  microsoft: 'Microsoft',
  ibm: 'IBM',
  poolside: 'Poolside',
  thinkingmachines: 'Thinking Machines',
  other: 'Other',
});

// Upstream organisation segment -> [maker, family prefix].
const ORGS = Object.freeze({
  openai: ['openai', 'openai'],
  anthropic: ['anthropic', 'anthropic'],
  google: ['google', 'google'],
  meta: ['meta', 'meta'],
  'meta-llama': ['meta', 'meta'],
  qwen: ['alibaba', 'qwen'],
  alibaba: ['alibaba', 'qwen'],
  nvidia: ['nvidia', 'nvidia'],
  'stepfun-ai': ['stepfun', 'stepfun'],
  stepfun: ['stepfun', 'stepfun'],
  cohere: ['cohere', 'cohere'],
  'z-ai': ['zhipu', 'zhipu'],
  'zai-org': ['zhipu', 'zhipu'],
  zai: ['zhipu', 'zhipu'],
  thudm: ['zhipu', 'zhipu'],
  zhipu: ['zhipu', 'zhipu'],
  minimax: ['minimax', 'minimax'],
  minimaxai: ['minimax', 'minimax'],
  'deepseek-ai': ['deepseek', 'deepseek'],
  deepseek: ['deepseek', 'deepseek'],
  moonshotai: ['moonshot', 'moonshot'],
  moonshot: ['moonshot', 'moonshot'],
  mistralai: ['mistral', 'mistral'],
  mistral: ['mistral', 'mistral'],
  'x-ai': ['xai', 'xai'],
  xai: ['xai', 'xai'],
  microsoft: ['microsoft', 'microsoft'],
  'ibm-granite': ['ibm', 'ibm'],
  ibm: ['ibm', 'ibm'],
  poolside: ['poolside', 'poolside'],
  thinkingmachines: ['thinkingmachines', 'thinkingmachines'],
});

// Upstream ids without an organisation segment ("gemini-2.5-flash", "glm-4.7-flash"): by name.
const NAME_RULES = Object.freeze([
  [/^(gemini|gemma)/, 'google'],
  [/^claude/, 'anthropic'],
  [/^glm/, 'zhipu'],
  [/^(gpt|o\d|codex)/, 'openai'],
  [/^llama/, 'meta'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^deepseek/, 'deepseek'],
  [/^kimi/, 'moonshot'],
  [/^(mistral|codestral|devstral|magistral|ministral)/, 'mistral'],
  [/^minimax/, 'minimax'],
  [/^nemotron/, 'nvidia'],
  [/^grok/, 'xai'],
  [/^(command|north)/, 'cohere'],
  [/^step/, 'stepfun'],
]);

const PREFIX_OF_MAKER = Object.freeze({ alibaba: 'qwen' });

// Normalized upstream id -> fixed identity parts. The family of a quantized or provider-specific
// variant is the model it serves, so routes of the same model share it.
const FAMILY_OVERRIDES = Object.freeze({
  'nvidia/nemotron-3-ultra-550b-a55b': { family: 'nvidia/nemotron-3-ultra-550b' },
  'meta/llama-3.3-70b-instruct-fp8-fast': { family: 'meta/llama-3.3-70b', name: 'Llama 3.3 70B' },
  'glm-4.7-flash': { name: 'GLM-4.7 Flash' },
  'glm-4.5-flash': { name: 'GLM-4.5 Flash' },
});

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// "@cf/openai/gpt-oss-120b" -> "openai/gpt-oss-120b"; "cohere/north-mini-code:free" -> "cohere/north-mini-code".
export function normalizeUpstream(upstream) {
  return String(upstream || '').trim().toLowerCase().replace(/^@cf\//, '').replace(/:[a-z0-9._-]+$/, '');
}

// "GPT-OSS 120B (Groq)" -> "GPT-OSS 120B"; "North Mini Code (OpenRouter, free)" -> "North Mini Code".
export function cleanModelName(name) {
  const text = String(name || '').trim();
  const cleaned = text.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s*[,:-]\s*free$/i, '').trim();
  return cleaned || text;
}

function makerByName(slug) {
  return NAME_RULES.find(([pattern]) => pattern.test(slug))?.[1] ?? null;
}

const cache = new WeakMap(); // entry -> identity

/**
 * { maker, maker_name, family, name } of a catalog entry (a route). Pure; cached per entry
 * object (entries are frozen and replaced, never mutated).
 */
export function modelIdentity(entry) {
  if (entry && typeof entry === 'object' && cache.has(entry)) return cache.get(entry);
  const upstream = normalizeUpstream(entry?.upstream_model);
  const parts = upstream.split('/').filter(Boolean);
  const slug = parts.at(-1) || upstream || String(entry?.id || '').toLowerCase();
  const org = parts.length > 1 ? parts[0] : null;
  let maker = null;
  let prefix = null;
  if (org && ORGS[org]) [maker, prefix] = ORGS[org];
  if (!maker) maker = makerByName(slug);
  if (!maker && org && SLUG.test(org)) prefix = org;
  if (!maker) maker = 'other';
  prefix ||= PREFIX_OF_MAKER[maker] || maker;
  const override = FAMILY_OVERRIDES[upstream] || {};
  const identity = Object.freeze({
    maker,
    maker_name: MAKERS[maker] || MAKERS.other,
    family: override.family || `${prefix}/${SLUG.test(slug) ? slug : 'model'}`,
    name: override.name || cleanModelName(entry?.display_name) || slug,
  });
  if (entry && typeof entry === 'object') cache.set(entry, identity);
  return identity;
}

export const familyOf = entry => modelIdentity(entry).family;
