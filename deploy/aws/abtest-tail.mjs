// Workers CPU for the A/B harness (abtest.mjs): `wrangler tail` on a staging Worker, reduced to the
// fields the report needs. Only a staging script can be tailed (abtest-guard.mjs refuses the
// production ones), the child gets no credential of the run, and the raw stream is never written:
// each event is cut down in memory to outcome, cpuTime, wallTime, status, path, the harness's
// `ab` join key, cf-ray, the script version and the proxy's own log reasons.
//
// Whether a tail event carries cpuTime and wallTime depends on the Wrangler and runtime versions:
// the summary records which fields were present, and Workers Logs (an export of the staging
// Worker's observability logs) is the fallback (`abtest.mjs report --workers-logs <file>`).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stagingScript } from './abtest-guard.mjs';

export const WRANGLER = 'wrangler@4.147.0';

// One tail or Workers Logs event, reduced. Unknown shapes give nulls, never a throw.
export function reduceEvent(event) {
  const request = event?.event?.request || event?.request || {};
  let url = null;
  try { url = new URL(request.url); } catch { /* no URL */ }
  const headers = request.headers || {};
  const logs = (event?.logs || []).flatMap(entry => [entry?.message].flat()).map(String);
  const reasons = logs.map(line => /"reason":"([a-z_]+)"/.exec(line)?.[1]).filter(Boolean);
  const cpu = event?.cpuTime ?? event?.cpuTimeMs ?? event?.$workers?.cpuTimeMs ?? null;
  const wall = event?.wallTime ?? event?.wallTimeMs ?? event?.$workers?.wallTimeMs ?? null;
  return {
    ab: url?.searchParams.get('ab') ?? null,
    path: url?.pathname ?? null,
    status: event?.event?.response?.status ?? event?.response?.status ?? null,
    outcome: event?.outcome ?? event?.$workers?.outcome ?? null,
    cpuMs: typeof cpu === 'number' ? cpu : null,
    wallMs: typeof wall === 'number' ? wall : null,
    exceptions: Array.isArray(event?.exceptions) ? event.exceptions.length : 0,
    ray: headers['cf-ray'] ?? null,
    version: event?.scriptVersion?.id ?? event?.$workers?.scriptVersion?.id ?? null,
    reasons,
  };
}

// Wrangler prints one JSON object per event, possibly over several lines: split on balanced braces.
export function jsonObjects(onObject) {
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  return chunk => {
    for (const char of String(chunk)) {
      buffer += char;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') { if (depth++ === 0) start = buffer.length - 1; }
      else if (char === '}' && depth > 0 && --depth === 0) {
        try { onObject(JSON.parse(buffer.slice(start))); } catch { /* not an event */ }
        buffer = '';
      }
    }
    if (depth === 0 && buffer.length > 4096) buffer = '';
  };
}

/**
 * Starts `npx wrangler@4.147.0 tail <script> --format json` in `cwd` (neuroncli/auth-server, for
 * the account). Returns { events, fields, stop }. `spawnImpl` is injectable for the checks.
 */
export function startTail(script, { cwd, spawnImpl = spawn, env = process.env } = {}) {
  const name = stagingScript(script);
  const events = [];
  const fields = new Set();
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^ZEROX_AB_|TOKEN$|_KEY$|SECRET/i.test(key)));
  const win = process.platform === 'win32';
  // The name is checked above; on Windows npx is a .cmd, which needs a shell.
  const proc = spawnImpl(win ? 'npx.cmd' : 'npx', ['--yes', WRANGLER, 'tail', name, '--format', 'json'],
    { cwd, env: childEnv, shell: win, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const feed = jsonObjects(event => {
    for (const key of ['cpuTime', 'wallTime', 'outcome', 'scriptVersion']) if (key in event) fields.add(key);
    events.push(reduceEvent(event));
  });
  proc.stdout?.on('data', feed);
  return { events, fields, stop: () => proc.kill() };
}

/** A Workers Logs export (JSON array or JSON lines), reduced the same way. */
export function importWorkersLogs(file, read = path => readFileSync(path, 'utf8')) {
  const text = read(file).trim();
  const rows = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  return rows.map(reduceEvent);
}
