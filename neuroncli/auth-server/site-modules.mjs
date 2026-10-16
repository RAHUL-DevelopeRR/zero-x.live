// Test helper: the website's browser scripts (dashboard.js, pricing.js, billing-checkout.js at
// the repository root) are ES modules, but the site has no package.json, so Node decides their
// format from the nearest ancestor package.json. On a machine whose home directory holds a
// package.json with "type": "commonjs", importing them fails. This in-thread load hook makes
// Node read every .js file directly under the site root as an ES module, whatever lies above
// the checkout. Import it before importing any site script.
import { readFileSync } from 'node:fs';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

export const SITE_ROOT = new URL('../../', import.meta.url);

const siteScript = url => url.startsWith(SITE_ROOT.href) && url.endsWith('.js') &&
  !url.slice(SITE_ROOT.href.length).includes('/');

if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    load(url, context, nextLoad) {
      if (!siteScript(url)) return nextLoad(url, context);
      return { format: 'module', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    },
  });
}
