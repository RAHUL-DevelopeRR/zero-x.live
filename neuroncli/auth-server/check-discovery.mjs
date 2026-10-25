// Provider discovery (src/discovery/, migration 20261019120000), offline: PGlite for the
// database and fake upstreams for every list, models.dev, OmniRoute, the Claude Messages API,
// the verification stream and HealthHub. Any other outbound request fails the run.
//   node check-discovery.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rpc, rpcRows } from './src/account-store.js';
import { closeAllPglite, getPgliteHandle } from './src/db/pglite.js';
import { CATALOG, listModelsForCaller, loadCatalog, offeredEntries, resolveModelId } from './src/catalog.js';
import { catalogSnapshot } from './src/catalog-db.js';
import { RoutingEngine } from './src/router.js';
import { HealthHub } from './src/health-hub.js';
import { ProviderHealthTracker } from './src/provider-health.js';
import { resetHubClientCache } from './src/health-hub-client.js';
import { candidateRow, evaluateOffer, exclusionReason, MIN_CONTEXT } from './src/discovery/policy.js';
import { LIST_SOURCES, MODELS_DEV_URL, parseKilo, parseLlm7, parseNvidia, parseOpenRouter, parseRequesty, parseVercel } from './src/discovery/sources.js';
import { OMNIROUTE_CATALOG_URL, omnirouteDiff, parseOmnirouteCatalog } from './src/discovery/omniroute.js';
import { parseResearchAnswer, researchBudget, researchCostMicrousd, researchRows, RESEARCH_MODEL } from './src/discovery/research.js';
import { verificationTarget, verifyCandidate } from './src/discovery/verify.js';
import { REVIEW_PAGE } from './src/discovery/review-page.js';
import { DAY, discoveryJobs, researchEnabled, runDiscoveryTick, WEEK } from './src/discovery/jobs.js';
import { anthropicFetch } from './src/anthropic-transport.js';
import app from './src/index.js';

const passed = [];
function ok(name) { passed.push(name); console.log(`ok - ${name}`); }
const DB = { DATABASE_DRIVER: 'pglite' };
const ADMIN = 'discovery-admin-token-0123456789abcdef';
const sql = async (text, params) => (await (await getPgliteHandle(DB)).db.query(text, params)).rows;
const candidate = async (provider, model = '') => (await sql(
  'SELECT * FROM public.zerox_provider_candidates WHERE provider = $1 AND model_id = $2', [provider, model]))[0];
const job = async name => (await sql('SELECT *, extract(epoch FROM next_run_at - now()) AS due_in FROM public.zerox_discovery_state WHERE job = $1', [name]))[0];
const makeDue = name => sql("UPDATE public.zerox_discovery_state SET next_run_at = now() - interval '1 second' WHERE job = $1", [name]);

// ── Fake upstreams ──
const calls = [];
const upstream = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  calls.push({ url, init });
  for (const [prefix, handler] of upstream) if (url.startsWith(prefix)) return handler(url, init);
  throw new Error(`Unexpected outbound request: ${url}`);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const callsTo = prefix => calls.filter(call => call.url.startsWith(prefix));

const or = (id, { tools = true, context = 131072, input = ['text'] } = {}) => ({ id, name: id, context_length: context,
  architecture: { input_modalities: input, output_modalities: ['text'] },
  supported_parameters: tools ? ['max_tokens', 'tools'] : ['max_tokens'], top_provider: { max_completion_tokens: 16384 } });
const LISTS = {
  'https://openrouter.ai/api/v1/models': () => json({ data: [
    or('cohere/north-mini-code:free', { context: 256000 }), or('acme/coder-pro:free', { input: ['text', 'image'] }),
    or('acme/tiny:free', { context: 32768 }), or('acme/notools:free', { tools: false, context: 200000 }), or('acme/paid'),
  ] }),
  'https://ai-gateway.kilo.ai/api/v1/models': () => json({ data: [
    { ...or('kilo-auto/free', { context: 256000 }), isFree: true }, { ...or('zeta/new:free'), isFree: true },
    { ...or('zeta/paid'), isFree: false },
  ] }),
  'https://opencode.ai/zen/v1/models': () => json({ object: 'list', data: [{ id: 'big-pickle' }, { id: 'fresh-free' }, { id: 'paid-model' }] }),
  'https://ai-gateway.vercel.sh/v1/models': () => json({ data: [
    { id: 'newco/model-free', type: 'language', context_window: 262144, tags: ['free', 'tool-use'], pricing: { input: '0', output: '0' } },
    { id: 'newco/embed', type: 'embedding', context_window: 8192, tags: ['free'], pricing: { input: '0', output: '0' } },
    { id: 'newco/paid', type: 'language', context_window: 262144, tags: ['tool-use'], pricing: { input: '1', output: '2' } },
  ] }),
  'https://router.requesty.ai/v1/models': () => json({ data: [
    { api: 'chat', id: 'novita/ling-9', input_price: 0, output_price: 0, context_window: 131072, supports_tool_calling: true, supports_vision: false },
    { api: 'chat', id: 'novita/paid', input_price: 1e-7, output_price: 2e-7, context_window: 131072, supports_tool_calling: true },
  ] }),
  'https://aihubmix.com/v1/models': () => json({ data: [{ id: 'brand-new-free' }, { id: 'unknown-free' }, { id: 'paid-thing' }] }),
  'https://integrate.api.nvidia.com/v1/models': () => json({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'nvidia/nemotron-3-ultra-550b-a55b' },
    { id: 'stepfun-ai/step-5-preview' }, { id: 'newlab/agent-70b' }, { id: 'newlab/embed' }] }),
  'https://api.llm7.io/v1/models': () => json({ data: [
    { id: 'GLM-9-Flash', model_type: 'chat', tier: 'turbo', context_window: { tokens: 400000 }, capabilities: { tools: true, vision: false } },
    { id: 'GLM-9', model_type: 'chat', tier: 'pro', context_window: { tokens: 400000 }, capabilities: { tools: true } },
  ] }),
};
const MODELS_DEV = {
  opencode: { models: { 'fresh-free': { tool_call: true, limit: { context: 200000, output: 32000 }, cost: { input: 0, output: 0 },
    modalities: { input: ['text'], output: ['text'] } }, 'paid-model': { tool_call: true, limit: { context: 200000 }, cost: { input: 1, output: 2 } } } },
  aihubmix: { models: { 'brand-new-free': { name: 'Brand New', tool_call: true, limit: { context: 1000000, output: 65536 } } } },
  nvidia: { models: { 'newlab/agent-70b': { tool_call: true, limit: { context: 131072, output: 8192 }, modalities: { output: ['text'] } },
    'newlab/embed': { tool_call: false, limit: { context: 8192 }, modalities: { output: ['embedding'] } } } },
};
const omnirouteLines = extra => [
  '// fixture', 'export const FREE_CATALOG_CURATED_AT = "2026-10-10";', 'export const FREE_MODEL_BUDGETS: FreeModelBudget[] = [',
  ...Array.from({ length: 120 }, (_, index) => `  { provider: "groq", modelId: "fixture-${index}", displayName: "Fixture ${index}", monthlyTokens: 0, creditTokens: 0, freeType: "recurring-daily", poolKey: null, tos: "ok" },`),
  '  { provider: "gone-provider", modelId: "old", displayName: "Old", monthlyTokens: 0, creditTokens: 0, freeType: "discontinued", poolKey: null, tos: "ok" },',
  ...extra, '];', '',
].join('\n');
let omniroute = omnirouteLines([]);
for (const [url, handler] of Object.entries(LISTS)) upstream.set(url, handler);
upstream.set(MODELS_DEV_URL, () => json(MODELS_DEV));
upstream.set(OMNIROUTE_CATALOG_URL, () => new Response(omniroute, { status: 200, headers: { 'content-type': 'text/plain' } }));

// HealthHub stand-in: records /mark calls.
const hubMarks = [];
const HEALTH_HUB = { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
  if (String(url).endsWith('/mark')) { hubMarks.push(JSON.parse(init.body)); return json({ ok: true }); }
  return json({ pools: {} });
} }) };

try {
  // ──────────────────────────────────────────── policy
  assert.equal(exclusionReason({ auth: 'cookie' }), 'Access scrapes a consumer chat website session.');
  assert.match(exclusionReason({ notes: 'Needs a CAPTCHA per request.' }), /CAPTCHA/);
  assert.equal(exclusionReason({ notes: 'No CAPTCHA required, plain API keys.' }), null, 'negated phrases do not exclude');
  assert.match(exclusionReason({ notes: 'Reuses the Kiro product login in a third-party client.' }), /another product's login/);
  assert.match(exclusionReason({ notes: 'Needs a spoofed Claude Code client fingerprint.' }), /spoofed client/);
  assert.match(exclusionReason({ base_url: 'https://chatgpt.com/backend-api' }), /consumer chat/);
  assert.equal(exclusionReason({ base_url: 'https://api.meta.ai/v1' }), null, 'API subdomains of consumer brands are fine');
  assert.match(exclusionReason({ access_method: 'other_product_login' }), /another product's login/);
  assert.equal(exclusionReason({ auth: 'Authorization: Bearer <key>', notes: 'Sign in with Google OAuth.' }), null);
  assert.deepEqual(evaluateOffer({ tools: true, context: MIN_CONTEXT }), { status: 'new', reason: null });
  assert.equal(evaluateOffer({ tools: true, context: MIN_CONTEXT - 1 }).status, 'rejected');
  assert.equal(evaluateOffer({ tools: null, context: 200000 }).status, 'rejected', 'lists must publish tool support');
  assert.equal(evaluateOffer({ tools: null, context: null }, { strict: false }).status, 'new', 'claims without metadata are queued');
  assert.equal(evaluateOffer({ tools: false }, { strict: false }).status, 'rejected');
  assert.equal(evaluateOffer({ free: false, tools: true, context: 200000 }).status, 'rejected');
  assert.equal(evaluateOffer({ exclusion: 'x', tools: true, context: 200000 }).status, 'excluded');
  assert.equal(candidateRow({ source: 'list:x', provider: 'Bad Provider!!', model: 'm' }, { status: 'new' }).provider, 'bad-provider');
  assert.equal(candidateRow({ source: 'list:x', provider: 'p', model: 'has space' }, { status: 'new' }), null);
  assert.equal(candidateRow({ source: 'list:x', provider: 'p', model: 'm', evidenceUrl: 'http://insecure' }, { status: 'new' }).evidence_url, null);
  ok('policy: exclusion filter, 64K tool-capable rule, strict lists and lenient claims, row validation');

  // ──────────────────────────────────────────── parsers
  const orItems = parseOpenRouter(await LISTS['https://openrouter.ai/api/v1/models']().json());
  assert.deepEqual(orItems.filter(item => item.free).map(item => item.id),
    ['cohere/north-mini-code:free', 'acme/coder-pro:free', 'acme/tiny:free', 'acme/notools:free']);
  assert.deepEqual(orItems.find(item => item.id === 'acme/coder-pro:free'),
    { id: 'acme/coder-pro:free', name: 'acme/coder-pro:free', chat: true, free: true, tools: true, context: 131072, maxOutput: 16384, vision: true });
  assert.equal(parseKilo({ data: [{ id: 'x', isFree: true }] })[0].free, true);
  assert.equal(parseKilo({ data: [{ id: 'y', pricing: { prompt: '0', completion: '0' } }] })[0].free, true);
  assert.deepEqual(parseVercel(await LISTS['https://ai-gateway.vercel.sh/v1/models']().json()).map(item => [item.id, item.chat, item.free, item.tools]),
    [['newco/model-free', true, true, true], ['newco/embed', false, true, false], ['newco/paid', true, false, true]]);
  assert.deepEqual(parseRequesty(await LISTS['https://router.requesty.ai/v1/models']().json()).map(item => item.free), [true, false]);
  assert.deepEqual(parseLlm7(await LISTS['https://api.llm7.io/v1/models']().json()).map(item => [item.free, item.context]), [[true, 400000], [false, 400000]]);
  const nvidia = parseNvidia({ data: [{ id: 'newlab/agent-70b' }, { id: 'newlab/embed' }, { id: 'nobody/knows' }] }, MODELS_DEV.nvidia);
  assert.deepEqual(nvidia.map(item => [item.chat, item.tools, item.context]), [[true, true, 131072], [false, false, 8192], [true, null, null]]);
  assert.throws(() => parseOpenRouter({ unexpected: true }), /unexpected list format/);
  assert.equal(LIST_SOURCES.length, 8);
  ok('parsers: OpenRouter :free ids with tools, context and modalities; Kilo, Vercel, Requesty, LLM7; bare lists via models.dev');

  // ──────────────────────────────────────────── OmniRoute parser
  const parsedOmni = parseOmnirouteCatalog(omnirouteLines([
    '  { provider: "cloudflare-ai", modelId: "@cf/x/y", displayName: "Has \\"quotes\\", commas }", monthlyTokens: 1, creditTokens: 0, freeType: "recurring-daily", poolKey: "cf", tos: "caution", trainsOnPrompts: true },',
  ]));
  assert.equal(parsedOmni.curatedAt, '2026-10-10');
  assert.equal(parsedOmni.entries.length, 122);
  assert.deepEqual(parsedOmni.entries.at(-1), { provider: 'cloudflare-ai', modelId: '@cf/x/y', displayName: 'Has "quotes", commas }',
    monthlyTokens: 1, creditTokens: 0, freeType: 'recurring-daily', poolKey: 'cf', tos: 'caution', trainsOnPrompts: true });
  const baseline = omnirouteDiff(parsedOmni, null);
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.rows.length, 0, 'the first run only records a baseline');
  assert.ok(!baseline.snapshot.keys.includes('gone-provider|old'), 'discontinued entries are not live');
  const diff = omnirouteDiff(parsedOmni, { keys: baseline.snapshot.keys.filter(key => key !== 'cloudflare-ai|@cf/x/y').concat('groq|retired') },
    new Set(['groq']));
  assert.deepEqual(diff.added, ['cloudflare-ai|@cf/x/y']);
  assert.deepEqual(diff.removed, ['groq|retired']);
  assert.deepEqual(diff.rows.map(row => [row.provider, row.model_id, row.status]),
    [['cloudflare-workers-ai', '@cf/x/y', 'new'], ['cloudflare-workers-ai', '', 'new']], 'OmniRoute ids map to provider database ids');
  assert.throws(() => parseOmnirouteCatalog('nothing here'), /FREE_MODEL_BUDGETS/);
  ok('OmniRoute: line parser (data, never evaluated), baseline first, added and removed entries, provider id mapping');

  // ──────────────────────────────────────────── research parsing and budget
  const answer = parseResearchAnswer('Here you go:\n```json\n{"records":[{"id":"x"}],"removed":[]}\n```');
  assert.deepEqual(answer.records, [{ id: 'x' }]);
  assert.deepEqual(parseResearchAnswer('{"records":[]}').records, []);
  assert.throws(() => parseResearchAnswer('no json'), /no JSON object/);
  const researched = researchRows({ records: [
    { id: 'FreshAI', name: 'Fresh AI', free_status: 'active', change: 'New free tier', sources: ['https://freshai.example/pricing', 'javascript:alert(1)'],
      free_models: [{ id: 'fresh-coder', context_window: 131072, tool_calling: true }, { id: 'fresh-mini', context_window: 8192, tool_calling: true }] },
    { id: 'chatscrape', name: 'Chat Scrape', access_method: 'web_session', sources: ['https://chatscrape.example'], free_models: [{ id: 'cs-1' }] },
    { id: 'nosource', name: 'No Source', free_models: [{ id: 'ns-1' }] },
  ], removed: [{ provider: 'oldai', reason: 'free tier ended', sources: ['https://oldai.example/blog'] }, { provider: 'x', sources: [] }] }, '2026-10-19');
  assert.equal(researched.dropped, 1, 'records without sources are dropped');
  assert.deepEqual(researched.rows.map(row => [row.provider, row.model_id, row.status]), [
    ['freshai', '', 'new'], ['freshai', 'fresh-coder', 'new'], ['freshai', 'fresh-mini', 'rejected'],
    ['chatscrape', '', 'excluded'], ['chatscrape', 'cs-1', 'excluded']]);
  assert.deepEqual(researched.rows[0].record.sources, ['https://freshai.example/pricing']);
  assert.equal(researched.removed.length, 1);
  const budget = researchBudget({}, 30000);
  assert.equal(budget.capUsd, 0.25);
  assert.ok(budget.maxSearches >= 1 && budget.maxSearches <= 10);
  assert.equal(researchBudget({}, 30000, { max_searches: 2 }).maxSearches, 2, 'a run over the cap halves the next one');
  assert.equal(researchBudget({ DISCOVERY_RESEARCH_MAX_USD: '0.02' }, 30000).maxSearches, 0, 'a tiny cap allows no search');
  assert.equal(researchBudget({ DISCOVERY_RESEARCH_MAX_USD: '99' }, 30000).capUsd, 2, 'the cap is clamped');
  assert.equal(researchCostMicrousd({ input_tokens: 50000, output_tokens: 3000, server_tool_use: { web_search_requests: 4 } }), 46500);
  assert.equal(researchCostMicrousd({ input_tokens: 200000, output_tokens: 1000 }), 102500, 'long prompts use the long-context rate');
  ok('research: JSON extraction, sources required, excluded access, budget from the cap, list-price cost');

  // ──────────────────────────────────────────── migration and seed
  const handle = await getPgliteHandle(DB);
  assert.ok(handle.applied.includes('20261019120000'));
  const seeded = (await rpc(DB, 'zerox_discovery_overview', {})).overview;
  assert.deepEqual(seeded.counts, { new: 233, verified: 14, excluded: 204, filtered: 580 });
  assert.equal((await sql("SELECT count(*)::int AS n FROM public.zerox_provider_candidates WHERE model_id = ''"))[0].n, 186, 'one record per provider');
  assert.equal((await candidate('groq', 'openai/gpt-oss-120b')).status, 'verified', 'code catalog models are verified');
  assert.equal((await candidate('openrouter', 'cohere/north-mini-code:free')).status, 'verified');
  assert.equal((await candidate('google-gemini', 'gemini-2.5-flash')).status, 'verified');
  assert.equal((await candidate('duckduckgo-web')).status, 'excluded');
  assert.ok((await sql("SELECT count(*)::int AS n FROM public.zerox_provider_candidates WHERE status = 'excluded' AND excluded_reason IS NULL"))[0].n === 0);
  const pollinations = await candidate('pollinations');
  assert.equal(pollinations.record.id, 'pollinations', 'provider records keep the SCHEMA.json fields');
  assert.ok(pollinations.reviewed_at === null && pollinations.status === 'rejected', 'seed provider records are filtered, not reviewed');
  for (const role of ['anon', 'authenticated']) {
    const [grant] = await sql(`SELECT has_table_privilege('${role}', 'public.zerox_provider_candidates', 'SELECT') AS t,
      has_function_privilege('${role}', 'public.zerox_candidates_upsert(jsonb)', 'EXECUTE') AS f,
      has_function_privilege('${role}', 'public.zerox_catalog_db_models()', 'EXECUTE') AS c`);
    assert.deepEqual(grant, { t: false, f: false, c: false }, `${role} has no access`);
  }
  ok('migration: 186-provider seed (233 queued, 14 verified from src/catalog.js, 204 excluded); service_role-only access');

  // ──────────────────────────────────────────── candidate RPC semantics
  const up = rows => rpcRows(DB, 'zerox_candidates_upsert', { p_rows: rows });
  const row = (provider, model_id, status = 'new', extra = {}) => ({ source: 'test', provider, model_id, status, ...extra });
  const [filteredSeed] = await sql("SELECT provider, model_id FROM public.zerox_provider_candidates WHERE status = 'rejected' AND reviewed_at IS NULL AND model_id <> '' AND provider = 'openrouter' LIMIT 1");
  const lifted = await up([row(filteredSeed.provider, filteredSeed.model_id, 'new', { supports_tools: true, context_window: 131072 })]);
  assert.deepEqual([lifted[0].status, lifted[0].inserted], ['new', false], 'new evidence lifts a policy-filtered model');
  await rpcRows(DB, 'zerox_candidates_review', { p_ids: [lifted[0].id], p_action: 'reject', p_note: 'not for us' });
  assert.equal((await up([row(filteredSeed.provider, filteredSeed.model_id)]))[0].status, 'rejected', 'operator decisions stay');
  const reviewed = await candidate(filteredSeed.provider, filteredSeed.model_id);
  assert.equal(reviewed.review_notes, 'not for us');
  assert.equal((await up([row('pollinations', '', 'new')]))[0].status, 'rejected', 'provider records are never re-queued');
  assert.equal((await up([row('duckduckgo-web', 'ddg-model')]))[0].status, 'excluded', 'models of an excluded provider are excluded');
  const sneaky = await up([row('sneaky', ''), row('sneaky', 'm1')]);
  assert.deepEqual(sneaky.map(item => item.status), ['new', 'new']);
  await up([row('sneaky', '', 'excluded', { excluded_reason: 'Access needs CAPTCHA solving.' })]);
  assert.equal((await candidate('sneaky', 'm1')).status, 'excluded', 'excluding a provider takes its models with it');
  assert.equal((await up([row('sneaky', '', 'new')]))[0].status, 'excluded', 'exclusion is sticky');
  await assert.rejects(up([row('x', 'y', 'approved')]), /invalid_candidates/);
  await assert.rejects(up([row('x', 'y', 'excluded')]), /invalid_candidates/, 'an exclusion needs a reason');
  await assert.rejects(up([{ ...row('x', 'y'), evidence_url: 'http://insecure' }]), /check constraint/);
  await assert.rejects(rpcRows(DB, 'zerox_candidates_sync_listed', { p_provider: 'openrouter', p_model_ids: [] }), /empty list/);
  await assert.rejects(rpcRows(DB, 'zerox_candidates_review', { p_ids: [sneaky[1].id], p_action: 'approve' }), /candidate_excluded/);
  ok('candidate RPCs: refresh without losing decisions, policy lift, sticky and inherited exclusion, empty lists refused');

  // ──────────────────────────────────────────── daily lists through the cron tick
  const listEnv = { ...DB, HEALTH_HUB, OPENROUTER_HOSTED: 'true', NVIDIA_HOSTED: 'true' };
  const first = await runDiscoveryTick(listEnv);
  assert.deepEqual(first.ran.map(item => item.job).sort(), [...LIST_SOURCES.map(source => source.job), 'omniroute'].sort(),
    'every list and OmniRoute run; research needs ANTHROPIC_API_KEY');
  assert.ok(first.ran.every(item => item.ok), JSON.stringify(first.ran.filter(item => !item.ok)));
  const byJob = Object.fromEntries(first.ran.map(item => [item.job, item.summary]));
  assert.deepEqual(byJob['list:openrouter'].new_candidates, ['openrouter/acme/coder-pro:free']);
  assert.deepEqual(byJob['list:kilo'].new_candidates, ['kilo-gateway/zeta/new:free']);
  assert.deepEqual(byJob['list:opencode-zen'].new_candidates, ['opencode-zen/fresh-free']);
  assert.deepEqual(byJob['list:vercel'].new_candidates, ['vercel-ai-gateway/newco/model-free']);
  assert.deepEqual(byJob['list:requesty'].new_candidates, ['requesty/novita/ling-9']);
  assert.deepEqual(byJob['list:aihubmix'].new_candidates, ['aihubmix/brand-new-free']);
  assert.deepEqual(byJob['list:nvidia'].new_candidates, ['nvidia/newlab/agent-70b']);
  assert.deepEqual(byJob['list:llm7'].new_candidates, ['llm7/GLM-9-Flash']);
  assert.equal(callsTo(MODELS_DEV_URL).length, 1, 'models.dev is read once per tick');
  for (const [provider, model] of [['openrouter', 'acme/tiny:free'], ['openrouter', 'acme/notools:free'], ['openrouter', 'acme/paid'],
    ['aihubmix', 'unknown-free'], ['nvidia', 'newlab/embed'], ['llm7', 'GLM-9']]) {
    assert.equal(await candidate(provider, model), undefined, `${provider}/${model} is not queued`);
  }
  const coder = await candidate('openrouter', 'acme/coder-pro:free');
  assert.deepEqual([coder.status, coder.context_window, coder.supports_tools, coder.supports_vision, coder.evidence_url],
    ['new', 131072, true, true, 'https://openrouter.ai/acme/coder-pro:free']);
  assert.ok((await candidate('openrouter', 'poolside/laguna-s-2.1:free')).gone_at, 'a seeded model no longer listed is marked gone');
  assert.equal((await candidate('openrouter', 'cohere/north-mini-code:free')).gone_at, null);
  assert.ok(byJob['list:openrouter'].gone > 0);
  // The catalog's MiniMax entry is missing from the OpenRouter list: HealthHub is told.
  assert.deepEqual(byJob['list:openrouter'].missing, ['minimax/minimax-m3.1-flash:free']);
  assert.deepEqual(hubMarks, [{ keys: ['openrouter:minimax/minimax-m3.1-flash:free:free'], kind: 'model_unavailable' }]);
  assert.deepEqual(byJob['list:nvidia'].missing, [], 'NVIDIA still lists every catalog model');
  assert.equal(byJob.omniroute.baseline, true);
  const listJob = await job('list:openrouter');
  assert.ok(Math.abs(listJob.due_in - DAY) < 120, 'lists run again in a day');
  assert.deepEqual(listJob.snapshot.qualifying, ['acme/coder-pro:free', 'cohere/north-mini-code:free']);
  assert.ok(Math.abs((await job('omniroute')).due_in - WEEK) < 120, 'OmniRoute runs again in a week');

  const fetchesBefore = calls.length;
  assert.deepEqual(await runDiscoveryTick(listEnv), { ran: [] }, 'nothing is due ten minutes later');
  assert.equal(calls.length, fetchesBefore, 'no upstream is read again the same day');

  // A list that drops most catalog models is not trusted; a failing list retries in an hour.
  upstream.set('https://integrate.api.nvidia.com/v1/models', () => json({ data: [{ id: 'newlab/agent-70b' }] }));
  upstream.set('https://api.llm7.io/v1/models', () => json({ error: 'down' }, 503));
  await makeDue('list:nvidia');
  await makeDue('list:llm7');
  const second = Object.fromEntries((await runDiscoveryTick(listEnv)).ran.map(item => [item.job, item]));
  assert.match(second['list:nvidia'].summary.skipped, /not trusted/);
  assert.equal(second['list:nvidia'].summary.marked, 0);
  assert.equal(hubMarks.length, 1);
  assert.deepEqual([second['list:nvidia'].summary.added, second['list:nvidia'].summary.removed], [[], []],
    'the diff against the last snapshot is reported');
  assert.deepEqual(second['list:nvidia'].summary.missing.sort(),
    ['nvidia/nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/openai/gpt-oss-20b', 'nvidia/stepfun-ai/step-5-preview']);
  assert.equal(second['list:llm7'].ok, false);
  assert.match(second['list:llm7'].error, /api\.llm7\.io answered 503/);
  const llm7 = await job('list:llm7');
  assert.ok(Math.abs(llm7.due_in - 3600) < 120 && llm7.last_error, 'a failed list retries in an hour');
  upstream.set('https://integrate.api.nvidia.com/v1/models', LISTS['https://integrate.api.nvidia.com/v1/models']);
  upstream.set('https://api.llm7.io/v1/models', LISTS['https://api.llm7.io/v1/models']);
  assert.deepEqual(await runDiscoveryTick({ ...listEnv, DISCOVERY_ENABLED: 'false' }), { skipped: 'disabled' });
  assert.deepEqual(await runDiscoveryTick({}), { skipped: 'no_database' });
  ok('daily lists: once a day per source, new free tool-capable >=64K ids queued, gone ids marked, missing catalog ids sent to HealthHub, failures retried hourly');

  // ──────────────────────────────────────────── weekly OmniRoute diff
  omniroute = omnirouteLines([
    '  { provider: "newprov", modelId: "np-model", displayName: "NP Model", monthlyTokens: 1000, creditTokens: 0, freeType: "recurring-monthly", poolKey: "np", tos: "ok" },',
    '  { provider: "duckduckgo-web", modelId: "ddg-new", displayName: "DDG", monthlyTokens: 0, creditTokens: 0, freeType: "keyless", poolKey: "ddg", tos: "avoid" },',
  ]);
  await makeDue('omniroute');
  const weekly = (await runDiscoveryTick(listEnv)).ran.find(item => item.job === 'omniroute');
  assert.deepEqual(weekly.summary.added.sort(), ['duckduckgo-web|ddg-new', 'newprov|np-model']);
  assert.deepEqual(weekly.summary.new_candidates.sort(), ['newprov', 'newprov/np-model']);
  assert.equal(weekly.summary.excluded, 1);
  const np = await candidate('newprov', 'np-model');
  assert.deepEqual([np.status, np.supports_tools, np.context_window], ['new', null, null]);
  assert.match(np.notes, /unknown: check before approving/);
  assert.equal((await candidate('duckduckgo-web', 'ddg-new')).status, 'excluded', 'never offered');
  ok('weekly OmniRoute: baseline, then added free entries queued with unknown capabilities, excluded providers stay excluded');

  // ──────────────────────────────────────────── weekly research agent
  const anthropicCalls = [];
  let researchReply = () => json({
    id: 'msg_1', type: 'message', role: 'assistant', model: RESEARCH_MODEL, stop_reason: 'end_turn',
    content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'free llm api' } },
      { type: 'text', text: '```json\n' + JSON.stringify({ records: [
        { id: 'freshai', name: 'Fresh AI', free_status: 'active', change: 'Launched a free tier', sources: ['https://freshai.example/pricing'],
          access_method: 'api_key', free_models: [{ id: 'fresh-coder', context_window: 131072, tool_calling: true }] },
        { id: 'scrapeit', name: 'Scrape It', access_method: 'captcha', sources: ['https://scrapeit.example'], free_models: [{ id: 's1' }] },
      ], removed: [] }) + '\n```' }],
    usage: { input_tokens: 50000, output_tokens: 3000, server_tool_use: { web_search_requests: 4 } },
  });
  upstream.set('https://api.anthropic.com/v1/messages', (url, init) => { anthropicCalls.push(JSON.parse(init.body)); return researchReply(); });
  // DISCOVERY_CREDITS=false: this run counts the provider research call only (credits: check-credits.mjs).
  const researchEnv = { ...listEnv, ANTHROPIC_API_KEY: 'sk-ant-test', DISCOVERY_CREDITS: 'false' };
  // On the Node server (server.js builds env from process.env) the SDK would take its base URL
  // and a bearer token from these: the research client pins api.anthropic.com and x-api-key.
  process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token-must-not-be-sent';
  // A Claude Code shell often sets this; the SDK merges it after the auth headers.
  process.env.ANTHROPIC_CUSTOM_HEADERS = ['Authorization: Bearer custom-header-token', 'x-api-key: custom-header-key',
    'anthropic-beta: some-beta-2099', 'X-Custom-Header: leak'].join('\n');
  let research;
  try {
    research = (await runDiscoveryTick(researchEnv)).ran;
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  }
  assert.deepEqual(research.map(item => item.job), ['research'], 'research is due once a key is set; the lists are not');
  assert.equal(research[0].ok, true, research[0].error);
  const request = anthropicCalls[0];
  assert.equal(request.model, 'claude-haiku-5-5');
  assert.deepEqual(request.output_config, { effort: 'low' });
  assert.equal(request.tools[0].type, 'web_search_20250305');
  assert.ok(request.tools[0].max_uses >= 1 && request.tools[0].max_uses <= 10);
  assert.ok(request.max_tokens <= 8000);
  assert.match(request.messages[0].content, /openrouter \[rejected\]: .*acme\/coder-pro:free/, 'the agent is given the current list');
  assert.equal(new Headers(callsTo('https://api.anthropic.com').at(-1).init.headers).get('x-api-key'), 'sk-ant-test');
  assert.ok(callsTo('https://api.anthropic.com').every(call => call.init.redirect === 'manual'), 'the key never follows a redirect');
  assert.ok(!calls.some(call => call.url.startsWith('https://evil.example')), 'ANTHROPIC_BASE_URL never moves the key');
  assert.equal(new Headers(callsTo('https://api.anthropic.com').at(-1).init.headers).get('authorization'), null, 'no ANTHROPIC_AUTH_TOKEN bearer');
  const researchHeaders = new Headers(callsTo('https://api.anthropic.com').at(-1).init.headers);
  assert.deepEqual(['x-api-key', 'anthropic-beta', 'anthropic-version', 'x-custom-header'].map(name => researchHeaders.get(name)),
    ['sk-ant-test', null, '2023-06-01', null], 'ANTHROPIC_CUSTOM_HEADERS neither replaces the key nor adds a beta or any other header');
  await assert.rejects(anthropicFetch()('https://evil.example/v1/messages', { method: 'POST', headers: { 'x-api-key': 'sk-ant-test' } }),
    /other than api\.anthropic\.com/, 'the shared transport refuses other hosts');
  for (const file of ['research.js', 'credits.js']) {
    const source = readFileSync(new URL(`./src/discovery/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes("from '../anthropic-transport.js'") && !/new Anthropic\(/.test(source), `${file} builds its client with anthropicClient`);
  }
  assert.equal((await candidate('freshai', 'fresh-coder')).status, 'new');
  assert.equal((await candidate('freshai')).record.sources[0], 'https://freshai.example/pricing');
  assert.equal((await candidate('scrapeit', 's1')).status, 'excluded');
  // Providers it found are proposed as OIOP offers: discovered, untrusted, unknown terms.
  const [proposed] = await rpcRows(DB, 'zerox_offers_list', {}).then(rows => rows.filter(row => row.id === 'freshai.free'));
  assert.deepEqual([proposed?.lifecycle, proposed?.trust_tier, proposed?.redistribution], ['discovered', 'T3', 'unknown']);
  assert.equal(proposed.evidence[0].url, 'https://freshai.example/pricing');
  assert.ok(!(await rpcRows(DB, 'zerox_offers_list', {})).some(row => row.id === 'scrapeit.free'), 'excluded providers are not proposed');
  assert.deepEqual(research[0].summary.proposed_offers, ['freshai.free']);
  const researchState = await job('research');
  assert.equal(Number(researchState.spent_microusd), 46500, 'list-price spend is recorded');
  assert.ok(Math.abs(researchState.due_in - WEEK) < 120);
  // A paused answer is not resumed (that would spend past the cap); the spend still counts.
  researchReply = () => json({ id: 'msg_2', type: 'message', role: 'assistant', model: RESEARCH_MODEL, stop_reason: 'pause_turn',
    content: [], usage: { input_tokens: 400000, output_tokens: 100, server_tool_use: { web_search_requests: 10 } } });
  await makeDue('research');
  const paused = (await runDiscoveryTick(researchEnv)).ran[0];
  assert.equal(paused.ok, false);
  assert.match(paused.error, /paused/);
  const pausedState = await job('research');
  assert.equal(Number(pausedState.spent_microusd), 46500 + 300250, 'a failed paid call still records its cost');
  assert.ok(pausedState.snapshot.max_searches < request.tools[0].max_uses, 'a run over the cap halves the next one');
  assert.ok(Math.abs(pausedState.due_in - DAY) < 120, 'a failed research run waits a day');
  ok('weekly research: Haiku with web search, capped searches and tokens, current list in the prompt, records with sources, spend recorded');

  // ──────────────────────────────────────────── verification (streamed tool call)
  const sse = chunks => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const toolStream = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"record_',
    'result","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"status\\":\\"ok\\","}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"value\\":42}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  ];
  const chatBodies = [];
  let chatReply = () => sse(toolStream);
  upstream.set('https://openrouter.ai/api/v1/chat/completions', (url, init) => { chatBodies.push({ body: JSON.parse(init.body), headers: init.headers }); return chatReply(); });
  const verifyEnv = { OPENROUTER_API_KEY: 'or-secret-key' };
  assert.equal(verificationTarget({}, 'openrouter'), null);
  assert.equal(verificationTarget(verifyEnv, 'openrouter').keyVar, 'OPENROUTER_API_KEY');
  assert.equal(verificationTarget({ DISCOVERY_KEY_FRESHAI: 'k' }, 'freshai'), null, 'an operator key needs an operator base URL');
  assert.equal(verificationTarget({ DISCOVERY_KEY_FRESHAI: 'k', DISCOVERY_BASE_FRESHAI: 'http://freshai.example/v1' }, 'freshai'), null);
  assert.equal(verificationTarget({ DISCOVERY_KEY_FRESHAI: 'k', DISCOVERY_BASE_FRESHAI: 'https://api.freshai.example/v1' }, 'freshai').kind, 'operator_key');
  const good = await verifyCandidate(verifyEnv, { provider: 'openrouter', model_id: 'acme/coder-pro:free' });
  assert.equal(good.passed, true, JSON.stringify(good));
  assert.deepEqual(good.tool_call, { name: 'record_result', arguments: '{"status":"ok","value":42}', value_ok: true });
  assert.equal(good.finish_reason, 'tool_calls');
  const sent = chatBodies[0];
  assert.deepEqual([sent.body.model, sent.body.stream, sent.body.tools[0].function.name, sent.body.provider.data_collection],
    ['acme/coder-pro:free', true, 'record_result', 'deny'], 'the same adapter as real traffic (no data collection)');
  assert.equal(sent.headers.Authorization, 'Bearer or-secret-key');
  chatReply = () => sse(['data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']);
  const noTool = await verifyCandidate(verifyEnv, { provider: 'openrouter', model_id: 'acme/coder-pro:free' });
  assert.deepEqual([noTool.passed, noTool.error.message], [false, 'The stream ended without the test tool call.']);
  chatReply = () => json({ error: { message: 'Rate limit exceeded for key or-secret-key', code: 429 } }, 429);
  const limited = await verifyCandidate(verifyEnv, { provider: 'openrouter', model_id: 'acme/coder-pro:free' });
  assert.equal(limited.passed, false);
  assert.equal(limited.http_status, 429);
  assert.ok(!JSON.stringify(limited).includes('or-secret-key'), 'keys never reach the stored result');
  const unconfigured = await verifyCandidate({}, { provider: 'kilo-gateway', model_id: 'zeta/new:free' });
  assert.match(unconfigured.error.message, /signing up stays manual/);
  ok('verification: one streamed tool call through the production adapter, split SSE chunks, failures recorded without keys');

  // ──────────────────────────────────────────── admin API, review page and catalog drafts
  chatReply = () => sse(toolStream);
  const adminEnv = { ...DB, GATEWAY_ADMIN_TOKEN: ADMIN, OPENROUTER_API_KEY: 'or-secret-key', OPENROUTER_HOSTED: 'true',
    ALLOW_UNKNOWN_COUNTRY: 'true' };
  const call = async (path, { method = 'GET', body, env = adminEnv, token = ADMIN } = {}) => {
    const response = await app.request(`https://zero-x.live${path}`, { method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined }, env);
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* HTML page */ }
    return { status: response.status, body: parsed, text, headers: response.headers };
  };
  const servedIds = async env => (await call('/v1/models', { token: null, env })).body.data.map(model => model.id);
  const page = await call('/admin/discovery', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Provider discovery<\/title>/);
  assert.ok(!page.text.includes('acme/coder-pro'), 'the page shell holds no data');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/admin/discovery/candidates', { token: null })).status, 401);
  assert.equal((await call('/admin/discovery/candidates', { token: 'wrong-token-wrong-token-wrong-token' })).status, 401);
  // Cloudflare Access, as the catalog, key vault, offers and credits routes: once it is configured
  // the token alone reaches nothing (research and credit runs spend money, verify spends provider
  // keys, promote writes catalog drafts).
  const accessEnv = { ...adminEnv, ANTHROPIC_API_KEY: 'sk-ant-api03-check-not-real', CF_ACCESS_TEAM_DOMAIN: 'zerox.cloudflareaccess.com',
    CF_ACCESS_AUD: 'a'.repeat(32) };
  const callsBeforeAccess = calls.length;
  for (const [method, path, body] of [['GET', '/admin/discovery/candidates?status=all'], ['GET', '/admin/discovery/candidates/1'],
    ['POST', '/admin/discovery/run', { jobs: ['research'] }], ['POST', '/admin/discovery/run', { jobs: ['credits'] }],
    ['POST', '/admin/discovery/candidates/1/approve', {}], ['POST', '/admin/discovery/candidates/1/verify', {}],
    ['POST', '/admin/discovery/candidates/1/promote', {}], ['POST', '/admin/discovery/candidates/1/demote', {}],
    ['POST', '/admin/discovery/candidates/1/reject', {}], ['POST', '/admin/discovery/candidates/reject', { ids: [1] }]]) {
    const refused = await call(path, { method, body, env: accessEnv });
    assert.deepEqual([refused.status, refused.body?.error?.code], [403, 'access_required'], `${method} ${path}: Access is required when configured`);
    assert.equal((await call(path, { method, body, env: accessEnv, token: 'wrong-token-wrong-token-wrong-token' })).status, 401,
      'the token is checked first');
  }
  assert.equal(calls.length, callsBeforeAccess, 'no Claude call, verification or list fetch without Access');
  assert.equal((await call('/admin/discovery', { token: null, env: accessEnv })).status, 200, 'the page shell holds no data');
  const listed = await call('/admin/discovery/candidates?status=new&provider=openrouter');
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const coderRow = listed.body.data.find(item => item.model_id === 'acme/coder-pro:free');
  assert.deepEqual([coderRow.verifiable, coderRow.catalog_template, coderRow.record, coderRow.catalog_model_id], [true, true, null, null]);
  assert.equal(listed.body.settings.catalog_source, 'database');
  assert.equal(listed.body.settings.research_enabled, false, 'no ANTHROPIC_API_KEY, no research');
  assert.ok(listed.body.overview.jobs.some(item => item.job === 'list:openrouter'));
  assert.equal((await call('/admin/discovery/candidates?status=bogus')).status, 400);
  assert.ok(!(await servedIds(adminEnv)).includes('acme/coder-pro:free'), 'not served before review');

  assert.equal((await call(`/admin/discovery/candidates/${coderRow.id}/promote`, { method: 'POST', body: {} })).body.error.code,
    'candidate_not_verified', 'only verified models are promoted');
  const approved = await call(`/admin/discovery/candidates/${coderRow.id}/approve`, { method: 'POST', body: { note: 'looks good' } });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.verification.passed, true);
  assert.equal(approved.body.candidate.status, 'verified');
  assert.ok(!(await servedIds({ ...adminEnv })).includes('acme/coder-pro:free'), 'verified alone is not served: it is proposed');

  // Promote creates a draft catalog row (source discovery): nothing serves until it is approved.
  const promoted = await call(`/admin/discovery/candidates/${coderRow.id}/promote`, { method: 'POST', body: {} });
  assert.equal(promoted.status, 200, promoted.text);
  assert.deepEqual([promoted.body.promoted.public_model_id, promoted.body.promoted.status, promoted.body.served_within_seconds],
    ['acme/coder-pro:free', 'draft', null]);
  assert.equal(promoted.body.admin_url, '/admin/models?id=acme%2Fcoder-pro%3Afree');
  assert.match(promoted.body.notes[0], /draft catalog row: review and approve acme\/coder-pro:free on \/admin\/models/);
  const [draftRow] = await sql("SELECT status, source, candidate_id, pending_revision_id FROM public.zerox_catalog_models WHERE id = 'acme/coder-pro:free'");
  assert.deepEqual([draftRow.status, draftRow.source, Number(draftRow.candidate_id)], ['draft', 'discovery', Number(coderRow.id)]);
  const [{ n: legacyRows }] = await sql("SELECT count(*)::int AS n FROM public.gateway_provider_models WHERE public_model_id = 'acme/coder-pro:free'");
  assert.equal(legacyRows, 0, 'promotion no longer writes the legacy discovery table');
  const draftEnv = { ...adminEnv };
  assert.ok(!(await servedIds(draftEnv)).includes('acme/coder-pro:free'), 'a draft is never served');
  assert.ok(!catalogSnapshot(draftEnv).byId.has('acme/coder-pro:free'));
  const relisted = (await call('/admin/discovery/candidates?status=verified&provider=openrouter')).body.data.find(item => item.id === coderRow.id);
  assert.deepEqual([relisted.catalog_model_id, relisted.catalog_status], ['acme/coder-pro:free', 'draft'], 'the review page links the draft');

  // Approval happens on /admin/models (operator token, Access when configured), against the
  // reviewed revision; from then on the row serves through its provider type.
  const approval = await call('/admin/catalog/approve', { method: 'POST', body: { model_id: 'acme/coder-pro:free',
    revision_id: Number(draftRow.pending_revision_id), expected_active_revision_id: null, confirm: 'acme/coder-pro:free' } });
  assert.equal(approval.status, 200, approval.text);
  const servingEnv = { ...adminEnv };
  const models = (await call('/v1/models', { token: null, env: servingEnv })).body.data;
  const served = models.find(model => model.id === 'acme/coder-pro:free');
  assert.ok(served, 'an approved row is listed');
  assert.deepEqual([served.capabilities.tools, served.context_window, served.max_output_tokens, served.tiers], [true, 131072, 16384, ['free']]);
  const router = new RoutingEngine(new ProviderHealthTracker());
  const routed = router.route({ env: servingEnv, requestedModel: 'acme/coder-pro:free', needsTools: true, promptTokens: 100,
    maxTokens: 2048, tiers: ['free'], country: 'US' });
  assert.equal(routed.ok, true);
  assert.equal(routed.candidates[0].entry.source, 'database');
  assert.deepEqual([routed.candidates[0].pool.key_var, routed.candidates[0].pool.limits.rpd], ['OPENROUTER_API_KEY', 50],
    'the provider type fixes the key slot and the shared budget');
  const auto = router.route({ env: servingEnv, requestedModel: 'auto', needsTools: true, promptTokens: 100, maxTokens: 2048,
    tiers: ['free'], country: 'US' });
  assert.ok(auto.ok && auto.candidates.every(item => item.entry.id !== 'acme/coder-pro:free'), '`auto` never picks a discovery model (no auto rank)');
  const narrowed = { ...adminEnv, OPENROUTER_MODELS: 'cohere/north-mini-code:free' };
  await loadCatalog(narrowed);
  assert.ok(!offeredEntries(narrowed).some(entry => entry.id === 'acme/coder-pro:free'), '*_MODELS still narrows');
  const killSwitch = { ...adminEnv, CATALOG_SOURCE: 'code' };
  await loadCatalog(killSwitch);
  assert.ok(!offeredEntries(killSwitch).some(entry => entry.id === 'acme/coder-pro:free'), 'CATALOG_SOURCE=code serves code only');
  assert.equal(resolveModelId('acme/coder-pro:free'), null, 'resolution without the loaded env sees code models only');
  assert.equal((await call(`/admin/discovery/candidates/${coderRow.id}/promote`, { method: 'POST', body: {} })).body.error.code,
    'already_in_catalog', 'a served model is never proposed again over itself');
  const disabled = await call('/admin/catalog/disable', { method: 'POST', body: { model_id: 'acme/coder-pro:free', note: 'pause' } });
  assert.equal(disabled.status, 200);
  assert.ok(!(await servedIds({ ...adminEnv })).includes('acme/coder-pro:free'), 'disabled on /admin/models: no longer served');
  // A candidate promoted before the data-driven catalog keeps its legacy gateway_provider_models
  // row, and migration 20261025000100 imported it as a catalog row. Once that row is active,
  // "Remove from catalog" must not report a removal while it keeps serving: demote is refused.
  await sql(`INSERT INTO public.gateway_provider_models (public_model_id, provider_id, provider_model_id, candidate_id)
    VALUES ('acme/coder-pro:free', 'openrouter', 'acme/coder-pro:free', $1)`, [coderRow.id]);
  assert.equal((await call('/admin/catalog/enable', { method: 'POST', body: { model_id: 'acme/coder-pro:free' } })).status, 200);
  const both = (await call('/admin/discovery/candidates?status=verified&provider=openrouter')).body.data.find(item => item.id === coderRow.id);
  assert.deepEqual([both.promoted, both.catalog_model_id, both.catalog_status], [true, 'acme/coder-pro:free', 'active']);
  const managed = await call(`/admin/discovery/candidates/${coderRow.id}/demote`, { method: 'POST', body: {} });
  assert.deepEqual([managed.status, managed.body.error.code], [409, 'catalog_managed'], 'a catalog row is managed on /admin/models');
  assert.match(managed.body.error.message, /acme\/coder-pro:free is a catalog row \(active\); disable it on \/admin\/models/);
  assert.equal((await sql("SELECT status FROM public.zerox_catalog_models WHERE id = 'acme/coder-pro:free'"))[0].status, 'active');
  assert.ok((await servedIds({ ...adminEnv })).includes('acme/coder-pro:free'), 'the active row keeps serving and nothing claims otherwise');
  assert.match(REVIEW_PAGE, /row\.promoted && !row\.catalog_model_id\) button\('Remove legacy row', 'demote'\)/,
    'the page offers no demote next to a catalog row');
  assert.ok(!REVIEW_PAGE.includes('Removed from the catalog.'));
  assert.equal((await call('/admin/catalog/disable', { method: 'POST', body: { model_id: 'acme/coder-pro:free' } })).status, 200);
  // A legacy row without a catalog row can still be disabled; the answer says it was never served.
  const [legacy] = await sql(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, status)
    VALUES ('check', 'openrouter', 'acme/legacy:free', 'verified') RETURNING id`);
  await sql(`INSERT INTO public.gateway_provider_models (public_model_id, provider_id, provider_model_id, candidate_id)
    VALUES ('acme/legacy:free', 'openrouter', 'acme/legacy:free', $1)`, [legacy.id]);
  const legacyDemote = await call(`/admin/discovery/candidates/${legacy.id}/demote`, { method: 'POST', body: {} });
  assert.deepEqual([legacyDemote.status, legacyDemote.body.demoted, legacyDemote.body.served], [200, ['acme/legacy:free'], false]);
  assert.match(legacyDemote.body.note, /was not served/);
  // CATALOG_DB_MODELS is ignored: the legacy promoted-model table is never served.
  const legacyEnv = { ...adminEnv, CATALOG_DB_MODELS: 'true' };
  await loadCatalog(legacyEnv);
  assert.deepEqual(offeredEntries(legacyEnv).map(entry => entry.id), offeredEntries({ ...adminEnv }).map(entry => entry.id));

  const kiloRow = (await call('/admin/discovery/candidates?status=new&provider=kilo-gateway&q=zeta')).body.data[0];
  const kiloApproved = await call(`/admin/discovery/candidates/${kiloRow.id}/approve`, { method: 'POST', body: {} });
  assert.deepEqual([kiloApproved.body.candidate.status, kiloApproved.body.verification], ['approved', null]);
  assert.match(kiloApproved.body.message, /signing up stays manual/);
  assert.equal((await call(`/admin/discovery/candidates/${kiloRow.id}/verify`, { method: 'POST', body: {} })).body.error.code, 'no_key');
  assert.equal((await call(`/admin/discovery/candidates/${kiloRow.id}/promote`, { method: 'POST', body: {} })).body.error.code,
    'no_catalog_template');
  const [unsized] = await sql(`INSERT INTO public.zerox_provider_candidates (source, provider, model_id, status)
    VALUES ('check', 'openrouter', 'acme/unsized:free', 'verified') RETURNING id`);
  const unsizedPromote = await call(`/admin/discovery/candidates/${unsized.id}/promote`, { method: 'POST', body: {} });
  assert.deepEqual([unsizedPromote.status, unsizedPromote.body.error.param], [400, 'context_window'], 'an unknown context window is asked for');
  const sized = await call(`/admin/discovery/candidates/${unsized.id}/promote`, { method: 'POST',
    body: { context_window: 65536, max_output_tokens: 8192, display_name: 'Acme Unsized' } });
  assert.deepEqual([sized.status, sized.body.promoted.status], [200, 'draft']);
  const tooLong = await call(`/admin/discovery/candidates/${unsized.id}/promote`, { method: 'POST', body: { context_window: 4096, max_output_tokens: 8192 } });
  assert.equal(tooLong.status, 400, 'the guardrails refuse an output limit above the context window');
  const excludedRow = await candidate('duckduckgo-web', 'ddg-new');
  const refused = await call(`/admin/discovery/candidates/${excludedRow.id}/approve`, { method: 'POST', body: {} });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'candidate_excluded']);
  const seededVerified = await candidate('openrouter', 'cohere/north-mini-code:free');
  await sql("UPDATE public.zerox_provider_candidates SET status = 'verified' WHERE id = $1", [seededVerified.id]);
  assert.equal((await call(`/admin/discovery/candidates/${seededVerified.id}/promote`, { method: 'POST', body: {} })).body.error.code,
    'already_in_catalog', 'code-defined models are never shadowed');
  const freshRows = await sql("SELECT id FROM public.zerox_provider_candidates WHERE provider = 'freshai'");
  const bulk = await call('/admin/discovery/candidates/reject', { method: 'POST', body: { ids: freshRows.map(item => item.id), note: 'bulk' } });
  assert.equal(bulk.body.rejected.length, freshRows.length);
  assert.equal((await call('/admin/discovery/candidates/999999999')).status, 404);
  assert.equal((await call('/admin/discovery/run', { method: 'POST', body: { jobs: ['research'] } })).status, 400, 'research needs its key');
  const runNow = await call('/admin/discovery/run', { method: 'POST', body: { jobs: ['list:requesty'] }, env: { ...adminEnv, HEALTH_HUB } });
  assert.deepEqual(runNow.body.ran.map(item => [item.job, item.ok]), [['list:requesty', true]], 'run now forces a job that is not due');
  ok('admin API: token required (and Cloudflare Access when configured), approve runs the live tool call, verified is only proposed, promote creates a draft catalog row that serves only once approved on /admin/models (and stops when disabled)');

  // ──────────────────────────────────────────── research switch
  assert.equal(researchEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x' }), true, 'on by default once the key is set');
  assert.equal(researchEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x', DISCOVERY_RESEARCH: 'false' }), false);
  assert.equal(researchEnabled({ DISCOVERY_RESEARCH: 'true' }), false, 'never without the key');
  assert.ok(discoveryJobs({ ANTHROPIC_API_KEY: 'sk-ant-x' }).includes('research') && discoveryJobs({ ANTHROPIC_API_KEY: 'sk-ant-x' }).includes('credits'));
  assert.ok(!discoveryJobs({ ANTHROPIC_API_KEY: 'sk-ant-x', DISCOVERY_RESEARCH: 'false' }).some(item => ['research', 'credits'].includes(item)),
    'DISCOVERY_RESEARCH=false turns off both Claude jobs');
  assert.deepEqual(discoveryJobs({ ANTHROPIC_API_KEY: 'sk-ant-x', DISCOVERY_CREDITS: 'false' }).filter(item => ['research', 'credits'].includes(item)),
    ['research']);
  assert.equal(CATALOG.length, CATALOG.filter(entry => entry.source !== 'database').length);
  assert.ok(listModelsForCaller({}).data.length > 1);
  ok('research jobs: on once ANTHROPIC_API_KEY is set, DISCOVERY_RESEARCH=false turns research and credits off, DISCOVERY_CREDITS=false credits only');

  // ──────────────────────────────────────────── HealthHub /mark
  const saved = new Map();
  let alarm = null;
  const state = { blockConcurrencyWhile: fn => fn(), storage: { get: async key => saved.get(key), put: async (key, value) => saved.set(key, value),
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } } };
  const hub = new HealthHub(state, {}, { fetchImpl: () => { throw new Error('no fetch'); }, now: () => 1_000_000 });
  const mark = await hub.fetch(new Request('https://health-hub.internal/mark', { method: 'POST',
    body: JSON.stringify({ keys: ['openrouter:acme/x:free:free'], kind: 'model_unavailable' }) }));
  assert.deepEqual(await mark.json(), { ok: true, marked: 1 });
  assert.equal(hub.snapshot().pools['openrouter:acme/x:free:free'].status, 'blurred');
  assert.equal(hub.realAt.size, 0, 'a discovery mark is not real traffic');
  assert.equal((await hub.fetch(new Request('https://health-hub.internal/mark', { method: 'POST',
    body: JSON.stringify({ keys: ['k'], kind: 'server' }) }))).status, 400);
  resetHubClientCache();
  ok('HealthHub: POST /mark puts a pool in model_unavailable without counting as real traffic');

  // ──────────────────────────────────────────── cron entry point
  const waited = [];
  const scheduled = await app.scheduled({ cron: '*/10 * * * *' }, { ...DB, HEALTH_HUB }, { waitUntil: promise => waited.push(promise) });
  assert.deepEqual(Object.keys(scheduled).sort(), ['downgraded', 'released']);
  assert.equal(waited.length, 1);
  ok('cron: discovery runs beside maintenance and never changes its result');

  console.log(`\n${passed.length} discovery checks passed`);
} finally {
  globalThis.fetch = realFetch;
  await closeAllPglite();
}
