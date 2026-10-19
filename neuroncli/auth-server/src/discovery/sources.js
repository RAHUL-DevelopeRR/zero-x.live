// Public, no-key model lists the daily discovery job diffs (src/discovery/jobs.js). Each parser
// turns a provider's own list into { id, name, chat, free, tools, context, maxOutput, vision }:
// null means the list does not say. OpenCode Zen, AIHubMix and NVIDIA publish bare ids, so
// their capabilities come from models.dev (the open catalog behind OpenCode), when it lists them.
import { modelId, positiveInt } from './policy.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

const array = value => (Array.isArray(value) ? value : null);
const zero = value => value !== null && value !== undefined && value !== '' && Number(value) === 0;
const includes = (list, value) => (Array.isArray(list) ? list.includes(value) : null);

function rows(body, key = 'data') {
  const list = array(body?.[key]) ?? array(body);
  if (!list) throw new Error('unexpected list format');
  return list.filter(item => item && typeof item === 'object' && modelId(item.id));
}

// OpenRouter shape (also Kilo Gateway, which mirrors it).
function openRouterItem(item, free) {
  const output = item.architecture?.output_modalities;
  return {
    id: item.id.trim(), name: typeof item.name === 'string' ? item.name : null,
    chat: Array.isArray(output) ? output.includes('text') : true,
    free,
    tools: includes(item.supported_parameters, 'tools'),
    context: positiveInt(item.context_length) ?? positiveInt(item.top_provider?.context_length),
    maxOutput: positiveInt(item.top_provider?.max_completion_tokens),
    vision: includes(item.architecture?.input_modalities, 'image'),
  };
}

export function parseOpenRouter(body) {
  return rows(body).map(item => openRouterItem(item, item.id.trim().endsWith(':free')));
}

export function parseKilo(body) {
  return rows(body).map(item => openRouterItem(item, typeof item.isFree === 'boolean'
    ? item.isFree : zero(item.pricing?.prompt) && zero(item.pricing?.completion)));
}

export function parseVercel(body) {
  return rows(body).map(item => {
    const tags = array(item.tags);
    return {
      id: item.id.trim(), name: typeof item.name === 'string' ? item.name : null,
      chat: item.type === undefined || item.type === 'language',
      free: Boolean(tags?.includes('free')) || (zero(item.pricing?.input) && zero(item.pricing?.output)),
      tools: tags ? tags.includes('tool-use') : null,
      context: positiveInt(item.context_window),
      maxOutput: positiveInt(item.max_tokens),
      vision: tags?.includes('vision') || includes(item.modalities?.input, 'image'),
    };
  });
}

export function parseRequesty(body) {
  return rows(body).map(item => ({
    id: item.id.trim(), name: null,
    chat: item.api === undefined || item.api === 'chat',
    free: zero(item.input_price) && zero(item.output_price),
    tools: typeof item.supports_tool_calling === 'boolean' ? item.supports_tool_calling : null,
    context: positiveInt(item.context_window),
    maxOutput: positiveInt(item.max_output_tokens),
    vision: typeof item.supports_vision === 'boolean' ? item.supports_vision : null,
  }));
}

// LLM7's free tier serves the 'turbo' models (the 'pro' tier is paid).
export function parseLlm7(body) {
  return rows(body).map(item => ({
    id: item.id.trim(), name: null,
    chat: item.model_type === undefined || item.model_type === 'chat',
    free: item.tier === 'turbo',
    tools: typeof item.capabilities?.tools === 'boolean' ? item.capabilities.tools
      : typeof item.tools_calling === 'boolean' ? item.tools_calling : null,
    context: positiveInt(item.context_window?.tokens ?? item.context_window),
    maxOutput: null,
    vision: typeof item.capabilities?.vision === 'boolean' ? item.capabilities.vision : null,
  }));
}

// Bare id lists, completed from models.dev's entry for the same provider and id.
function bareList(isFree) {
  return (body, modelsDev) => rows(body).map(item => {
    const id = item.id.trim();
    const known = modelsDev?.models?.[id];
    const output = known?.modalities?.output;
    return {
      id, name: typeof known?.name === 'string' ? known.name : null,
      chat: Array.isArray(output) ? output.includes('text') : true,
      free: isFree(id, known),
      tools: typeof known?.tool_call === 'boolean' ? known.tool_call : null,
      context: positiveInt(known?.limit?.context),
      maxOutput: positiveInt(known?.limit?.output),
      vision: includes(known?.modalities?.input, 'image'),
      deprecated: known?.status === 'deprecated',
    };
  });
}

export const parseOpenCodeZen = bareList((id, known) =>
  id.endsWith('-free') || (zero(known?.cost?.input) && zero(known?.cost?.output)));
export const parseAihubmix = bareList(id => id.endsWith('-free'));
// NVIDIA's API Catalog is a trial: every model it lists is free to call while the key's
// credits last (docs/PROVIDER_TERMS.md).
export const parseNvidia = bareList(() => true);

/**
 * The daily sources. `provider` is the provider id in zerox_provider_candidates; `catalog`
 * names the src/catalog.js provider whose entries this list speaks for (a listed id that
 * disappears marks those entries in HealthHub); `modelsDev` the models.dev provider key used to
 * complete bare lists; `page(id)` the evidence link for one model.
 */
export const LIST_SOURCES = Object.freeze([
  { job: 'list:openrouter', provider: 'openrouter', catalog: 'openrouter', url: 'https://openrouter.ai/api/v1/models',
    parse: parseOpenRouter, page: id => `https://openrouter.ai/${id}` },
  { job: 'list:kilo', provider: 'kilo-gateway', url: 'https://ai-gateway.kilo.ai/api/v1/models', parse: parseKilo },
  { job: 'list:opencode-zen', provider: 'opencode-zen', url: 'https://opencode.ai/zen/v1/models',
    parse: parseOpenCodeZen, modelsDev: 'opencode' },
  { job: 'list:vercel', provider: 'vercel-ai-gateway', url: 'https://ai-gateway.vercel.sh/v1/models', parse: parseVercel },
  { job: 'list:requesty', provider: 'requesty', url: 'https://router.requesty.ai/v1/models', parse: parseRequesty },
  { job: 'list:aihubmix', provider: 'aihubmix', url: 'https://aihubmix.com/v1/models', parse: parseAihubmix,
    modelsDev: 'aihubmix' },
  { job: 'list:nvidia', provider: 'nvidia', catalog: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/models',
    parse: parseNvidia, modelsDev: 'nvidia' },
  { job: 'list:llm7', provider: 'llm7', url: 'https://api.llm7.io/v1/models', parse: parseLlm7 },
].map(source => Object.freeze(source)));
