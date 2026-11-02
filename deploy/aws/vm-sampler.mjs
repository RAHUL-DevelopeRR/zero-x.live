#!/usr/bin/env node
// Read-only sampler for the staging VM during an A/B run (AB-TEST.md): one JSON line a second
// with the host's CPU (user, system, iowait and steal, which shows t4g credit throttling), memory,
// load and TCP sockets, each gateway instance's CPU and RSS (zerox-gateway@0 and @1, by MainPID),
// cloudflared's and zerox-synth's, and the time each instance's loopback /ready takes (a database
// round trip seen from the VM). It changes nothing, opens no port and reads no secret.
//
//   node vm-sampler.mjs [--seconds 3600] [--out samples.jsonl]      # on the VM, as ubuntu
// Copy the file back with the run's results and pass it to `abtest.mjs report --ec2 <file>`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { seconds: { type: 'string', default: '3600' }, out: { type: 'string' } } });
if (process.platform !== 'linux') { console.error('vm-sampler.mjs runs on the VM (Linux) only'); process.exit(2); }
const SECONDS = Math.min(Number(values.seconds) || 3600, 4 * 3600);
const UNITS = ['zerox-gateway@0', 'zerox-gateway@1', 'cloudflared', 'zerox-synth'];
const READY_PORTS = { 'zerox-gateway@0': 8790, 'zerox-gateway@1': 8791 };
const TICK = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout) || 100;
const read = path => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

function hostCpu() {
  const [, ...fields] = read('/proc/stat').split('\n')[0].trim().split(/\s+/);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields.map(Number);
  return { user: user + nice, system: system + irq + softirq, idle, iowait, steal };
}
function mainPids() {
  return Object.fromEntries(UNITS.map(unit => {
    const run = spawnSync('systemctl', ['show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8' });
    return [unit, Number(run.stdout?.trim()) || 0];
  }));
}
function processUsage(pid) {
  if (!pid) return null;
  const stat = read(`/proc/${pid}/stat`);
  const status = read(`/proc/${pid}/status`);
  if (!stat || !status) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { cpuTicks: Number(fields[11]) + Number(fields[12]), rssMb: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) / 1024 };
}
async function readyMs(port) {
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return { status: response.status, ms: +(performance.now() - started).toFixed(1) };
  } catch {
    return { status: null, ms: null };
  }
}

let pids = mainPids();
let previous = { host: hostCpu(), procs: Object.fromEntries(UNITS.map(unit => [unit, processUsage(pids[unit])])), at: Date.now() };
const until = Date.now() + SECONDS * 1000;
for (let n = 1; Date.now() < until; n++) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (n % 30 === 0) pids = mainPids();
  const now = Date.now();
  const host = hostCpu();
  const total = Object.keys(host).reduce((sum, key) => sum + host[key] - previous.host[key], 0) || 1;
  const share = key => +((host[key] - previous.host[key]) / total).toFixed(4);
  const mem = read('/proc/meminfo');
  const memTotal = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1]);
  const memAvailable = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]);
  const procs = {};
  const usage = {};
  for (const unit of UNITS) {
    usage[unit] = processUsage(pids[unit]);
    const before = previous.procs[unit];
    procs[unit] = usage[unit] && before ? { pid: pids[unit], cpu: +(((usage[unit].cpuTicks - before.cpuTicks) / TICK) / ((now - previous.at) / 1000)).toFixed(4),
      rss_mb: +usage[unit].rssMb.toFixed(1) } : null;
  }
  const ready = {};
  for (const [unit, port] of Object.entries(READY_PORTS)) if (pids[unit]) ready[unit] = await readyMs(port);
  const sample = {
    t: new Date(now).toISOString(),
    cpu: { user: share('user'), system: share('system'), iowait: share('iowait'), steal: share('steal') },
    mem_available: memTotal ? +(memAvailable / memTotal).toFixed(4) : null,
    load1: Number(read('/proc/loadavg')?.split(' ')[0]),
    tcp_inuse: Number(/TCP: inuse (\d+)/.exec(read('/proc/net/sockstat') || '')?.[1] || 0),
    procs, ready,
  };
  const line = `${JSON.stringify(sample)}\n`;
  if (values.out) appendFileSync(values.out, line); else process.stdout.write(line);
  previous = { host, procs: usage, at: now };
}
