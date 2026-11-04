// The Zero-X house style (src/house-style.js, docs/HOUSE_STYLE.md), offline: the frozen text, the
// pure decision function, the system-message merge for every adapter, the accounting that leaves
// the preface out of what a user is charged, the response header and /health, and that the
// published text, notices and env examples match the code. No outbound request is possible.
//   node check-house-style.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toClaudeRequest } from './src/anthropic-request.js';
import { settlementArgs } from './src/capacity.js';
import { catalogEntry } from './src/catalog.js';
import { billableUsage, estimateOutputTokens, estimatePromptTokens } from './src/pricing.js';
import { sharedShingles, shingles } from './scripts/check-style-originality.mjs';
import { buildUpstreamPayload } from './src/providers.js';
import app from './src/index.js';
import {
  applyHouseStyle, carriesMarker, clientEstimate, creditPreface, HOUSE_STYLE_BYTES, HOUSE_STYLE_TEXT, HOUSE_STYLE_TOKENS, HOUSE_STYLE_VERSION,
  houseStyleMode, houseStylePercent, houseStyleStatus, parseStyleHeader, rolloutBucket, STYLE_HEADER, styleDecision, usageCountsPreface,
} from './src/house-style.js';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const realFetch = globalThis.fetch;
globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };

const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const user = { role: 'user', content: 'Add pagination to the list endpoint.' };
const agentBody = (extra = {}) => ({ model: 'auto', messages: [{ role: 'system', content: 'You are Acme Agent.' }, user], tools, ...extra });
const decide = (body, { env = {}, header = null, caller = 'user-1' } = {}) => styleDecision({ env, header, body, caller });
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

try {
  // ── The text ──
  {
    assert.ok(HOUSE_STYLE_BYTES <= 1400, `the text is ${HOUSE_STYLE_BYTES} bytes, at most 1,400 (about 350 tokens)`);
    assert.ok(HOUSE_STYLE_BYTES >= 1000, 'and not trimmed to nothing');
    assert.equal(HOUSE_STYLE_TOKENS, Math.ceil(HOUSE_STYLE_BYTES / 4));
    assert.ok(HOUSE_STYLE_TOKENS <= 350 && HOUSE_STYLE_TOKENS >= 250);
    assert.equal(new TextEncoder().encode(HOUSE_STYLE_TEXT).byteLength, HOUSE_STYLE_BYTES);
    assert.ok(/^[\x20-\x7e\n]+$/.test(HOUSE_STYLE_TEXT), 'plain ASCII and LF only');
    assert.equal(HOUSE_STYLE_VERSION, 'v1');
    assert.ok(HOUSE_STYLE_TEXT.startsWith('Zero-X house style v1. Defaults only: anything the user, the project'),
      'it begins by saying the user and project always win');
    const firstSentence = HOUSE_STYLE_TEXT.split('\n')[0];
    assert.ok(/overrides them\.$/.test(firstSentence) && /later system message/.test(firstSentence));
    for (const heading of ['\nEconomy\n', '\nBuild discipline\n', '\nDesign taste (UI work)\n']) {
      assert.ok(HOUSE_STYLE_TEXT.includes(heading), `section ${heading.trim()}`);
    }
    assert.ok(/the platform, the language's library or this codebase already covers the need/.test(HOUSE_STYLE_TEXT) && /whether it is a need at all/.test(HOUSE_STYLE_TEXT), 'economy: is it needed, does the platform, library or repo cover it');
    assert.ok(!/(?:rung|ladder)/i.test(HOUSE_STYLE_TEXT), 'no ladder wording');
    assert.ok(/small steps and verify each/.test(HOUSE_STYLE_TEXT) && /Never make up APIs/.test(HOUSE_STYLE_TEXT), 'build discipline');
    assert.ok(/design direction/.test(HOUSE_STYLE_TEXT) && /lorem ipsum/.test(HOUSE_STYLE_TEXT), 'design taste');
    assert.ok(!/\d{4}-\d{2}-\d{2}|\$\{|\{\{|<[a-z]/i.test(HOUSE_STYLE_TEXT), 'no date, template slot or markup in it');
    assert.ok(!/claude|anthropic/i.test(HOUSE_STYLE_TEXT), 'no vendor name in text users can read');
    // Nothing in the text is taken from the public projects: no long run of their words.
    for (const phrase of ['Ponytail', 'gstack', 'Hallmark', 'AntiSlop', 'anti-slop']) assert.ok(!HOUSE_STYLE_TEXT.includes(phrase), phrase);
    // Names prove nothing about copied words, so the originality check compares four-word runs
    // (scripts/check-style-originality.mjs). The skill files it is meant for live in the neuron
    // repository: run `ZEROX_BUNDLED_SKILLS=<dir> node check-house-style.mjs` (or the script on its own) locally.
    assert.deepEqual([...shingles('one two three four five')], ['one two three four', 'two three four five']);
    assert.deepEqual(sharedShingles('Take the first step. Only then write code.', [{ name: 'a.md', text: 'Always take the first step today' }, { name: 'b.md', text: 'unrelated words here' }]),
      [{ shingle: 'take the first step', sources: ['a.md'] }], 'the helper finds a shared four-word run and names its file');
    assert.deepEqual(sharedShingles(HOUSE_STYLE_TEXT, [{ name: 'x.md', text: 'two words only' }]), []);
    if (process.env.ZEROX_BUNDLED_SKILLS) {
      const { loadSources } = await import('./scripts/check-style-originality.mjs');
      const { delimiter } = await import('node:path');
      const shared = sharedShingles(HOUSE_STYLE_TEXT, loadSources(process.env.ZEROX_BUNDLED_SKILLS.split(delimiter).filter(Boolean)));
      assert.deepEqual(shared, [], 'no four-word run of the preface is in the bundled skills');
    }
    ok(`the preface text: ${HOUSE_STYLE_BYTES} bytes (about ${HOUSE_STYLE_TOKENS} tokens), starts by saying the user and project win, three sections, plain ASCII, no date, template slot or vendor name`);
  }

  // ── Modes and percent ──
  {
    assert.equal(houseStyleMode({}), 'auto');
    assert.deepEqual(['auto', 'on', 'off', ' OFF ', 'On'].map(HOUSE_STYLE => houseStyleMode({ HOUSE_STYLE })), ['auto', 'on', 'off', 'off', 'on']);
    assert.equal(houseStyleMode({ HOUSE_STYLE: 'banana' }), 'auto');
    assert.equal(houseStylePercent({}), 100);
    assert.deepEqual(['0', '10', '55.9', '100', '250', '-5', 'x', '', 30].map(HOUSE_STYLE_PERCENT => houseStylePercent({ HOUSE_STYLE_PERCENT })),
      [0, 10, 55, 100, 100, 0, 100, 100, 30]);
    assert.deepEqual(houseStyleStatus({ HOUSE_STYLE: 'off', HOUSE_STYLE_PERCENT: '25' }), { mode: 'off', percent: 25, version: 'v1' });
    assert.deepEqual(houseStyleStatus({}), { mode: 'auto', percent: 100, version: 'v1' });
    assert.deepEqual(['off', 'OFF', ' off ', 'client', 'Client', 'on', 'auto', 'v1', '', null, undefined].map(parseStyleHeader),
      ['off', 'off', 'off', 'client', 'client', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto']);
    ok('HOUSE_STYLE (auto, on, off; unknown means auto), HOUSE_STYLE_PERCENT (0 to 100; a bad value means 100) and the x-neuron-style request header parse to enums');
  }

  // ── The decision ──
  {
    assert.deepEqual(decide(agentBody()), { apply: true, reason: 'applied' });
    assert.equal(decide({ model: 'auto', messages: [user] }).reason, 'no_tools', 'plain chat is never touched');
    assert.equal(decide({ ...agentBody(), tools: [] }).reason, 'no_tools');
    assert.equal(decide(agentBody(), { env: { HOUSE_STYLE: 'off' } }).reason, 'mode_off', 'the kill switch');
    assert.equal(decide(agentBody(), { env: { HOUSE_STYLE: 'off' }, header: 'client' }).reason, 'mode_off');
    assert.equal(decide(agentBody(), { header: 'off' }).reason, 'opted_out', 'the per-request opt-out');
    assert.equal(decide(agentBody(), { env: { HOUSE_STYLE: 'on' }, header: 'off' }).reason, 'opted_out', 'on does not beat the opt-out');
    assert.equal(decide(agentBody(), { header: 'client' }).reason, 'client_marker');
    assert.equal(decide(agentBody(), { header: 'auto' }).apply, true);
    assert.equal(decide(agentBody({ tool_choice: 'auto' })).apply, true);
    assert.equal(decide(agentBody({ tool_choice: 'required' })).reason, 'forced_tool');
    assert.equal(decide(agentBody({ tool_choice: { type: 'function', function: { name: 'read_file' } } })).reason, 'forced_tool');
    assert.equal(decide(agentBody({ tool_choice: 'none' })).reason, 'tool_choice_none');
    assert.equal(decide(agentBody({ response_format: { type: 'json_object' } })).reason, 'json_mode');
    assert.equal(decide(agentBody({ response_format: { type: 'json_schema', json_schema: {} } })).reason, 'json_mode');
    assert.equal(decide(agentBody({ response_format: { type: 'text' } })).apply, true);
    assert.equal(decide(agentBody({ max_tokens: 256 })).reason, 'tiny_max_tokens', 'title and summary calls');
    assert.equal(decide(agentBody({ max_completion_tokens: 100 })).reason, 'tiny_max_tokens');
    assert.equal(decide(agentBody({ max_tokens: 257 })).apply, true);
    assert.equal(decide(agentBody({ max_tokens: 4096 })).apply, true);
    // A house style already there (ours, the client's marker line, or the bundled rules of builds
    // that predate the header): never paid for twice.
    const withSystem = text => agentBody({ messages: [{ role: 'system', content: text }, user] });
    assert.equal(decide(withSystem('Zero-X house style v1. Defaults only')).reason, 'client_marker');
    assert.equal(decide(withSystem('Be brief.\nNeuron house style v1 (client).')).reason, 'client_marker');
    assert.equal(decide(withSystem('- Ponytail: read first\n- AntiSlop: every choice has a purpose')).reason, 'client_marker');
    assert.equal(decide(withSystem('- Ponytail: read first')).apply, true, 'one label alone is not the marker');
    assert.equal(decide(withSystem('mentions AntiSlop: only')).apply, true);
    assert.equal(decide(agentBody({ messages: [{ role: 'developer', content: [{ type: 'text', text: 'Zero-X house style' }] }, user] })).reason,
      'client_marker', 'a developer message in parts');
    assert.equal(decide(agentBody({ messages: [{ role: 'system', content: 'ok' }, { role: 'user', content: 'Zero-X house style' }] })).apply, true,
      'a user who pastes the marker does not switch it off');
    assert.ok(carriesMarker([{ role: 'system', content: 'x Zero-X house style' }]) && !carriesMarker(undefined) && !carriesMarker([user]));
    ok('decision: applies to requests with tools only; skipped by HOUSE_STYLE=off, the x-neuron-style: off opt-out, the client marker (header, text, or both bundled labels in a system message), forced tool_choice, tool_choice none, JSON mode and max_tokens of 256 or less');
  }

  // ── Rollout percentage ──
  {
    const callers = Array.from({ length: 2000 }, (_, index) => `user-${index}-${(index * 2654435761) % 99991}`);
    for (const caller of callers.slice(0, 50)) assert.equal(rolloutBucket(caller), rolloutBucket(caller), 'stable');
    assert.ok(callers.every(caller => rolloutBucket(caller) >= 0 && rolloutBucket(caller) <= 99));
    const share = percent => callers.filter(caller => decide(agentBody(), { env: { HOUSE_STYLE_PERCENT: String(percent) }, caller }).apply).length / callers.length;
    assert.equal(share(0), 0);
    assert.equal(share(100), 1);
    assert.ok(Math.abs(share(10) - 0.1) < 0.04 && Math.abs(share(50) - 0.5) < 0.06, 'close to the asked share');
    // One caller is in or out for every turn of a conversation and the sets only grow with the percent.
    for (const caller of callers.slice(0, 100)) {
      const at = percent => decide(agentBody(), { env: { HOUSE_STYLE_PERCENT: String(percent) }, caller }).apply;
      if (at(10)) assert.ok(at(50) && at(100));
      assert.equal(at(30), at(30));
    }
    const out = callers.find(caller => rolloutBucket(caller) >= 5);
    assert.equal(decide(agentBody(), { env: { HOUSE_STYLE_PERCENT: '5' }, caller: out }).reason, 'rollout');
    assert.equal(decide(agentBody(), { env: { HOUSE_STYLE: 'on', HOUSE_STYLE_PERCENT: '5' }, caller: out }).apply, true, 'on ignores the percentage');
    ok('rollout: HOUSE_STYLE_PERCENT keys on a stable hash of the caller (0 and 100 are the edges, close to the share in between, sets only grow); on ignores it');
  }

  // ── Merging into the system prompt ──
  {
    const text = HOUSE_STYLE_TEXT;
    const base = deepFreeze(agentBody());
    const styled = applyHouseStyle(base);
    assert.equal(styled.messages.length, base.messages.length, 'merged into the one system message, no second system message');
    assert.equal(styled.messages[0].role, 'system');
    assert.equal(styled.messages[0].content, `${text}\n\nYou are Acme Agent.`, 'the preface is first, the client prompt follows');
    assert.equal(styled.messages[1], base.messages[1], 'later messages are the same objects');
    assert.equal(styled.tools, base.tools);
    assert.equal(styled.model, base.model);
    assert.equal(base.messages[0].content, 'You are Acme Agent.', 'the input is never mutated (it is frozen)');

    const noSystem = applyHouseStyle(deepFreeze({ model: 'auto', messages: [user], tools }));
    assert.deepEqual(noSystem.messages, [{ role: 'system', content: text }, user], 'no system message: one is added first');

    const parts = applyHouseStyle(deepFreeze({ model: 'auto', messages: [{ role: 'system', content: [{ type: 'text', text: 'Acme.' }] }, user], tools }));
    assert.deepEqual(parts.messages[0].content, [{ type: 'text', text: `${text}\n\n` }, { type: 'text', text: 'Acme.' }]);

    const developer = applyHouseStyle({ messages: [{ role: 'developer', content: 'Acme.' }, user] });
    assert.deepEqual(developer.messages[0], { role: 'developer', content: `${text}\n\nAcme.` }, 'a developer message keeps its role (the adapters map it to system)');

    assert.equal(applyHouseStyle({ messages: [{ role: 'system', content: '  ' }, user] }).messages[0].content, text, 'an empty system prompt is replaced, not padded');
    const late = applyHouseStyle({ messages: [user, { role: 'system', content: 'mid' }] });
    assert.deepEqual(late.messages.map(message => message.role), ['system', 'user', 'system'], 'a later system turn is left where it is');
    assert.equal(late.messages[2].content, 'mid');

    // The same first bytes for any user and any model: nothing per request goes into the preface.
    const one = applyHouseStyle({ model: 'groq/x', messages: [{ role: 'system', content: 'Prompt A' }, user], user: 'alice' });
    const two = applyHouseStyle({ model: 'gemini/y', messages: [{ role: 'system', content: 'Prompt B, longer' }, user], user: 'bob' });
    assert.equal(one.messages[0].content.slice(0, HOUSE_STYLE_BYTES + 2), two.messages[0].content.slice(0, HOUSE_STYLE_BYTES + 2));
    assert.equal(one.messages[0].content.slice(0, HOUSE_STYLE_BYTES), text);
    assert.ok(!JSON.stringify(two).includes('Prompt A'));
    ok('merge: the preface goes first in the one system message (string, parts, developer, empty or none: a new one), the input is never mutated, later messages are untouched, the first bytes are identical for every caller and model');
  }

  // ── Per adapter ──
  {
    const body = agentBody({ model: 'x' });
    const styled = applyHouseStyle(body);
    // OpenAI-compatible and strict providers: only role and content, developer mapped to system.
    for (const id of ['groq/openai/gpt-oss-120b', 'gemini/gemini-2.5-flash']) {
      const entry = catalogEntry(id);
      assert.ok(entry, id);
      const payload = buildUpstreamPayload(entry, styled, 1000);
      assert.deepEqual(Object.keys(payload.messages[0]).sort(), ['content', 'role'], `${id}: the system message has role and content only`);
      assert.equal(payload.messages.filter(message => message.role === 'system').length, 1, `${id}: one system message`);
      assert.equal(payload.messages[0].role, 'system');
      assert.ok(payload.messages[0].content.startsWith('Zero-X house style v1.'));
      assert.ok(payload.messages[0].content.endsWith('You are Acme Agent.'));
      assert.equal(payload.messages.length, body.messages.length);
    }
    const developer = buildUpstreamPayload(catalogEntry('groq/openai/gpt-oss-120b'), applyHouseStyle({ messages: [{ role: 'developer', content: 'Acme.' }, user] }), 1000);
    assert.equal(developer.messages[0].role, 'system');
    // The native Anthropic adapter: the preface leads the first top-level system block, which
    // keeps the cache breakpoint, and no system turn is added mid-conversation.
    const claude = catalogEntry('anthropic/claude-sonnet-5-5');
    assert.ok(claude, 'a Claude catalog row');
    const history = [{ role: 'system', content: 'You are Acme Agent.' }, user, { role: 'assistant', content: 'Reading.' }, { role: 'user', content: 'Go on.' }];
    const plain = toClaudeRequest(claude, buildUpstreamPayload(claude, { messages: history, tools }, 4096)).body;
    const withStyle = toClaudeRequest(claude, buildUpstreamPayload(claude, applyHouseStyle({ messages: history, tools }), 4096)).body;
    assert.equal(withStyle.system.length, 1);
    assert.equal(withStyle.system[0].text, `${HOUSE_STYLE_TEXT}\n\nYou are Acme Agent.`);
    assert.deepEqual(withStyle.system[0].cache_control, { type: 'ephemeral' }, 'the breakpoint stays on the last system block');
    assert.deepEqual(withStyle.messages, plain.messages, 'the conversation turns are identical');
    assert.ok(withStyle.messages.every(message => message.role !== 'system'), 'no system turn mid-conversation');
    assert.deepEqual({ ...withStyle, system: null }, { ...plain, system: null }, 'nothing but the system text differs');
    const noSystem = toClaudeRequest(claude, buildUpstreamPayload(claude, applyHouseStyle({ messages: [user], tools }), 4096)).body;
    assert.deepEqual(noSystem.system.map(block => block.text), [HOUSE_STYLE_TEXT], 'a request with no system prompt gets one block');
    assert.deepEqual(noSystem.system[0].cache_control, { type: 'ephemeral' });
    const partsClaude = toClaudeRequest(claude, buildUpstreamPayload(claude, applyHouseStyle({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'Acme.' }] }, user], tools }), 4096)).body;
    assert.equal(partsClaude.system[0].text, `${HOUSE_STYLE_TEXT}\n\nAcme.`, 'parts are joined without gluing the preface to the client text');
    ok('every adapter: OpenAI-compatible, Gemini and Groq get one system message with role and content only; Claude gets the preface at the head of the first system block, cache_control kept, no mid-conversation system turn');
  }

  // ── Accounting ──
  {
    const price = { input_microusd_per_mtok: 1000000, output_microusd_per_mtok: 4000000 };
    const entry = { provider: 'groq', upstream_model: 'm' };
    const args = (usage, extra = {}) => settlementArgs({ reservationId: 'r', entry, pool: { tier: 'paid', price }, status: 'ok', promptEstimate: 900,
      usage, ...extra });
    const usage = { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300 };
    const withStyle = args(usage, { styleTokens: HOUSE_STYLE_TOKENS });
    const without = args({ ...usage, prompt_tokens: 2000 - HOUSE_STYLE_TOKENS, total_tokens: 2300 - HOUSE_STYLE_TOKENS });
    assert.equal(withStyle.p_prompt_tokens, 2000 - HOUSE_STYLE_TOKENS, 'the preface comes off the prompt side');
    assert.equal(withStyle.p_completion_tokens, 300);
    assert.deepEqual(withStyle, without, 'a request with the preface is settled like the same request without it');
    assert.ok(withStyle.p_cost_microusd < args(usage).p_cost_microusd, 'credits too');
    assert.equal(args(usage).p_prompt_tokens, 2000, 'no preface, no credit');
    assert.equal(args(usage, { styleTokens: 0 }).p_prompt_tokens, 2000);
    // Floor at zero.
    const small = args({ prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 }, { styleTokens: HOUSE_STYLE_TOKENS });
    assert.deepEqual([small.p_prompt_tokens, small.p_completion_tokens], [0, 9], 'never negative');
    // The cache split is clamped to what is left.
    const cached = args({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 50, cache_write_1h_tokens: 20 } },
      { styleTokens: HOUSE_STYLE_TOKENS });
    assert.equal(cached.p_prompt_tokens, 1000 - HOUSE_STYLE_TOKENS);
    assert.ok(cached.p_cache_read_tokens + cached.p_cache_write_tokens <= cached.p_prompt_tokens);
    assert.ok(cached.p_cache_read_tokens <= 900 && cached.p_cache_read_tokens >= 0);
    // Estimates never held the preface: no usage, usage flagged estimate, a bare total.
    assert.equal(args(undefined, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 900, 'no usage: the estimate from the client messages');
    assert.equal(args({ prompt_tokens: 900, completion_tokens: 0, estimate: true }, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 900);
    // normalizeCompletion flags its usage-less fallback `estimated`: the same, not reduced.
    assert.equal(args({ prompt_tokens: 900, completion_tokens: 3, total_tokens: 903, estimated: true }, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 900);
    assert.equal(args({ prompt_tokens: 120, completion_tokens: 3, total_tokens: 123, estimated: true }, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 120, 'a small estimate does not floor to 0');
    assert.equal(usageCountsPreface({ prompt_tokens: 5, estimated: true }), false);
    assert.equal(usageCountsPreface({ prompt_tokens: 5, estimated: false }), true);
    // clientEstimate pins an estimate to the client's prompt (the Workers AI adapter estimates from the payload it sent, preface included).
    assert.deepEqual(clientEstimate({ prompt_tokens: 1000, completion_tokens: 7, total_tokens: 1007, estimated: true }, 650), { prompt_tokens: 650, completion_tokens: 7, total_tokens: 657, estimated: true });
    assert.deepEqual(clientEstimate({ prompt_tokens: 1000, completion_tokens: 7, estimate: true }, 650).prompt_tokens, 650);
    const provider = { prompt_tokens: 1000, completion_tokens: 7, total_tokens: 1007 };
    assert.equal(clientEstimate(provider, 650), provider, 'provider usage is returned as it is');
    assert.equal(clientEstimate(undefined, 650), undefined);
    assert.equal(args({ total_tokens: 13 }, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 13, 'a bare total is not reduced below what was sent');
    assert.ok(usageCountsPreface({ prompt_tokens: 1 }) && usageCountsPreface({ total_tokens: 5, completion_tokens: 1 }));
    assert.ok(!usageCountsPreface({ total_tokens: 5 }) && !usageCountsPreface(null) && !usageCountsPreface({ estimate: true, prompt_tokens: 5 }));
    assert.equal(args(usage, { status: 'refunded', styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 0, 'refunds still bill nothing');
    // The same helper on a billableUsage result (the session-KV path).
    const billed = billableUsage(usage);
    assert.deepEqual(creditPreface(billed, usage, 100), { ...billed, prompt_tokens: 1900, total_tokens: 2200 });
    assert.equal(creditPreface(billed, usage, 0), billed);
    assert.equal(creditPreface(billableUsage(undefined, { prompt_tokens: 900 }), undefined, 345).prompt_tokens, 900);
    ok('accounting: the preface tokens come off the prompt side of settlement and credits (floor 0, cache split clamped); estimates (either flag spelling), bare totals and refunds are not reduced; same bill as the request without it');
  }

  // ── Through the gateway ──
  {
    const day = new Date().toISOString().slice(0, 10);
    const store = new Map();
    const session = { created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: day };
    for (const token of ['ses_user_a', 'ses_user_b', 'ses_user_c', 'ses_user_d']) store.set(token, JSON.stringify(session));
    const env = {
      ALLOW_ANONYMOUS_SESSIONS: 'true', GROQ_API_KEY: 'groq-test', GATEWAY_ADMIN_TOKEN: 'operator-token-0123456789abcdef012345',
      SESSIONS_KV: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) },
    };
    const MODEL = 'groq/openai/gpt-oss-120b';
    const sent = [];
    let usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 };
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://api.groq.com/')) throw new Error(`Unexpected outbound request: ${url}`);
      sent.push(init.body);
      if (JSON.parse(init.body).stream) {
        const events = [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }];
        return new Response(`${events.map(event => `data: ${JSON.stringify(event)}

`).join('')}data: [DONE]

`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json({ id: 'up', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage });
    };
    const post = (body, { token = 'ses_user_a', headers = {}, bindings = env } = {}) => app.request('https://zero-x.live/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, bindings);
    const upstream = () => JSON.parse(sent.at(-1));
    const system = 'You are Acme Agent.';
    const body = (extra = {}) => ({ model: MODEL, messages: [{ role: 'system', content: system }, user], tools, ...extra });

    const applied = await post(body());
    assert.equal(applied.status, 200);
    assert.equal(applied.headers.get(STYLE_HEADER), 'v1', 'the response header says it was added');
    // A browser client can read the header and send the opt-out: CORS allows and exposes it.
    assert.match(applied.headers.get('access-control-expose-headers') ?? '', /x-neuron-style/i, 'the response header is exposed to browsers');
    const preflight = await app.request('https://zero-x.live/v1/chat/completions', { method: 'OPTIONS', headers: {
      Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-neuron-style' } }, env);
    assert.ok(preflight.status < 300, `preflight status ${preflight.status}`);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-neuron-style/i, 'the opt-out request header passes a browser preflight');
    const appliedBody = upstream();
    assert.equal(appliedBody.messages[0].content, `${HOUSE_STYLE_TEXT}\n\n${system}`);
    assert.equal(appliedBody.messages.length, 2);
    assert.deepEqual(appliedBody.tools, tools);

    // Skipped requests reach the upstream exactly as before, and carry no header.
    const strip = parsed => ({ ...parsed, messages: parsed.messages.map((message, index) =>
      (index === 0 && message.content.startsWith(HOUSE_STYLE_TEXT) ? { ...message, content: message.content.slice(HOUSE_STYLE_TEXT.length + 2) } : message)) });
    const baseline = strip(appliedBody);
    for (const [name, response] of [
      ['opt-out header', await post(body(), { headers: { [STYLE_HEADER]: 'off' } })],
      ['kill switch', await post(body(), { bindings: { ...env, HOUSE_STYLE: 'off' } })],
      ['client header', await post(body(), { headers: { [STYLE_HEADER]: 'client' } })],
      ['percent 0', await post(body(), { bindings: { ...env, HOUSE_STYLE_PERCENT: '0' } })],
    ]) {
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get(STYLE_HEADER), null, `${name}: no header`);
      assert.deepEqual(upstream(), baseline, `${name}: the upstream payload is the one without the preface, byte for byte`);
      assert.equal(sent.at(-1), JSON.stringify(baseline), `${name}: same serialisation`);
    }
    const markerBody = body({ messages: [{ role: 'system', content: '- Ponytail: x\n- AntiSlop: y' }, user] });
    const marked = await post(markerBody);
    assert.equal(marked.headers.get(STYLE_HEADER), null);
    assert.equal(upstream().messages[0].content, '- Ponytail: x\n- AntiSlop: y', 'a client with its own rules is sent as it is');
    const plain = await post({ model: MODEL, messages: [user] });
    assert.equal(plain.headers.get(STYLE_HEADER), null);
    assert.deepEqual(upstream().messages, [user], 'plain chat is untouched');
    assert.equal((await post(body({ tool_choice: 'required' }))).headers.get(STYLE_HEADER), null);
    assert.equal(upstream().messages[0].content, system);
    assert.equal((await post(body({ tool_choice: 'auto' }))).headers.get(STYLE_HEADER), 'v1');

    // The header is present exactly when the preface was sent; also streamed.
    const streamedResponse = await post(body({ stream: true }));
    assert.equal(streamedResponse.headers.get(STYLE_HEADER), 'v1');
    assert.match(await streamedResponse.text(), /done/);
    assert.ok(upstream().messages[0].content.startsWith('Zero-X house style v1.'));

    // Two users, same first bytes upstream.
    await post(body({ messages: [{ role: 'system', content: 'Prompt for A' }, user] }), { token: 'ses_user_a' });
    const first = upstream().messages[0].content;
    await post(body({ messages: [{ role: 'system', content: 'Another prompt for B' }, user] }), { token: 'ses_user_b' });
    assert.equal(upstream().messages[0].content.slice(0, HOUSE_STYLE_BYTES), first.slice(0, HOUSE_STYLE_BYTES));

    // A secret is replaced before the preface goes on and never touches it.
    const groqKey = `gsk_${'Q9w8'.repeat(13)}`;
    await post(body({ messages: [{ role: 'system', content: system }, { role: 'user', content: `Use ${groqKey}` }] }));
    const scrubbed = upstream();
    assert.ok(!JSON.stringify(scrubbed).includes(groqKey) && /zxsecret_/.test(scrubbed.messages[1].content), 'the secret was scrubbed');
    assert.ok(scrubbed.messages[0].content.startsWith(HOUSE_STYLE_TEXT) && !HOUSE_STYLE_TEXT.includes('zxsecret'));

    // KV-path accounting: the preface is not billed.
    const tokensOf = token => JSON.parse(store.get(token)).tokens_used;
    usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 };
    const before = tokensOf('ses_user_c');
    await post(body(), { token: 'ses_user_c' });
    const afterApplied = tokensOf('ses_user_c');
    await post(body(), { token: 'ses_user_c', headers: { [STYLE_HEADER]: 'off' } });
    const afterOff = tokensOf('ses_user_c');
    assert.equal(afterApplied - before, 1040 - HOUSE_STYLE_TOKENS, 'with the preface: the provider count less the preface');
    assert.equal(afterOff - afterApplied, 1040, 'without it: the provider count');
    usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 };
    const beforeSmall = tokensOf('ses_user_d');
    await post(body(), { token: 'ses_user_d' });
    assert.equal(tokensOf('ses_user_d') - beforeSmall, 40, 'never below the completion tokens (the prompt side floors at 0)');

    // Operator /health.
    const health = async bindings => (await app.request('https://zero-x.live/health', { headers: { Authorization: `Bearer ${env.GATEWAY_ADMIN_TOKEN}` } }, bindings)).json();
    assert.deepEqual((await health(env)).house_style, { mode: 'auto', percent: 100, version: 'v1' });
    assert.deepEqual((await health({ ...env, HOUSE_STYLE: 'off', HOUSE_STYLE_PERCENT: '10' })).house_style, { mode: 'off', percent: 10, version: 'v1' });
    const anonymous = await (await app.request('https://zero-x.live/health', {}, env)).json();
    assert.ok(!('house_style' in anonymous), 'anonymous callers do not see it');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('gateway: x-neuron-style: v1 exactly when the preface was sent (absent for opt-out, kill switch, client marker, percent 0, no tools, forced tool); skipped payloads equal today byte for byte; same prefix for every user; scrubbing first; the KV bill leaves the preface out; operator /health shows house_style');
  }

  // ── Ledger settlement and failover through the gateway ──
  {
    const day = new Date().toISOString().slice(0, 10);
    const accountId = '12345678-1234-4234-8234-123456789abc';
    const { planPolicyRows } = await import('./contract-rows.mjs');
    const policyRows = await planPolicyRows();
    const store = new Map([['ses_acct', JSON.stringify({ created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: day,
      user_id: accountId, account_backed: true })]]);
    const env = { ALLOW_ANONYMOUS_SESSIONS: 'true', GROQ_API_KEY: 'groq-test', GEMINI_API_KEY: 'gemini-test', GEMINI_MODELS: 'gemini-2.5-flash', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test',
      SESSIONS_KV: { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) } };
    const rpcCalls = [];
    const bodies = [];
    let failFirst = false;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('/rest/v1/rpc/')) {
        const rpc = String(url).split('/').at(-1);
        const args = JSON.parse(options.body);
        rpcCalls.push([rpc, args]);
        if (rpc === 'zerox_get_account') return Response.json([{ clerk_id: accountId, plan: 'free', daily_requests: 1, daily_tokens_used: 0, last_usage_reset: day }]);
        if (rpc === 'zerox_plan_policies_v2') return Response.json(policyRows);
        if (rpc === 'zerox_reserve_v2') return Response.json([{ status: 'ok', reservation_id: `res-${rpcCalls.length}`, plan: 'free', remaining_requests: 90, remaining_tokens: 400000 }]);
        if (rpc === 'zerox_settle_v2') return Response.json([{ status: 'settled' }]);
        throw new Error(`Unexpected RPC ${rpc}`);
      }
      if (!['https://api.groq.com/', 'https://generativelanguage.googleapis.com/'].some(origin => String(url).startsWith(origin))) throw new Error(`Unexpected outbound request: ${url}`);
      bodies.push(options.body);
      if (failFirst && bodies.length === 1) return new Response('{"error":{"message":"busy"}}', { status: 503 });
      return Response.json({ id: 'up', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 50, total_tokens: 3050 } });
    };
    const post = (extra = {}, headers = {}) => app.request('https://zero-x.live/v1/chat/completions', { method: 'POST',
      headers: { Authorization: 'Bearer ses_acct', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'groq/openai/gpt-oss-120b', messages: [{ role: 'system', content: 'Acme.' }, user], tools, ...extra }) }, env);
    const settles = () => rpcCalls.filter(([rpc]) => rpc === 'zerox_settle_v2').map(([, args]) => args);
    const reserves = () => rpcCalls.filter(([rpc]) => rpc === 'zerox_reserve_v2').map(([, args]) => args);

    assert.equal((await post()).status, 200);
    assert.equal((await post({}, { [STYLE_HEADER]: 'off' })).status, 200);
    const [styled, plain] = settles();
    assert.equal(styled.p_prompt_tokens, 3000 - HOUSE_STYLE_TOKENS, 'ledger settlement leaves the preface out');
    assert.equal(plain.p_prompt_tokens, 3000);
    assert.equal(styled.p_completion_tokens, plain.p_completion_tokens);
    const [reserveStyled, reservePlain] = reserves();
    assert.equal(reserveStyled.p_tokens, reservePlain.p_tokens, 'the reservation is sized from the client messages, with or without the preface');

    // A failed first attempt that reported no usage: the retry sends the same preface.
    bodies.length = 0;
    failFirst = true;
    const retried = await post({ model: 'auto' });
    failFirst = false;
    assert.equal(retried.status, 200);
    assert.equal(bodies.length, 2, 'the first pool failed and a second one served');
    assert.ok(JSON.parse(bodies[0]).messages[0].content.startsWith(HOUSE_STYLE_TEXT));
    assert.equal(JSON.parse(bodies[0]).messages[0].content, JSON.parse(bodies[1]).messages[0].content, 'failover sends the same prefix');
    assert.equal(retried.headers.get(STYLE_HEADER), 'v1');
    const failedSettle = settles().find(args => args.p_status !== 'ok');
    assert.ok(failedSettle && failedSettle.p_prompt_tokens >= 0 && failedSettle.p_status === 'refunded', 'the failed attempt is refunded');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('ledger: settlement subtracts the preface from the prompt tokens, the reservation is unchanged, a failover attempt sends the same preface');
  }

  // ── Estimates, client aborts, failed attempts and context fit through the gateway ──
  {
    const day = new Date().toISOString().slice(0, 10);
    const accountId = '12345678-1234-4234-8234-123456789abc';
    const { planPolicyRows } = await import('./contract-rows.mjs');
    const policyRows = await planPolicyRows();
    const store = new Map([['ses_acct', JSON.stringify({ created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: day,
      user_id: accountId, account_backed: true })]]);
    for (const token of ['ses_kv_styled', 'ses_kv_off', 'ses_cf_styled', 'ses_cf_off', 'ses_fit_styled', 'ses_fit_off']) {
      store.set(token, JSON.stringify({ created: Date.now(), plan: 'free', requests: 0, tokens_used: 0, usage_day: day }));
    }
    const kv = { get: async key => store.get(key), put: async (key, value) => store.set(key, value), delete: async key => store.delete(key) };
    const ledgerEnv = { ALLOW_ANONYMOUS_SESSIONS: 'true', GROQ_API_KEY: 'groq-test', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', SESSIONS_KV: kv };
    const aiRuns = [];
    const kvEnv = { ALLOW_ANONYMOUS_SESSIONS: 'true', GROQ_API_KEY: 'groq-test', SESSIONS_KV: kv,
      AI: { run: async (model, payload) => { aiRuns.push({ model, payload }); return { response: 'done' }; } } };
    const rpcCalls = [];
    let upstream = 'no_usage';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('/rest/v1/rpc/')) {
        const rpc = String(url).split('/').at(-1);
        const args = JSON.parse(options.body);
        rpcCalls.push([rpc, args]);
        if (rpc === 'zerox_get_account') return Response.json([{ clerk_id: accountId, plan: 'free', daily_requests: 1, daily_tokens_used: 0, last_usage_reset: day }]);
        if (rpc === 'zerox_plan_policies_v2') return Response.json(policyRows);
        if (rpc === 'zerox_reserve_v2') return Response.json([{ status: 'ok', reservation_id: `res-${rpcCalls.length}`, plan: 'free', remaining_requests: 90, remaining_tokens: 400000 }]);
        if (rpc === 'zerox_settle_v2') return Response.json([{ status: 'settled' }]);
        throw new Error(`Unexpected RPC ${rpc}`);
      }
      if (!String(url).startsWith('https://api.groq.com/')) throw new Error(`Unexpected outbound request: ${url}`);
      if (upstream === 'hang') {
        return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      if (upstream === 'model_error') return new Response('{"error":{"code":"tool_use_failed","message":"Failed to call a function"}}', { status: 400, headers: { 'Content-Type': 'application/json' } });
      // A reply with no usage block at all (some OpenAI-compatible hosts).
      return Response.json({ id: 'up', choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });
    };
    const MODEL = 'groq/openai/gpt-oss-120b';
    const CF = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const messages = [{ role: 'system', content: 'Acme.' }, user];
    const post = (extra, { token = 'ses_acct', headers = {}, bindings = ledgerEnv, signal } = {}) => app.request('https://zero-x.live/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model: MODEL, messages, tools, ...extra }), signal }, bindings);
    const off = { [STYLE_HEADER]: 'off' };
    // Settlement arguments without the per-request id and the measured latency.
    const settles = () => rpcCalls.filter(([rpc]) => rpc === 'zerox_settle_v2').map(([, args]) => ({ ...args, p_reservation_id: null, p_latency_ms: 0 }));
    const tokensOf = token => JSON.parse(store.get(token)).tokens_used;
    const clientPrompt = estimatePromptTokens(messages, tools);
    assert.ok(clientPrompt < HOUSE_STYLE_TOKENS, 'a small prompt: taking the preface off an estimate would floor it to 0');

    // 1. A non-streaming reply with no usage block: normalizeCompletion estimates it from the
    //    client's messages, which never held the preface. Settled prompt = the client estimate.
    rpcCalls.length = 0;
    assert.equal((await post({})).status, 200);
    assert.equal((await post({}, { headers: off })).status, 200);
    const [estStyled, estOff] = settles();
    assert.equal(estStyled.p_prompt_tokens, clientPrompt, 'ledger: the styled prompt is the client estimate, not the estimate less the preface');
    assert.deepEqual(estStyled, estOff, 'and the whole settlement equals the unstyled request\'s');
    // The KV path.
    const bill = async (token, headers = {}) => { const before = tokensOf(token); await post({}, { token, bindings: kvEnv, headers }); return tokensOf(token) - before; };
    const kvStyled = await bill('ses_kv_styled');
    const kvOff = await bill('ses_kv_off', off);
    assert.equal(kvStyled, kvOff, 'KV: no usage block, the same bill with and without the preface');
    assert.ok(kvStyled >= clientPrompt, 'KV: never below the client prompt estimate');

    // 2. Workers AI estimates from the payload it sent, which holds the preface: pinned back to
    //    the client's prompt (clientEstimate), so the bill is the same with and without it.
    const cfBill = async (token, headers = {}) => {
      const before = tokensOf(token);
      aiRuns.length = 0;
      const response = await post({ model: CF }, { token, bindings: kvEnv, headers });
      assert.equal(response.status, 200, `${CF}: ${response.status}`);
      return { billed: tokensOf(token) - before, sent: aiRuns[0].payload.messages[0].content };
    };
    const cfStyled = await cfBill('ses_cf_styled');
    const cfOff = await cfBill('ses_cf_off', off);
    assert.ok(cfStyled.sent.startsWith('Zero-X house style v1.') && cfOff.sent === 'Acme.', 'Workers AI was sent the preface only when styled');
    assert.equal(cfStyled.billed, cfOff.billed, 'Workers AI estimate: the preface is not charged, and not credited twice');
    assert.ok(cfStyled.billed >= clientPrompt);

    // 3. A client abort before the first byte settles the processed prompt: the full client
    //    estimate, never reduced by a preface the estimate does not hold.
    upstream = 'hang';
    rpcCalls.length = 0;
    for (const headers of [{}, off]) {
      const client = new AbortController();
      setTimeout(() => client.abort(), 40);
      const response = await post({}, { headers, signal: client.signal });
      assert.ok(response.status >= 400, 'the aborted request fails');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const [abortStyled, abortOff] = settles();
    assert.equal(abortStyled.p_status, 'error');
    assert.equal(abortStyled.p_prompt_tokens, clientPrompt, 'abort: the full client estimate is billed');
    assert.deepEqual(abortStyled, abortOff, 'abort: the same settlement with and without the preface');

    // 4. A model-side failure after the upstream ran the model (failed_upstream) settles the
    //    prompt it processed: again the client estimate, not less.
    upstream = 'model_error';
    rpcCalls.length = 0;
    await post({});
    await post({}, { headers: off });
    const failed = settles();
    assert.equal(failed.length, 2);
    assert.equal(failed[0].p_status, 'failed_upstream');
    assert.equal(failed[0].p_prompt_tokens, clientPrompt, 'failed attempt: the full client estimate');
    assert.deepEqual(failed[0], failed[1], 'failed attempt: the same settlement with and without the preface');

    // 5. Context fit counts the preface: a prompt that leaves room for 1,024 output tokens without
    //    it but not with it is not sent to a 24,000-token model at all.
    const entry = catalogEntry(CF);
    assert.equal(entry.context_window, 24000, 'the model this test is sized for');
    const sized = target => {
      let length = Math.floor(target * 3.5);
      const build = () => [{ role: 'system', content: 'Acme.' }, { role: 'user', content: 'x'.repeat(length) }];
      while (estimatePromptTokens(build(), tools) > target) length--;
      while (estimatePromptTokens(build(), tools) < target) length++;
      return build();
    };
    const nearLimit = sized(entry.context_window - 1100);
    const room = entry.context_window - estimatePromptTokens(nearLimit, tools);
    assert.ok(room >= 1024, 'it fits without the preface');
    assert.ok(room - HOUSE_STYLE_TOKENS < 1024, 'and does not with it');
    aiRuns.length = 0;
    const fitsOff = await post({ model: CF, messages: nearLimit, max_tokens: 2000 }, { token: 'ses_fit_off', bindings: kvEnv, headers: off });
    assert.equal(fitsOff.status, 200, 'without the preface the request is served');
    assert.equal(aiRuns.length, 1);
    aiRuns.length = 0;
    const tooBig = await post({ model: CF, messages: nearLimit, max_tokens: 2000 }, { token: 'ses_fit_styled', bindings: kvEnv });
    assert.ok(tooBig.status >= 400 && tooBig.status < 500, `with the preface counted the request is refused before any upstream call (status ${tooBig.status})`);
    assert.equal(tooBig.headers.get(STYLE_HEADER), null);
    assert.equal(aiRuns.length, 0, 'the model was never asked');
    globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    ok('regressions: a reply with no usage block (Groq-style and Workers AI) is billed the client estimate with and without the preface; a client abort and a failed attempt settle the full client estimate; the context-window fit counts the preface');
  }

  // ── The A/B harness (scripts/style-ab.mjs): safe by default, offline ──
  {
    const { buildPlan, describePlan, execute, HARD_MAX_REQUESTS, loadTarget, main, parseArgs, summarize } = await import('./scripts/style-ab.mjs');
    const { TASKS, buildRequest, countLines, extractCode, grade, slopCount } = await import('./scripts/style-ab-tasks.mjs');
    const KEY = `nzx_${'a'.repeat(43)}`;
    const sink = () => { const lines = []; return { lines, write: text => { lines.push(String(text)); return true; } }; };
    const throws = async (fn, pattern, what) => { await assert.rejects(async () => fn(), pattern, what); };
    const MODEL = 'free/model';
    const targetsFile = body => ({ read: () => JSON.stringify(body) });

    // Arguments: a credential or a URL never goes on the command line.
    for (const argv of [['--token', KEY], [`--token=${KEY}`], [KEY], ['--api-key', 'x']]) assert.throws(() => parseArgs(argv), /credential never goes on the command line|unexpected argument/, argv.join(' '));
    assert.throws(() => parseArgs(['--target', 'local', '--bogus', '1']), /unknown flag/);
    assert.throws(() => loadTarget('https://staging.example.com'), /never a URL/);
    assert.throws(() => loadTarget('http://127.0.0.1:8787'), /never a URL/);

    // Targets: production in every spelling, plain http, IPs, missing allow-list.
    const entry = base => ({ staging: { base, models: [MODEL] } });
    for (const base of ['https://zero-x.live', 'https://ZERO-X.LIVE.', 'https://www.zero-x.live', 'https://neuron.zero-x.live', 'https://aws.zero-x.live', 'http://zero-x.live',
      'https://user@staging.example.com', 'https://staging.example.com:8443', 'https://203.0.113.5', 'https://gateway.example.com', 'http://staging.example.com']) {
      assert.throws(() => loadTarget('staging', targetsFile(entry(base))), /production host|https only|no userinfo|no port|no IP|not a staging host|not a loopback/, base);
    }
    assert.throws(() => loadTarget('staging', targetsFile({ staging: { base: 'https://gateway-staging.example.com' } })), /allow-list/);
    assert.throws(() => loadTarget('absent', targetsFile(entry('https://gateway-staging.example.com'))), /no target absent/);
    assert.equal(loadTarget('staging', targetsFile(entry('https://gateway-staging.example.com'))).origin, 'https://gateway-staging.example.com');
    assert.equal(loadTarget('local', { port: 9099 }).origin, 'http://127.0.0.1:9099');
    assert.equal(loadTarget('staging', targetsFile({ staging: { base: 'https://staging.example.com', models: [MODEL], max_requests: 9999 } })).maxRequests, HARD_MAX_REQUESTS, 'the file cannot raise the hard cap');

    // The plan: counts, alternation, caps, allow-list.
    const staging = loadTarget('staging', targetsFile(entry('https://gateway-staging.example.com')));
    const plan = buildPlan({ models: MODEL, tasks: 'py-pagination,go-reverse', repeat: '2' }, { target: staging });
    assert.equal(plan.total, 2 * 1 * 2 * 2);
    assert.deepEqual(plan.runs.map(run => run.arm), ['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A'], 'the first arm alternates');
    assert.deepEqual(new Set(plan.runs.map(run => run.model)), new Set([MODEL]));
    assert.throws(() => buildPlan({ models: 'other/model' }, { target: staging }), /allow-list/);
    assert.throws(() => buildPlan({}, { target: staging }), /--models/);
    assert.throws(() => buildPlan({ models: MODEL, tasks: 'nope' }, { target: staging }), /unknown task/);
    assert.throws(() => buildPlan({ models: MODEL, repeat: '3' }, { target: staging }), /above the cap of 40/, 'the default cap is 40 and a plan above it is refused, not trimmed');
    assert.throws(() => buildPlan({ models: MODEL, 'max-requests': '401' }, { target: staging }), /between|from 1 to 400/);
    assert.throws(() => buildPlan({ models: MODEL, repeat: '11', tasks: 'go-reverse' }, { target: staging }), /--repeat/);
    assert.equal(buildPlan({ models: MODEL, 'max-requests': '22' }, { target: staging }).total, 22);
    assert.ok(describePlan(plan).startsWith('DRY RUN: nothing was sent'));

    // A dry run opens no socket and reads no credential (fetch throws, no token anywhere).
    const out = sink();
    const dry = await main(['--target', 'local', '--models', MODEL, '--tasks', 'go-reverse'], { env: {}, stdout: out, prompt: async () => { throw new Error('asked for a credential'); } });
    assert.equal(dry.code, 0);
    assert.match(out.lines.join(''), /DRY RUN/);
    await throws(() => main(['--target', 'local', '--models', MODEL, '--tasks', 'go-reverse', '--execute'], { env: {}, stdout: sink() }), /--confirm must name the target/);
    await throws(() => main(['--target', 'local', '--models', MODEL, '--tasks', 'go-reverse', '--execute', '--confirm', 'staging'], { env: {}, stdout: sink() }), /--confirm must name the target/);
    await throws(() => main(['--target', 'local', '--models', MODEL, '--tasks', 'go-reverse', '--execute', '--confirm', 'local'], { env: { ZEROX_AB_TOKEN: 'ses_abc' }, stdout: sink(), ledger: false }), /session token/);

    // The tasks: every code task fails on its own starter text, and a good answer passes.
    for (const task of TASKS.filter(item => item.kind === 'code')) assert.equal(grade(task, { content: task.prompt }).pass, false, `${task.id} is not already satisfied by its prompt`);
    const task = id => TASKS.find(item => item.id === id);
    const write = content => ({ tool_calls: [{ function: { name: 'write_file', arguments: JSON.stringify({ path: 'f', content }) } }] });
    assert.equal(grade(task('py-pagination'), write('def paginate(items, page, per_page):\n    if page < 1:\n        raise ValueError("page")\n    start = (page - 1) * per_page\n    return items[start:start + per_page]\n')).pass, true);
    assert.equal(grade(task('py-pagination'), write('def paginate(items, page, per_page):\n    return items[page * per_page:]\n')).pass, false);
    assert.equal(grade(task('js-long-file'), write('const DEFAULTS = { timeout: 5000 };\nexport function post(path) {}\n')).pass, true);
    assert.equal(grade(task('go-reverse'), write('func Reverse(s string) string {\n\tr := []rune(s)\n\treturn string(r)\n}\n')).pass, true);
    assert.equal(grade(task('go-reverse'), { content: 'no code at all' }).pass, false);
    assert.equal(grade(task('py-timeout-units'), { content: '```python\ndef fetch_report(client, url, timeout=5):\n    return client.get(url, timeout=timeout * 1000)\n```' }).pass, true, 'fenced code is read too');
    assert.equal(countLines('# c\n\nx = 1\n// c\ny = 2\n  \n'), 2);
    assert.equal(extractCode({ tool_calls: [{ function: { arguments: '{bad' } }] }), '');
    assert.ok(slopCount('Lorem ipsum, revolutionize your seamless day, linear-gradient(red, blue)') >= 4);
    assert.equal(slopCount('A plain page for Trailhead.'), 0);
    const request = buildRequest(task('go-reverse'), MODEL);
    assert.deepEqual([Array.isArray(request.tools), request.tool_choice, request.max_tokens > 256], [true, 'auto', true], 'a tools request the gateway treats as a coding-agent request');
    assert.ok(!/Ponytail:|AntiSlop:|house style/i.test(JSON.stringify(request)), 'the request carries no marker');

    // A local stub gateway on loopback: arm B gets the header and a shorter answer when it "applies" the preface.
    const { createServer } = await import('node:http');
    let apply = true;
    let chats = 0;
    const answers = { 'go-reverse': ['func Reverse(s string) string {\n\tr := []rune(s)\n\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {\n\t\tr[i], r[j] = r[j], r[i]\n\t}\n\treturn string(r)\n}\n', 'func Reverse(s string) string {\n\tr := []rune(s)\n\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {\n\t\tr[i], r[j] = r[j], r[i]\n\t}\n\treturn string(r)\n}\n'],
      'py-pagination': ['def paginate(items, page, per_page):\n    """Return one page."""\n    if page < 1:\n        raise ValueError("page must be at least 1")\n    start = (page - 1) * per_page\n    end = start + per_page\n    return items[start:end]\n', 'def paginate(items, page, per_page):\n    if page < 1:\n        raise ValueError("page")\n    return items[(page - 1) * per_page:][:per_page]\n'] };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
        if (req.url === '/v1/models') {
          return json(200, { data: [{ id: MODEL, tiers: ['free'], available: true }, { id: 'paid/model', tiers: ['free', 'paid'], available: true }, { id: 'both/model', tiers: ['paid'], available: true }] });
        }
        chats++;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const optedOut = req.headers['x-neuron-style'] === 'off';
        const styled = apply && !optedOut;
        const id = Object.keys(answers).find(key => body.messages.at(-1).content.includes(key.replace('go-reverse', 'Reverse').replace('py-pagination', 'paginate'))) || 'go-reverse';
        const code = answers[id][styled ? 1 : 0];
        json(200, { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'f', content: code }) } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: (body.messages.length > 3 ? Math.ceil(JSON.stringify(body.messages).length / 3.5) : 1000) + (styled ? HOUSE_STYLE_TOKENS : 0), completion_tokens: styled ? 60 : 100, total_tokens: 0 } }, styled ? { 'x-neuron-style': 'v1' } : {});
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    globalThis.fetch = realFetch;
    try {
      const argv = extra => ['--target', 'local', '--port', String(port), '--tasks', 'go-reverse,py-pagination', '--repeat', '2', '--delay-ms', '0', ...extra];
      // Paid or unlisted models are refused before the first chat request.
      for (const model of ['paid/model', 'both/model', 'unlisted/model']) {
        chats = 0;
        await throws(() => main(argv(['--models', model, '--execute', '--confirm', 'local']), { env: { ZEROX_AB_TOKEN: KEY }, stdout: sink(), ledger: false }), /not a free, available model/, model);
        assert.equal(chats, 0, `${model}: nothing was sent`);
      }
      // A real run: 2 tasks x 1 model x 2 arms x 2 repeats.
      chats = 0;
      const output = sink();
      const file = `${process.env.TEMP || process.env.TMPDIR || '.'}/style-ab-check-${process.pid}.json`;
      const result = await main(argv(['--models', MODEL, '--execute', '--confirm', 'local', '--out', file]), { env: { ZEROX_AB_TOKEN: KEY }, stdout: output, ledger: false });
      assert.equal(result.code, 0);
      assert.equal(chats, 8);
      assert.equal(result.report.rows.length, 8);
      assert.ok(result.report.rows.every(row => row.pass && (row.arm === 'B') === (row.style_header === 'v1')), 'arm B carried the header, arm A did not');
      const [row] = result.report.summary;
      assert.equal(row.model, MODEL);
      assert.deepEqual([row.A.n, row.B.n, row.pairs], [4, 4, 4]);
      assert.equal(row.A.pass_rate, 1);
      assert.equal(row.A.prompt_tokens, 1000);
      assert.equal(row.B.prompt_tokens, 1000 + HOUSE_STYLE_TOKENS, 'provider basis counts the preface');
      assert.equal(row.B.billed_total, 1000 + 60, 'billed basis leaves it out');
      assert.equal(row.A.billed_total, 1100);
      assert.ok(row.B_over_A.billed_tokens < 1 && row.B_over_A.cost_tokens > 1, 'cheaper billed, dearer for Zero-X');
      assert.ok(row.B_over_A.lines <= 1 && row.B_over_A.pass_rate_points === 0);
      assert.ok(!JSON.stringify(result.report).includes(KEY), 'the credential is never in the report');
      assert.ok(!output.lines.join('').includes(KEY));
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).plan.runs, undefined);
      (await import('node:fs')).rmSync(file, { force: true });
      // Both shapes in one run: the loop shape carries a long prior conversation, so the preface is a small share of its cost.
      chats = 0;
      const both = await main(argv(['--models', MODEL, '--shapes', 'single,loop', '--context-tokens', '8000', '--execute', '--confirm', 'local']), { env: { ZEROX_AB_TOKEN: KEY }, stdout: sink(), ledger: false });
      assert.equal(both.code, 0);
      assert.equal(chats, 16, '2 tasks x 2 shapes x 2 arms x 2 repeats');
      const [single, loop] = both.report.summary;
      assert.deepEqual([single.shape, loop.shape, single.pairs, loop.pairs], ['single', 'loop', 4, 4]);
      assert.ok(single.B_over_A.cost_tokens > 1.2, `single-shot: the preface looks expensive on a tiny prompt (${single.B_over_A.cost_tokens})`);
      assert.ok(loop.B_over_A.cost_tokens > 1.02 && loop.B_over_A.cost_tokens < 1.08, `loop: the preface is a few percent of a long prompt (${loop.B_over_A.cost_tokens})`);
      assert.ok(loop.B_over_A.billed_tokens < 1 && loop.A.prompt_tokens > 7000, 'loop: billed is cheaper (the preface is left out, completions shorter) on a real-sized prompt');
      assert.notEqual(single.reading, loop.reading);
      assert.ok(!('gate' in both.report) && !JSON.stringify(both.report.summary).includes('"gate"'), 'no gate is computed');
      assert.match(both.report.note, /No gate is computed/);
      // The gateway under test is not applying the preface: the run stops at the first mismatch.
      apply = false;
      chats = 0;
      const stopped = await main(argv(['--models', MODEL, '--execute', '--confirm', 'local']), { env: { ZEROX_AB_TOKEN: KEY }, stdout: sink(), ledger: false });
      assert.equal(stopped.code, 2);
      assert.match(stopped.report.invalid, /arm B got x-neuron-style: \(absent\)/);
      assert.equal(chats, 2, 'two requests, not eight');
      // The fetch guard: only the target's origin is reachable during a run.
      await assert.rejects(async () => {
        const release = (await import('../../deploy/aws/abtest-guard.mjs')).installFetchGuard([`http://127.0.0.1:${port}`]);
        try { await fetch('https://example.com/'); } finally { release(); }
      }, /not one of this run's origins/);
    } finally {
      await new Promise(resolve => server.close(resolve));
      globalThis.fetch = async input => { throw new Error(`Unexpected outbound request: ${String(input?.url ?? input)}`); };
    }
    // summarize on its own: a failed request is an error, not a pass or a zero.
    const rows = [{ model: 'm', arm: 'A', task: 't', round: 0, kind: 'code', pass: true, prompt_tokens: 100, completion_tokens: 10, billed_total: 110, lines: 10 },
      { model: 'm', arm: 'B', task: 't', round: 0, kind: 'code', pass: false, prompt_tokens: 450, completion_tokens: 5, billed_total: 105, lines: 5 },
      { model: 'm', arm: 'B', task: 'u', round: 0, error: 'HTTP 503' }];
    const [summary] = summarize(rows);
    assert.deepEqual([summary.B.n, summary.B.errors, summary.B.pass_rate, summary.B_over_A.pass_rate_points], [2, 1, 0, -100]);
    assert.equal(summary.B_over_A.lines, 0.5);
    // The loop shape: the same task after a long, fixed prior conversation, for cost.
    {
      const { buildLoopRequest, LOOP_MAX_TOKENS, LOOP_MIN_TOKENS } = await import('./scripts/style-ab-tasks.mjs');
      for (const target of [LOOP_MIN_TOKENS, 8000, LOOP_MAX_TOKENS]) {
        const loop = buildLoopRequest(task('go-reverse'), MODEL, { contextTokens: target });
        const estimate = estimatePromptTokens(loop.messages, loop.tools);
        assert.ok(Math.abs(estimate - target) / target < 0.03, `${target}: the prior conversation is about ${target} tokens (got ${estimate})`);
        assert.equal(JSON.stringify(loop), JSON.stringify(buildLoopRequest(task('go-reverse'), MODEL, { contextTokens: target })), 'byte-identical every time (a cacheable prefix)');
        assert.equal(loop.messages[0].role, 'system');
        assert.equal(loop.messages.at(-1).content, task('go-reverse').prompt, 'the task is the last turn');
        assert.ok(loop.messages.some(message => message.role === 'tool') && Array.isArray(loop.tools) && loop.tool_choice === 'auto');
        assert.ok(!/Ponytail:|AntiSlop:|house style|claude|anthropic/i.test(JSON.stringify(loop)), 'no marker and no vendor name in the transcript');
      }
      assert.throws(() => buildLoopRequest(task('go-reverse'), MODEL, { contextTokens: 4999 }), /contextTokens/);
      assert.throws(() => buildLoopRequest(task('go-reverse'), MODEL, { contextTokens: LOOP_MAX_TOKENS + 1 }), /contextTokens/);
      const both = buildPlan({ models: MODEL, tasks: 'go-reverse', shapes: 'single,loop' }, { target: staging });
      assert.deepEqual([both.total, both.shapes, both.contextTokens], [4, ['single', 'loop'], 8000]);
      assert.deepEqual(new Set(both.runs.map(run => run.shape)), new Set(['single', 'loop']));
      assert.deepEqual(buildPlan({ models: MODEL, tasks: 'go-reverse' }, { target: staging }).shapes, ['single'], 'single-shot is the default');
      assert.throws(() => buildPlan({ models: MODEL, shapes: 'long' }, { target: staging }), /unknown shape/);
      assert.throws(() => buildPlan({ models: MODEL, shapes: 'loop', 'context-tokens': '30000' }, { target: staging }), /--context-tokens/);
      assert.throws(() => buildPlan({ models: MODEL, shapes: 'single,loop', repeat: '2' }, { target: staging }), /above the cap of 40/, 'both shapes count against the cap');
      assert.match(describePlan(both), /loop \(about 8000 prompt tokens each, read cost here\)/);
    }
    // A pair whose arm A produced no code stays in the comparison: a failed pass, a no_code count,
    // and only the lines ratio is left out.
    {
      const [kept] = summarize([
        { model: 'm', shape: 'single', arm: 'A', task: 't', round: 0, kind: 'code', pass: false, prompt_tokens: 100, completion_tokens: 10, billed_total: 110, lines: 0 },
        { model: 'm', shape: 'single', arm: 'B', task: 't', round: 0, kind: 'code', pass: true, prompt_tokens: 450, completion_tokens: 40, billed_total: 140, lines: 6 }]);
      assert.deepEqual([kept.pairs, kept.A.no_code, kept.A.pass_rate, kept.B.pass_rate, kept.B_over_A.lines, kept.B_over_A.pass_rate_points], [1, 1, 0, 1, null, 100]);
      assert.equal(kept.B_over_A.billed_tokens, Number((140 / 110).toFixed(3)));
      assert.match(kept.reading, /Output length and pass rate only/);
    }
    assert.ok(typeof execute === 'function');
    ok('A/B harness: single and loop shapes (loop: a long fixed prior conversation, cost read there); no gate; pairs with no arm A code kept; dry run by default (no socket, no credential); credentials, URLs and unknown flags refused; production, http, IP and port targets refused; the cap is hard and refuses instead of trimming; only free listed models; arm and header must agree or the run stops; billed and provider-cost token bases; the report never holds the credential');
  }

  // ── Published text, notices and env examples match the code ──
  {
    const docs = read('../../docs.html');
    assert.ok(docs.includes('id="house-style"'), 'docs.html has the House style section');
    assert.ok(docs.includes(HOUSE_STYLE_TEXT), 'docs.html publishes the verbatim preface text');
    assert.ok(docs.includes('x-neuron-style') && docs.includes('x-neuron-style: off'), 'docs.html lists the header and the opt-out');
    assert.ok(/not (?:counted|charged)/i.test(docs.slice(docs.indexOf('id="house-style"'))), 'docs say it is not charged');
    for (const source of ['Ponytail', 'gstack', 'Nutlope/hallmark', 'miqdadbadjuber/anti-slop']) assert.ok(docs.includes(source), `docs credit ${source}`);
    assert.ok(!/All are MIT/i.test(docs) && /MIT licensed according to its project page/.test(docs), 'docs do not claim a Hallmark licence file they did not check');
    const trust = read('../../docs/trust.html');
    assert.ok(/house style/i.test(trust) && /not (?:counted|charged)/i.test(trust) && trust.includes('x-neuron-style'), 'the trust page discloses it');
    for (const page of ['privacy.html', 'terms.html']) assert.ok(/style preface/i.test(read(`../../${page}`)), `${page} mentions the style preface`);
    const notice = read('../../NOTICE');
    for (const source of ['DietrichGebert/ponytail', 'dkfish/ponytail', 'garrytan/gstack', 'Nutlope/hallmark', 'miqdadbadjuber/anti-slop', '388cbe3', 'MIT']) {
      assert.ok(notice.includes(source), `NOTICE credits ${source}`);
    }
    assert.ok(notice.includes('own words'), 'NOTICE says the text is our own');
    const flat = notice.split(/\s+/).join(' ');
    assert.ok(flat.includes('check-style-originality.mjs') && flat.includes('four words'), 'NOTICE says how the originality claim was checked');
    assert.ok(!/copies no text/i.test(flat), 'NOTICE does not claim more than the check shows');
    assert.ok(flat.includes('MIT licence according to its project page'), 'NOTICE says what is known about the Hallmark licence');
    assert.ok(read('docs/HOUSE_STYLE.md').includes('check-style-originality.mjs'), 'HOUSE_STYLE.md documents the originality check');
    const contract = read('docs/PLATFORM_CONTRACT.md');
    assert.ok(contract.includes('x-neuron-style'), 'the contract lists the header');
    const guide = read('docs/HOUSE_STYLE.md');
    for (const name of ['HOUSE_STYLE', 'HOUSE_STYLE_PERCENT', 'x-neuron-style', 'client']) assert.ok(guide.includes(name), `HOUSE_STYLE.md covers ${name}`);
    for (const file of ['.env.example', '.dev.vars.example', '../../deploy/aws/gateway.env.example']) {
      const text = read(file);
      assert.ok(/HOUSE_STYLE/.test(text), `${file} documents HOUSE_STYLE`);
    }
    assert.ok(read('../../.gitignore').includes('neuroncli/auth-server/scripts/style-ab-targets.local.json'), 'the local targets file is gitignored');
    assert.ok(JSON.parse(read('scripts/style-ab-targets.example.json')).staging.models.length, 'the example targets file lists an allow-list');
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts['check:server'].includes('check-house-style.mjs'), 'check:server runs this check');
    ok('the published text is the code\'s text; docs, trust, privacy, terms, NOTICE, the contract, HOUSE_STYLE.md and the env examples say what the gateway does; npm run check:server includes this check');
  }

  console.log(`PASS: house style (${passed.length} groups): frozen ${HOUSE_STYLE_BYTES}-byte text, decision and rollout, merge per adapter, accounting, headers, /health, published copy`);
} finally {
  globalThis.fetch = realFetch;
}
