// Weekly research agent (only with ANTHROPIC_API_KEY): one Claude Messages API call with the
// server-side web search tool asks what changed in free LLM API tiers this week, given what is
// already known, and returns records in the provider database shape (SCHEMA.json) with sources.
// Spending is capped per run (DISCOVERY_RESEARCH_MAX_USD). Its output is untrusted web-derived
// data: it only ever creates candidates for review, and nothing it returns is ever called.
import Anthropic from '@anthropic-ai/sdk';
import { bool, candidateRow, evaluateOffer, exclusionReason, httpsUrl, positiveInt, providerId } from './policy.js';

export const RESEARCH_MODEL = 'claude-haiku-5-5';
// Claude Haiku 5.5 list prices in $ per million tokens (2026-10): prompts up to 100K tokens,
// and the rate card for longer prompts. Web search is $10 per 1,000 searches.
export const RESEARCH_PRICE = Object.freeze({ input: 0.10, output: 0.50, longInput: 0.50, longOutput: 2.50, longAbove: 100000 });
export const SEARCH_USD = 0.01;
// Worst case assumed per search: its results add this many input tokens, read again by the
// steps after it. The cap is checked against the real usage after the call.
const SEARCH_TOKENS = 25000;
const MAX_TOKENS = 8000;
const MAX_SEARCHES = 10;
export const DEFAULT_CAP_USD = 0.25;
const MAX_CAP_USD = 2;
const MAX_RECORDS = 40;
const MAX_MODELS_PER_RECORD = 30;

const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function researchCap(env) {
  const value = Number(env?.DISCOVERY_RESEARCH_MAX_USD);
  return clamp(Number.isFinite(value) && value > 0 ? value : DEFAULT_CAP_USD, 0.02, MAX_CAP_USD);
}

/**
 * Searches this run may use: what fits in the cap after the prompt and a full answer at the
 * long-prompt rate, never more than the previous run allows (`snapshot.max_searches` halves
 * after a run that cost more than the cap). 0 = the cap is too small to search at all.
 */
export function researchBudget(env, promptChars, snapshot = null) {
  const cap = researchCap(env);
  const fixed = (Math.ceil(promptChars / 3) * RESEARCH_PRICE.longInput + MAX_TOKENS * RESEARCH_PRICE.longOutput) / 1e6;
  const perSearch = SEARCH_USD + SEARCH_TOKENS * RESEARCH_PRICE.longInput / 1e6;
  let searches = clamp(Math.floor((cap - fixed) / perSearch), 0, MAX_SEARCHES);
  if (Number.isInteger(snapshot?.max_searches)) searches = Math.min(searches, snapshot.max_searches);
  return { capUsd: cap, maxSearches: searches, maxTokens: MAX_TOKENS };
}

// List-price cost of one response, in micro-dollars.
export function researchCostMicrousd(usage = {}) {
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const long = input > RESEARCH_PRICE.longAbove;
  const tokens = input * (long ? RESEARCH_PRICE.longInput : RESEARCH_PRICE.input) +
    (usage.output_tokens || 0) * (long ? RESEARCH_PRICE.longOutput : RESEARCH_PRICE.output);
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return Math.ceil(tokens + searches * SEARCH_USD * 1e6);
}

const SYSTEM = `You research free LLM API tiers for Zero-X, an API gateway behind a coding agent. Use web search to find what changed in the last seven days: new free models or providers, free tiers that changed limits, ended, or became paid. Report only facts from pages you actually read, with their URLs; use null for anything you could not verify and never invent numbers. A model is only useful when it supports tool calling, ideally with a context window of 64K tokens or more.

Never suggest or describe ways around access controls. If access needs CAPTCHA solving, scraping a consumer chat website, a spoofed or impersonated client, or reusing another product's login, still report it but set access_method to captcha, web_session, spoofed_client or other_product_login.

Answer with one JSON object and nothing else.`;

const SCHEMA = `{
  "records": [{
    "id": "kebab-case provider id; reuse the id from the known list when it is the same provider",
    "name": "provider name",
    "change": "one line: what changed this week",
    "kind": "official_free_tier | trial_credit | keyless | aggregator_free_models | other",
    "free_status": "active | trial_only | paid_only_now | retired | unclear",
    "free_status_note": "one line: what exactly is free today",
    "base_url": "OpenAI-style base URL or null",
    "api_shape": ["openai" | "anthropic" | "gemini" | "custom"],
    "auth": "e.g. 'Authorization: Bearer <key>' or 'none (keyless)'",
    "access_method": "api_key | keyless | oauth_own | captcha | web_session | spoofed_client | other_product_login",
    "signup": {"card_required": null, "phone_required": null, "kyc": null, "india_available": null, "region_notes": null},
    "free_models": [{"id": "exact API model id", "context_window": null, "max_output": null, "tool_calling": null, "notes": null}],
    "limits": {"rpm": null, "rpd": null, "tpm": null, "tpd": null, "concurrency": null, "other": null, "scope": null},
    "terms": "one short line",
    "data_training_free_tier": "one phrase",
    "sources": ["https URLs you read"],
    "verified_date": "YYYY-MM-DD"
  }],
  "removed": [{"provider": "id", "model_id": "id or null", "reason": "one line", "sources": ["https URLs"]}]
}`;

export function researchPrompt(known, today) {
  const lines = known.map(row => `${row.provider} [${row.status ?? 'models only'}]${row.models?.length ? `: ${row.models.join(', ')}` : ''}`);
  return `Today is ${today}. These providers and free models are already known (provider [our status]: live candidate model ids):

${lines.join('\n')}

What changed in free LLM API tiers this week? Report only providers or models that are new, changed or gone compared with the list above (at most ${MAX_RECORDS} records). Return this JSON shape:

${SCHEMA}`;
}

// The last JSON object in the answer (fenced or bare).
export function parseResearchAnswer(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]);
  const candidates = fenced.length ? fenced.reverse() : [String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.records)) return parsed;
    } catch { /* try the next block */ }
  }
  throw new Error('research answer has no JSON object with records');
}

function researchRecord(record, today) {
  return JSON.parse(JSON.stringify({
    id: record.id, name: clip(record.name, 120), change: clip(record.change, 300), kind: clip(record.kind, 40),
    free_status: clip(record.free_status, 40), free_status_note: clip(record.free_status_note, 400),
    base_url: httpsUrl(record.base_url) || undefined, api_shape: Array.isArray(record.api_shape) ? record.api_shape.slice(0, 4) : undefined,
    auth: clip(record.auth, 200), access_method: clip(record.access_method, 40),
    signup: record.signup && typeof record.signup === 'object' ? {
      card_required: bool(record.signup.card_required), phone_required: bool(record.signup.phone_required),
      kyc: clip(record.signup.kyc, 160), india_available: bool(record.signup.india_available),
      region_notes: clip(record.signup.region_notes, 300) } : undefined,
    limits: record.limits && typeof record.limits === 'object' ? {
      rpm: positiveInt(record.limits.rpm), rpd: positiveInt(record.limits.rpd), tpm: positiveInt(record.limits.tpm),
      tpd: positiveInt(record.limits.tpd), concurrency: positiveInt(record.limits.concurrency),
      other: clip(record.limits.other, 300), scope: clip(record.limits.scope, 40) } : undefined,
    terms: clip(record.terms, 300), data_training_free_tier: clip(record.data_training_free_tier, 160),
    sources: record.sources, verified_date: clip(record.verified_date, 10), researched: today,
  }, (key, item) => (item === null ? undefined : item)));
}

/**
 * Candidate rows from the agent's answer. Records without an https source are dropped. Models
 * of an excluded provider are excluded; unknown capabilities are queued for the reviewer.
 */
export function researchRows(answer, today) {
  const rows = [];
  let dropped = 0;
  for (const record of (answer.records || []).slice(0, MAX_RECORDS)) {
    const provider = providerId(record?.id);
    const sources = (Array.isArray(record?.sources) ? record.sources : []).map(httpsUrl).filter(Boolean).slice(0, 8);
    if (!provider || !sources.length) { dropped++; continue; }
    const exclusion = exclusionReason(record);
    const stored = researchRecord({ ...record, sources }, today);
    rows.push(candidateRow({ source: 'research', provider, displayName: record.name, evidenceUrl: sources[0],
      notes: clip(record.change, 300) || clip(record.free_status_note, 300), record: stored },
    exclusion ? { status: 'excluded', reason: exclusion } : { status: 'new', reason: null }));
    const free = !['paid_only_now', 'retired'].includes(record.free_status);
    for (const model of (Array.isArray(record.free_models) ? record.free_models : []).slice(0, MAX_MODELS_PER_RECORD)) {
      const context = positiveInt(model?.context_window);
      const tools = bool(model?.tool_calling);
      rows.push(candidateRow({ source: 'research', provider, model: model?.id, context, maxOutput: model?.max_output, tools,
        evidenceUrl: sources[0], notes: clip(model?.notes, 300), record: { research: today } },
      exclusion ? { status: 'excluded', reason: exclusion } : evaluateOffer({ free, tools, context }, { strict: false })));
    }
  }
  const removed = (Array.isArray(answer.removed) ? answer.removed : []).slice(0, 50).map(item => ({
    provider: providerId(item?.provider), model_id: clip(item?.model_id, 256) ?? null, reason: clip(item?.reason, 300) ?? null,
    sources: (Array.isArray(item?.sources) ? item.sources : []).map(httpsUrl).filter(Boolean).slice(0, 3),
  })).filter(item => item.provider && item.sources.length);
  return { rows: rows.filter(Boolean), removed, dropped };
}

/**
 * Runs one research call. Returns { rows, removed, dropped, spentMicrousd, searches, nextSnapshot }
 * or throws (with `spentMicrousd` on the error when the call itself was billed).
 */
export async function runResearch(env, known, { today, snapshot = null } = {}) {
  const prompt = researchPrompt(known, today);
  const budget = researchBudget(env, SYSTEM.length + prompt.length, snapshot);
  if (!budget.maxSearches) throw new Error(`DISCOVERY_RESEARCH_MAX_USD (${budget.capUsd}) is too small for one search`);
  // No SDK retries: a retried timeout could bill twice. The job itself retries the next day.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 300_000,
    fetch: (...args) => fetch(...args) });
  const response = await client.messages.create({
    model: RESEARCH_MODEL,
    max_tokens: budget.maxTokens,
    output_config: { effort: 'low' },
    system: SYSTEM,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: budget.maxSearches }],
    messages: [{ role: 'user', content: prompt }],
  });
  const spentMicrousd = researchCostMicrousd(response.usage);
  const searches = response.usage?.server_tool_use?.web_search_requests || 0;
  // Halve the searches after a run over the cap; recover gradually after cheap runs.
  const over = spentMicrousd > budget.capUsd * 1e6;
  const nextSnapshot = { max_searches: over ? Math.max(1, Math.floor(budget.maxSearches / 2))
    : Math.min(MAX_SEARCHES, budget.maxSearches + 1), last_spent_microusd: spentMicrousd };
  const fail = message => Object.assign(new Error(message), { spentMicrousd, nextSnapshot });
  // A paused turn is not resumed: resuming would spend past the cap.
  if (response.stop_reason === 'refusal') throw fail('research call was refused');
  if (response.stop_reason === 'pause_turn') throw fail('research call paused before answering (not resumed, to keep the cap)');
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
  let answer;
  try { answer = parseResearchAnswer(text); } catch (error) { throw fail(error.message); }
  return { ...researchRows(answer, today), spentMicrousd, searches, overBudget: over, capUsd: budget.capUsd, nextSnapshot };
}
