#!/usr/bin/env node
// Worker vs EC2 A/B harness: proves (or refutes) that a /v1 chat request routed to EC2 runs its
// whole lifecycle on the Node server and costs the Worker proxy overhead only (AB-TEST.md, and
// README.md "A/B test: is the CPU problem gone?").
//
//   node deploy/aws/abtest.mjs plan --target <name> [--scenarios S1,S2,S6]      # prints the plan, sends nothing
//   node deploy/aws/abtest.mjs run  --target <name> [--scenarios ...]           # the same: a dry run
//   node deploy/aws/abtest.mjs run  --target <name> --execute --confirm <arm B Worker host>
//   node deploy/aws/abtest.mjs report <runDir> [--ec2 <samples.jsonl>] [--workers-logs <export>]
//
// Arm A is a Worker with no proxy switch (the chat pipeline on the Worker); arm B a Worker of the
// same commit whose EC2_PROXY_PREFIXES covers chat (forwarded to EC2). Targets are names only:
// `local` (everything on this machine, abtest-local.mjs) or one from the gitignored
// abtest-targets.local.json (staging only, abtest-guard.mjs). Dry run unless --execute; a remote
// run also needs --confirm with arm B's host typed out. The credential comes from a hidden
// prompt or ZEROX_AB_TOKEN, never argv. Operator actions (deploys, restarts, a stopped tunnel,
// secret changes) are printed as exact staging commands; the harness waits for Enter and records
// the time, and never runs them. Results go to %TEMP%/zerox-abtest/<runId>/ (requests.jsonl,
// cells.jsonl, tail.jsonl, synth.jsonl, usage.jsonl, summary.json): counts, timings and
// allow-listed headers, never a prompt, an answer or the credential.
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CAPS, capped, hiddenPrompt, installFetchGuard, loadTarget, loopbackOrigin, readToken, refuseTokenArgs, reserveRequests, tokenLabel,
} from './abtest-guard.mjs';
import { buildBody } from './abtest-payloads.mjs';
import { measureStream, percentile, slope } from './abtest-sse.mjs';
import { importWorkersLogs, startTail, WRANGLER } from './abtest-tail.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, '../../neuroncli/auth-server');
const DEFAULT_TARGETS = join(here, 'abtest-targets.local.json');
const DEFAULT_SCENARIOS = 'S1,S2,S6,S7,S8';
const sleep = ms => new Promise(done => setTimeout(done, ms));

// ── Scenarios ──
// Sizes for a staging run; `local` scales them down so check-abtest.mjs runs in seconds.
// kind: latency (A and B interleaved request by request), concurrency (blocks A B B A), long,
// cancel (the harness aborts), fault (the synthetic upstream fails), operator (an action by hand).
export const SCENARIOS = {
  S1: { title: 'tiny prompt', kind: 'latency', payload: 'tiny', tokens: 64, rate: 100, requests: 35, local: { requests: 6 } },
  S2: { title: 'realistic Neuron request (22 tools, 21 KB)', kind: 'latency', payload: 'realistic', tokens: 64, rate: 100, requests: 35,
    local: { requests: 6 } },
  S3: { title: 'large prompt', kind: 'latency', payload: 'large', sizes: [256, 768], tokens: 32, rate: 100, requests: 15,
    local: { requests: 2, sizes: [48, 96] } },
  S4: { title: 'long history (400 turns, 300 KB)', kind: 'latency', payload: 'history', kb: 300, tokens: 32, rate: 100, requests: 15,
    local: { requests: 2 } },
  S5: { title: 'many tools (110 tools and a 40 KB schema)', kind: 'latency', payload: 'tools', tokens: 32, rate: 100, requests: 15,
    local: { requests: 2 } },
  S6: { title: 'concurrency', kind: 'concurrency', payload: 'realistic', levels: [1, 2, 4, 8, 16, 32], tokens: 300, rate: 50,
    local: { levels: [1, 4], tokens: 30, rate: 200 } },
  S7: { title: 'long streams (30, 60, 90 s; 40 s quiet)', kind: 'long', payload: 'tiny', durations: [30, 60, 90], rate: 10, quietMs: 40000,
    requests: 3, local: { durations: [2], quietMs: 2500, requests: 1 } },
  S8: { title: 'client cancel (before the first token, mid-stream)', kind: 'cancel', payload: 'tiny', requests: 4,
    cases: [{ name: 'before-first-token', ttfbMs: 5000, abortMs: 2000, tokens: 50 }, { name: 'mid-stream', tokens: 600, rate: 10, abortMs: 20000 }],
    local: { requests: 1, cases: [{ name: 'before-first-token', ttfbMs: 1500, abortMs: 500, tokens: 20 }, { name: 'mid-stream', tokens: 100, rate: 20, abortMs: 1500 }] } },
  S9: { title: 'provider faults', kind: 'fault', payload: 'tiny', requests: 3,
    cases: [{ name: 'fail-503', fail: 503 }, { name: 'fail-429', fail: 429 }, { name: 'stall', tokens: 100, stallAfter: 40 }],
    local: { requests: 1, cases: [{ name: 'fail-503', fail: 503 }, { name: 'fail-429', fail: 429 }] } },
  S10: { title: 'deploys during streams', kind: 'operator', staging: true, steps: [
    { name: 'vm-deploy', streams: 8, streamSeconds: 90, command: t => `deploy/aws/push-release.sh --instance-id ${t.vm.instanceId} --known-hosts ${t.vm.knownHosts} --env-file ${t.vm.envFile}`,
      expect: 'complete' },
    { name: 'worker-deploy', streams: 4, streamSeconds: 60, command: t => `(cd neuroncli/auth-server && npx ${WRANGLER} deploy --config wrangler.staging.toml --name ${t.arms.B.script})`, expect: 'complete' },
  ] },
  S11: { title: 'EC2 instance restart', kind: 'operator', staging: true, steps: [
    { name: 'restart', streams: 4, streamSeconds: 60, command: t => `aws ec2-instance-connect ssh --instance-id ${t.vm.instanceId} --connection-type eice --os-user ubuntu $P -- sudo systemctl restart zerox-gateway@0 zerox-gateway@1`,
      expect: 'node-or-503' },
  ] },
  S12: { title: 'tunnel down for 60 s', kind: 'operator', staging: true, steps: [
    { name: 'tunnel-stop', command: t => `aws ec2-instance-connect ssh --instance-id ${t.vm.instanceId} --connection-type eice --os-user ubuntu $P -- 'sudo systemctl stop cloudflared; sleep 60; sudo systemctl start cloudflared'`,
      expect: 'node-or-503' },
  ] },
  S13: { title: 'misconfigured switch (fail closed)', kind: 'operator', staging: true, steps: [
    { name: 'secret-missing', command: t => `npx ${WRANGLER} secret delete EC2_PROXY_SECRET --name ${t.arms.B.script}`, expect: 'worker-503' },
    { name: 'secret-restored', command: t => `printf '%s' "$STAGING_PROXY_SECRET" | npx ${WRANGLER} secret put EC2_PROXY_SECRET --name ${t.arms.B.script}`, expect: 'node' },
    { name: 'origin-http', command: t => `printf '%s' 'http://${new URL(t.ec2Origin || 'https://aws-staging.invalid').host}' | npx ${WRANGLER} secret put EC2_PROXY_ORIGIN --name ${t.arms.B.script}`, expect: 'worker-503' },
    { name: 'origin-loop', command: t => `printf '%s' '${t.arms.B.base}' | npx ${WRANGLER} secret put EC2_PROXY_ORIGIN --name ${t.arms.B.script}`, expect: 'worker-503' },
    { name: 'origin-restored', command: t => `printf '%s' '${t.ec2Origin}' | npx ${WRANGLER} secret put EC2_PROXY_ORIGIN --name ${t.arms.B.script}`, expect: 'node' },
  ] },
  S14: { title: 'switch drill (the only way back to the Worker)', kind: 'operator', staging: true, steps: [
    { name: 'switch-off', command: t => `npx ${WRANGLER} secret delete EC2_PROXY_PREFIXES --name ${t.arms.B.script}`, expect: 'worker' },
    { name: 'switch-on', command: t => `printf '%s' '${new URL(t.arms.B.base).host}/v1/' | npx ${WRANGLER} secret put EC2_PROXY_PREFIXES --name ${t.arms.B.script}`, expect: 'node' },
  ] },
};
const PROBE_SECONDS = 60;

function scenarioSpec(id, target) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`unknown scenario ${id} (S1-S14)`);
  if (scenario.staging && target.kind === 'local') return null;
  if (target.database === 'shared-production' && !['S1', 'S2', 'S7'].includes(id)) {
    throw new Error(`${id} is refused on the shared-production profile (S1, S2 and S7 only)`);
  }
  return target.kind === 'local' ? { ...scenario, ...scenario.local } : scenario;
}

/** The cells of a run, with their request counts. Pure: no network, no clock. */
export function buildPlan(target, ids, caps) {
  const cells = [];
  const skipped = [];
  for (const id of ids) {
    const spec = scenarioSpec(id, target);
    if (!spec) { skipped.push(`${id} (staging only)`); continue; }
    const per = spec.requests ?? 0;
    if (spec.kind === 'latency') {
      for (const kb of spec.sizes || [spec.kb ?? null]) {
        cells.push({ id: kb && spec.sizes ? `${id}-${kb}k` : id, scenario: id, kind: 'latency', payload: spec.payload, kb, tokens: spec.tokens,
          rate: spec.rate, perArm: per });
      }
    } else if (spec.kind === 'concurrency') {
      for (const level of spec.levels.filter(level => level <= caps.concurrency)) {
        cells.push({ id: `${id}-n${level}`, scenario: id, kind: 'concurrency', payload: spec.payload, tokens: spec.tokens, rate: spec.rate,
          level, perArm: level * 2 });
      }
    } else if (spec.kind === 'long') {
      for (const seconds of spec.durations.filter(seconds => seconds <= CAPS.streamSeconds)) {
        cells.push({ id: `${id}-${seconds}s`, scenario: id, kind: 'latency', payload: spec.payload, tokens: seconds * spec.rate, rate: spec.rate, perArm: per });
      }
      cells.push({ id: `${id}-quiet`, scenario: id, kind: 'latency', payload: spec.payload, tokens: 20, rate: spec.rate, quietMs: spec.quietMs, perArm: per });
    } else if (spec.kind === 'cancel' || spec.kind === 'fault') {
      for (const each of spec.cases) {
        cells.push({ id: `${id}-${each.name}`, scenario: id, kind: spec.kind, payload: spec.payload, tokens: each.tokens ?? 32, rate: each.rate ?? 100,
          ttfbMs: each.ttfbMs, abortMs: each.abortMs, fail: each.fail, stallAfter: each.stallAfter, perArm: per });
      }
    } else if (spec.kind === 'operator') {
      for (const step of spec.steps) {
        cells.push({ id: `${id}-${step.name}`, scenario: id, kind: 'operator', step, expect: step.expect,
          perArm: (step.streams || 0) + PROBE_SECONDS });
      }
    }
  }
  const warmup = target.kind === 'local' ? 1 : 5;
  const total = cells.reduce((sum, cell) => sum + cell.perArm * (cell.kind === 'operator' ? 1 : 2), 0) + warmup * 2;
  return { cells, skipped, warmup, total };
}

function describePlan(target, plan, caps, out) {
  out(`Target: ${target.name} (${target.kind}${target.database ? `, database ${target.database}` : ''})`);
  if (target.kind === 'local') {
    out('  everything on this machine: synth-upstream, server.js (EC2 stand-in) and two Worker processes on 127.0.0.1');
  } else {
    out(`  arm A: ${target.arms.A.base}${target.arms.A.path} (Worker, no proxy switch)`);
    out(`  arm B: ${target.arms.B.base}${target.arms.B.path} (Worker forwarding chat to ${target.ec2Origin || 'its EC2_PROXY_ORIGIN'})`);
    for (const arm of ['A', 'B']) if (target.arms[arm].script) out(`  tail (with --tail): npx ${WRANGLER} tail ${target.arms[arm].script} --format json`);
  }
  out(`Caps: concurrency ${caps.concurrency}, ${caps.requestsPerRun} requests per run, ${caps.ratePerSecond} new requests/s, ramp ${caps.rampMs} ms`);
  for (const cell of plan.cells) {
    const what = cell.kind === 'operator' ? `operator step, expect ${cell.expect}` : `${cell.payload}${cell.kb ? ` ${cell.kb} KB` : ''}, ` +
      `${cell.tokens} tokens at ${cell.rate}/s${cell.level ? `, ${cell.level} at once` : ''}${cell.abortMs ? `, abort at ${cell.abortMs} ms` : ''}${cell.fail ? `, upstream ${cell.fail}` : ''}`;
    out(`  ${cell.id.padEnd(22)} ${String(cell.perArm).padStart(4)} per arm  ${what}`);
    if (cell.kind === 'operator') out(`      operator: ${cell.step.command(placeholders(target))}`);
  }
  for (const skipped of plan.skipped) out(`  skipped: ${skipped}`);
  out(`Requests: about ${plan.total} (${(plan.total / 1000).toFixed(1)}% of Workers Free's 100,000 a day${target.kind === 'local' ? ', not counted: local' : ''})`);
}

// Operator commands name the staging VM and Workers from the target, or a placeholder to fill in.
function placeholders(target) {
  return {
    ...target,
    arms: target.arms || { A: { base: '<arm A worker>', script: '<arm A script>' }, B: { base: '<arm B worker>', script: '<arm B script>' } },
    ec2Origin: target.ec2Origin || 'https://aws-staging.zero-x.live',
    vm: { instanceId: target.vm?.instanceId || '<staging instance id>', knownHosts: target.vm?.knownHosts || '<staging known_hosts>',
      envFile: target.vm?.envFile || '<staging gateway.env>' },
  };
}

// ── Running ──
function rateLimiter(perSecond) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await sleep(at - now);
  };
}

function shuffled(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class Breaker extends Error {}

async function execute(target, plan, caps, options, deps) {
  const { out } = deps;
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-') + '-' + Math.random().toString(16).slice(2, 6);
  const runDir = options.out ? resolve(options.out) : join(tmpdir(), 'zerox-abtest', runId);
  mkdirSync(runDir, { recursive: true });
  const write = (name, row) => appendFileSync(join(runDir, name), `${JSON.stringify(row)}\n`);
  let local = null;
  let uninstall = () => {};
  const tails = [];
  try {
    let arms;
    const tokens = {};
    if (target.kind === 'local') {
      local = await deps.startLocal();
      arms = local.arms;
      uninstall = installFetchGuard([...Object.values(arms).map(arm => loopbackOrigin(arm.base))]);
      for (const arm of ['A', 'B']) {
        const response = await fetch(`${arms[arm].base}/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machine_fingerprint: `abtest-${runId}-${arm}` }) });
        if (response.status !== 200) throw new Error(`local session on arm ${arm}: HTTP ${response.status}`);
        tokens[arm] = (await response.json()).session_token;
      }
    } else {
      arms = target.arms;
      uninstall = installFetchGuard([arms.A.base, arms.B.base, ...(target.synthBase ? [target.synthBase] : [])]);
      const token = await readToken({ env: deps.env, prompt: deps.prompt });
      tokens.A = tokens.B = token;
      out(`credential ${tokenLabel(token)} (never written)`);
      await preflight(target, token, options, out);
      reserveRequests(plan.total, { limit: capped('requestsPerDay', options['per-day']) });
      if (options.tail) {
        for (const arm of ['A', 'B']) {
          if (arms[arm].script) tails.push({ arm, tail: startTail(arms[arm].script, { cwd: gatewayDir, spawnImpl: deps.spawn, env: deps.env }) });
        }
        await sleep(5000);
      }
    }
    const model = local?.model || target.model;
    const limit = rateLimiter(caps.ratePerSecond);
    let seq = 0;
    let sent = 0;
    const recentB = [];
    const send = async (arm, cell, extra = {}) => {
      if (++sent > caps.requestsPerRun) throw new Breaker(`the run reached its cap of ${caps.requestsPerRun} requests`);
      await limit();
      const ab = `${runId}.${++seq}`;
      const body = buildBody(cell.payload || 'tiny', { model, kb: cell.kb ?? 256, nonce: ab, tokens: cell.tokens, rate: cell.rate,
        ttfbMs: cell.ttfbMs ?? 0, fail: cell.fail ?? null, stallAfter: cell.stallAfter ?? null, quietMs: cell.quietMs ?? 0 });
      const startedAt = Date.now();
      const metrics = await measureStream({ url: `${arms[arm].base}${arms[arm].path}?ab=${encodeURIComponent(ab)}`,
        headers: { Authorization: `Bearer ${tokens[arm]}` }, body, abortAfterMs: extra.abortMs });
      const row = { run: runId, ab, seq, arm, cell: cell.id, scenario: cell.scenario, kind: cell.kind, expect: cell.expect ?? null,
        step: extra.step ?? null, warmup: !!extra.warmup, startedAt, abortAt: extra.abortMs ? startedAt + extra.abortMs : null,
        bodyKb: +(Buffer.byteLength(body) / 1024).toFixed(1), tokensAsked: cell.tokens ?? null, ...metrics };
      write('requests.jsonl', row);
      breakers(row, recentB);
      return row;
    };
    // Warm-up, excluded from the statistics.
    for (let i = 0; i < plan.warmup; i++) for (const arm of ['A', 'B']) await send(arm, { id: 'warmup', scenario: 'warmup', payload: 'tiny', tokens: 8, rate: 200 }, { warmup: true });

    for (const cell of plan.cells) {
      out(`cell ${cell.id}`);
      const cpuBefore = local ? { A: await local.cpu('A'), B: await local.cpu('B') } : null;
      if (local) await local.ec2Mark();
      const counts = { A: 0, B: 0 };
      const tracked = async (arm, extra = {}) => { counts[arm]++; return send(arm, extra.cell || cell, extra); };
      if (cell.kind === 'latency' || cell.kind === 'cancel' || cell.kind === 'fault') {
        for (let i = 0; i < cell.perArm; i++) {
          for (const arm of shuffled(['A', 'B'])) await tracked(arm, { abortMs: cell.abortMs });
        }
      } else if (cell.kind === 'concurrency') {
        for (const arm of ['A', 'B', 'B', 'A']) {
          const ramp = Math.max(caps.rampMs, 0) / Math.max(cell.level, 1);
          await Promise.all(Array.from({ length: cell.level }, async (_, i) => { await sleep(i * ramp); return tracked(arm); }));
        }
      } else if (cell.kind === 'operator') {
        await operatorStep(target, cell, arms, tracked, deps);
      }
      const entry = { cell: cell.id, scenario: cell.scenario, counts };
      if (local) {
        const cpuAfter = { A: await local.cpu('A'), B: await local.cpu('B') };
        const perRequest = key => Object.fromEntries(['A', 'B'].map(arm => [arm,
          counts[arm] ? +((cpuAfter[arm][key] - cpuBefore[arm][key]) / counts[arm]).toFixed(3) : null]));
        // The Worker process's CPU (coarse on Windows), its event-loop active time (fine; the
        // adapter's work included on both arms) and the Worker fetch's synchronous part (for B,
        // the whole forwarding decision).
        entry.workerCpuMsPerRequest = perRequest('cpuMs');
        entry.workerActiveMsPerRequest = perRequest('activeMs');
        entry.appSyncMsPerRequest = perRequest('appSyncMs');
        const ec2 = await local.ec2Read();
        entry.ec2 = { cpuMsPerRequest: counts.B ? +(ec2.cpuMs / counts.B).toFixed(3) : null, elu: +ec2.elu.toFixed(3), lagP99Ms: +ec2.lagP99Ms.toFixed(1),
          maxRssMb: +ec2.maxRssMb.toFixed(0) };
      }
      write('cells.jsonl', entry);
      await sleep(target.kind === 'local' ? 50 : 5000);
    }
  } catch (error) {
    if (!(error instanceof Breaker)) throw error;
    out(`STOPPED: ${error.message}`);
    write('cells.jsonl', { stopped: error.message });
  } finally {
    for (const { arm, tail } of tails) {
      tail.stop();
      for (const event of tail.events) write('tail.jsonl', { arm, ...event });
      write('tail-fields.jsonl', { arm, fields: [...tail.fields] });
    }
    if (local) {
      for (const record of local.synth.records) write('synth.jsonl', record);
      await local.stop();
    }
    uninstall();
  }
  const summary = report(runDir, { localStandIn: target.kind === 'local' });
  printSummary(summary, out);
  out(`results: ${runDir}`);
  return summary;
}

// Stops the run on what no further request can fix: a B answer served by the Worker (fail open),
// a credential refused, or B failing more than 5% of 20 outside the failure scenarios.
function breakers(row, recentB) {
  if (row.warmup || row.kind === 'operator') return;
  if (row.arm === 'B' && row.status >= 200 && row.status < 300 && row.runtime !== 'node') {
    throw new Breaker(`FAIL-OPEN: arm B answered ${row.status} from runtime ${row.runtime ?? 'unknown'} (cell ${row.cell})`);
  }
  if (row.status === 401 || row.status === 403) throw new Breaker(`arm ${row.arm} got ${row.status} ${row.errorCode ?? ''}: credential or plan refused`);
  if (row.arm === 'B' && row.kind !== 'fault' && row.kind !== 'cancel') {
    recentB.push(row.status >= 500 || !!row.error);
    if (recentB.length > 20) recentB.shift();
    if (recentB.length === 20 && recentB.filter(Boolean).length > 1) throw new Breaker('arm B: more than 5% of the last 20 requests failed');
  }
}

async function preflight(target, token, options, out) {
  const account = await fetch(`${target.arms.A.base}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
  if (account.status !== 200) throw new Error(`pre-flight: /api/account answered ${account.status}`);
  const email = (await account.json()).user?.email;
  if (String(email).toLowerCase() !== target.accountEmail.toLowerCase()) {
    throw new Error('pre-flight: the credential is not the target\'s test account (account_email): stopped before any load');
  }
  const health = {};
  for (const arm of ['A', 'B']) health[arm] = await (await fetch(`${target.arms[arm].base}/health`)).json().catch(() => ({}));
  if (health.A.commit !== health.B.commit && !options['allow-commit-mismatch']) {
    throw new Error(`pre-flight: the Workers run different commits (${health.A.commit} and ${health.B.commit})`);
  }
  for (const arm of ['A', 'B']) {
    const probe = await fetch(`${target.arms[arm].base}${target.arms[arm].path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await probe.body?.cancel();
    const runtime = probe.headers.get('x-zerox-runtime');
    const want = arm === 'A' ? 'worker' : 'node';
    if (runtime !== want) throw new Error(`pre-flight: arm ${arm}'s chat path answered from ${runtime ?? 'an unknown runtime'}, expected ${want}`);
  }
  out(`pre-flight: test account, commit ${health.A.commit}, A runs on the Worker, B on EC2`);
}

// One operator step: background streams on B (when the step has them), the exact command, Enter,
// then one probe a second on B for PROBE_SECONDS, classified against the step's expectation.
async function operatorStep(target, cell, arms, send, deps) {
  const { step } = cell;
  // Streams of the step's length (10 tokens a second), and short probes.
  const stream = { ...cell, payload: 'tiny', tokens: (step.streamSeconds || 1) * 10, rate: 10 };
  const probe = { ...cell, payload: 'tiny', tokens: 4, rate: 100 };
  const streams = Array.from({ length: step.streams || 0 }, () => send('B', { step: step.name, cell: stream }));
  deps.out(`\n  ${cell.id}: run this now, then press Enter:\n    ${step.command(placeholders(target))}`);
  await deps.waitForEnter();
  const marked = Date.now();
  deps.out(`  recorded ${new Date(marked).toISOString()}; probing arm B for ${PROBE_SECONDS} s`);
  const probes = [];
  for (let i = 0; i < PROBE_SECONDS; i++) {
    probes.push(send('B', { step: step.name, cell: probe }));
    await sleep(1000);
  }
  await Promise.all([...streams, ...probes]);
}

// ── Report ──
const readJsonl = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const ok2xx = row => row.status >= 200 && row.status < 300;
const completed = row => ok2xx(row) && row.done && !row.errorEvent;

/** summary.json from a run directory (and the optional EC2 samples or Workers Logs export). */
export function report(runDir, { ec2File, workersLogsFile, localStandIn } = {}) {
  const rows = readJsonl(join(runDir, 'requests.jsonl')).filter(row => !row.warmup);
  const cells = readJsonl(join(runDir, 'cells.jsonl'));
  const tail = workersLogsFile ? importWorkersLogs(workersLogsFile) : readJsonl(join(runDir, 'tail.jsonl'));
  const synth = readJsonl(join(runDir, 'synth.jsonl'));
  const samples = ec2File ? readJsonl(ec2File) : [];
  const local = localStandIn ?? cells.some(cell => cell.workerCpuMsPerRequest);
  const byAb = new Map(tail.filter(event => event.ab).map(event => [event.ab, event]));
  const stat = (list, key) => ({ p50: percentile(list.map(row => row[key]), 50), p95: percentile(list.map(row => row[key]), 95),
    p99: percentile(list.map(row => row[key]), 99) });
  const perCell = {};
  for (const cellId of [...new Set(rows.map(row => row.cell))]) {
    perCell[cellId] = {};
    for (const arm of ['A', 'B']) {
      const list = rows.filter(row => row.cell === cellId && row.arm === arm);
      if (!list.length) continue;
      const joined = list.map(row => byAb.get(row.ab)).filter(Boolean);
      perCell[cellId][arm] = {
        n: list.length, lowN: list.length < 30, completion: +(list.filter(completed).length / list.length).toFixed(4),
        fiveXX: list.filter(row => row.status >= 500).length, html: list.filter(row => row.htmlError).length,
        runtimes: Object.fromEntries([...new Set(list.map(row => row.runtime))].map(runtime => [runtime, list.filter(row => row.runtime === runtime).length])),
        headers: stat(list, 'headersMs'), firstEvent: stat(list, 'firstEventMs'), firstToken: stat(list, 'firstTokenMs'), total: stat(list, 'totalMs'),
        workerCpu: joined.length ? { coverage: +(joined.length / list.length).toFixed(3), ...stat(joined, 'cpuMs'),
          max: Math.max(...joined.map(event => event.cpuMs ?? 0)), outcomes: Object.fromEntries([...new Set(joined.map(event => event.outcome))]
            .map(outcome => [outcome, joined.filter(event => event.outcome === outcome).length])) } : null,
      };
    }
  }
  const criteria = {};
  const set = (id, status, detail) => { criteria[id] = { status, detail }; };
  const B = rows.filter(row => row.arm === 'B');
  const A = rows.filter(row => row.arm === 'A');
  const steady = row => ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].includes(row.scenario);

  // P1: every B 2xx ran on Node, and the upstream saw the VM, not a Worker, for B's nonces.
  const b2xx = B.filter(row => ok2xx(row) && row.kind !== 'operator');
  const notNode = b2xx.filter(row => row.runtime !== 'node');
  const bNonces = new Set(B.map(row => row.ab));
  const witnessed = synth.filter(record => bNonces.has(record.nonce));
  const witnessWorker = witnessed.filter(record => record.caller !== 'vm');
  set('P1', !b2xx.length ? 'unmeasured' : notNode.length || witnessWorker.length ? 'fail' : 'pass',
    `${b2xx.length} B 2xx, ${notNode.length} not from node; upstream witness ${witnessed.length} B requests, ${witnessWorker.length} from a Worker`);

  // P2: Worker CPU for B is proxy overhead only.
  const bTail = B.map(row => byAb.get(row.ab)).filter(event => event && event.cpuMs !== null);
  if (bTail.length) {
    const p99 = percentile(bTail.map(event => event.cpuMs), 99);
    const coverage = bTail.length / B.length;
    const perKb = slope(B.filter(row => byAb.get(row.ab)?.cpuMs != null).map(row => [row.bodyKb, byAb.get(row.ab).cpuMs]));
    const perToken = slope(B.filter(row => byAb.get(row.ab)?.cpuMs != null).map(row => [row.tokens, byAb.get(row.ab).cpuMs]));
    const bad = bTail.filter(event => !['ok', 'canceled'].includes(event.outcome));
    set('P2', p99 <= 2 && coverage >= 0.95 && !bad.length && (perKb ?? 0) <= 0.002 && (perToken ?? 0) <= 0.0005 ? 'pass' : 'fail',
      `Workers cpuTime p99 ${p99} ms over ${bTail.length} joined (coverage ${(coverage * 100).toFixed(1)}%), slope ${perKb?.toFixed(5)} ms/KB, ` +
      `${perToken?.toFixed(6)} ms/token, ${bad.length} outcomes other than ok/canceled`);
  } else if (local) {
    // Steady cells only (a cancel or an upstream failure costs either arm little). B's forwarding
    // decision must stay under 1 ms and B's whole Worker process (its streaming adapter included)
    // must cost less than A's, which runs the pipeline.
    const measured = cells.filter(cell => cell.appSyncMsPerRequest?.B != null && cell.counts?.A && cell.counts?.B &&
      ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].includes(cell.scenario));
    const forwardMs = Math.max(...measured.map(cell => cell.appSyncMsPerRequest.B));
    const activeA = measured.reduce((sum, cell) => sum + cell.workerActiveMsPerRequest.A * cell.counts.A, 0) / measured.reduce((sum, cell) => sum + cell.counts.A, 0);
    const activeB = measured.reduce((sum, cell) => sum + cell.workerActiveMsPerRequest.B * cell.counts.B, 0) / measured.reduce((sum, cell) => sum + cell.counts.B, 0);
    set('P2', !measured.length ? 'unmeasured' : forwardMs <= 1 && activeB < activeA ? 'pass (stand-in)' : 'fail',
      `local stand-in: B's forwarding decision at most ${forwardMs.toFixed(3)} ms per request; Worker process event-loop time per request ` +
      `A ${activeA.toFixed(2)} ms, B ${activeB.toFixed(2)} ms (the local streaming adapter included on both)`);
  } else set('P2', 'unmeasured', 'no tail events with cpuTime joined: run with --tail, or pass --workers-logs');

  // P3: arm A's baseline, the 1102s it reproduces.
  const aTail = A.map(row => byAb.get(row.ab)).filter(Boolean);
  const exceeded = aTail.filter(event => event.outcome === 'exceededCpu').length + A.filter(row => row.htmlError).length;
  set('P3', A.length ? 'recorded' : 'unmeasured', `${A.length} A requests, ${exceeded} exceededCpu or 1102 pages, Workers cpuTime p99 ` +
    `${percentile(aTail.map(event => event.cpuMs), 99) ?? 'n/a'} ms`);

  // P4: B completes steady cells, with the same headers as A.
  const bSteady = B.filter(row => steady(row));
  const bDone = bSteady.filter(completed).length;
  const shapes = bSteady.filter(row => ok2xx(row) && (!/^text\/event-stream/.test(row.contentType || '') || !row.requestId));
  set('P4', !bSteady.length ? 'unmeasured' : bDone / bSteady.length >= 0.995 && !bSteady.some(row => row.status >= 500) && !shapes.length ? 'pass' : 'fail',
    `B completed ${bDone}/${bSteady.length} steady streams, ${bSteady.filter(row => row.status >= 500).length} 5xx, ${shapes.length} without event-stream or x-request-id`);

  // P5: first token on B within 150 ms of A's (S1, S2).
  const firstToken = (arm, list) => percentile(list.filter(row => row.arm === arm && ['S1', 'S2'].includes(row.scenario) && completed(row)).map(row => row.firstTokenMs), 50);
  const fa = firstToken('A', rows);
  const fb = firstToken('B', rows);
  set('P5', fa === null || fb === null ? 'unmeasured' : fb - fa <= 150 ? 'pass' : 'fail', `first token p50: A ${fa?.toFixed(0)} ms, B ${fb?.toFixed(0)} ms`);

  // P6: EC2 headroom.
  if (samples.length) {
    const cpu = samples.map(sample => sample.cpu.user + sample.cpu.system);
    const steal = Math.max(...samples.map(sample => sample.cpu.steal));
    const mem = Math.min(...samples.map(sample => sample.mem_available ?? 1));
    set('P6', percentile(cpu, 95) <= 0.8 && mem >= 0.4 && steal <= 0.02 ? 'pass' : 'fail',
      `host CPU p95 ${percentile(cpu, 95)}, MemAvailable min ${mem}, steal max ${steal}`);
  } else if (local) {
    const loaded = cells.filter(cell => cell.ec2);
    const elu = Math.max(...loaded.map(cell => cell.ec2.elu));
    const lag = Math.max(...loaded.map(cell => cell.ec2.lagP99Ms));
    set('P6', !loaded.length ? 'unmeasured' : elu <= 0.8 && lag <= 100 ? 'pass (stand-in)' : 'fail', `server.js ELU max ${elu}, event-loop p99 max ${lag} ms`);
  } else set('P6', 'unmeasured', 'no vm-sampler file (--ec2)');

  // P7: a cancelled stream closed at the upstream within 5 s.
  const cancelled = rows.filter(row => row.kind === 'cancel' && row.abortAt);
  const closes = cancelled.map(row => synth.find(record => record.nonce === row.ab)).filter(Boolean);
  const late = cancelled.filter(row => {
    const record = synth.find(each => each.nonce === row.ab);
    return record && (record.closed === null || record.closed - row.abortAt > 5000 || record.reason === 'done');
  });
  set('P7', !closes.length ? 'unmeasured' : late.length ? 'fail' : 'pass',
    `${cancelled.length} cancelled, ${closes.length} seen by the upstream, ${late.length} not closed within 5 s` +
    '; settlement: compare usage events per request_id (AB-TEST.md)');

  // P8: failures never reach the Worker's chat path: node 2xx or the JSON 503 only, never HTML.
  const failures = rows.filter(row => row.kind === 'operator' && row.expect === 'node-or-503');
  const wrong = failures.filter(row => !(ok2xx(row) && row.runtime === 'node') && !(row.status === 503 && /json/.test(row.contentType || '') && row.retryAfter));
  const misconfig = rows.filter(row => row.kind === 'operator' && row.expect === 'worker-503');
  const wrongMisconfig = misconfig.filter(row => !(row.status === 503 && row.runtime === 'worker' && row.retryAfter && !row.htmlError));
  set('P8', !failures.length && !misconfig.length ? 'unmeasured' : wrong.length || wrongMisconfig.length ? 'fail' : 'pass',
    `${failures.length} answers during restarts or a stopped tunnel (${wrong.length} wrong), ${misconfig.length} during misconfiguration (${wrongMisconfig.length} not the Worker's JSON 503)`);

  // P9: streams survive a VM deploy.
  const deploy = rows.filter(row => row.cell === 'S10-vm-deploy');
  set('P9', !deploy.length ? 'unmeasured' : deploy.every(row => completed(row)) ? 'pass' : 'fail',
    `${deploy.filter(completed).length}/${deploy.length} completed during the VM deploy`);

  const summary = { runDir, requests: rows.length, tailFields: readJsonl(join(runDir, 'tail-fields.jsonl')), cells: perCell, local: cells, criteria };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 1));
  return summary;
}

function printSummary(summary, out) {
  for (const [cell, arms] of Object.entries(summary.cells)) {
    for (const [arm, s] of Object.entries(arms)) {
      out(`  ${cell.padEnd(22)} ${arm} n=${String(s.n).padStart(3)} done ${(s.completion * 100).toFixed(1)}%  first token p50 ${s.firstToken.p50?.toFixed(0) ?? '-'} ms  ` +
        `total p95 ${s.total.p95?.toFixed(0) ?? '-'} ms  runtime ${JSON.stringify(s.runtimes)}${s.workerCpu ? `  cpu p99 ${s.workerCpu.p99} ms` : ''}`);
    }
  }
  for (const entry of summary.local) if (entry.workerCpuMsPerRequest) {
    out(`  ${String(entry.cell).padEnd(22)} Worker per request: event loop A ${entry.workerActiveMsPerRequest.A} ms, B ${entry.workerActiveMsPerRequest.B} ms; ` +
      `B forward ${entry.appSyncMsPerRequest.B} ms; EC2 CPU ${entry.ec2?.cpuMsPerRequest} ms`);
  }
  for (const [id, { status, detail }] of Object.entries(summary.criteria)) out(`${id} ${status.toUpperCase()}: ${detail}`);
}

// ── CLI ──
export async function main(argv, deps = {}) {
  const out = deps.out || (line => console.log(line));
  refuseTokenArgs(argv);
  const [command, ...rest] = argv;
  if (command === 'report') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ec2: { type: 'string' }, 'workers-logs': { type: 'string' } } });
    if (!positionals[0]) throw new Error('report <runDir>');
    const summary = report(resolve(positionals[0]), { ec2File: values.ec2, workersLogsFile: values['workers-logs'] });
    printSummary(summary, out);
    return summary;
  }
  if (command !== 'plan' && command !== 'run') {
    out('usage: abtest.mjs plan|run --target <name> [--scenarios S1,S2] [--execute --confirm <host>] | report <runDir>');
    return null;
  }
  const { values } = parseArgs({ args: rest, options: {
    target: { type: 'string' }, 'targets-file': { type: 'string' }, scenarios: { type: 'string' }, execute: { type: 'boolean' },
    confirm: { type: 'string' }, concurrency: { type: 'string' }, requests: { type: 'string' }, rate: { type: 'string' },
    'ramp-ms': { type: 'string' }, 'per-day': { type: 'string' }, out: { type: 'string' }, tail: { type: 'boolean' },
    upstream: { type: 'string' }, 'allow-commit-mismatch': { type: 'boolean' },
  } });
  const target = loadTarget(values.target, { file: values['targets-file'] ? resolve(values['targets-file']) : DEFAULT_TARGETS, read: deps.read });
  if (values.upstream === 'real' && !target.allowRealUpstream) throw new Error('--upstream real: the target does not allow it (allow_real_upstream)');
  const caps = {
    concurrency: capped('concurrency', values.concurrency, { targetMax: target.maxConcurrency }),
    requestsPerRun: capped('requestsPerRun', values.requests, { targetMax: target.maxRequestsPerRun }),
    ratePerSecond: capped('ratePerSecond', values.rate ?? (target.kind === 'local' ? CAPS.ratePerSecond : undefined)),
    rampMs: Math.max(CAPS.minRampMs, Number(values['ramp-ms']) || CAPS.minRampMs),
  };
  if (values.upstream === 'real') caps.concurrency = Math.min(caps.concurrency, 2);
  const ids = String(values.scenarios || DEFAULT_SCENARIOS).split(',').map(id => id.trim().toUpperCase()).filter(Boolean);
  const plan = buildPlan(target, ids, caps);
  if (plan.total > caps.requestsPerRun) out(`note: the plan needs about ${plan.total} requests; the run stops at ${caps.requestsPerRun} (--requests)`);
  describePlan(target, plan, caps, out);
  if (command === 'plan' || !values.execute) {
    out(`dry run: nothing was sent. To run: --execute --confirm ${target.kind === 'local' ? 'local' : new URL(target.arms.B.base).host}`);
    return { plan, dryRun: true };
  }
  const expected = target.kind === 'local' ? 'local' : new URL(target.arms.B.base).host;
  if (values.confirm !== expected) throw new Error(`--confirm must name ${expected} exactly`);
  return execute(target, plan, caps, values, {
    out, env: deps.env || process.env, spawn: deps.spawn || nodeSpawn, prompt: deps.prompt || hiddenPrompt(),
    startLocal: deps.startLocal || (async () => (await import('./abtest-local.mjs')).startLocal()),
    waitForEnter: deps.waitForEnter || (() => new Promise(done => {
      const rl = createInterface({ input: process.stdin });
      rl.once('line', () => { rl.close(); done(); });
    })),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(() => process.exit(0), error => { console.error(`abtest: ${error.message}`); process.exit(1); });
}
