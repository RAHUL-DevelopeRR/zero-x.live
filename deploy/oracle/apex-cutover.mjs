#!/usr/bin/env node
// Phase 2 DNS switch for zero-x.live (deploy/oracle/README.md, "Phase 2"), done through the
// Cloudflare API so the hostname is without a DNS record for as short a time as possible.
// Removing the Worker's Custom Domain deletes its record; a resolver that asks before the tunnel
// CNAME exists caches "no such record" for min(SOA TTL, SOA minimum), 1800 s on the zone today,
// and for its users the whole site, sign-in and API are down that long.
//
//   --to tunnel   detach the Custom Domain, then at once create the proxied CNAME to the tunnel
//                 (--create-routes also adds the zero-x.live/* and /v1/* routes right after,
//                 when the dashboard refused them while the Custom Domain existed)
//   --to worker   rollback: delete that CNAME, then at once attach the Custom Domain again
//   --negative-ttl <s>   a day ahead: set the zone SOA's minimum TTL (negative caching) to s
//                 seconds (60 or more), keeping the rest of the SOA; only --zone is needed
//
// Dry run by default: reads the current state and prints the plan. --apply makes the two writes
// back to back, retrying the second for a few seconds; if it never lands, the first is undone.
// The token comes from CLOUDFLARE_API_TOKEN only (Workers Scripts Write on the account, DNS
// Write, Zone DNS Settings Write and Workers Routes Write on the zone) and is never printed.
//
//   CLOUDFLARE_API_TOKEN=... node deploy/oracle/apex-cutover.mjs --negative-ttl 60 --zone <zone id> [--apply]
//   CLOUDFLARE_API_TOKEN=... node deploy/oracle/apex-cutover.mjs --to tunnel --account <account id> \
//     --zone <zone id> --worker <Worker name> --tunnel <TUNNEL_ID> [--hostname zero-x.live] [--apply]
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://api.cloudflare.com/client/v4';
const ID = /^[0-9a-f]{32}$/;
const TUNNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Negative answers cached longer than this are worth lowering a day ahead.
const SHORT_NEGATIVE_TTL = 300;

// api(method, path, body) -> the result of a Cloudflare v4 call; throws with Cloudflare's error
// codes and messages (never the token).
export function client(token, fetchImpl = (...args) => fetch(...args)) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success === false) {
      const reason = json?.errors?.map(error => `${error.code}: ${error.message}`).join('; ') || `HTTP ${response.status}`;
      throw new Error(`${method} ${path.split('?')[0]}: ${reason}`);
    }
    return json?.result;
  };
}

async function current(api, { account, zone, hostname, tunnel }) {
  const [domains, records, settings, routes] = await Promise.all([
    api('GET', `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`),
    api('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(hostname)}`),
    api('GET', `/zones/${zone}/dns_settings`).catch(() => null),
    api('GET', `/zones/${zone}/workers/routes`),
  ]);
  const soa = settings?.soa;
  return {
    domain: (domains || []).find(domain => domain.hostname === hostname) || null,
    cname: (records || []).find(record => record.type === 'CNAME' && record.content === `${tunnel}.cfargotunnel.com`) || null,
    others: (records || []).filter(record => record.content !== `${tunnel}.cfargotunnel.com`),
    negativeTtl: soa ? Math.min(Number(soa.min_ttl), Number(soa.ttl)) : null,
    routes: routes || [],
  };
}

// The second write of a pair, retried while the first settles (a deleted record can take a
// moment to clear); undo() runs when it never lands. A write can land and still fail (a timeout
// after Cloudflare applied it), so landed() and undone() re-read the state before a retry and
// after a failed undo. The error says "restored" only when the undo is known to have worked.
async function thenAtOnce(second, undo, { landed, undone, restored, broken, log, pause, retries = 6 }) {
  for (let attempt = 1; ; attempt++) {
    try { return await second(); } catch (error) {
      if (await landed().catch(() => false)) return;
      if (attempt < retries) { await pause(500); continue; }
      log(`${error.message}; undoing the first step`);
      try { await undo(); } catch (undoError) {
        if (!(await undone().catch(() => false))) {
          throw new Error(`${error.message}; the undo failed too (${undoError.message}): ${broken}`);
        }
      }
      log(restored);
      throw new Error(`${error.message} (${restored})`);
    }
  }
}

// Resolvers cache a missing record for min(SOA TTL, SOA minimum). Lowering the minimum a day
// ahead (after the SOA itself, cached up to its TTL, has expired everywhere) keeps a gap short.
export async function lowerNegativeTtl(api, { zone, seconds, apply = false, log = console.log }) {
  if (!ID.test(zone || '')) throw new Error('--zone must be a 32-hex id');
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error('--negative-ttl must be 60 to 86400 seconds');
  const soa = (await api('GET', `/zones/${zone}/dns_settings`))?.soa;
  if (!soa) throw new Error('The zone has no SOA settings to change (dns_settings); plan for its default negative caching');
  log(`SOA minimum TTL ${soa.min_ttl} s, SOA TTL ${soa.ttl} s; plan: minimum TTL ${seconds} s`);
  if (!apply) { log('Dry run: pass --apply to make this change'); return; }
  await api('PATCH', `/zones/${zone}/dns_settings`, { soa: { ...soa, min_ttl: seconds } });
  log(`Negative caching is now at most ${Math.min(seconds, Number(soa.ttl))} s for answers given from now on`);
}

export async function cutover(api, { to, account, zone, hostname = 'zero-x.live', worker, tunnel, apply = false,
  createRoutes = false, log = console.log, pause = ms => new Promise(done => setTimeout(done, ms)) }) {
  if (!['tunnel', 'worker'].includes(to)) throw new Error('--to must be tunnel or worker');
  if (!ID.test(account || '') || !ID.test(zone || '')) throw new Error('--account and --zone must be 32-hex ids');
  if (!TUNNEL.test(tunnel || '')) throw new Error('--tunnel must be the tunnel id (a UUID)');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(worker || '')) throw new Error('--worker must be the Worker name');
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('invalid --hostname');
  const now = await current(api, { account, zone, hostname, tunnel });
  const target = `${tunnel}.cfargotunnel.com`;
  const attach = () => api('PUT', `/accounts/${account}/workers/domains`, { hostname, service: worker, zone_id: zone });
  const point = () => api('POST', `/zones/${zone}/dns_records`, {
    type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1, comment: 'Cloudflare Tunnel zerox-gw (deploy/oracle)',
  });
  const attached = async () => ((await api('GET', `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`)) || [])
    .some(domain => domain.hostname === hostname && domain.service === worker);
  const pointed = async () => ((await api('GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(hostname)}`)) || [])
    .some(record => record.type === 'CNAME' && record.content === target);
  const broken = `${hostname} has neither the Custom Domain nor the tunnel CNAME, so the site, sign-in and API are down: ` +
    `attach the Custom Domain to ${worker} (Workers > ${worker} > Domains) or create the proxied CNAME to ${target} by hand now`;
  if (now.negativeTtl === null) log('Could not read the zone SOA (dns_settings); a gap is cached for up to 1800 s by default');
  else if (now.negativeTtl > SHORT_NEGATIVE_TTL) {
    log(`SOA: resolvers cache a missing record for ${now.negativeTtl} s. Lower the zone's SOA minimum TTL a day ahead (README, Phase 2).`);
  }
  if (now.others.length) log(`Other records at ${hostname}: ${now.others.map(record => record.type).join(', ')}`);
  const started = Date.now();

  if (to === 'tunnel') {
    if (!now.domain && now.cname) { log(`${hostname} already points at the tunnel; nothing to do`); return; }
    if (!now.domain) throw new Error(`No Workers Custom Domain for ${hostname}`);
    if (now.domain.service !== worker) throw new Error(`The Custom Domain ${hostname} serves ${now.domain.service}, not ${worker}`);
    const wanted = [{ pattern: `${hostname}/*`, script: worker }, { pattern: `${hostname}/v1/*` }];
    const missing = wanted.filter(route => !now.routes.some(have => have.pattern === route.pattern && (have.script || undefined) === route.script));
    if (missing.length && !createRoutes) {
      throw new Error(`Missing Workers routes ${missing.map(route => route.pattern).join(', ')}: add them first (README, Phase 2 steps 2 and 3), or pass --create-routes`);
    }
    log(`Plan: detach the Custom Domain ${hostname} (${worker}), then create CNAME ${hostname} -> ${target} (proxied)` +
      (missing.length ? `, then add the routes ${missing.map(route => route.pattern).join(', ')}` : ''));
    if (!apply) { log('Dry run: pass --apply to make these changes'); return; }
    await api('DELETE', `/accounts/${account}/workers/domains/${now.domain.id}`);
    await thenAtOnce(point, attach, { landed: pointed, undone: attached, restored: 'Custom Domain restored', broken, log, pause });
    log(`${hostname} points at the tunnel (${Date.now() - started} ms from the first write)`);
    for (const route of missing) {
      await api('POST', `/zones/${zone}/workers/routes`, route);
      log(`Route ${route.pattern} -> ${route.script || 'no Worker'} added`);
    }
    return;
  }

  if (!now.cname && now.domain?.service === worker) { log(`${hostname} is already the Worker's Custom Domain; nothing to do`); return; }
  if (!now.cname) throw new Error(`No CNAME ${hostname} -> ${target}`);
  log(`Plan: delete CNAME ${hostname} -> ${target}, then attach the Custom Domain ${hostname} to ${worker}. ` +
    'Afterwards delete the zero-x.live/* and zero-x.live/v1/* routes (README, Phase 2 rollback).');
  if (!apply) { log('Dry run: pass --apply to make these changes'); return; }
  await api('DELETE', `/zones/${zone}/dns_records/${now.cname.id}`);
  await thenAtOnce(attach, point, { landed: attached, undone: pointed, restored: 'tunnel CNAME restored', broken, log, pause });
  log(`${hostname} is the Worker's Custom Domain again (${Date.now() - started} ms from the first write)`);
}

async function main() {
  const { values } = parseArgs({ options: {
    to: { type: 'string' }, account: { type: 'string' }, zone: { type: 'string' }, worker: { type: 'string' },
    tunnel: { type: 'string' }, hostname: { type: 'string', default: 'zero-x.live' },
    apply: { type: 'boolean', default: false }, 'create-routes': { type: 'boolean', default: false },
    'negative-ttl': { type: 'string' },
  } });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN in the environment (not on the command line)');
  if (values['negative-ttl'] !== undefined) {
    await lowerNegativeTtl(client(token), { zone: values.zone, seconds: Number(values['negative-ttl']), apply: values.apply });
  } else {
    await cutover(client(token), { ...values, createRoutes: values['create-routes'] });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
