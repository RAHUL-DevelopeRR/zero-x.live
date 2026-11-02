// Test hosts (EXTRA_WEB_HOSTS, C10): a comma list of extra hostnames, e.g. "aws.zero-x.live", that
// serve the whole site on their own origin (src/index.js: site pages, the dashboard, the device and
// operator pages) and whose https pages may call the identity APIs and approve device sign-ins like
// the production hosts, so every browser flow can be tried on the Node server on EC2 before a
// production host moves there. EC2 only, and only for the test window: the Worker never sets it,
// and without it nothing changes. Entries that are not plain hostnames (a port, a scheme, a path)
// are ignored, and so are the production hosts: listed by mistake, they keep their own routing.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PRODUCTION_HOSTS = ['zero-x.live', 'www.zero-x.live', 'dashboard.zero-x.live', 'neuron.zero-x.live', 'relay.zero-x.live'];

// Parsed once per value, not per request.
let parsed = { value: undefined, hosts: [] };
export function extraWebHosts(env) {
  const value = env?.EXTRA_WEB_HOSTS;
  if (value !== parsed.value) {
    parsed = {
      value,
      hosts: String(value ?? '').split(',').map(host => host.trim().toLowerCase())
        .filter(host => HOSTNAME.test(host) && !PRODUCTION_HOSTS.includes(host)),
    };
  }
  return parsed.hosts;
}

export const extraWebOrigins = env => extraWebHosts(env).map(host => `https://${host}`);

export const isExtraWebHost = (env, hostname) => extraWebHosts(env).includes(hostname);
