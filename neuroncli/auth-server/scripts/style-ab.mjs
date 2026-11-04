// A/B harness for the Zero-X house style (docs/HOUSE_STYLE.md): the same coding and UI requests
// with and without the preface, compared on tokens in and out, lines of code and a static check
// pass rate. It helps answer one question before the preface is rolled out past a canary: does it
// save anything on the models we route to?
//
// What it can and cannot tell you (the report says the same in its "reading" fields):
//   - shape "single" (the default): one short request per task, a few hundred prompt tokens. Use it
//     for OUTPUT LENGTH and the static pass rate only. The preface roughly doubles such a prompt, so
//     its cost_tokens ratio says nothing about real agent loops, and its billed_tokens ratio
//     subtracts the preface from arm B by construction, so it reduces to a completion-length
//     comparison;
//   - shape "loop": the same task after a long, fixed prior conversation (--context-tokens, 5K to
//     20K, a transcript of file reads), with the preface as the first bytes of the system prompt like
//     a real agent step. Read COST here: cost_tokens (provider counts, preface included: what
//     Zero-X pays) and billed_tokens (preface left out: what the user is charged), separately. The
//     context is synthetic, so it is an indication, not the cost of real agent traffic;
//   - no pass or fail gate is computed. A cost claim needs the neuron repository's agent-loop evals
//     (evals/coding) on top of this, and "does it lower cost" is not settled by one ratio.
//
//   node scripts/style-ab.mjs --target local --models groq/openai/gpt-oss-120b        # dry run
//   node scripts/style-ab.mjs --target staging --models a,b --repeat 3 --execute --confirm staging
//   node scripts/style-ab.mjs --target staging --models a --shapes single,loop --context-tokens 12000 --repeat 2
//
// Safety, none of it switchable by a flag:
//   - a dry run is the default: it prints the plan and opens no socket and reads no credential;
//   - a real run needs --execute and --confirm <target> naming the same target;
//   - targets are NAMES: "local" (a loopback gateway, http://127.0.0.1:<port>) or an entry of
//     scripts/style-ab-targets.local.json (gitignored; see the .example.json), which lists the
//     allowed origin and the allowed models. A URL on the command line is refused. Production
//     hosts are refused in every spelling and a remote origin must be https with a staging label
//     (deploy/aws/abtest-guard.mjs, shared with the Worker-vs-EC2 harness);
//   - only free models: every model must be on the target's allow-list and listed by the
//     target's GET /v1/models with tiers exactly ["free"] and available, before the first request;
//   - the request cap is a hard cap of 400 requests; --max-requests can only lower it (default 40);
//     a plan above the cap is refused, never trimmed;
//   - the credential comes from ZEROX_AB_TOKEN or a hidden prompt, never argv; fetch reaches only
//     the target's origin and never follows a redirect;
//   - the run stops at the first response whose x-neuron-style header does not match its arm
//     (arm B must say v1, arm A must not carry it), because the comparison would be meaningless;
//   - results are printed, or written only to the --out file you name; nothing is stored in the repo.
// Model-written code is never executed: the pass rate is a static shape check (style-ab-tasks.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { hiddenPrompt, installFetchGuard, loopbackOrigin, readToken, refuseTokenArgs, reserveRequests, stagingOrigin } from '../../../deploy/aws/abtest-guard.mjs';
import { HOUSE_STYLE_TOKENS, HOUSE_STYLE_VERSION, STYLE_HEADER, STYLE_HEADER_OFF } from '../src/house-style.js';
import { buildLoopRequest, buildRequest, grade, LOOP_DEFAULT_TOKENS, LOOP_MAX_TOKENS, LOOP_MIN_TOKENS, TASKS } from './style-ab-tasks.mjs';

export const HARD_MAX_REQUESTS = 400;
export const DEFAULT_MAX_REQUESTS = 40;
export const MAX_REPEAT = 10;
const here = dirname(fileURLToPath(import.meta.url));
export const TARGETS_FILE = join(here, 'style-ab-targets.local.json');
export const SHAPES = Object.freeze(['single', 'loop']);
const FLAGS_WITH_VALUE = new Set(['target', 'models', 'tasks', 'shapes', 'context-tokens', 'repeat', 'max-requests', 'confirm', 'out', 'port', 'delay-ms', 'targets']);
const BOOLEAN_FLAGS = new Set(['execute', 'help']);

export function parseArgs(argv) {
  refuseTokenArgs(argv);
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2).split('=')[0];
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(name)) throw new Error(`unknown flag --${name}`);
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  return flags;
}

const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const wholeNumber = (value, name, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  return number;
};

// A target by name: { name, origin, models: allow-list | null (local: any, still checked as free) }.
export function loadTarget(name, { file = TARGETS_FILE, port = 8787, read = path => readFileSync(path, 'utf8') } = {}) {
  if (!name) throw new Error('--target <name> is required (a name from the targets file, or local)');
  if (/[/:]/.test(name)) throw new Error('--target takes a name from the targets file, never a URL');
  if (name === 'local') return { name, origin: loopbackOrigin(`http://127.0.0.1:${wholeNumber(port, 'port', 1024, 65535)}`), models: null, maxRequests: HARD_MAX_REQUESTS };
  let all;
  try { all = JSON.parse(read(file)); } catch (error) { throw new Error(`cannot read the targets file ${file}: ${error.code || error.message}`); }
  const raw = all?.[name];
  if (!raw || typeof raw !== 'object') throw new Error(`no target ${name} in ${file}`);
  const models = Array.isArray(raw.models) ? raw.models.map(String).filter(Boolean) : [];
  if (!models.length) throw new Error(`target ${name}: models (the allow-list of free model ids) is required`);
  const origin = /^http:\/\//i.test(String(raw.base)) ? loopbackOrigin(raw.base) : stagingOrigin(raw.base, `${name}.base`);
  return { name, origin, models, maxRequests: Math.min(HARD_MAX_REQUESTS, Math.max(1, Number(raw.max_requests) || DEFAULT_MAX_REQUESTS)) };
}

// The plan: what would be sent. Pure; the dry run prints it.
export function buildPlan(flags, { target = loadTarget(flags.target, { file: flags.targets || TARGETS_FILE, port: flags.port ?? 8787 }) } = {}) {
  const models = list(flags.models);
  if (!models.length) throw new Error('--models <id[,id]> is required (free model ids)');
  if (target.models) for (const model of models) if (!target.models.includes(model)) throw new Error(`model ${model} is not on target ${target.name}'s allow-list`);
  const known = new Map(TASKS.map(task => [task.id, task]));
  const ids = flags.tasks ? list(flags.tasks) : TASKS.map(task => task.id);
  const tasks = ids.map(id => known.get(id) || (() => { throw new Error(`unknown task ${id} (${[...known.keys()].join(', ')})`); })());
  const shapes = [...new Set(flags.shapes ? list(flags.shapes) : ['single'])];
  for (const shape of shapes) if (!SHAPES.includes(shape)) throw new Error(`unknown shape ${shape} (${SHAPES.join(', ')})`);
  if (!shapes.length) throw new Error('--shapes needs single, loop or both');
  const contextTokens = wholeNumber(flags['context-tokens'] ?? LOOP_DEFAULT_TOKENS, 'context-tokens', LOOP_MIN_TOKENS, LOOP_MAX_TOKENS);
  const repeat = wholeNumber(flags.repeat ?? 1, 'repeat', 1, MAX_REPEAT);
  const cap = flags['max-requests'] === undefined ? Math.min(DEFAULT_MAX_REQUESTS, target.maxRequests) : wholeNumber(flags['max-requests'], 'max-requests', 1, HARD_MAX_REQUESTS);
  if (cap > target.maxRequests) throw new Error(`--max-requests ${cap} is above target ${target.name}'s cap of ${target.maxRequests}`);
  const runs = [];
  let order = 0;
  for (let round = 0; round < repeat; round++) {
    for (const task of tasks) {
      for (const model of models) {
        for (const shape of shapes) {
          // Alternate which arm goes first so provider warm-up does not favour one arm.
          const arms = order++ % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
          for (const arm of arms) runs.push({ task: task.id, model, shape, arm, round });
        }
      }
    }
  }
  const total = runs.length;
  if (total > cap) throw new Error(`the plan is ${total} requests, above the cap of ${cap} (--max-requests, hard cap ${HARD_MAX_REQUESTS}); narrow --tasks, --models or --repeat`);
  return { target: target.name, origin: target.origin, models, tasks: tasks.map(task => task.id), shapes, contextTokens, repeat, cap, total, runs,
    arms: { A: `${STYLE_HEADER}: ${STYLE_HEADER_OFF} (no preface)`, B: 'default (the gateway adds the preface)' } };
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ratio = (b, a) => (a && b !== null ? Number((b / a).toFixed(3)) : null);

// What each shape can show; copied into every summary row so a report read alone is not misread.
export const READING = Object.freeze({
  single: 'Output length and pass rate only. These prompts are a few hundred tokens, which the preface roughly doubles, so cost_tokens here is not evidence about real agent loops, and billed_tokens leaves the preface out of arm B by construction (it compares completion length).',
  loop: 'Cost on a long fixed prior conversation, the preface being a small, cacheable prefix. Read cost_tokens (provider counts with the preface: what Zero-X pays) and billed_tokens (preface left out: what the user is charged) separately. The context is synthetic: an indication, confirmed only by agent-loop evals on real tasks.',
});

// One row per model, shape and arm, and the B-over-A ratios. Two token bases: "billed" leaves the
// preface out of arm B's prompt (what the user is charged), "cost" counts it (what Zero-X pays).
// A pair is every task and round where both arms answered; an arm A answer with no code stays in
// it (it is a failed pass-rate row and a no_code count) and only drops out of the lines ratio,
// which has nothing to divide by.
export function summarize(rows) {
  const cell = items => {
    const valid = items.filter(row => !row.error);
    return { n: items.length, errors: items.length - valid.length, pass_rate: valid.length ? Number((valid.filter(row => row.pass).length / valid.length).toFixed(3)) : null,
      no_code: valid.filter(row => !row.lines).length,
      prompt_tokens: median(valid.map(row => row.prompt_tokens)), completion_tokens: median(valid.map(row => row.completion_tokens)), cached_tokens: median(valid.map(row => row.cached_tokens ?? 0)),
      billed_total: median(valid.map(row => row.billed_total)), cost_total: median(valid.map(row => row.prompt_tokens + row.completion_tokens)),
      lines: median(valid.map(row => row.lines)), slop: median(valid.filter(row => row.kind === 'ui').map(row => row.slop)) };
  };
  const out = [];
  for (const model of [...new Set(rows.map(row => row.model))]) {
    for (const shape of [...new Set(rows.filter(row => row.model === model).map(row => row.shape ?? 'single'))]) {
      const mine = rows.filter(row => row.model === model && (row.shape ?? 'single') === shape);
      const a = cell(mine.filter(row => row.arm === 'A'));
      const b = cell(mine.filter(row => row.arm === 'B'));
      // Paired by task and round: the median of per-pair B/A ratios.
      const pairs = [];
      for (const rowA of mine.filter(row => row.arm === 'A' && !row.error)) {
        const rowB = mine.find(row => row.arm === 'B' && !row.error && row.task === rowA.task && row.round === rowA.round);
        if (!rowB) continue;
        const costA = rowA.prompt_tokens + rowA.completion_tokens;
        pairs.push({ tokens: rowA.billed_total ? rowB.billed_total / rowA.billed_total : null,
          cost: costA ? (rowB.prompt_tokens + rowB.completion_tokens) / costA : null, lines: rowA.lines ? rowB.lines / rowA.lines : null });
      }
      const of = key => ratio(median(pairs.map(pair => pair[key]).filter(value => value !== null)), 1);
      out.push({ model, shape, A: a, B: b, pairs: pairs.length, reading: READING[shape],
        B_over_A: { billed_tokens: of('tokens'), cost_tokens: of('cost'), lines: of('lines'),
          pass_rate_points: a.pass_rate === null || b.pass_rate === null ? null : Number(((b.pass_rate - a.pass_rate) * 100).toFixed(1)) } });
    }
  }
  return out;
}

// One request. Returns the row; arm A sends the opt-out header, arm B nothing.
async function send(plan, run, { token, fetchImpl, task }) {
  const request = run.shape === 'loop' ? buildLoopRequest(task, run.model, { contextTokens: plan.contextTokens }) : buildRequest(task, run.model);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (run.arm === 'A') headers[STYLE_HEADER] = STYLE_HEADER_OFF;
  const started = Date.now();
  const response = await fetchImpl(`${plan.origin}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(request) });
  const marker = response.headers.get(STYLE_HEADER);
  const row = { ...run, shape: run.shape ?? 'single', kind: task.kind, status: response.status, style_header: marker, latency_ms: Date.now() - started };
  if (!response.ok) return { ...row, error: `HTTP ${response.status}` };
  const json = await response.json();
  const usage = json.usage || {};
  const graded = grade(task, json.choices?.[0]?.message);
  const prompt = Number(usage.prompt_tokens) || 0;
  return { ...row, ...graded, prompt_tokens: prompt, completion_tokens: Number(usage.completion_tokens) || 0,
    cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
    billed_total: Math.max(0, prompt - (run.arm === 'B' ? HOUSE_STYLE_TOKENS : 0)) + (Number(usage.completion_tokens) || 0) };
}

const armMatches = (arm, marker) => (arm === 'B' ? marker === HOUSE_STYLE_VERSION : marker === null);

// Runs the plan. Throws before the first chat request when a model is not free; stops at the first
// arm/header mismatch.
export async function execute(plan, { token, fetchImpl = globalThis.fetch, delayMs = 1500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} }) {
  const listing = await fetchImpl(`${plan.origin}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!listing.ok) throw new Error(`GET /v1/models answered ${listing.status}`);
  const catalog = new Map(((await listing.json()).data || []).map(model => [model.id, model]));
  for (const id of plan.models) {
    const model = catalog.get(id);
    const free = Array.isArray(model?.tiers) && model.tiers.length === 1 && model.tiers[0] === 'free';
    if (!model || !free || model.available === false) throw new Error(`model ${id} is not a free, available model on ${plan.target}; refusing to send anything`);
  }
  const tasks = new Map(TASKS.map(task => [task.id, task]));
  const rows = [];
  let invalid = null;
  for (const run of plan.runs) {
    let row;
    try { row = await send(plan, run, { token, fetchImpl, task: tasks.get(run.task) }); } catch (error) { row = { ...run, error: error?.name || 'Error' }; }
    rows.push(row);
    log(`${run.arm} ${run.model} ${run.shape ?? 'single'} ${run.task}#${run.round} ${row.error ? `error ${row.error}` : `${row.pass ? 'pass' : 'fail'} ${row.prompt_tokens}+${row.completion_tokens} tokens ${row.lines} lines`}`);
    if (!row.error && !armMatches(run.arm, row.style_header)) {
      invalid = `arm ${run.arm} got ${STYLE_HEADER}: ${row.style_header ?? '(absent)'}; the gateway must run with HOUSE_STYLE=auto or on and the model must carry tools. Stopped after ${rows.length} requests.`;
      break;
    }
    if (delayMs) await sleep(delayMs);
  }
  return { rows, invalid, summary: summarize(rows.filter(row => armMatches(row.arm, row.style_header) || row.error)) };
}

export function describePlan(plan) {
  return [`DRY RUN: nothing was sent and no credential was read. Add --execute --confirm ${plan.target} to run it.`,
    `target ${plan.target} (${plan.origin}), models ${plan.models.join(', ')}`,
    `${plan.tasks.length} tasks x ${plan.models.length} models x ${plan.shapes.length} shapes x 2 arms x ${plan.repeat} repeats = ${plan.total} requests (cap ${plan.cap}, hard cap ${HARD_MAX_REQUESTS})`,
    `arm A: ${plan.arms.A}`, `arm B: ${plan.arms.B}`, `tasks: ${plan.tasks.join(', ')}`,
    `shapes: ${plan.shapes.map(shape => (shape === 'loop' ? `loop (about ${plan.contextTokens} prompt tokens each, read cost here)` : 'single (read output length here)')).join('; ')}`,
    `preface: ${HOUSE_STYLE_VERSION}, about ${HOUSE_STYLE_TOKENS} tokens; the gateway under test needs HOUSE_STYLE=auto or on`].join('\n');
}

export async function main(argv, { env = process.env, stdout = process.stdout, fetchImpl, prompt, ledger = true } = {}) {
  const flags = parseArgs(argv);
  if (flags.help) { stdout.write('see the header of scripts/style-ab.mjs and docs/HOUSE_STYLE.md\n'); return { code: 0 }; }
  const target = loadTarget(flags.target, { file: flags.targets || TARGETS_FILE, port: flags.port ?? 8787 });
  const plan = buildPlan(flags, { target });
  if (!flags.execute) { stdout.write(`${describePlan(plan)}\n`); return { code: 0, plan }; }
  if (flags.confirm !== target.name) throw new Error(`--confirm must name the target (${target.name}) to send requests`);
  const token = await readToken({ env, prompt: prompt ?? hiddenPrompt() });
  if (ledger && target.name !== 'local') reserveRequests(plan.total + 1);
  const release = fetchImpl ? () => {} : installFetchGuard([plan.origin]);
  try {
    const result = await execute(plan, { token, fetchImpl: fetchImpl || globalThis.fetch, delayMs: flags['delay-ms'] === undefined ? 1500 : wholeNumber(flags['delay-ms'], 'delay-ms', 0, 60000),
      log: line => stdout.write(`${line}\n`) });
    const report = { plan: { ...plan, runs: undefined }, invalid: result.invalid, summary: result.summary, rows: result.rows,
      note: 'static shape checks, not executed tests; a direction, not a measured effect size. No gate is computed: single-shot results show output length, loop results show cost on a synthetic context, and neither replaces agent-loop evals on real tasks.' };
    stdout.write(`${JSON.stringify({ invalid: report.invalid, summary: report.summary }, null, 2)}\n`);
    if (flags.out) writeFileSync(flags.out, JSON.stringify(report, null, 2));
    return { code: result.invalid ? 2 : 0, plan, report };
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(result => { process.exitCode = result.code; }, error => { console.error(`style-ab: ${error.message}`); process.exitCode = 1; });
}
