#!/usr/bin/env node
// One run of the Worker's 10-minute cron (wrangler.toml [triggers]) for the Node server: the
// same app.scheduled (src/index.js) with the env server.js builds from process.env. It runs
// scheduled maintenance (zerox_release_stale_reservations, subscription expiry, device grant
// purge), the provider discovery tick and the models.dev facts refresh (KV only, so skipped on
// Node). deploy/oracle/zerox-cron.timer starts it every 10 minutes with the gateway's
// environment file. Exits 1 when maintenance failed (discovery records its own failures).
// Running it beside the Worker's own cron is safe: the release is idempotent and discovery jobs
// are claimed in Postgres (zerox_discovery_claim), so each runs once.
//
//   node scripts/cron.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function runCron(env, now = Date.now()) {
  const { default: app } = await import('../src/index.js');
  return app.scheduled({ cron: '*/10 * * * *', scheduledTime: now }, env);
}

// The process ends on its own once idle fetch sockets close (process.exit while they close
// trips a libuv assertion on Windows); systemd's TimeoutStartSec bounds a run that hangs.
async function main() {
  const { runtimeEnv } = require('../server.js');
  const started = Date.now();
  try {
    const maintenance = await runCron(runtimeEnv(process.env.AUTH_HOST || '127.0.0.1'), started);
    console.log(JSON.stringify({ cron: 'ok', maintenance, ms: Date.now() - started }));
  } catch (error) {
    console.error(JSON.stringify({ cron: 'failed', message: String(error?.message).slice(0, 200), ms: Date.now() - started }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
