// Weekly diff of OmniRoute's free-tier catalog (MIT, github.com/diegosouzapw/OmniRoute; the
// repository was checked on 2026-10-19, the catalog is a hand-curated TypeScript data file).
// The file is data, never code: entries are read with a line parser, nothing is evaluated.
import { candidateRow, evaluateOffer, providerId } from './policy.js';

export const OMNIROUTE_CATALOG_URL =
  'https://raw.githubusercontent.com/diegosouzapw/OmniRoute/main/open-sse/config/freeModelCatalog.data.ts';
export const OMNIROUTE_SOURCE_URL =
  'https://github.com/diegosouzapw/OmniRoute/blob/main/open-sse/config/freeModelCatalog.data.ts';
const MAX_BYTES = 2 * 1024 * 1024;
// Fewer entries than this means the file moved or changed shape (it had 489 on 2026-10-19).
export const MIN_ENTRIES = 100;

// OmniRoute provider ids that the provider database (and zerox_provider_candidates) names
// differently, taken from the 2026-10-19 merge (provider-db.json `omniroute.id`).
export const OMNIROUTE_PROVIDER_IDS = Object.freeze({
  alibaba: 'alibaba-intl', baidu: 'baidu-qianfan', byteplus: 'byteplus-modelark', 'cloudflare-ai': 'cloudflare-workers-ai',
  gemini: 'google-gemini', vertex: 'google-vertex', sparkdesk: 'iflytek', kilocode: 'kilo-gateway', modelscope: 'modelscope-cn',
  'naga-ai': 'nagaai', nlpcloud: 'nlp-cloud', 'openference-api': 'openference', siliconflow: 'siliconflow-intl',
  tencent: 'tencent-hunyuan', doubao: 'volcengine-ark', 'glm-cn': 'zhipu-bigmodel',
});

const FIELD = /(\w+):\s*("(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g;
const CURATED = /FREE_CATALOG_CURATED_AT\s*=\s*"(\d{4}-\d{2}-\d{2})"/;

function value(raw) {
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  return Number(raw);
}

// Entries of FREE_MODEL_BUDGETS: one `{ provider: "...", modelId: "...", ... },` per line.
export function parseOmnirouteCatalog(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('OmniRoute catalog is missing or too large');
  const start = text.indexOf('FREE_MODEL_BUDGETS');
  if (start < 0) throw new Error('OmniRoute catalog has no FREE_MODEL_BUDGETS');
  const entries = [];
  for (const line of text.slice(start).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('];')) break;
    if (!trimmed.startsWith('{ provider:')) continue;
    const fields = {};
    for (const [, name, raw] of trimmed.matchAll(FIELD)) if (!Object.hasOwn(fields, name)) fields[name] = value(raw);
    if (typeof fields.provider !== 'string' || typeof fields.modelId !== 'string') continue;
    entries.push(fields);
  }
  return { curatedAt: CURATED.exec(text)?.[1] ?? null, entries };
}

export const omnirouteProvider = id => OMNIROUTE_PROVIDER_IDS[id] || providerId(id);
const entryKey = entry => `${entry.provider}|${entry.modelId}`;

/**
 * Diff against the previous snapshot. The first run only records a baseline: the 2026-10-19
 * seed already holds this catalog. Later runs queue added free entries (capabilities unknown,
 * so the reviewer checks them) and report removed ones. `knownProviders` (ids already in
 * zerox_provider_candidates) decides which providers get a new provider record.
 */
export function omnirouteDiff(parsed, snapshot, knownProviders = new Set()) {
  const live = parsed.entries.filter(entry => entry.freeType !== 'discontinued');
  const keys = [...new Set(live.map(entryKey))].sort();
  const previous = Array.isArray(snapshot?.keys) ? new Set(snapshot.keys) : null;
  const next = { keys, curated_at: parsed.curatedAt };
  if (!previous) return { baseline: true, snapshot: next, added: [], removed: [], rows: [] };
  const current = new Set(keys);
  const added = live.filter(entry => !previous.has(entryKey(entry)));
  const removed = [...previous].filter(key => !current.has(key));
  const rows = [];
  const newProviders = new Set();
  for (const entry of added) {
    const provider = omnirouteProvider(entry.provider);
    if (!provider) continue;
    const terms = [`OmniRoute: ${entry.freeType}`, entry.tos && `ToS rating ${entry.tos}`,
      entry.eligibilityGate && `eligibility: ${entry.eligibilityGate}`, entry.trainsOnPrompts && 'trains on prompts']
      .filter(Boolean).join(', ');
    rows.push(candidateRow({ source: 'omniroute', provider, model: entry.modelId, displayName: entry.displayName,
      evidenceUrl: OMNIROUTE_SOURCE_URL, notes: terms,
      record: { omniroute: { provider: entry.provider, freeType: entry.freeType, monthlyTokens: entry.monthlyTokens,
        creditTokens: entry.creditTokens, poolKey: entry.poolKey, tos: entry.tos, hardStopGuaranteed: entry.hardStopGuaranteed,
        trainsOnPrompts: entry.trainsOnPrompts, eligibilityGate: entry.eligibilityGate, curated_at: parsed.curatedAt } } },
    evaluateOffer({ free: true }, { strict: false })));
    if (!knownProviders.has(provider)) newProviders.add(provider);
  }
  for (const provider of newProviders) {
    rows.push(candidateRow({ source: 'omniroute', provider, evidenceUrl: OMNIROUTE_SOURCE_URL,
      notes: 'New provider in OmniRoute\'s free-tier catalog; signing up stays manual.' }, { status: 'new', reason: null }));
  }
  return { baseline: false, snapshot: next, added: added.map(entryKey), removed, rows: rows.filter(Boolean) };
}
