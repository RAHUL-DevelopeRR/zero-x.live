// The Zero-X house style (src/house-style.js, docs/HOUSE_STYLE.md), offline: the frozen text, the
// pure decision function, the system-message merge for every adapter, the accounting that leaves
// the preface out of what a user is charged, the response header and /health.
//   node check-house-style.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toClaudeRequest } from './src/anthropic-request.js';
import { settlementArgs } from './src/capacity.js';
import { catalogEntry } from './src/catalog.js';
import { billableUsage } from './src/pricing.js';
import { buildUpstreamPayload } from './src/providers.js';
import app from './src/index.js';
import {
  applyHouseStyle, carriesMarker, creditPreface, HOUSE_STYLE_BYTES, HOUSE_STYLE_TEXT, HOUSE_STYLE_TOKENS, HOUSE_STYLE_VERSION,
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
    assert.ok(/standard library or platform/.test(HOUSE_STYLE_TEXT) && /need not exist/.test(HOUSE_STYLE_TEXT), 'economy ladder');
    assert.ok(/small verified steps/.test(HOUSE_STYLE_TEXT) && /not invent APIs/.test(HOUSE_STYLE_TEXT), 'build discipline');
    assert.ok(/design direction/.test(HOUSE_STYLE_TEXT) && /lorem ipsum/.test(HOUSE_STYLE_TEXT), 'design taste');
    assert.ok(!/\d{4}-\d{2}-\d{2}|\$\{|\{\{|<[a-z]/i.test(HOUSE_STYLE_TEXT), 'no date, template slot or markup in it');
    assert.ok(!/claude|anthropic/i.test(HOUSE_STYLE_TEXT), 'no vendor name in text users can read');
    // Nothing in the text is taken from the public projects: no long run of their words.
    for (const phrase of ['Ponytail', 'gstack', 'Hallmark', 'AntiSlop', 'anti-slop']) assert.ok(!HOUSE_STYLE_TEXT.includes(phrase), phrase);
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
    assert.equal(args({ total_tokens: 13 }, { styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 13, 'a bare total is not reduced below what was sent');
    assert.ok(usageCountsPreface({ prompt_tokens: 1 }) && usageCountsPreface({ total_tokens: 5, completion_tokens: 1 }));
    assert.ok(!usageCountsPreface({ total_tokens: 5 }) && !usageCountsPreface(null) && !usageCountsPreface({ estimate: true, prompt_tokens: 5 }));
    assert.equal(args(usage, { status: 'refunded', styleTokens: HOUSE_STYLE_TOKENS }).p_prompt_tokens, 0, 'refunds still bill nothing');
    // The same helper on a billableUsage result (the session-KV path).
    const billed = billableUsage(usage);
    assert.deepEqual(creditPreface(billed, usage, 100), { ...billed, prompt_tokens: 1900, total_tokens: 2200 });
    assert.equal(creditPreface(billed, usage, 0), billed);
    assert.equal(creditPreface(billableUsage(undefined, { prompt_tokens: 900 }), undefined, 345).prompt_tokens, 900);
    ok('accounting: the preface tokens come off the prompt side of settlement and credits (floor 0, cache split clamped); estimates, bare totals and refunds are not reduced; same bill as the request without it');
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

  console.log(`PASS: house style (${passed.length} groups): frozen ${HOUSE_STYLE_BYTES}-byte text, decision and rollout, merge per adapter, accounting, headers, /health`);
} finally {
  globalThis.fetch = realFetch;
}
