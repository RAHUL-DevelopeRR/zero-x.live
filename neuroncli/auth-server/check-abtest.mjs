// The Worker-vs-EC2 A/B harness (deploy/aws/abtest.mjs, AB-TEST.md), offline: its safety rules
// and a local run.
//   - a dry run (plan, or run without --execute) opens no socket and starts no process;
//   - production hosts are refused in every spelling, staging hosts need a staging first label,
//     targets are names (never URLs), production Worker scripts are never tailed;
//   - a credential on argv is refused, a session token never comes from the environment;
//   - caps cannot be raised, the daily ledger holds, --confirm must name arm B's host, the
//     shared-production profile is a smoke test only;
//   - the fetch guard reaches only the run's origins and never follows a redirect;
//   - the report's criteria catch a fail-open B, a Worker CPU regression and a misconfiguration
//     answered by anything but the Worker's JSON 503;
//   - a local A/B (both arms, the EC2 stand-in and the synthetic upstream on loopback): B runs on
//     Node, A on the Worker, and B's forwarding decision costs the Worker under 1 ms.
//   node check-abtest.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, main, preflight, report, requireStagingWitness } from '../../deploy/aws/abtest.mjs';
import {
  CAPS, capped, installFetchGuard, loadTarget, readToken, refuseTokenArgs, reserveRequests, stagingOrigin, stagingScript,
} from '../../deploy/aws/abtest-guard.mjs';
import { buildBody, readDirective } from '../../deploy/aws/abtest-payloads.mjs';
import { jsonObjects, reduceEvent, startTail } from '../../deploy/aws/abtest-tail.mjs';

const passed = [];
const ok = name => { passed.push(name); console.log(`ok - ${name}`); };
const work = mkdtempSync(join(tmpdir(), 'zerox-check-abtest-'));
const KEY = `nzx_${'a'.repeat(43)}`;
const TARGETS = {
  staging: {
    arms: { A: { worker_base: 'https://zerox-a-staging.example.workers.dev', worker_script: 'zerox-a-staging' },
      B: { worker_base: 'https://zerox-b-staging.example.workers.dev', worker_script: 'zerox-b-staging' } },
    ec2_origin: 'https://aws-staging.zero-x.live', synth_base: 'https://synth-staging.zero-x.live', database: 'staging',
    account_email: 'abtest@example.com', max_concurrency: 8, max_requests_per_run: 500,
  },
  shared: {
    arms: { A: { worker_base: 'https://zerox-a-staging.example.workers.dev' }, B: { worker_base: 'https://zerox-b-staging.example.workers.dev' } },
    database: 'shared-production', account_email: 'abtest@example.com',
  },
};
const targetsFile = join(work, 'targets.json');
writeFileSync(targetsFile, JSON.stringify(TARGETS));

const realFetch = globalThis.fetch;
const refuseNetwork = () => { throw new Error('network used'); };
const lines = [];
const quiet = line => lines.push(line);

try {
  // ── Dry runs touch nothing ──
  {
    globalThis.fetch = refuseNetwork;
    const deps = { out: quiet, spawn: () => { throw new Error('process started'); }, startLocal: () => { throw new Error('local stack started'); },
      prompt: () => { throw new Error('prompted'); } };
    for (const args of [['plan', '--target', 'local', '--scenarios', 'S1,S2,S6,S7,S8,S9,S13'], ['run', '--target', 'local'],
      ['plan', '--target', 'staging', '--targets-file', targetsFile, '--scenarios', 'S1,S2,S10,S11,S12,S13,S14'],
      ['run', '--target', 'staging', '--targets-file', targetsFile, '--scenarios', 'S1', '--tail']]) {
      lines.length = 0;
      const result = await main(args, deps);
      assert.equal(result.dryRun, true, args.join(' '));
      assert.ok(lines.some(line => line.startsWith('dry run: nothing was sent')), args.join(' '));
    }
    assert.ok(lines.some(line => line.includes('tail (with --tail): npx wrangler@4.147.0 tail zerox-b-staging --format json')));
    // The staging plan prints the operator's commands for staging only.
    lines.length = 0;
    await main(['plan', '--target', 'staging', '--targets-file', targetsFile, '--scenarios', 'S13,S14'], deps);
    const commands = lines.filter(line => line.includes('operator:'));
    assert.equal(commands.length, 7);
    assert.ok(commands.every(line => /--name zerox-b-staging/.test(line)), 'every secret change names the staging Worker');
    assert.ok(!commands.some(line => /zero-x-callback-api\b|--name zero-x|aws\.zero-x\.live/.test(line)), 'never a production Worker or origin');
    globalThis.fetch = realFetch;
    ok('dry runs (plan, run without --execute) open no socket, start no process and never prompt; the plan lists cells, caps, quota share, the tail command and the staging-only operator commands');
  }

  // ── Hosts, targets and scripts ──
  {
    for (const value of ['https://zero-x.live', 'https://ZERO-X.LIVE.', 'https://zero-x.live:443/v1', 'https://user:pw@zero-x.live', 'http://zero-x.live',
      'https://aws.zero-x.live', 'https://www.zero-x.live/v1/', 'https://Dashboard.Zero-X.Live', 'https://neuron.zero-x.live', 'https://relay.zero-x.live',
      'https://104.21.32.1', 'https://[2606:4700::1]', 'https://api.zero-x.live', 'https://zerox-staging-a.example.workers.dev',
      'http://zerox-a-staging.example.workers.dev', 'https://zerox-a-staging.example.workers.dev:8443', 'https://u@zerox-a-staging.example.workers.dev',
      'not a url', 'ftp://staging.example.com']) {
      assert.throws(() => stagingOrigin(value), Error, value);
    }
    assert.throws(() => stagingOrigin('https://ZERO-X.live./x'), /production host/);
    for (const [value, origin] of [['https://zerox-b-staging.example.workers.dev/v1', 'https://zerox-b-staging.example.workers.dev'],
      ['https://AWS-Staging.zero-x.live', 'https://aws-staging.zero-x.live'], ['https://staging.example.com/', 'https://staging.example.com']]) {
      assert.equal(stagingOrigin(value), origin);
    }
    assert.throws(() => loadTarget('https://zerox-b-staging.example.workers.dev', { file: targetsFile }), /never a URL/);
    assert.throws(() => loadTarget('missing', { file: targetsFile }), /no target missing/);
    const read = targets => () => JSON.stringify(targets);
    assert.throws(() => loadTarget('t', { file: 'x', read: read({ t: { ...TARGETS.staging, arms: { ...TARGETS.staging.arms, B: { worker_base: 'https://zero-x.live' } } } }) }),
      /production host/);
    assert.throws(() => loadTarget('t', { file: 'x', read: read({ t: { ...TARGETS.staging, ec2_origin: 'https://aws.zero-x.live' } }) }), /production host/);
    assert.throws(() => loadTarget('t', { file: 'x', read: read({ t: { ...TARGETS.staging, account_email: '' } }) }), /account_email/);
    // The committed example is a valid staging target and names no production host.
    const exampleFile = new URL('../../deploy/aws/abtest-targets.example.json', import.meta.url);
    const example = loadTarget('staging', { file: exampleFile });
    assert.equal(example.arms.B.script, 'zerox-b-staging');
    assert.equal(example.vm.instanceId, 'i-0123456789abcdef0');
    assert.ok(!/\/\/(?:(?:www|dashboard|neuron|relay|aws)\.)?zero-x\.live\b/.test(readFileSync(exampleFile, 'utf8')), 'no production host in the example');
    const shared = loadTarget('shared', { file: targetsFile });
    assert.equal(shared.maxConcurrency, 2);
    assert.equal(shared.maxRequestsPerRun, 50);
    assert.throws(() => buildPlan(shared, ['S8'], { concurrency: 2 }), /shared-production/);
    for (const script of ['zero-x-callback-api', 'neuron-gateway', 'zerox-b', 'Zerox-B-Staging', 'a;rm -rf -staging', '']) {
      assert.throws(() => stagingScript(script), Error, script);
    }
    assert.equal(stagingScript('zerox-b-staging'), 'zerox-b-staging');
    // wrangler tail: a staging script only, and no credential in the child's environment.
    let spawned = null;
    const fake = (command, args, options) => { spawned = { command, args, options }; return { stdout: null, kill() {} }; };
    assert.throws(() => startTail('zero-x-callback-api', { spawnImpl: fake }), /production Worker/);
    assert.equal(spawned, null);
    startTail('zerox-b-staging', { spawnImpl: fake, env: { PATH: 'p', ZEROX_AB_TOKEN: KEY, CLOUDFLARE_API_TOKEN: 'cf', SOME_SECRET: 's' } });
    assert.deepEqual(spawned.args.slice(-4), ['tail', 'zerox-b-staging', '--format', 'json']);
    assert.ok(spawned.args.includes('wrangler@4.147.0'));
    assert.deepEqual(Object.keys(spawned.options.env), ['PATH'], 'no credential reaches the child');
    ok('production hosts refused in every spelling (case, trailing dot, port, userinfo, http, IP, non-staging label), targets are names with staging hosts and a test account, the shared-production profile is capped, production Worker scripts are never tailed and the tail gets no credential');
  }

  // ── Credentials, caps, the ledger and --confirm ──
  {
    for (const argv of [['run', '--token', KEY], ['run', `--token=${KEY}`], ['run', KEY], ['run', '--api-key', 'x'], ['run', `ses_${'x'.repeat(20)}`]]) {
      assert.throws(() => refuseTokenArgs(argv), /never goes on the command line/, argv.join(' '));
      await assert.rejects(main(argv, { out: quiet }), /never goes on the command line/);
    }
    assert.equal(await readToken({ env: { ZEROX_AB_TOKEN: KEY } }), KEY);
    await assert.rejects(readToken({ env: { ZEROX_AB_TOKEN: `ses_${'x'.repeat(30)}` } }), /hidden prompt/, 'a session token never from the environment');
    await assert.rejects(readToken({ env: { ZEROX_AB_TOKEN: 'sk-something' } }), /not an nzx_ API key/);
    await assert.rejects(readToken({ env: {} }), /no credential/);
    assert.equal(await readToken({ env: {}, prompt: async () => ` ses_${'y'.repeat(30)} ` }), `ses_${'y'.repeat(30)}`);
    await assert.rejects(readToken({ env: {}, prompt: async () => 'hunter2' }), /not an nzx_ key or a ses_ token/);

    assert.equal(capped('concurrency', undefined), 4);
    assert.equal(capped('concurrency', '16'), 16);
    assert.throws(() => capped('concurrency', String(CAPS.concurrency + 1)), /above the cap/);
    assert.throws(() => capped('concurrency', '9', { targetMax: 8 }), /above the cap of 8/);
    assert.throws(() => capped('requestsPerRun', '2001'), /above the cap/);
    assert.throws(() => capped('ratePerSecond', '0'), /positive/);
    await assert.rejects(main(['run', '--target', 'staging', '--targets-file', targetsFile, '--concurrency', '9'], { out: quiet }), /above the cap of 8/);
    const ledger = join(work, 'ledger.json');
    const day = new Date('2026-11-01T10:00:00Z');
    assert.equal(reserveRequests(2000, { path: ledger, limit: 3000, now: day }), 2000);
    assert.throws(() => reserveRequests(1001, { path: ledger, limit: 3000, now: day }), /leaves no room/);
    assert.equal(reserveRequests(1000, { path: ledger, limit: 3000, now: new Date('2026-11-02T00:00:01Z') }), 1000, 'a new UTC day');
    assert.throws(() => reserveRequests(1, { path: ledger, limit: CAPS.requestsPerDay + 1 }), /at most/);

    globalThis.fetch = refuseNetwork;
    for (const confirm of [undefined, 'zero-x.live', 'zerox-a-staging.example.workers.dev', 'ZEROX-B-STAGING.example.workers.dev']) {
      await assert.rejects(main(['run', '--target', 'staging', '--targets-file', targetsFile, '--scenarios', 'S1', '--execute',
        ...(confirm ? ['--confirm', confirm] : [])], { out: quiet, prompt: () => { throw new Error('prompted'); } }),
      /--confirm must name zerox-b-staging\.example\.workers\.dev exactly/);
    }
    await assert.rejects(main(['run', '--target', 'local', '--execute'], { out: quiet }), /--confirm must name local/);
    await assert.rejects(main(['plan', '--target', 'staging', '--targets-file', targetsFile, '--upstream', 'real'], { out: quiet }), /allow_real_upstream/);
    globalThis.fetch = realFetch;
    ok('a credential on argv is refused, a session token only from the hidden prompt; caps and target caps cannot be raised; the per-day ledger holds; --execute needs --confirm with arm B\'s exact host; a real upstream needs the target\'s consent');
  }

  // ── The fetch guard ──
  {
    const seen = [];
    const fakeTarget = { fetch: async (input, init) => { seen.push([String(input), init]); return new Response('ok'); } };
    const uninstall = installFetchGuard(['https://zerox-b-staging.example.workers.dev'], { target: fakeTarget });
    await fakeTarget.fetch('https://zerox-b-staging.example.workers.dev/v1/models', { redirect: 'follow' });
    assert.equal(seen[0][1].redirect, 'manual', 'a redirect is recorded, never followed');
    for (const url of ['https://zero-x.live/v1/models', 'https://zerox-a-staging.example.workers.dev/', 'http://zerox-b-staging.example.workers.dev/']) {
      await assert.rejects(fakeTarget.fetch(url), /not one of this run's origins/);
    }
    uninstall();
    assert.equal(seen.length, 1);
    ok('the fetch guard reaches only the run\'s origins and turns every redirect into manual');
  }

  // ── Payloads, the synthetic upstream's directive and the tail's reduction ──
  {
    for (const kind of ['tiny', 'realistic', 'large', 'history', 'tools']) {
      const body = JSON.parse(buildBody(kind, { model: 'auto', kb: 64, nonce: 'r.1', tokens: 7, fail: 503 }));
      assert.equal(body.stream, true);
      assert.deepEqual(readDirective(body), { nonce: 'r.1', tokens: 7, rate: 50, ttfb_ms: 0, quiet_ms: 0, tool_frags: 0, reasoning: 0, fail: 503 }, kind);
      if (body.tools) assert.ok(body.tools.length <= 128, 'within the gateway\'s tool limit');
    }
    assert.ok(Buffer.byteLength(buildBody('large', { kb: 256 })) > 256 * 1024);
    assert.ok(Buffer.byteLength(buildBody('history', { kb: 300 })) > 300 * 1024);
    const events = [];
    const feed = jsonObjects(event => events.push(reduceEvent(event)));
    const tailed = { outcome: 'exceededCpu', cpuTime: 12.5, wallTime: 40, exceptions: [{}], scriptVersion: { id: 'v1' },
      event: { request: { url: 'https://zerox-a-staging.example.workers.dev/v1/chat/completions?ab=run.7', headers: { 'cf-ray': 'abc-BOM', authorization: 'Bearer x' } },
        response: { status: 503 } }, logs: [{ message: ['EC2 proxy refused {"reason":"secret_missing","note":"}{"}'] }] };
    const text = JSON.stringify(tailed, null, 2);
    feed(text.slice(0, 50));
    feed(text.slice(50));
    assert.deepEqual(events, [{ ab: 'run.7', path: '/v1/chat/completions', status: 503, outcome: 'exceededCpu', cpuMs: 12.5, wallMs: 40,
      exceptions: 1, ray: 'abc-BOM', version: 'v1', reasons: ['secret_missing'] }], 'allow-listed fields only (no authorization)');
    ok('payloads carry the directive within the gateway\'s limits; tail events split across chunks are reduced to the allow-listed fields');
  }

  // ── The report's criteria ──
  {
    const dir = mkdtempSync(join(work, 'report-'));
    const row = (arm, extra) => ({ arm, cell: 'S2', scenario: 'S2', kind: 'latency', status: 200, runtime: arm === 'A' ? 'worker' : 'node', done: true,
      contentType: 'text/event-stream', requestId: `req_${extra.ab}`, firstTokenMs: arm === 'A' ? 300 : 340, totalMs: 900, bodyKb: 21, tokens: 64, ...extra });
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(row('A', { ab: `r.a${i}`, bodyKb: 10 + i }), row('B', { ab: `r.b${i}`, bodyKb: 10 + i }));
    const write = (name, list) => writeFileSync(join(dir, name), list.map(each => JSON.stringify(each)).join('\n') + '\n');
    // S8 on both arms: a cancel before the first token (no status, no request id) and one mid-stream.
    for (const arm of ['A', 'B']) {
      rows.push(row(arm, { ab: `r.${arm}c1`, cell: 'S8-before-first-token', scenario: 'S8', kind: 'cancel', status: null, requestId: null, done: false,
        contentType: null, abortAt: 1000 }));
      rows.push(row(arm, { ab: `r.${arm}c2`, cell: 'S8-mid-stream', scenario: 'S8', kind: 'cancel', done: false, abortAt: 2000 }));
    }
    write('requests.jsonl', rows);
    write('tail.jsonl', rows.map(each => ({ ab: each.ab, outcome: each.arm === 'A' && each.ab.endsWith('1') && each.kind !== 'cancel' ? 'exceededCpu' : 'ok',
      cpuMs: each.arm === 'A' ? 9 + each.bodyKb / 10 : 0.4 })));
    // The synth witness: every request reached it from its arm's runtime; cancels closed 500 ms after the abort.
    const witness = rows.map(each => ({ nonce: each.ab, caller: each.arm === 'B' ? 'vm' : 'worker',
      closed: each.abortAt ? each.abortAt + 500 : 5000, reason: each.abortAt ? 'client_closed' : 'done' }));
    write('synth.jsonl', witness);
    let summary = report(dir);
    assert.equal(summary.criteria.P1.status, 'pass');
    assert.equal(summary.criteria.P2.status, 'pass', summary.criteria.P2.detail);
    assert.match(summary.criteria.P3.detail, /4 exceededCpu/);
    assert.equal(summary.criteria.P4.status, 'pass');
    assert.equal(summary.criteria.P5.status, 'pass');
    assert.equal(summary.cells.S2.B.workerCpu.coverage, 1);
    // Settlement: one usage event per stream answered 200 (by id), and as many usage events as
    // witnessed requests (the cancels before the first token have no id); a missing or doubled one fails.
    const events = rows.map(each => ({ request_id: each.requestId ?? `req_unanswered_${each.ab}`, status: each.kind === 'cancel' ? 'error' : 'ok' }));
    write('usage.jsonl', events);
    assert.equal(report(dir).criteria.P7.status, 'pass', report(dir).criteria.P7.detail);
    write('usage.jsonl', [...events, events[3]]);
    assert.match(report(dir).criteria.P7.detail, /1 without exactly one usage event/);
    assert.equal(report(dir).criteria.P7.status, 'fail');
    write('usage.jsonl', events.slice(1));
    assert.equal(report(dir).criteria.P7.status, 'fail');
    // A cancel before the first token on B whose reservation never settled: no id to join, the count catches it.
    write('usage.jsonl', events.filter(each => each.request_id !== 'req_unanswered_r.Bc1'));
    assert.equal(report(dir).criteria.P7.status, 'fail', report(dir).criteria.P7.detail);
    assert.match(report(dir).criteria.P7.detail, /83 usage events for 84 witnessed requests/);
    // A cancel the witness has no record of fails; one closed late fails.
    write('usage.jsonl', events);
    write('synth.jsonl', witness.filter(each => each.nonce !== 'r.Bc1'));
    assert.equal(report(dir).criteria.P7.status, 'fail', report(dir).criteria.P7.detail);
    write('synth.jsonl', witness.map(each => (each.nonce === 'r.Bc2' ? { ...each, closed: 9000 } : each)));
    assert.equal(report(dir).criteria.P7.status, 'fail');
    // Without the witness neither P1 nor P7 can pass: usage events alone measure no cancel, and
    // nothing shows B's provider call ran on the VM.
    write('synth.jsonl', []);
    summary = report(dir);
    assert.equal(summary.criteria.P7.status, 'unmeasured', summary.criteria.P7.detail);
    assert.equal(summary.criteria.P1.status, 'unmeasured', summary.criteria.P1.detail);
    // The witness short of the B 2xx: P1 unmeasured, not passed.
    write('synth.jsonl', witness.filter(each => each.nonce !== 'r.b7'));
    assert.equal(report(dir).criteria.P1.status, 'unmeasured');
    // Arm A requests the Worker killed (a 1102 page) may or may not have settled: excused from the count.
    write('synth.jsonl', witness);
    write('requests.jsonl', rows.map(each => (each.ab === 'r.a5' ? { ...each, status: 503, htmlError: true, requestId: null } : each)));
    write('usage.jsonl', events.filter(each => each.request_id !== 'req_r.a5'));
    assert.equal(report(dir).criteria.P7.status, 'pass', report(dir).criteria.P7.detail);
    write('requests.jsonl', rows);
    write('usage.jsonl', []);
    // B's Worker CPU growing with the body: the CPU problem is still there.
    write('tail.jsonl', rows.map(each => ({ ab: each.ab, outcome: 'ok', cpuMs: 0.3 + each.bodyKb * 0.05 })));
    assert.equal(report(dir).criteria.P2.status, 'fail');
    // A B 2xx from the Worker is a fail-open; a misconfiguration answered by anything but the
    // Worker's JSON 503 fails P8, an HTML page during a restart too.
    write('tail.jsonl', []);
    write('requests.jsonl', [...rows, row('B', { ab: 'r.fo', runtime: 'worker' }),
      row('B', { ab: 'r.m1', cell: 'S13-secret-missing', scenario: 'S13', kind: 'operator', expect: 'worker-503', status: 503, runtime: 'worker',
        contentType: 'application/json', retryAfter: '30' }),
      row('B', { ab: 'r.m2', cell: 'S13-secret-missing', scenario: 'S13', kind: 'operator', expect: 'worker-503', status: 401, runtime: 'worker',
        contentType: 'application/json' })]);
    summary = report(dir);
    assert.equal(summary.criteria.P1.status, 'fail');
    assert.equal(summary.criteria.P8.status, 'fail', summary.criteria.P8.detail);
    write('requests.jsonl', [...rows, row('B', { ab: 'r.o1', cell: 'S12-tunnel-stop', scenario: 'S12', kind: 'operator', expect: 'node-or-503', status: 503,
      runtime: 'worker', contentType: 'application/json', retryAfter: '5' }), row('B', { ab: 'r.o2', cell: 'S12-tunnel-stop', scenario: 'S12', kind: 'operator',
      expect: 'node-or-503' })]);
    assert.equal(report(dir).criteria.P8.status, 'pass');
    write('requests.jsonl', [...rows, row('B', { ab: 'r.o3', cell: 'S12-tunnel-stop', scenario: 'S12', kind: 'operator', expect: 'node-or-503', status: 530,
      runtime: null, contentType: 'text/html', htmlError: true })]);
    assert.equal(report(dir).criteria.P8.status, 'fail');
    assert.ok(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).criteria.P8);
    ok('the report passes a clean run and fails a fail-open B, a missing or doubled usage event, B\'s Worker CPU growing with the body, and failures answered by anything but node or the JSON 503');
  }

  // ── Pre-flight: arm B must reach the staging VM before any load ──
  {
    const target = loadTarget('staging', { file: targetsFile });
    // A staging run without the witness stops before it opens a socket or prompts.
    assert.equal(requireStagingWitness(target, { ZEROX_AB_SYNTH_KEY: 'synth-key' }), 'synth-key');
    assert.throws(() => requireStagingWitness(target, {}), /ZEROX_AB_SYNTH_KEY/);
    assert.throws(() => requireStagingWitness({ ...target, ec2Origin: null }, { ZEROX_AB_SYNTH_KEY: 'k' }), /ec2_origin/);
    assert.throws(() => requireStagingWitness({ ...target, synthBase: null }, { ZEROX_AB_SYNTH_KEY: 'k' }), /synth_base/);
    globalThis.fetch = refuseNetwork;
    await assert.rejects(main(['run', '--target', 'staging', '--targets-file', targetsFile, '--scenarios', 'S1', '--execute', '--confirm',
      'zerox-b-staging.example.workers.dev', '--out', join(work, 'no-witness')], { out: quiet, env: { ZEROX_AB_TOKEN: KEY },
      prompt: () => { throw new Error('prompted'); } }), /ZEROX_AB_SYNTH_KEY/);
    globalThis.fetch = realFetch;

    // The two Workers and the staging synth, faked. `chat[arm]` answers an unauthenticated chat
    // POST; B's authenticated canary streams from node; `callers` is who the synth saw for it.
    const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    const invalidSession = runtime => json(401, { error: { code: 'invalid_session' } }, { 'X-Zerox-Runtime': runtime });
    const fake = ({ chat, caller = 'vm' }) => {
      let canary = null;
      return async (input, init = {}) => {
        const url = new URL(String(input));
        const auth = new Headers(init.headers).get('authorization');
        if (url.pathname === '/api/account') return json(200, { user: { email: 'abtest@example.com' } });
        if (url.pathname === '/health') return json(200, { commit: 'c0ffee' });
        if (url.pathname === '/stats') return json(200, { records: canary && caller ? [{ nonce: canary, caller, closed: 1, reason: 'done' }] : [] });
        const arm = url.host.startsWith('zerox-a-') ? 'A' : 'B';
        if (!auth) return chat[arm]();
        canary = url.searchParams.get('ab');
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Zerox-Runtime': 'node', 'X-Request-Id': 'req_canary' } });
      };
    };
    const good = { A: () => invalidSession('worker'), B: () => invalidSession('node') };
    const run = async options => {
      globalThis.fetch = fake(options);
      const rows = [];
      try {
        await preflight(target, KEY, {}, quiet, { runId: 'run1', synthKey: 'synth-key', write: (name, row) => rows.push(row), wait: async () => {} });
      } finally { globalThis.fetch = realFetch; }
      return rows;
    };
    const rows = await run({ chat: good });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ab, 'run1.canary');
    assert.equal(rows[0].warmup, true, 'the canary is kept out of the statistics');
    // B's Worker fell back to the production tunnel: the production VM refuses its forward.
    await assert.rejects(run({ chat: { ...good, B: () => json(503, { error: { code: 'service_unavailable' } },
      { 'X-Zerox-Runtime': 'node', 'X-Zerox-Refused': 'proxy_secret_mismatch' }) } }), /arm B's chat path answered 503 service_unavailable refused proxy_secret_mismatch/);
    await assert.rejects(run({ chat: { ...good, B: () => json(503, { error: { code: 'service_unavailable' } },
      { 'X-Zerox-Runtime': 'node', 'X-Zerox-Refused': 'misdirected_request' }) } }), /arm B/);
    // Arm A's Worker refuses chat (its switch is on): not a baseline.
    await assert.rejects(run({ chat: { ...good, A: () => json(503, { error: { code: 'service_unavailable' } }, { 'X-Zerox-Runtime': 'worker' }) } }),
      /arm A's chat path answered 503/);
    await assert.rejects(run({ chat: { ...good, B: () => invalidSession('worker') } }), /expected 401 invalid_session from node/);
    // B reaches a VM, but not the one that calls the staging synth.
    await assert.rejects(run({ chat: good, caller: null }), /never saw the canary/);
    await assert.rejects(run({ chat: good, caller: 'worker' }), /not the VM/);
    ok('pre-flight: a staging run needs ec2_origin, synth_base and ZEROX_AB_SYNTH_KEY; each arm must answer 401 invalid_session from its runtime, never a refusal (a B Worker on the production tunnel, an A Worker that refuses chat), and B\'s canary must reach the staging synth from the VM');
  }

  // ── A local A/B ──
  {
    lines.length = 0;
    const summary = await main(['run', '--target', 'local', '--scenarios', 'S2,S6,S8', '--execute', '--confirm', 'local', '--out', join(work, 'local')],
      { out: quiet });
    const rows = readFileSync(join(work, 'local', 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(each => !each.warmup);
    const answered = rows.filter(each => each.status === 200);
    assert.ok(answered.length >= 30, `${answered.length} streams answered`);
    for (const each of answered) assert.equal(each.runtime, each.arm === 'A' ? 'worker' : 'node', `${each.arm} ${each.cell}`);
    for (const id of ['P1', 'P4']) assert.equal(summary.criteria[id].status, 'pass', `${id}: ${summary.criteria[id].detail}`);
    // Locally every cancel is witnessed closing; settlement is not read (no database): a stand-in pass.
    assert.equal(summary.criteria.P7.status, 'pass (stand-in)', summary.criteria.P7.detail);
    assert.equal(summary.criteria.P2.status, 'pass (stand-in)', summary.criteria.P2.detail);
    const forward = summary.local.filter(entry => entry.appSyncMsPerRequest).map(entry => entry.appSyncMsPerRequest.B);
    assert.ok(forward.every(ms => ms < 1), `B's forwarding decision: ${forward.join(', ')} ms`);
    ok(`local A/B: ${answered.length} streams, A on the Worker and B on Node every time, B's forwarding decision at most ${Math.max(...forward).toFixed(3)} ms of the Worker's time; ${summary.criteria.P2.detail}`);
  }
} finally {
  globalThis.fetch = realFetch;
  rmSync(work, { recursive: true, force: true });
}

console.log(`PASS: A/B harness (${passed.length} groups): dry runs, host and script rules, credentials, caps, ledger and confirmation, fetch guard, payloads and tail, report criteria, a local A/B`);
