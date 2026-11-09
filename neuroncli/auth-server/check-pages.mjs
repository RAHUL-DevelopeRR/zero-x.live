// Static checks for the business website pages (WP-B4) plus DOM-free unit tests of the pure helpers in
// dashboard.js, pricing.js and billing-checkout.js. Browser behaviour lives in check-dashboard.mjs.
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
// Site scripts load as ES modules whatever package.json lies above the checkout.
import './site-modules.mjs';
import {NEURON_INSTALL, NEURON_RELEASE_DATE, NEURON_RELEASE_URL, NEURON_VERSION} from './src/neuron-release.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const isFile = file => existsSync(new URL(file, root)) && statSync(new URL(file, root)).isFile();

const PUBLIC_PAGES = ['index.html', 'pricing.html', 'neuron-cli.html', 'docs.html', 'ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html', 'docs/trust.html', 'docs/data.html', 'download.html', 'changelog.html', 'refund.html', 'contact.html', 'shipping.html', 'privacy.html', 'terms.html'];
const PRIVATE_PAGES = ['dashboard.html', '404.html', 'neuroncli/index.html'];
const SITE_SCRIPTS = ['dashboard.js', 'pricing.js', 'billing-checkout.js', 'home.js', 'download.js', 'billing-details.js', 'changelog.js', 'site-nav.js', 'announce.js', 'copy-code.js', 'install-bar.js'];
const RELEASE_MANIFESTS = ['releases/cli/latest.json', 'releases/desktop/latest.json'];
const SITE_FILES = [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...SITE_SCRIPTS, ...RELEASE_MANIFESTS, 'zx-tokens.css', 'home.css', 'content.css', 'zerox-auth.js', 'neuroncli/login/index.html', 'neuroncli/callback/index.html'];
const BASES = {'dashboard.html': 'https://dashboard.zero-x.live/', '404.html': 'https://zero-x.live/404', 'neuroncli/index.html': 'https://zero-x.live/neuroncli/'};
const CSP = {
  script: ['https://cdn.jsdelivr.net', 'https://checkout.razorpay.com'],
  style: ['https://fonts.googleapis.com', 'https://api.fontshare.com', 'https://cdn.fontshare.com'],
  font: ['https://fonts.gstatic.com', 'https://cdn.fontshare.com'],
};

const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].slice(1).map(m => [m[1], m[2] ?? '']));
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(m => attrs(m[0]));
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const stripScripts = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const inlineScripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// The menu-mode script every page with the shared header runs right after </header> (site-nav.js).
const NAV_PRESET = `<script>(function(h){var b=h&&h.querySelector('.zx-nav-toggle');if(b&&'noModule'in HTMLScriptElement.prototype){h.dataset.nav='closed';b.hidden=false}})(document.querySelector('.zx-header'))</script>`;
const meta = html => Object.fromEntries(tags(html, 'meta').map(a => [a.name || a.property || a['http-equiv'], a.content]));

const seoPages = JSON.parse(read('seo-pages.json'));
const routeFiles = new Map(seoPages.map(page => [new URL(page.url).host + new URL(page.url).pathname, page.file]));
routeFiles.set('zero-x.live/dashboard', 'dashboard.html');
routeFiles.set('dashboard.zero-x.live/', 'dashboard.html');
routeFiles.set('neuron.zero-x.live/device', 'neuroncli/device/index.html');
const {TABS} = await import(new URL('dashboard.js', root));

/* ───────────── Mobile header (zx-tokens.css) ───────────── */

// At 375 px the shared header used to wrap into three rows (about 153 px, a fifth of a phone screen,
// on every page). Below 720 px it is one row: 56 px inside plus its 1 px border, never over 64 px.
// Desktop keeps the full nav: the menu button exists only inside the phone media query.
{
  const css = read('zx-tokens.css');
  const phone = css.match(/@media \(max-width: 720px\) \{([\s\S]*?)^\}/m);
  assert.ok(phone, 'zx-tokens.css: a phone block for the header');
  const block = phone[1];
  assert.match(css, /^\.zx-nav-toggle \{ display: none; \}$/m, 'the menu button is hidden outside the phone block (desktop unchanged)');
  assert.match(block, /\.zx-header:not\(\[data-nav\]\) \{ position: static; \}/, 'without site-nav.js the wrapped header does not stick');
  assert.match(block, /\.zx-header\[data-nav="closed"\] \.zx-nav \{ display: none; \}/, 'the closed menu hides the nav');
  assert.match(block, /\.zx-header\[data-nav="open"\] \.zx-nav \{ flex-basis: 100%;/, 'the open menu is a full-width row under the bar');
  const inner = block.match(/\.zx-header\[data-nav\] \.zx-header__inner \{ min-height: (\d+)px; padding-block: (\d+)px; \}/);
  assert.ok(inner, 'the bar height is set in the phone block');
  const toggleHeight = Number(block.match(/\.zx-header\[data-nav\] \.zx-nav-toggle \{[^}]*min-height: (\d+)px/)[1]);
  const brandHeight = Number(css.match(/\.zx-brand \{[^}]*min-height: (\d+)px/)[1]);
  const rowHeight = Math.max(Number(inner[1]), Math.max(toggleHeight, brandHeight) + 2 * Number(inner[2]));
  assert.ok(rowHeight + 1 <= 64, `the phone header is ${rowHeight + 1} px tall (at most 64)`);
  assert.ok(toggleHeight >= 44, 'the Menu button is a 44 px touch target');
  assert.doesNotMatch(css.replace(phone[0], ''), /\.zx-header\[data-nav/, 'menu mode styles only apply on phones');
}

/* ───────────── Page structure, accessibility, SEO flags ───────────── */

for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES]) {
  const html = read(file);
  const body = stripScripts(html);
  const pointer = file === 'neuroncli/index.html';
  assert.match(html, /^<!doctype html>/i, file + ': doctype');
  assert.match(html, /<html lang="en">/, file + ': lang');
  assert.match(html, /<meta charset="utf-8">/i, file + ': charset');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, file + ': viewport');
  assert.ok(meta(html).description, file + ': description');
  assert.equal((body.match(/<h1\b/g) || []).length, 1, file + ': exactly one h1');
  assert.match(body, /<main id="main"/, file + ': main landmark');
  if (!pointer) {
    assert.ok(body.includes('<header') && body.includes('<footer'), file + ': header and footer landmarks');
    assert.match(body, /<a class="zx-skip" href="#main">Skip to content<\/a>/, file + ': skip link');
    assert.ok(tags(html, 'nav').some(a => a['aria-label']), file + ': labelled navigation');
    // Phones: the shared header is one row, the mark and a Menu button (site-nav.js) that opens the
    // main nav as a disclosure; hidden until the script runs, so without it the nav wraps.
    const toggle = tags(body, 'button').find(a => (a.class || '').split(' ').includes('zx-nav-toggle'));
    assert.ok(toggle, file + ': header menu button');
    assert.deepEqual([toggle.type, toggle['aria-expanded'], toggle['aria-controls'], 'hidden' in toggle], ['button', 'false', 'site-nav', true],
      file + ': the menu button is a hidden disclosure button for #site-nav');
    assert.ok(tags(body, 'nav').some(a => a.id === 'site-nav' && a['aria-label'] === 'Main'), file + ': the main nav is #site-nav');
    // The same links on every page: no page-only anchor (the home page once had a Models link the others lacked).
    const navHtml = (/<nav class="zx-nav" id="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(body) || [])[1] || '';
    for (const link of tags(navHtml, 'a')) assert.doesNotMatch(link.href || '', /^#/, file + ': the header nav has no page-only anchor links');
    if (/<main[^>]*class="[^"]*\bzx-legal\b/.test(body)) {
      assert.ok(tags(html, 'link').some(a => a.rel === 'stylesheet' && a.href === '/content.css'), file + ': a reading page loads content.css');
    }
    assert.match(body, /<button class="zx-nav-toggle"[^>]*>[\s\S]*?Menu<\/button>\s*<nav class="zx-nav" id="site-nav"/, file + ': the button has a visible name and sits before the nav');
    assert.ok(tags(html, 'script').some(a => a.type === 'module' && a.src === '/site-nav.js'), file + ': loads /site-nav.js');
    // Review 2026-11-05: menu mode before first paint (no wrapped header that then jumps 96 px):
    // the same inline script right after </header>, and site-nav.js first of the scripts that run
    // after parsing (deferred and module scripts run in document order).
    assert.ok(html.includes('</header>\n  ' + NAV_PRESET) || html.includes('</header>\r\n  ' + NAV_PRESET),
      file + ': the menu-mode inline script right after </header>');
    const ordered = tags(html, 'script').filter(a => a.src && (a.type === 'module' || 'defer' in a));
    assert.equal(ordered[0].src, '/site-nav.js', file + ': site-nav.js runs first of the deferred and module scripts');
  }
  assert.ok(tags(html, 'link').some(a => a.rel === 'stylesheet' && a.href === '/zx-tokens.css'), file + ': uses zx-tokens.css');
  assert.doesNotMatch(html, /rahultech|@gmail\.com/i, file + ': personal Gmail address');
  assert.doesNotMatch(body, /<[^>]+\son[a-z]+\s*=/i, file + ': inline event handler attribute');
  assert.doesNotMatch(body, /<[^>]+\sstyle="/i, file + ': inline style attribute');
  assert.doesNotMatch(html, /(?:href|src|action)="\s*javascript:/i, file + ': javascript: URL');
  const robots = meta(html).robots || '';
  if (PUBLIC_PAGES.includes(file)) assert.ok(robots.includes('index') && !robots.includes('noindex'), file + ': indexable');
  else assert.match(robots, /noindex/, file + ': private pages are noindex');
  const pageIds = ids(body);
  assert.equal(new Set(pageIds).size, pageIds.length, file + ': duplicate id ' + pageIds.find((id, i) => pageIds.indexOf(id) !== i));
  for (const tag of body.matchAll(/<[^>]+>/g)) {
    const a = attrs(tag[0]);
    for (const key of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'for']) {
      if (!a[key]) continue;
      for (const ref of a[key].split(/\s+/)) {
        // ids rendered at runtime inside the usage chart are created by dashboard.js
        if (file === 'dashboard.html' && /^usage-svg-/.test(ref)) continue;
        assert.ok(pageIds.includes(ref), `${file}: ${key}="${ref}" does not resolve`);
      }
    }
  }
  for (const img of tags(body, 'img')) assert.ok('alt' in img && Number(img.width) > 0 && Number(img.height) > 0, file + ': img alt/width/height');
  for (const input of [...body.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map(m => attrs(m[0]))) {
    assert.ok(input.type === 'hidden' || body.includes(`for="${input.id}"`), file + ': form control without label ' + input.id);
  }
}

// aria-current="page" marks the link to this very page, never another one (a footer copied from a
// sibling page once marked Privacy Policy as current on three pages). Every site page is checked.
for (const file of [...PUBLIC_PAGES, 'about.html', 'neucockpit.html', 'find-files-by-content.html', 'wheres-that-file.html', 'start.html']) {
  for (const link of tags(stripScripts(read(file)), 'a').filter(a => a['aria-current'] === 'page' && a.href)) {
    const own = file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, '');
    assert.equal(link.href.replace(/#.*$/, ''), own, file + ': aria-current marks ' + link.href + ', not this page');
  }
}
assert.ok(!seoPages.some(page => PRIVATE_PAGES.includes(page.file)), 'Private pages must stay out of seo-pages.json');
for (const file of PUBLIC_PAGES) assert.ok(seoPages.some(page => page.file === file), file + ' is listed in seo-pages.json');
assert.match(read('neuroncli/index.html'), /<meta http-equiv="refresh" content="0; url=\/neuron-cli">/, 'Old /neuroncli/ page points to /neuron-cli');
assert.match(read('neuroncli/index.html'), /<link rel="canonical" href="https:\/\/zero-x.live\/neuron-cli">/);

// The release and its install commands come from src/neuron-release.js (as written in HTML: & is &amp;).
// check-neuron-version.mjs fails on any other 7.0.0 build, installer or pip without --pre across the site;
// these checks pin where each command appears.
const escapeHtml = value => value.replace(/&/g, '&amp;');
const RELEASE_TAG_URL = NEURON_RELEASE_URL;
const INSTALL_NPM = NEURON_INSTALL.npm;
const INSTALL_PIP = NEURON_INSTALL.pip;
const INSTALL_SH = escapeHtml(NEURON_INSTALL.shell);
const INSTALL_PS1 = escapeHtml(NEURON_INSTALL.powershell);
const INSTALL_CMD = escapeHtml(NEURON_INSTALL.cmd);
assert.equal(INSTALL_PIP, 'python -m pip install --pre neuroncli', 'pip needs --pre while Neuron 7 is a pre-release');
assert.equal(NEURON_INSTALL.powershell, 'irm https://zero-x.live/install.ps1 | iex', 'Windows: the one-liner that runs under the default ExecutionPolicy');
// The superseded alpha's installer still resolves, so a page that keeps naming it silently installs the old build.
for (const file of new Set([...seoPages.map(page => page.file), ...PUBLIC_PAGES, ...PRIVATE_PAGES, 'llms.txt', 'neuroncli/login/index.html', 'neuroncli/callback/index.html', 'neuroncli/device/index.html'])) {
  assert.doesNotMatch(read(file), /7\.0\.0-alpha\.1\b/, file + ': names the superseded 7.0.0-alpha.1');
}
// The install bar (install-bar.js, styles in zx-tokens.css) on every page that shows install commands:
// one pill with "Get Neuron", the command and a copy button. Its list holds every command, best first:
// the Windows PowerShell one-liner (works under the default ExecutionPolicy), Command Prompt, macOS and
// Linux, then npm and pip. Without JavaScript the pill shows the PowerShell command and the page's
// first bar lists them all; the docs install section has the requirements and troubleshooting.
const INSTALL_BAR_METHODS = [
  ['powershell', 'Windows (PowerShell)', NEURON_INSTALL.powershell], ['cmd', 'Windows (Command Prompt)', NEURON_INSTALL.cmd],
  ['shell', 'macOS / Linux', NEURON_INSTALL.shell], ['npm', 'npm', NEURON_INSTALL.npm], ['pip', 'pip', NEURON_INSTALL.pip],
];
// (A Windows checkout has CRLF pages; the browser reads them as LF.)
const installBars = html => [...html.replace(/\r\n?/g, '\n').matchAll(/<div class="zx-getbar[^"]*" data-install-bar>([\s\S]*?)\n\s*<\/ul>\n\s*<\/div>/g)].map(m => m[1]);
const INSTALL_BAR_PAGES = ['index.html', 'neuron-cli.html', 'docs.html', 'download.html', 'ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html'];
for (const file of INSTALL_BAR_PAGES) {
  const page = read(file);
  const bars = installBars(page);
  assert.ok(bars.length >= 1, `${file}: has the install bar`);
  assert.ok(page.includes('<script type="module" src="/install-bar.js"></script>') && page.includes('<script type="module" src="/copy-code.js"></script>'), `${file}: loads install-bar.js and copy-code.js`);
  bars.forEach((bar, index) => {
    const where = `${file} install bar ${index + 1}`;
    assert.ok(bar.includes('<span class="zx-getbar__pick">Get Neuron</span>'), `${where}: the Get Neuron label`);
    const code = bar.match(/<code class="zx-getbar__cmd" id="([\w-]+)" data-method="powershell">([^<]*)<\/code>/);
    assert.ok(code, `${where}: the pill shows a command`);
    assert.equal(code[2], escapeHtml(NEURON_INSTALL.powershell), `${where}: the PowerShell one-liner by default`);
    assert.ok(bar.includes(`data-copy-target="${code[1]}"`), `${where}: the copy button copies the pill's command`);
    assert.match(bar, /<p class="zx-getbar__alt">[^<]*<a href="[^"]*#(install|troubleshooting)">/, `${where}: links to the install guide`);
    const items = [...bar.matchAll(/<li data-method="(\w+)"><span class="zx-getbar__name">([^<]+)<\/span> <code>([^<]*)<\/code><\/li>/g)].map(m => [m[1], m[2], m[3]]);
    assert.deepEqual(items, INSTALL_BAR_METHODS.map(([id, name, command]) => [id, name, escapeHtml(command)]), `${where}: every command, best first`);
    // The first bar on a page lists the commands for visitors without JavaScript; the others repeat it.
    assert.equal(/<ul class="zx-getbar__list"[^>]* hidden>/.test(bar), index > 0, `${where}: list ${index ? 'hidden' : 'shown'} without JavaScript`);
  });
  // The first install command on the page is the bar's.
  assert.ok(page.indexOf('data-install-bar') < page.indexOf(INSTALL_NPM), `${file}: the install bar comes before any npm command`);
}
// The docs install section: requirements, the other ways, after installing, and the errors people hit.
{
  const words = stripScripts(read('docs.html')).replace(/<[^>]+>/g, ' ').replace(/&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  for (const phrase of ['Node.js 22.14 or later', 'Python 3.9 or later', 'keep --pre', 'npm.cmd install -g @zero-x.live/neuron', 'neuron.cmd',
    '"npm.ps1 cannot be loaded because running scripts is disabled on this system"', '"Python was not found', '"& was unexpected at this time."',
    'Open a new terminal, run neuron login , then neuron in your project folder.', 'NEURON_NO_TUI', NEURON_INSTALL.powershellPinned, NEURON_INSTALL.shellPinned]) {
    assert.ok(words.toLowerCase().includes(phrase.toLowerCase()), 'docs.html install section says: ' + phrase);
  }
  assert.ok(ids(read('docs.html')).includes('install') && ids(read('docs.html')).includes('troubleshooting'), 'docs.html #install and #troubleshooting');
}
for (const file of ['index.html', 'neuron-cli.html', 'download.html']) {
  const words = stripScripts(read(file)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(words, /Open a new terminal, run neuron login , then neuron in your project folder\./, file + ': what to do after installing');
}
// llms.txt stays plain text with every command.
for (const command of Object.values(NEURON_INSTALL).slice(0, 5)) assert.ok(read('llms.txt').includes('`' + command + '`'), 'llms.txt lists ' + command);
{
  const html = read('neuron-cli.html');
  const software = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  assert.deepEqual([software.softwareVersion, software.downloadUrl], [NEURON_VERSION, RELEASE_TAG_URL], 'neuron-cli.html JSON-LD names the current release');
  assert.ok(html.includes(`Neuron ${NEURON_VERSION} is the fifth alpha, published on ${NEURON_RELEASE_DATE} as a <a href="${RELEASE_TAG_URL}">GitHub pre-release</a>`), 'neuron-cli.html names the release and its date');
  assert.match(html, /status bar under the prompt/, 'neuron-cli.html says what the release brings');
  // Without a terminal nobody approves, so a headless test run needs an allow rule or it is denied and exits 2.
  const headless = html.match(/<h3>Run it headless<\/h3>([\s\S]*?)<\/li>/)[1];
  assert.ok(headless.includes('neuron -p "Run the test suite and summarise the failures"'), 'headless example');
  assert.ok(headless.includes('{"permissions": {"allow": ["bash(npm:*)", "PowerShell(npm:*)"]}}'), 'headless example allows the test runner in settings');
  assert.match(headless, /exits with code 2/, 'headless example explains the denied run');
  assert.match(headless, /before <code>-p<\/code>/, 'headless example says flags go before -p');
  assert.match(headless, /danger-full-access<\/code>[^<]*disposable environments only/, 'full access is for disposable environments only');
}

/* Dashboard specifics: tabs, alerts, no hardcoded limits */
{
  const html = read('dashboard.html');
  const tabTags = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map(m => attrs(m[0]));
  assert.deepEqual(tabTags.map(t => t.id), TABS.map(t => 'tab-' + t), 'Tabs follow TABS order');
  for (const tab of tabTags) {
    const panel = attrs(html.match(new RegExp(`<section\\b[^>]*id="${tab['aria-controls']}"[^>]*>`))[0]);
    assert.equal(panel.role, 'tabpanel');
    assert.equal(panel['aria-labelledby'], tab.id);
  }
  assert.match(html, /role="tablist" aria-label="Dashboard sections"/);
  for (const id of ['gate-error', 'dash-alert', 'overview-error', 'usage-error', 'events-error', 'keys-error', 'billing-error', 'sessions-error', 'account-error']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"`), 'Inline role=alert container ' + id);
  }
  assert.match(html, /role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100"/);
  assert.doesNotMatch(html, /256,000|500K|10M|50M|2,000|10,000|44K/, 'Dashboard must not hardcode plan limits');
  // The quick start leads with the same install bar as the public pages: on a fresh Windows machine
  // npm.ps1 is blocked by the default ExecutionPolicy and `python` is the Microsoft Store alias.
  {
    const bars = installBars(html);
    assert.equal(bars.length, 1, 'Dashboard quick start has the install bar');
    assert.ok(html.includes('<script type="module" src="/install-bar.js"></script>'), 'dashboard.html loads install-bar.js');
    const code = bars[0].match(/<code class="zx-getbar__cmd" id="qs-install" data-method="powershell">([^<]*)<\/code>/);
    assert.ok(code && code[1] === INSTALL_PS1, 'Dashboard install bar shows the PowerShell one-liner by default');
    assert.ok(bars[0].includes('data-copy-target="qs-install"'), 'Dashboard install bar copies its own command');
    const items = [...bars[0].matchAll(/<li data-method="(\w+)"><span class="zx-getbar__name">([^<]+)<\/span> <code>([^<]*)<\/code><\/li>/g)].map(m => [m[1], m[2], m[3]]);
    assert.deepEqual(items, INSTALL_BAR_METHODS.map(([id, name, command]) => [id, name, escapeHtml(command)]), 'Dashboard install bar: every command, best first');
    assert.ok(html.indexOf('data-install-bar') < html.indexOf(INSTALL_NPM), 'Dashboard: the install bar comes before any npm command');
    assert.doesNotMatch(html, /any terminal on macOS, Linux or Windows/, 'Dashboard does not claim npm and pip work in any Windows terminal');
    assert.match(html, /<code>npm\.cmd<\/code>/, 'Dashboard names npm.cmd for Windows PowerShell');
    assert.doesNotMatch(html, /id="qs-install-pip"/, 'Dashboard has no separate pip block ahead of the installers');
  }
  assert.match(html, /href="https:\/\/zero-x\.live\/docs#install" data-site-path="\/docs#install">install guide<\/a>/, 'Dashboard quick start links the install guide');
  assert.match(html, /neuron -p[\s\S]*?exits with code 2 unless <code>~\/\.neuron\/settings\.json<\/code> allows them/, 'Dashboard headless example explains the denied run');
  assert.match(html, /<code id="qs-login">neuron login<\/code>/);
  assert.match(html, /https:\/\/zero-x\.live\/v1/);
  assert.doesNotMatch(read('dashboard.js'), /alert\(|confirm\(/, 'No alert()/confirm() dialogs');
}

/* The billing details step (billing-details.js) sits in front of every purchase: no payment starts without it */
{
  for (const file of ['pricing.js', 'dashboard.js']) {
    const source = read(file);
    assert.match(source, /from '\.\/billing-details\.js'/, file + ' imports the billing details step');
    assert.match(source, /purchaseWithDetails\(/, file + ' runs purchases through it');
    assert.doesNotMatch(source, /await start(?:Subscription|Topup)\(/, file + ': a purchase starts only inside purchaseWithDetails, after the details step');
  }
  assert.doesNotMatch(read('billing-details.js'), /startSubscription|startTopup|loadRazorpay|runCheckout/, 'the step never starts a payment');
  // The dialog and its form controls are built by the script (labels, autocomplete, errors: check-dashboard.mjs), so the pages carry no copy of it.
  for (const file of ['pricing.html', 'dashboard.html']) assert.doesNotMatch(read(file), /bd-form|bd-title|billing-details/, file + ': no markup of the step');
  assert.ok(read('zx-tokens.css').includes('.zx-dialog--billing'), 'the dialog styles ship with the shared tokens');
  // In the two-column layout the long-hint fields (address lines, tax id, phone) span the full width.
  const wide = read('zx-tokens.css').match(/@media \(min-width: 560px\) \{ \.zx-form-grid \{[^}]*\}([^{]*)\{ grid-column: 1 \/ -1; \}/);
  assert.ok(wide, 'the details form has a two-column rule with full-width fields');
  for (const id of ['bd-address-line1-field', 'bd-address-line2-field', 'bd-tax-id-field', 'bd-phone-field']) assert.ok(wide[1].includes('#' + id), id + ' spans both columns');
}

/* ───────────── Links resolve to files or routes ───────────── */

function resolveLink(file, html, value) {
  if (/^(mailto|tel):/.test(value)) return;
  if (value.startsWith('#')) { assert.ok(ids(html).includes(value.slice(1)), `${file}: broken fragment ${value}`); return; }
  const base = BASES[file] || seoPages.find(page => page.file === file)?.url;
  const url = new URL(value, base);
  if (!['zero-x.live', 'neuron.zero-x.live', 'dashboard.zero-x.live'].includes(url.hostname)) {
    assert.equal(url.protocol, 'https:', `${file}: insecure external link ${value}`);
    assert.ok(!url.hostname.endsWith('zero-x.live'), `${file}: unknown zero-x host ${value}`);
    return;
  }
  assert.equal(url.protocol, 'https:', `${file}: ${value}`);
  if (url.hostname === 'dashboard.zero-x.live' && url.pathname === '/') {
    if (url.hash) assert.ok(TABS.includes(url.hash.slice(1)) || (file === 'dashboard.html' && ids(html).includes(url.hash.slice(1))), `${file}: unknown dashboard tab ${url.hash}`);
    return;
  }
  const target = routeFiles.get(url.hostname + url.pathname) ||
    (url.pathname.endsWith('/') && isFile('.' + url.pathname + 'index.html') ? '.' + url.pathname + 'index.html' : '.' + url.pathname);
  assert.ok(isFile(target), `${file}: ${value} does not resolve to a file or route`);
  if (url.hash) assert.ok(read(target).includes(`id="${url.hash.slice(1)}"`), `${file}: broken fragment ${value}`);
}

for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES]) {
  const html = read(file);
  for (const tag of html.matchAll(/<(?:a|link|img|script|source)\b[^>]*>/g)) {
    const a = attrs(tag[0]);
    const value = tag[0].startsWith('<link') && !['stylesheet', 'icon', 'apple-touch-icon', 'canonical'].includes(a.rel) ? null : a.href || a.src;
    if (value) resolveLink(file, html, value);
  }
}
for (const file of SITE_SCRIPTS) {
  for (const m of read(file).matchAll(/from '(\.\/[\w.-]+)'/g)) assert.ok(isFile(m[1].slice(2)), `${file}: import ${m[1]} missing`);
}

/* Footer legal links on every public page (Razorpay requires them to be reachable), plus the
   three landing pages so each one has an internal link from every indexable page */
for (const file of PUBLIC_PAGES) {
  const footer = read(file).match(/<footer[\s\S]*<\/footer>/)[0];
  for (const path of ['/terms', '/privacy', '/refund', '/shipping', '/contact', '/pricing', '/ai-coding-agent', '/free-ai-coding-agent', '/claude-code-alternative']) assert.ok(footer.includes(`href="${path}"`), `${file}: footer links ${path}`);
  assert.ok(footer.includes('support@zero-x.live'), file + ': footer support email');
}

/* ───────────── No secrets, no unsafe sinks ───────────── */

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/, /gsk_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{30,}/, /rzp_(?:live|test)_[A-Za-z0-9]{8,}/, /nzx_[A-Za-z0-9_-]{16,}/,
  /ses_[A-Za-z0-9_-]{20,}/, /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/, /sb_(?:publishable|secret)_[A-Za-z0-9_-]{10,}/, /service_role/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /RAZORPAY_KEY_SECRET\s*[:=]/, /RAZORPAY_WEBHOOK_SECRET\s*[:=]/,
];
for (const file of SITE_FILES) {
  const source = read(file);
  for (const pattern of SECRET_PATTERNS) assert.doesNotMatch(source, pattern, `${file}: possible secret ${pattern}`);
}

const UNSAFE_SINKS = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(|setTimeout\(\s*['"`]/;
for (const file of SITE_SCRIPTS) assert.doesNotMatch(read(file), UNSAFE_SINKS, `${file}: unsafe HTML/code sink`);
for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES]) for (const script of inlineScripts(read(file))) assert.doesNotMatch(script, UNSAFE_SINKS, `${file}: inline script uses an unsafe sink`);
for (const file of SITE_SCRIPTS) {
  for (const m of read(file).matchAll(/fetch\(/g)) assert.equal(file, 'billing-checkout.js', `${file}: network calls must go through apiFetch`);
}
assert.match(read('billing-checkout.js'), /API_PATH = \/\^\\\/\(\?:api\|v1\|auth\|releases\)\\\//, 'apiFetch only allows same-origin gateway paths and release manifests');

/* ───────────── CSP-compatible origins ───────────── */

const origin = value => { try { return new URL(value).origin; } catch { return 'self'; } };
for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES, 'neuroncli/login/index.html', 'neuroncli/callback/index.html']) {
  const html = read(file);
  for (const script of tags(html, 'script')) if (script.src) assert.ok(origin(script.src) === 'self' || CSP.script.includes(origin(script.src)), `${file}: script origin ${script.src}`);
  for (const link of tags(html, 'link')) if (link.rel === 'stylesheet') assert.ok(origin(link.href) === 'self' || CSP.style.includes(origin(link.href)), `${file}: style origin ${link.href}`);
  assert.doesNotMatch(html, /<iframe\b|<object\b|<embed\b/i, `${file}: no embedded frames`);
  for (const form of tags(html, 'form')) assert.ok(!form.action, `${file}: forms post to self only`);
  for (const script of tags(html, 'script')) if (script.src && script.src.includes('supabase-js')) {
    assert.match(script.src, /@supabase\/supabase-js@\d+\.\d+\.\d+\//, `${file}: supabase-js must be pinned to an exact version`);
    assert.match(script.integrity || '', /^sha384-/, `${file}: supabase-js needs SRI`);
  }
}
// Every page of the site (not only the business pages above) pins supabase-js with SRI.
const allHtml = readdirSync(root).filter(name => name.endsWith('.html'));
for (const file of allHtml) {
  for (const script of tags(read(file), 'script')) if (script.src && script.src.includes('supabase-js')) {
    assert.match(script.src, /@supabase\/supabase-js@\d+\.\d+\.\d+\//, `${file}: supabase-js must be pinned to an exact version`);
    assert.match(script.integrity || '', /^sha384-/, `${file}: supabase-js needs SRI`);
    assert.equal(script.crossorigin, 'anonymous', `${file}: SRI needs crossorigin=anonymous`);
  }
}
assert.doesNotMatch(read('zx-tokens.css'), /@import|url\((?!\s*['"]?(?:data:|\/[^/]))/, 'zx-tokens.css loads nothing remote');
/* ───────────── Content-Security-Policy hashes (audit F14, F15, D1) ───────────── */

// Inline scripts and styles are allowed by sha256, not by 'unsafe-inline': src/csp-hashes.js must list
// exactly what the pages carry (node build-csp-hashes.mjs rewrites it), no page may use an inline event
// handler or a javascript: URL (script-src-attr 'none'), and the one third-party script is allowed by URL.
{
  const {collectInlineHashes, render} = await import('./build-csp-hashes.mjs');
  const generated = render(collectInlineHashes());
  assert.equal(read('neuroncli/auth-server/src/csp-hashes.js').replace(/\r\n/g, '\n'), generated,
    'src/csp-hashes.js is out of date: run `node build-csp-hashes.mjs` in neuroncli/auth-server');
  const {INLINE_SCRIPT_HASHES, INLINE_STYLE_HASHES} = await import('./src/csp-hashes.js');
  assert.ok(INLINE_SCRIPT_HASHES.length >= 3 && INLINE_STYLE_HASHES.length >= 1, 'the pages carry inline scripts and styles');
  for (const hash of [...INLINE_SCRIPT_HASHES, ...INLINE_STYLE_HASHES]) assert.match(hash, /^sha256-[A-Za-z0-9+/]{43}=$/);
  const {sitePolicy, SUPABASE_JS_SRC, ADMIN_POLICY} = await import('./src/csp.js');
  const version = /SUPABASE_JS_VERSION = '([\d.]+)'/.exec(read('zerox-auth.js'))?.[1];
  assert.ok(version, 'zerox-auth.js pins a supabase-js version');
  assert.equal(SUPABASE_JS_SRC, `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${version}/dist/umd/supabase.js`, 'src/csp.js allows the file zerox-auth.js loads');
  for (const file of allHtml) {
    const html = read(file);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${file}: no inline event handler attribute`);
    assert.doesNotMatch(html, /(?:href|src|action)\s*=\s*["']\s*javascript:/i, `${file}: no javascript: URL`);
    for (const script of tags(html, 'script')) if (script.src && script.src.includes('supabase-js')) assert.equal(script.src, SUPABASE_JS_SRC, `${file}: the supabase-js URL the policy allows`);
  }
  for (const [env, path, host] of [[{}, '/', 'zero-x.live'], [{}, '/pricing', 'zero-x.live'], [{SUPABASE_URL: 'https://abc.supabase.co'}, '/dashboard', 'dashboard.zero-x.live'],
    [{}, '/neuroncli/login/', 'zero-x.live'], [{}, '/neuroncli/callback/', 'zero-x.live'], [{}, '/device', 'neuron.zero-x.live']]) {
    const policy = sitePolicy(env, {hostname: host, pathname: path});
    const parts = policy.split('; ');
    const script = parts.find(part => part.startsWith('script-src '));
    assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"), `${path}: script-src has no unsafe-inline or unsafe-eval`);
    assert.ok(!/(^| )https:( |;|$)/.test(policy), `${path}: no bare https: source`);
    assert.ok(script.split(' ').includes('https://static.cloudflareinsights.com'), `${path}: the Cloudflare Web Analytics beacon script`);
    assert.ok(parts.find(part => part.startsWith('connect-src ')).split(' ').includes('https://cloudflareinsights.com'), `${path}: the beacon's reporting endpoint`);
    assert.equal(policy.includes('*.supabase.co'), !env.SUPABASE_URL, `${path}: the Supabase wildcard only without a configured project`);
    const checkout = ['/pricing', '/dashboard'].includes(path);
    assert.equal(parts.find(part => part.startsWith('style-src ')).includes("'unsafe-inline'"), checkout, `${path}: inline styles only where the Razorpay checkout runs`);
    assert.equal(policy.includes('http://127.0.0.1:*'), path === '/neuroncli/login/', `${path}: the loopback form target is the CLI sign-in page's alone`);
    assert.equal(policy.includes('frame-src https://api.razorpay.com'), checkout, `${path}: payment frames only on the checkout pages`);
  }
  assert.ok(!/unsafe-/.test(ADMIN_POLICY), 'the operator policy has no unsafe source');
}

// Every maker logo the pane draws is vendored, with its licence notice.
for (const m of read('zx-tokens.css').matchAll(/url\("(\/[^"]+)"\)/g)) assert.ok(isFile(m[1].slice(1)), 'zx-tokens.css: ' + m[1] + ' exists');
assert.match(read('Assets/makers/NOTICE.txt'), /Simple Icons[\s\S]*CC0 1\.0/, 'maker logos carry their Simple Icons CC0 notice');
for (const m of read('site-fonts.css').matchAll(/url\(['"]?(https:[^'")]+)/g)) assert.ok(CSP.font.includes(new URL(m[1]).origin), 'font origin ' + m[1]);
for (const file of [...SITE_SCRIPTS, 'zerox-auth.js']) {
  for (const m of read(file).matchAll(/'(https:\/\/[^'\s]+)'/g)) {
    const host = new URL(m[1].replace(/'.*$/, '')).hostname;
    assert.ok(['checkout.razorpay.com', 'cdn.jsdelivr.net', 'zero-x.live', 'dashboard.zero-x.live', 'www.w3.org'].includes(host), `${file}: unexpected origin ${m[1]}`);
  }
}
assert.match(read('zerox-auth.js'), /SUPABASE_JS_VERSION = '\d+\.\d+\.\d+'/, 'zerox-auth pins supabase-js');
assert.match(read('zerox-auth.js'), /SUPABASE_JS_INTEGRITY = 'sha384-[A-Za-z0-9+/]{64}'/);

/* ───────────── Design system: fonts, icons, tokens, no AI-slop patterns ───────────── */

// Pages that use the design system (the legacy product pages keep their own styles for now).
const LEGACY_PAGES = [];
const GUIDE_PAGES = ['find-files-by-content.html', 'wheres-that-file.html', 'neucockpit.html'];
const DESIGN_PAGES = [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...GUIDE_PAGES].filter(f => f !== 'neuroncli/index.html' && !LEGACY_PAGES.includes(f));
const plainText = file => stripScripts(read(file)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Aspekta and JetBrains Mono are self-hosted (SIL OFL, licences next to the files); nothing is loaded from a font CDN.
{
  const css = read('zx-tokens.css');
  const faces = [...css.matchAll(/@font-face \{ font-family: '([^']+)'; font-weight: (\d+); font-style: normal; font-display: swap; src: url\('(\/fonts\/[^']+\.woff2)'\)/g)];
  assert.deepEqual(faces.map(m => m[1] + ' ' + m[2]), ['Aspekta 400', 'Aspekta 450', 'Aspekta 500', 'Aspekta 600', 'JetBrains Mono 400', 'JetBrains Mono 500', 'JetBrains Mono 700'], 'the font faces the design uses');
  for (const m of faces) assert.ok(isFile(m[3].slice(1)), 'font file ' + m[3]);
  assert.match(css, /font-family: 'Aspekta Fallback'; src: local\('Arial'\)[^}]*size-adjust/, 'a size-adjusted fallback for Aspekta');
  assert.match(css, /font-family: 'JetBrains Mono Fallback'; src: local\('Courier New'\)[^}]*size-adjust/, 'a size-adjusted fallback for JetBrains Mono');
  assert.match(read('fonts/OFL-Aspekta.txt'), /SIL OPEN FONT LICENSE Version 1\.1/, 'Aspekta licence text ships with the font');
  assert.match(read('fonts/OFL-JetBrains-Mono.txt'), /SIL Open Font License, Version 1\.1/, 'JetBrains Mono licence text ships with the font');
  const firstPaint = ['aspekta-400', 'aspekta-450', 'aspekta-500', 'aspekta-600', 'jetbrains-mono-400', 'jetbrains-mono-500']
    .reduce((sum, name) => sum + statSync(new URL(`fonts/${name}.woff2`, root)).size, 0);
  assert.ok(firstPaint < 150 * 1024, `fonts used for first paint are ${firstPaint} bytes (under 150 KB)`);
}
// Every page that uses the design system preloads the two faces used above the fold and links no font CDN.
for (const file of [...DESIGN_PAGES, 'neuroncli/login/index.html', 'neuroncli/callback/index.html', 'neuroncli/device/index.html', 'neuroncli/admin/keys/index.html', 'neuroncli/admin/models/index.html']) {
  const html = read(file);
  const preloads = tags(html, 'link').filter(a => a.rel === 'preload');
  assert.deepEqual(preloads.map(a => a.href), ['/fonts/aspekta-400.woff2', '/fonts/aspekta-500.woff2'], file + ': preloads the two faces used above the fold');
  for (const link of preloads) assert.deepEqual([link.as, link.type, 'crossorigin' in link], ['font', 'font/woff2', true], file + ': font preload attributes');
  assert.doesNotMatch(html, /site-fonts\.css|fontshare|fonts\.googleapis|fonts\.gstatic/, file + ': no hotlinked fonts');
  assert.deepEqual(tags(html, 'meta').filter(a => a.name === 'theme-color').map(a => a.media), ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)'], file + ': theme colour for both schemes');
}
// One icon sprite, same origin, Lucide: every <use> resolves to a symbol in it.
{
  const sprite = read('icons.svg');
  const symbols = new Set([...sprite.matchAll(/<symbol id="([\w-]+)" viewBox="0 0 24 24">/g)].map(m => m[1]));
  assert.ok(symbols.size >= 60, 'the sprite has the icons the site needs');
  for (const name of ['home', 'chat', 'lock', 'bar-chart', 'timer', 'check-circle', 'list', 'globe', 'box', 'user', 'credit-card', 'scroll', 'settings', 'arrow-right', 'x', 'menu',
    'terminal', 'download', 'external-link', 'copy', 'check', 'search', 'book', 'shield', 'key']) assert.ok(symbols.has(name), 'sprite icon ' + name);
  assert.match(sprite, /ISC License[\s\S]*Permission to use, copy, modify/, 'the sprite carries the Lucide ISC licence');
  assert.doesNotMatch(sprite.replace(/<!--[\s\S]*?-->/, ''), /<(?:script|image|foreignObject|style)\b|\son[a-z]+=|href=/i, 'the sprite is plain vector paths');
  for (const file of allHtml) {
    for (const m of read(file).matchAll(/<use href="([^"]+)"/g)) {
      assert.match(m[1], /^\/icons\.svg#[\w-]+$/, `${file}: icons come from the same-origin sprite (${m[1]})`);
      assert.ok(symbols.has(m[1].split('#')[1]), `${file}: ${m[1]} exists in the sprite`);
    }
  }
  assert.match(read('zx-tokens.css'), /\.zx-icon \{[^}]*stroke-width: 1\.5; stroke-linecap: round; stroke-linejoin: round;/, '.zx-icon: 1.5px stroke, round caps and joins');
}
// Anti-slop rules for the shared stylesheets: no gradients, glass, violet, stacked shadows; purple survives only as a legacy alias.
for (const file of ['zx-tokens.css', 'home.css', 'content.css']) {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /gradient\(/i, file + ': no gradients');
  assert.doesNotMatch(css, /backdrop-filter|filter:\s*blur/i, file + ': no glass or blur');
  assert.doesNotMatch(css, /violet|#(?:7C4DFF|A58AFF|5B3FD0)/i, file + ': no violet');
  assert.doesNotMatch(css.replace(/--zx-purple(?:-soft)?: [^;]+;|\.zx-badge--purple|var\(--zx-purple(?:-soft)?\)/g, ''), /purple/i, file + ': purple only survives as a legacy alias for the tan accent');
  assert.doesNotMatch(css, /box-shadow:[^;{}]*\),\s*[^;{}]*\)/i, file + ': no stacked drop shadows');
}
{
  const css = read('zx-tokens.css');
  for (const token of ['bg', 'panel', 'surface-strong', 'border', 'ink', 'muted', 'accent', 'tan', 'green', 'amber', 'red', 'slate', 'radius', 'font-body', 'font-mono']) {
    assert.ok(new RegExp('--zx-' + token + ':').test(css), 'token --zx-' + token);
  }
  // Light is the default; dark follows the system and data-theme.
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/, 'dark through prefers-color-scheme unless data-theme="light"');
  const light = css.match(/\n:root \{([\s\S]*?)\n\}/)[1];
  const dark = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1];
  assert.match(light, /--zx-bg: #FFFFFF;/, 'the default theme is light');
  assert.match(light, /--zx-ink: #1B1B1B;/, 'ink');
  assert.match(dark, /--zx-bg: #141413;/, 'dark paper');
  assert.match(dark, /--zx-ink: #ECEBE8;/, 'dark ink');
  // The media-query dark block and the data-theme block carry the same values.
  const media = css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/)[1];
  const values = block => Object.fromEntries([...block.matchAll(/(--zx-[\w-]+): ([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const darkValues = values(dark);
  const mediaValues = values(media);
  for (const key of Object.keys(mediaValues)) assert.equal(darkValues[key], mediaValues[key], 'dark tokens agree: ' + key);
  for (const key of Object.keys(darkValues).filter(k => k !== 'color-scheme')) assert.ok(key in mediaValues, 'dark tokens agree: ' + key);
  // WCAG 4.5:1 for the text tokens on the surfaces they sit on, in both themes.
  const lum = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m); return (hi + .05) / (lo + .05); };
  for (const [name, block] of Object.entries({ light, dark })) {
    const v = key => { const m = block.match(new RegExp('--zx-' + key + ': (#[0-9A-Fa-f]{6})')); assert.ok(m, `${name}: --zx-${key}`); return m[1]; };
    for (const textToken of ['ink', 'muted', 'faint', 'accent-text', 'success', 'warning', 'danger', 'info', 'tan-text']) {
      for (const surface of ['bg', 'panel']) assert.ok(ratio(v(textToken), v(surface)) >= 4.5, `${name}: --zx-${textToken} on --zx-${surface} is ${ratio(v(textToken), v(surface)).toFixed(2)}:1 (needs 4.5)`);
    }
    assert.ok(ratio(v('on-ink'), v('ink-fill')) >= 4.5, name + ': primary button label');
    assert.ok(ratio(v('ink'), v('surface-strong')) >= 4.5 && ratio(v('muted'), v('surface-strong')) >= 4.5, name + ': text on the active pill');
  }
}
for (const file of DESIGN_PAGES) assert.doesNotMatch(plainText(file), /supercharge|unlock the|seamless|revolutionary|next-gen|game-chang/i, file + ': no generic filler words');
// The shared footer is the same on every page: three link groups and the brand, the current page marked.
for (const file of DESIGN_PAGES) {
  const footer = read(file).match(/<footer class="zx-footer">[\s\S]*?<\/footer>/)[0];
  assert.deepEqual([...footer.matchAll(/<nav aria-label="([^"]+)"/g)].map(m => m[1]), ['Product', 'Company', 'Legal'], file + ': footer groups');
  for (const path of ['/neuron-cli', '/pricing', '/docs', '/about', '/contact', '/terms', '/privacy', '/refund', '/shipping', '/download', '/changelog']) {
    assert.ok(footer.includes(`href="${path}"`) || footer.includes(`href="https://zero-x.live${path}"`), `${file}: footer links ${path}`);
  }
  assert.match(footer, /<a class="zx-brand" href="[^"]+"[^>]*><img src="\/Assets\/zerox-mark\.svg" width="28" height="28" alt="">Zero-X<\/a>/, file + ': footer brand');
  assert.match(read(file), /<button class="zx-nav-toggle"[^>]*><svg class="zx-icon zx-icon--menu"[^>]*><use href="\/icons\.svg#menu"\/><\/svg><svg class="zx-icon zx-icon--close"[^>]*><use href="\/icons\.svg#x"\/><\/svg>Menu<\/button>/, file + ': Menu button icons');
}
// The announcement bar on the homepage: a region, a pill, one line with an arrow link, a close button that stays hidden until announce.js runs.
{
  const html = read('index.html');
  const bar = html.match(/<div class="zx-announce"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(bar, /role="region" aria-label="Announcement" data-announce="[\w-]+"/, 'announcement region');
  assert.match(bar, /<span class="zx-badge zx-badge--ink">New<\/span>/, 'announcement pill');
  assert.match(bar, /<button class="zx-announce__close" type="button" aria-label="Dismiss announcement" hidden>/, 'announcement close button is hidden without the script');
  assert.ok(tags(html, 'script').some(a => a.type === 'module' && a.src === '/announce.js'), 'index loads announce.js');
}
assert.match(read('zerox-auth.js'), /getAccessToken: getAccessToken/);

/* .assetsignore must not hide the new public files */
{
  const patterns = read('.assetsignore').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const toRegex = pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + (pattern.endsWith('/') ? '' : '$'));
  for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...SITE_SCRIPTS, ...RELEASE_MANIFESTS, 'zx-tokens.css', 'site-fonts.css', 'home.css', 'content.css',
    'neucockpit.html', 'favicon.ico', 'Assets/zerox-share.png', 'icons.svg', 'announce.js', 'fonts/aspekta-400.woff2', 'fonts/aspekta-500.woff2', 'fonts/jetbrains-mono-400.woff2', 'fonts/OFL-Aspekta.txt', 'fonts/OFL-JetBrains-Mono.txt']) {
    assert.ok(isFile(file), `${file} exists`);
    assert.ok(!patterns.some(pattern => toRegex(pattern).test(file)), `${file} is excluded from the Worker assets`);
  }
  // Share cards: every public page names an image that is deployed with the site.
  for (const file of PUBLIC_PAGES) {
    for (const key of ['og:image', 'twitter:image']) {
      const url = new URL(meta(read(file))[key]);
      assert.equal(url.origin, 'https://zero-x.live', `${file}: ${key} host`);
      assert.ok(isFile('.' + url.pathname), `${file}: ${key} ${url.pathname} exists`);
    }
  }
}

/* ───────────── Legal content required for payment activation ───────────── */

const text = file => stripScripts(read(file)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ADDRESS = '6/2, N. Pugalur, Karur 639113, Tamil Nadu, India';
{
  const refund = read('refund.html');
  for (const id of ['cancellation', 'refunds', 'request', 'contact']) assert.ok(refund.includes(`id="${id}"`), 'refund: section ' + id);
  // The refund terms are approved, so the draft "Owner review required" box is gone.
  assert.ok(!refund.includes('id="owner-review"'), 'refund: no owner-review draft box');
  assert.doesNotMatch(text('refund.html'), /Owner review required/);
  assert.match(text('refund.html'), /full refund of your first payment within 7 days of that payment/);
  assert.match(text('refund.html'), /Credits that have been consumed by requests are not refundable/);
  assert.match(text('refund.html'), /cancel at any time/i);
  assert.match(text('refund.html'), /stay active until the end of the billing period/);
  assert.ok(text('refund.html').includes(ADDRESS));

  assert.match(text('shipping.html'), /do not sell or ship physical goods/);
  assert.match(text('shipping.html'), /no shipping charges/);
  assert.match(text('shipping.html'), /as soon as Razorpay confirms the payment/);
  assert.doesNotMatch(text('shipping.html'), /Gemini|Groq|OpenRouter|Workers AI|NVIDIA/, 'shipping.html names no provider or switched-off model');

  const contact = text('contact.html');
  assert.ok(contact.includes('Zero-X 6/2, N. Pugalur Karur 639113 Tamil Nadu, India'), 'contact: postal address');
  assert.match(contact, /support@zero-x\.live/);
  assert.match(contact, /within 2 business days/);
  for (const file of ['about.html', 'privacy.html', 'terms.html']) assert.ok(text(file).includes('6/2, N. Pugalur, Karur 639113'), file + ' carries the same address');

  const privacy = text('privacy.html');
  for (const processor of ['Groq', 'Google Gemini API', 'Cloudflare', 'Workers AI', 'OpenRouter', 'NVIDIA', 'Supabase', 'Razorpay']) assert.ok(privacy.includes(processor), 'privacy: processor ' + processor);
  // Providers as the live gateway serves them: free OpenRouter and NVIDIA models on every plan.
  assert.match(privacy, /Serves the free OpenRouter models Zero-X offers/);
  assert.match(privacy, /Free models served on NVIDIA's shared trial endpoints/);
  assert.match(privacy, /may use prompts to improve their models and may let humans review them/);
  for (const id of ['retention', 'rights', 'grievance', 'age', 'processors']) assert.ok(read('privacy.html').includes(`id="${id}"`), 'privacy: section ' + id);
  assert.match(privacy, /aged 18 or over/);
  assert.match(privacy, /Data Protection Board of India/);

  const terms = read('terms.html');
  for (const id of ['plans', 'billing', 'credits', 'fair-use', 'free-tier', 'acceptable-use', 'no-resale', 'suspension', 'liability', 'law']) assert.ok(terms.includes(`id="${id}"`), 'terms: section ' + id);
  assert.match(text('terms.html'), /renew automatically/);
  assert.match(text('terms.html'), /upstream provider's price plus 25%/);
  assert.match(text('terms.html'), /may not resell, sublicense, rent or share access/);
  assert.match(text('terms.html'), /at least 18 years old/);

  // Claude on the paid plans (Anthropic as a processor, credit holds, daily spend limits).
  assert.match(text('terms.html'), /Effective date: 3 November 2026\. Replaces the terms dated 25 October 2026/, 'terms.html effective date');
  // 4 November 2026: the optional GSTIN or tax ID (legal-versions.js privacy is 2026-11-04 with it, so buyers agree again).
  assert.match(text('privacy.html'), /Effective date: 4 November 2026\. Replaces the policy dated 3 November 2026\. This version adds the optional GSTIN or tax ID/, 'privacy.html effective date');
  const anthropicRow = read('privacy.html').match(/<tr><th scope="row"><a href="https:\/\/www\.anthropic\.com\/legal\/privacy">Anthropic<\/a><\/th>([\s\S]*?)<\/tr>/);
  assert.ok(anthropicRow, 'privacy: Anthropic is listed as a processor');
  assert.match(anthropicRow[1], /not used to train its models/);
  assert.doesNotMatch(anthropicRow[1], /\d+[ -]days?/, 'privacy: no Anthropic retention period until it is confirmed in docs/PROVIDER_TERMS.md');
  assert.match(privacy, /Requests to Claude Haiku 5\.5, which every plan includes, go to Anthropic, and so do requests to Claude Sonnet 5\.5 or Claude Opus 5\.5 on the paid plans/);
  assert.match(anthropicRow[1], /Claude Haiku 5\.5 on every plan and the paid models on the paid plans/, 'privacy: Haiku on the Free plan reaches Anthropic');
  assert.match(privacy, /read from or written to Anthropic's prompt cache/);
  assert.match(text('terms.html'), /including Anthropic, Groq, Google, Cloudflare, NVIDIA, OpenRouter and Z\.ai;/);
  assert.match(text('terms.html'), /paid-capacity models, including Claude Sonnet 5\.5 and Claude Opus 5\.5/);
  assert.match(text('terms.html'), /we hold the most it could cost[\s\S]*daily spending limit shared by all users/);
  const pricingPage = text('pricing.html');
  assert.match(pricingPage, /Claude Sonnet 5\.5 \$2\.50 \$0\.25 \$3\.125 \$12\.50/, 'pricing: Sonnet 5.5 at list price plus 25%');
  assert.match(pricingPage, /Claude Opus 5\.5 \$5\.00 \$0\.25 \$6\.25 \$25\.00/, 'pricing: Opus 5.5 at list price plus 25%');
  assert.match(pricingPage, /Anthropic \(Claude Haiku 5\.5 on every plan, Claude Sonnet 5\.5 and Claude Opus 5\.5 on the paid plans\)/, 'pricing: the provider FAQ names Anthropic');
  // Claude Haiku 5.5 on every plan (contract section 19): the copy says what it is and how it is limited, and names no provider.
  assert.match(pricingPage, /Every plan includes Claude Haiku 5\.5 at no charge, up to 10M tokens a month per account/);
  assert.match(pricingPage, /Claude Haiku 5\.5 on every plan Pick it with \/model claude-haiku-5-5 ; auto stays on the free models\. It costs no credits\./);
  assert.match(pricingPage, /renews on the first of each month \(UTC\)[\s\S]*insufficient_quota[\s\S]*every other model keeps working/);
  assert.match(pricingPage, /Models Free models and Claude Haiku 5\.5 Free models, Claude Haiku 5\.5, Claude Sonnet 5\.5 and Claude Opus 5\.5/);
  const haikuCopy = pricingPage.slice(pricingPage.indexOf('Claude Haiku 5.5 on every plan Pick it'), pricingPage.indexOf('Claude prices billed from credits'));
  assert.ok(haikuCopy.length > 100 && !/anthropic|groq|nvidia|openrouter|z\.ai/i.test(haikuCopy), 'pricing: the Haiku block names no provider');
  for (const file of ['index.html', 'neuron-cli.html']) assert.match(text(file), /Claude Haiku 5\.5 100K context/, file + ': the built-in model list has Haiku');
  // The price table shows exactly what the gateway bills (src/catalog.js: list price x MARKUP).
  const { catalogEntry } = await import('./src/catalog.js');
  const dollars = micro => `$${(micro / 1e6).toFixed(Math.max(2, String(micro / 1e6).split('.')[1]?.length ?? 0))}`;
  for (const [id, name] of [['anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['anthropic/claude-opus-5-5', 'Claude Opus 5.5']]) {
    const price = catalogEntry(id).pools.find(pool => pool.tier === 'paid').price;
    const row = [price.input_microusd_per_mtok, price.cache_read_microusd_per_mtok, price.cache_write_microusd_per_mtok,
      price.output_microusd_per_mtok].map(dollars).join(' ');
    assert.ok(pricingPage.includes(`${name} ${row}`), `pricing: ${name} row equals the gateway's billed rates (${row})`);
  }
  assert.match(text('docs.html'), /and for Claude cache_read_per_mtok_usd and cache_write_per_mtok_usd/, 'docs: the Claude cache price fields');

  // Legal rewrite of 2026-11-03: every provider the gateway can serve is named, what the text says about
  // Gemini and Workers AI follows the deploy configuration, and nothing promises what the schema does not do.
  const { BUILTIN_OFFERS } = await import('./src/oiop/offers.js');
  const providerNames = { anthropic: 'Anthropic', groq: 'Groq', nvidia: 'NVIDIA API Catalog', openrouter: 'OpenRouter', zai: 'Z.ai', gemini: 'Google Gemini API', cloudflare: 'Cloudflare Workers AI' };
  for (const provider of new Set(BUILTIN_OFFERS.map(offer => offer.provider))) {
    assert.ok(providerNames[provider], 'a provider the gateway can serve has a name in the legal text check: ' + provider);
    assert.ok(privacy.includes(providerNames[provider]), 'privacy names provider ' + provider);
  }
  const wrangler = read('neuroncli/auth-server/wrangler.toml');
  for (const [variable, phrase] of [['GEMINI_MODELS', 'Gemini models, only while Gemini is switched on (it is not at the moment)'], ['CLOUDFLARE_MODELS', 'Workers AI models, only while Workers AI is switched on (it is not at the moment)']]) {
    const off = new RegExp('^' + variable + ' = ""', 'm').test(wrangler);
    assert.equal(privacy.includes(phrase), off, 'privacy says ' + variable + (off ? ' is switched off' : ' is on') + ' (wrangler.toml; change both together)');
  }
  assert.match(privacy, /Amazon Web Services/);
  // Statements the system cannot back up stay out of the public text (review of 2026-11-03): the consent record is
  // described as the code writes it, the production host is hedged, no notice or receipt is promised on a third
  // party's behalf, and the static Free-plan line and model lists follow what is switched on.
  assert.doesNotMatch(text('privacy.html'), /Each time you start a payment/);
  assert.match(text('privacy.html'), /no new record is made for it/);
  assert.match(text('privacy.html'), /may also run on a server we operate on Amazon Web Services/);
  assert.match(text('privacy.html'), /A record is made when the payment window is prepared, not when the payment goes through/);
  for (const file of ['terms.html', 'pricing.html', 'docs.html', 'refund.html']) {
    assert.doesNotMatch(text(file), /Razorpay (also )?emails (you )?a receipt|(bank or Razorpay|Razorpay or your bank) will notify/, file + ' promises no receipt or notice from Razorpay');
  }
  assert.match(text('terms.html'), /Razorpay may email you a receipt for a payment/);
  const switchedOff = variable => new RegExp('^' + variable + ' = ""', 'm').test(wrangler);
  if (switchedOff('GEMINI_MODELS') && switchedOff('CLOUDFLARE_MODELS')) {
    for (const file of ['pricing.html', 'pricing.js', 'neuroncli/auth-server/src/plan-policy.js']) {
      assert.ok(!read(file).includes('Free models from Groq, Google Gemini'), file + ': the Free plan line names only providers that are switched on');
    }
    for (const file of ['index.html', 'neuron-cli.html']) {
      assert.ok(!/gemini\/gemini-|@cf\//.test(read(file)), file + ': the static model list has no Gemini or Workers AI row while they are switched off');
    }
  }
  assert.match(privacy, /Microsoft/);
  assert.match(privacy, /Expo/);
  assert.match(privacy, /text message to your phone number/);
  for (const id of ['billing-details', 'deletion', 'transfers', 'cookies', 'security', 'changes']) assert.ok(read('privacy.html').includes(`id="${id}"`), 'privacy: section ' + id);
  // What really happens: the database removes payment records with the account, so the text must not promise otherwise.
  assert.match(privacy, /our own copies of its credit ledger, subscription and payment records/);
  assert.match(privacy, /Razorpay keeps its own record of every payment/);
  assert.doesNotMatch(privacy, /even after account deletion/);
  assert.match(privacy, /grievance officer: Rahul S, founder of Zero-X, at support@zero-x\.live/);
  assert.doesNotMatch(privacy, /We do not ask for a tax or GST number/, 'the tax id is asked for (optionally) since 4 November 2026');
  assert.match(privacy, /You can also give a GSTIN or tax ID; it is optional, and if you give one we keep it with these details and use it only for billing records\. It is not sent to Razorpay\./);
  assert.match(privacy, /We never ask for card, UPI or bank details/);
  assert.match(text('docs/data.html'), /optional street address, phone and GSTIN or tax ID, business name/);
  assert.match(privacy, /Razorpay's payment window is filled in with your name \(the first 50 characters\), email address and phone number only/);
  assert.match(contact, /Grievance officer Zero-X is a small business founded and run by Rahul S/);
  assert.ok(read('contact.html').includes('id="grievance"'));
  for (const file of PUBLIC_PAGES) assert.ok(read(file).match(/<footer[\s\S]*<\/footer>/)[0].includes('Grievance officer'), file + ': footer names the grievance officer');
  assert.match(text('terms.html'), /Prices are the full amount you pay: no GST is charged on them/);
  assert.match(text('terms.html'), /currently 3,000,000 tokens, with a daily cap on requests, currently 100/);
  assert.match(text('terms.html'), /Neuron 7.0.0-alpha.5 and parts of the services are pre-release/);
  assert.match(text('terms.html'), /cancel at any time from the Billing tab/);
  assert.match(text('terms.html'), /danger-full-access mode it runs any command without asking/);
  for (const id of ['alpha', 'agent']) assert.ok(terms.includes(`id="${id}"`), 'terms: section ' + id);
  assert.match(text('refund.html'), /When a payment is refunded in full, the subscription is cancelled at once/);
  assert.match(text('refund.html'), /taken back in proportion/);
  assert.match(text('refund.html'), /Razorpay may retry it/);
  assert.match(text('refund.html'), /5 to 7 business days/);
  assert.match(pricingPage, /No GST is charged, so the price shown is the price you pay/);
  assert.match(pricingPage, /Paid plans renew every month at the price shown until you cancel/);
  assert.match(pricingPage, /How far does 3M tokens go\?/);
  // The owner's rule (2026-11-04): the pricing page does not name the providers behind the free models; the
  // privacy policy and docs/data.html, which disclose who receives requests, still do.
  assert.doesNotMatch(pricingPage, /Groq|NVIDIA|Z\.ai|Gemini|Workers AI|free models on OpenRouter|OpenRouter, free/, 'pricing names no upstream provider of the free models');
  assert.ok(read('pricing.html').includes('href="/privacy#processors"'), 'pricing links the privacy policy table of providers');
  for (const file of ['pricing.html', 'pricing.js', 'neuroncli/auth-server/src/plan-policy.js']) {
    assert.ok(read(file).includes('Free models chosen for coding, with tool use'), file + ': the Free plan line names no provider');
  }
  assert.match(read('zerox-auth.js'), /By continuing you agree to the <a href="https:\/\/zero-x\.live\/terms"[^>]*>Terms of Service<\/a> and the <a href="https:\/\/zero-x\.live\/privacy"[^>]*>Privacy Policy<\/a>, and confirm you are 18 or older/);
  assert.match(text('neuroncli/device/index.html'), /By continuing you agree to the Terms of Service and the Privacy Policy ?, and confirm you are 18 or older/);
  const data = text('docs/data.html');
  for (const word of ['Anthropic', 'Groq', 'NVIDIA', 'OpenRouter', 'Z.ai', 'Cloudflare', 'Amazon Web Services', 'Supabase', 'Razorpay', 'Expo']) assert.ok(data.includes(word), 'docs/data.html names ' + word);
  for (const id of ['flow', 'stored', 'processors', 'tokens', 'control', 'requests', 'security', 'changes']) assert.ok(ids(read('docs/data.html')).includes(id), 'docs/data.html #' + id);
  assert.match(data, /At most 14 days on our server/);
  assert.ok(ids(read('docs.html')).includes('data'), 'docs.html has a data section');
  assert.match(read('docs.html'), /href="\/docs\/data"/);
  const llmsText = read('llms.txt');
  for (const link of ['/privacy', '/terms', '/refund', '/shipping', '/docs/trust', '/docs/data']) assert.ok(llmsText.includes('(https://zero-x.live' + link + ')'), 'llms.txt links ' + link);
  assert.match(text('dashboard.html'), /Credits pay for Claude Sonnet 5\.5, Claude Opus 5\.5 and other paid capacity/);
}

/* ───────────── Prices and limits match PLATFORM_CONTRACT.md §1 ───────────── */

const contract = read('neuroncli/auth-server/docs/PLATFORM_CONTRACT.md');
const money = value => Math.round(Number(String(value).replace(/[^0-9.]/g, '')) * 100);
const expectedPlans = ['free', 'athlete', 'speed', 'pro', 'max'].map(id => {
  const cells = contract.match(new RegExp(`^\\| ${id} \\|(.*)\\|$`, 'm'))[1].split('|').map(cell => cell.trim());
  const [name, price, requests, tokens, rpm, concurrency, tiers, credits, windowTokens, windowSeconds] = cells;
  const [usd, inr] = price.split('/');
  const optional = value => value === '—' ? null : Number(value.replace(/,/g, ''));
  return {id, name, usd_cents: money(usd), inr_paise: inr ? money(inr) : 0, daily_requests: Number(requests.replace(/,/g, '')), daily_tokens: Number(tokens.replace(/,/g, '')),
    window_tokens: optional(windowTokens), window_seconds: optional(windowSeconds),
    rpm: Number(rpm), concurrency: Number(concurrency), tiers: tiers.split(',').map(t => t.trim()), monthly_credit_usd: money(credits) / 100};
});
const expectedTopups = [...contract.matchAll(/`(credits_\d+)` \(\$(\d+) credit, \$(\d+) \/ ₹([\d,]+)\)/g)].map(m => ({id: m[1], credit_usd: Number(m[2]), usd_cents: Number(m[3]) * 100, inr_paise: money(m[4])}));
assert.equal(expectedPlans.length, 5);
assert.deepEqual(expectedPlans.map(plan => [plan.id, plan.window_tokens, plan.window_seconds]),
  [['free', 3000000, 18000], ['athlete', null, null], ['speed', null, null], ['pro', null, null], ['max', null, null]],
  'contract section 1: Free has 3M tokens per rolling 5 hours, paid plans no window');
assert.equal(expectedTopups.length, 2);

const pricing = await import(new URL('pricing.js', root));
const {PLAN_CATALOG, formatMoney, formatTokens, formatCount, formatUsdAmount, limitLabel} = pricing;
assert.deepEqual(PLAN_CATALOG.plans.map(p => ({id: p.id, name: p.name, usd_cents: p.price.usd_cents, inr_paise: p.price.inr_paise, ...p.limits, tiers: p.tiers, monthly_credit_usd: p.monthly_credit_usd})), expectedPlans, 'PLAN_CATALOG matches contract §1');
assert.deepEqual(PLAN_CATALOG.topups.map(t => ({id: t.id, credit_usd: t.credit_usd, usd_cents: t.price.usd_cents, inr_paise: t.price.inr_paise})), expectedTopups, 'Top-up packs match contract §1');

function dataCells(html, attribute) {
  return [...html.matchAll(new RegExp(`<[a-z0-9]+\\b([^>]*\\b${attribute}="([^"]+)"[^>]*)>([^<]*)<`, 'g'))].map(m => ({key: m[2], attrs: attrs('<x ' + m[1] + '>'), text: m[3]}));
}
for (const file of ['pricing.html', 'neuron-cli.html']) {
  const html = read(file);
  const priceCells = dataCells(html, 'data-plan-price');
  assert.ok(priceCells.length >= 3, file + ': price cells');
  for (const cell of priceCells) {
    const plan = PLAN_CATALOG.plans.find(p => p.id === cell.key);
    const currency = cell.attrs['data-price-currency'] || 'USD';
    assert.equal(cell.text, formatMoney(currency === 'INR' ? plan.price.inr_paise : plan.price.usd_cents, currency), `${file}: ${cell.key} ${currency} price`);
  }
  for (const cell of dataCells(html, 'data-plan-limit')) {
    const [id, field] = cell.key.split(':');
    assert.equal(cell.text, limitLabel(PLAN_CATALOG.plans.find(p => p.id === id), field), `${file}: ${cell.key}`);
  }
  for (const cell of dataCells(html, 'data-plan-credit')) assert.equal(cell.text, formatUsdAmount(PLAN_CATALOG.plans.find(p => p.id === cell.key).monthly_credit_usd), `${file}: credit ${cell.key}`);
  for (const cell of dataCells(html, 'data-topup-price')) {
    const pack = PLAN_CATALOG.topups.find(t => t.id === cell.key);
    const currency = cell.attrs['data-price-currency'] || 'USD';
    assert.equal(cell.text, formatMoney(currency === 'INR' ? pack.price.inr_paise : pack.price.usd_cents, currency), `${file}: top-up ${cell.key}`);
  }
  for (const cell of dataCells(html, 'data-topup-credit')) assert.equal(cell.text, formatUsdAmount(PLAN_CATALOG.topups.find(t => t.id === cell.key).credit_usd));
}
// The coding-agent guide and the free and comparison landing pages quote Free plan limits without
// loading pricing.js, so their static text must match the catalog.
for (const file of ['ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html']) {
  const cells = dataCells(read(file), 'data-plan-limit');
  assert.ok(cells.length >= 2, file + ': limit cells');
  for (const cell of cells) {
    const [id, field] = cell.key.split(':');
    assert.equal(cell.text, limitLabel(PLAN_CATALOG.plans.find(p => p.id === id), field), `${file}: ${cell.key}`);
  }
}
{
  const html = read('pricing.html');
  for (const plan of PLAN_CATALOG.plans) {
    const list = html.match(new RegExp(`<ul data-plan-features="${plan.id}">([\\s\\S]*?)</ul>`))[1];
    assert.deepEqual([...list.matchAll(/<li>([^<]+)<\/li>/g)].map(m => m[1]), plan.features, `pricing.html: static features for ${plan.id} match the fallback catalog`);
  }
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const offers = graph.find(node => node['@type'] === 'Product').offers.map(o => [o.name, o.priceCurrency, Number(o.price)]);
  const expectedOffers = expectedPlans.flatMap(p => [[p.name, 'USD', p.usd_cents / 100], ...(p.inr_paise ? [[p.name, 'INR', p.inr_paise / 100]] : [])]);
  assert.deepEqual(offers.sort(), expectedOffers.sort(), 'Product JSON-LD offers match real prices');
  assert.match(meta(html).description, /\$10\/month/);
  assert.match(meta(html).description, /\$40\/month/);
  assert.match(meta(html).description, /Athlete \(\$1\/month\), Speed \(\$5\/month\)/);
  const software = JSON.parse(read('neuron-cli.html').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  assert.deepEqual([software.offers.price, software.offers.priceCurrency], ['0', 'USD']);
  const docsLimits = text('docs.html');
  for (const plan of expectedPlans) {
    const tokens = plan.window_tokens ? `${formatCount(plan.window_tokens)} per ${plan.window_seconds / 3600} hours` : `${formatCount(plan.daily_tokens)} per day`;
    assert.ok(docsLimits.includes(`${plan.name} ${formatCount(plan.daily_requests)} ${tokens} ${plan.rpm} ${plan.concurrency}`), 'docs.html limits row for ' + plan.id);
  }
}
{
  // Error codes documented in docs.html match contract §3.3.
  const section = contract.match(/### 3\.3 Errors([\s\S]*?)### 3\.4/)[1];
  const codes = [...section.matchAll(/^\| (\d{3}) \| `([a-z_]+)` \| ([a-z_]+) \|/gm)].map(m => [m[1], m[2], m[3]]);
  assert.equal(codes.length, 13);
  const docs = read('docs.html');
  for (const [status, code, type] of codes) {
    assert.match(docs, new RegExp(`<td>${status}</td><th scope="row"><code>${code}</code></th><td><code>${type}</code></td>`), 'docs.html error row ' + code);
  }
}

/* ───────────── Pure helpers ───────────── */

const checkout = await import(new URL('billing-checkout.js', root));
const dash = await import(new URL('dashboard.js', root));

// Formatters
assert.equal(formatMoney(0, 'USD'), '$0');
assert.equal(formatMoney(1000, 'USD'), '$10');
assert.equal(formatMoney(1050, 'USD'), '$10.50');
assert.equal(formatMoney(89900, 'INR'), '₹899');
assert.equal(formatMoney(349900, 'INR'), '₹3,499');
assert.equal(formatMoney(174900, 'inr'), '₹1,749');
assert.equal(formatMoney(NaN, 'USD'), '—');
assert.equal(formatTokens(500000), '500K');
assert.equal(formatTokens(10000000), '10M');
assert.equal(formatTokens(1500000), '1.5M');
assert.equal(formatTokens(123456), '123K');
assert.equal(formatTokens(999), '999');
assert.equal(formatCount(10000), '10,000');
assert.equal(formatUsdAmount(35), '$35');
assert.equal(dash.formatUsd(7.4213), '$7.42');
assert.equal(dash.formatUsd(0), '$0.00');
assert.equal(dash.formatUsd(0.00123), '$0.0012');
assert.equal(dash.formatUsd(0.00001), '<$0.0001');
assert.equal(dash.formatUsd('2.5'), '$2.50');
assert.equal(dash.formatUsd(null), '—');
assert.equal(dash.formatMinor(89900, 'INR'), '₹899');
assert.equal(dash.formatMinor(1999, 'EUR'), '€19.99');
assert.equal(dash.formatMinor(null, 'USD'), '—');
assert.equal(dash.formatDate('2026-11-01T00:00:00Z'), 'Nov 1, 2026');
assert.equal(dash.formatDate('not a date'), '—');
assert.equal(dash.formatShortDay('2026-10-03'), 'Oct 3');
assert.equal(dash.formatDateTime('2026-10-16T17:05:00Z', 'UTC'), 'Oct 16, 17:05');

// Limits and progress
assert.equal(dash.percentUsed(50, 100), 50);
assert.equal(dash.percentUsed(150, 100), 100);
assert.equal(dash.percentUsed(5, 0), 0);
assert.equal(dash.percentUsed(5, null), 0);
assert.equal(dash.progressTone(74), 'ok');
assert.equal(dash.progressTone(75), 'warn');
assert.equal(dash.progressTone(90), 'danger');
const now = Date.parse('2026-10-16T22:30:00Z');
assert.equal(dash.formatResetIn('2026-10-17T00:00:00Z', now), 'Resets in 1 h 30 min');
assert.equal(dash.formatResetIn('2026-10-16T22:30:30Z', now), 'Resets in under a minute');
assert.equal(dash.formatResetIn('2026-10-19T00:00:00Z', now), 'Resets on Oct 19, 2026');
assert.equal(dash.formatResetIn('', now), '');
assert.equal(dash.formatFreesIn('2026-10-17T01:15:00Z', now), 'Frees up in 2 h 45 min');
assert.equal(dash.formatFreesIn(null, now), '');
assert.equal(dash.windowLabel(18000), '5-hour');
assert.equal(dash.windowLabel(5400), '90-minute');

// Chart scaling
assert.equal(dash.niceMax(0), 1);
assert.equal(dash.niceMax(7), 10);
assert.equal(dash.niceMax(40), 50);
assert.equal(dash.niceMax(230), 250);
assert.equal(dash.niceMax(1001), 2000);
{
  const scale = dash.chartScale([0, 25, 50, 1], {width: 400, height: 100, gap: 4, minBar: 2});
  assert.equal(scale.max, 50);
  assert.deepEqual(scale.bars.map(b => b.height), [0, 50, 100, 2], 'Heights are proportional with a visible minimum');
  assert.deepEqual(scale.bars.map(b => b.x), [2, 102, 202, 302]);
  assert.ok(scale.bars.every(b => b.width === 96 && b.y === 100 - b.height));
  assert.deepEqual(dash.chartScale([], {}).bars, []);
  assert.deepEqual(dash.chartScale([-5, 'x', null]).bars.map(b => b.height), [0, 0, 0], 'Invalid values draw nothing');
}
assert.deepEqual(dash.fillDays([{day: '2026-10-02', requests: 3}], '2026-10-01', '2026-10-03').map(r => [r.day, r.requests]), [['2026-10-01', 0], ['2026-10-02', 3], ['2026-10-03', 0]]);
assert.equal(dash.fillDays([], '2026-01-01', '2026-12-31').length, 92, 'At most 92 days');
assert.deepEqual(dash.fillDays([], '2026-10-05', '2026-10-01'), []);
assert.deepEqual(dash.lastDaysRange(Date.parse('2026-10-16T23:59:00Z')), {from: '2026-09-17', to: '2026-10-16'});

// Routing
assert.equal(dash.parseTab('#billing'), 'billing');
assert.equal(dash.parseTab('#KEYS'), 'keys');
assert.equal(dash.parseTab('#main'), 'overview');
assert.equal(dash.parseTab(''), 'overview');
assert.equal(dash.nextTab('overview', 'ArrowLeft'), 'account');
assert.equal(dash.nextTab('account', 'ArrowRight'), 'overview');
assert.equal(dash.nextTab('usage', 'Home'), 'overview');
assert.equal(dash.nextTab('usage', 'End'), 'account');
assert.equal(dash.nextTab('usage', 'Enter'), null);

// Normalizers keep untrusted data inert
{
  const account = dash.normalizeAccount({user: {id: 'u', email: 'a@b.c', image_url: 'javascript:alert(1)'}, plan: {id: 'PRO<x>'}, limits: {daily_requests: '2000'}, usage_today: {requests: 'x'}, flags: {suspended: 'yes'}});
  assert.equal(account.user.image_url, '');
  assert.equal(account.plan.id, 'free');
  assert.equal(account.limits.daily_requests, 2000);
  assert.equal(account.limits.daily_tokens, null);
  assert.equal(account.usage.requests, 0);
  assert.equal(account.suspended, false);
  assert.equal(dash.normalizeAccount(null).plan.name, 'Free');
  assert.equal(account.window, null, 'no usage_window, no window');
  const windowed = dash.normalizeAccount({limits: {window_tokens: 1000000, window_seconds: 18000},
    usage_window: {tokens: '250000', limit_tokens: 1000000, remaining_tokens: 750000, window_seconds: 18000, resets_at: '2026-10-16T23:00:00Z'}});
  assert.deepEqual(windowed.window, {tokens: 250000, limit: 1000000, seconds: 18000, resets_at: '2026-10-16T23:00:00Z', split: null});
  assert.deepEqual([windowed.limits.window_tokens, windowed.limits.window_seconds], [1000000, 18000]);
  // token_split (GET /api/account, migration 20261109000000): the raw tokens behind the counted ones.
  const split = dash.normalizeAccount({limits: {window_tokens: 3000000, window_seconds: 18000},
    usage_today: {tokens: 470000, token_split: {input_tokens: 400000, cached_input_tokens: 600000, output_tokens: 8000}},
    usage_window: {tokens: 468000, limit_tokens: 3000000, window_seconds: 18000,
      token_split: {input_tokens: '400000', cached_input_tokens: 600000, output_tokens: 8000}}});
  assert.deepEqual(split.window.split, {input: 400000, cached: 600000, output: 8000});
  assert.deepEqual(split.usage.split, {input: 400000, cached: 600000, output: 8000});
  assert.equal(dash.tokenSplitText(split.window.split), 'Input 400K · cached 600K (counts 10%) · output 8K');
  assert.equal(dash.tokenSplitText(null), null, 'no split, no line');
  assert.equal(dash.tokenSplitText({input: 0, cached: 0, output: 0}), null, 'nothing used yet, no line');
  assert.equal(dash.normalizeAccount({usage_today: {token_split: {input_tokens: 'x', cached_input_tokens: 1, output_tokens: 1}}}).usage.split, null,
    'an invalid split is ignored');
  assert.equal(dash.normalizeAccount({usage_window: {limit_tokens: 'lots', window_seconds: 18000}}).window, null, 'an invalid window is ignored');
  assert.equal(dash.normalizeAccount({user: {image_url: 'https://lh3.googleusercontent.com/a.png'}}).user.image_url, 'https://lh3.googleusercontent.com/a.png');
}
assert.equal(dash.normalizeEvents({events: [], next_before: 'x;drop'}).nextBefore, null);
assert.equal(dash.normalizeEvents({events: [], next_before: 42}).nextBefore, '42');
assert.equal(dash.normalizeEvents({events: [{id: 1, latency_ms: 'n/a'}]}).events[0].latency_ms, null);
assert.deepEqual(dash.normalizeKeys({keys: [{id: '../etc', name: 'x'}, {id: 'k1', name: ''}]}).map(k => [k.id, k.name]), [['k1', 'Untitled key']]);
assert.equal(dash.keyStatus({revoked_at: '2026-10-01'}), 'revoked');
assert.equal(dash.keyStatus({revoked_at: null}), 'active');
assert.deepEqual(dash.validateKeyName('  CI  '), {ok: true, name: 'CI'});
assert.equal(dash.validateKeyName('').ok, false);
assert.equal(dash.validateKeyName('x'.repeat(65)).ok, false);
assert.equal(dash.validateKeyName('bad\u0007name').ok, false);
{
  const billing = dash.normalizeBilling({provider_configured: true, subscription: {plan: 'max', status: 'halted'}, payments: [{kind: 'other', amount_minor: '500', currency: 'usd', invoice_url: 'http://insecure.example/i'}]});
  assert.equal(billing.payments[0].kind, 'subscription');
  assert.equal(billing.payments[0].currency, 'USD');
  assert.equal(billing.payments[0].amount_minor, 500);
  assert.equal(billing.payments[0].invoice_url, '', 'Only https invoice links are kept');
  assert.equal(dash.subscriptionSummary(billing.subscription).label, 'Payment issue');
}
assert.deepEqual(dash.subscriptionSummary(null).canCancel, false);
assert.equal(dash.subscriptionSummary({status: 'active', cancel_at_period_end: false, current_period_end: '2026-11-01T00:00:00Z'}).periodText, 'Nov 1, 2026');
assert.equal(dash.subscriptionSummary({status: 'authenticated', cancel_at_period_end: true}).canCancel, false);
assert.equal(dash.subscriptionSummary({status: 'cancelled'}).label, 'Cancelled');
assert.equal(dash.subscriptionSummary({status: 'completed'}).active, false);
assert.equal(dash.paymentStatusTone('captured'), 'success');
assert.equal(dash.paymentStatusTone('failed'), 'danger');
assert.equal(dash.eventStatusTone('ok'), 'success');

// Pricing catalog handling
assert.equal(pricing.defaultCurrency({stored: 'INR'}), 'INR');
assert.equal(pricing.defaultCurrency({timeZone: 'Asia/Kolkata'}), 'INR');
assert.equal(pricing.defaultCurrency({timeZone: 'Europe/Berlin', fallback: 'usd'}), 'USD');
assert.equal(pricing.defaultCurrency({stored: 'EUR', timeZone: 'America/New_York'}), 'USD');
assert.equal(pricing.normalizeCatalog(null), null);
assert.equal(pricing.normalizeCatalog({plans: [{id: 'pro', price: {usd_cents: -1, inr_paise: 1}}]}), null, 'Invalid prices are rejected');
{
  const normalized = pricing.normalizeCatalog({currency_default: 'INR', plans: [{id: 'pro', name: '<b>Pro</b>', price: {usd_cents: 1000, inr_paise: 89900}, limits: {daily_requests: 2000, rpm: 'fast'}, features: ['ok', 7, ''], highlighted: 'yes'}, {id: 'BAD ID', price: {usd_cents: 1, inr_paise: 1}}],
    topups: [{id: 'credits_5', credit_usd: 5, price: {usd_cents: 500, inr_paise: 44900}}, {id: 'gift', price: {usd_cents: 1, inr_paise: 1}}]});
  assert.equal(normalized.currency_default, 'INR');
  assert.deepEqual(normalized.plans.map(p => p.id), ['pro']);
  assert.equal(normalized.plans[0].limits.rpm, null);
  assert.deepEqual(normalized.plans[0].features, ['ok']);
  assert.equal(normalized.plans[0].highlighted, false);
  assert.deepEqual(normalized.topups.map(t => t.id), ['credits_5']);
}
const proPlan = PLAN_CATALOG.plans.find(plan => plan.id === 'pro');
const athletePlan = PLAN_CATALOG.plans.find(plan => plan.id === 'athlete');
assert.deepEqual(PLAN_CATALOG.plans.map(plan => plan.id), ['free', 'athlete', 'speed', 'pro', 'max'], 'the site catalog lists the plans in price order');
assert.equal(limitLabel(athletePlan, 'token_allowance'), '6M per day', 'Athlete: 6M tokens per day');
assert.equal(limitLabel(athletePlan, 'daily_requests'), '300');
assert.equal(formatUsdAmount(athletePlan.monthly_credit_usd), '$0.75', 'Athlete credits show cents');
assert.equal(formatMoney(athletePlan.price.inr_paise, 'INR'), '₹89');
assert.equal(limitLabel(proPlan, 'daily_tokens'), '10M');
assert.equal(limitLabel(PLAN_CATALOG.plans[0], 'token_allowance'), '3M every 5 hours', 'Free: the rolling window');
assert.equal(limitLabel(PLAN_CATALOG.plans[0], 'window_tokens'), '3M');
assert.equal(limitLabel(proPlan, 'token_allowance'), '10M per day');
assert.equal(limitLabel(proPlan, 'window_tokens'), null, 'no window on Pro');
assert.equal(pricing.windowLength(3600), 'hour');
assert.equal(pricing.windowLength(5400), '90 minutes');
assert.equal(pricing.tokenAllowance({limits: {daily_tokens: 500000, window_tokens: null}}), '500K per day', 'a catalog without a window');
// Running text carries the whole phrase in one hydrated span, so a database without the window
// (before migration 20261102000000) turns "1M tokens every 5 hours" into "500K tokens per day".
assert.equal(limitLabel(PLAN_CATALOG.plans[0], 'token_phrase'), '3M tokens every 5 hours');
assert.equal(limitLabel({limits: {daily_tokens: 500000, window_tokens: null, window_seconds: null}}, 'token_phrase'), '500K tokens per day');
assert.equal(limitLabel(proPlan, 'token_phrase'), '10M tokens per day');
for (const page of ['index.html', 'neuron-cli.html', 'ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html']) {
  const html = read(page);
  assert.doesNotMatch(html, /data-plan-limit="free:window_tokens"/, `${page}: no bare window number next to static "every 5 hours"`);
  assert.match(html, /<span data-plan-limit="free:token_phrase">3M tokens every 5 hours<\/span>/, `${page}: the whole phrase is hydrated`);
}
assert.deepEqual(pricing.normalizeCatalog({plans: [{id: 'free', price: {usd_cents: 0, inr_paise: 0}, limits: {window_tokens: 1000000, window_seconds: 18000}}]}).plans[0].limits,
  {daily_requests: null, daily_tokens: null, window_tokens: 1000000, window_seconds: 18000, rpm: null, concurrency: null});
assert.equal(limitLabel(proPlan, 'daily_requests'), '2,000');
assert.equal(limitLabel({limits: {rpm: null}}, 'rpm'), null);
{
  const store = new Map();
  const storage = {getItem: k => store.get(k) ?? null};
  const t0 = Date.parse('2026-10-16T10:00:00Z');
  store.set(pricing.PENDING_CHECKOUT_KEY, JSON.stringify({kind: 'plan', id: 'pro', currency: 'inr', created: t0}));
  assert.deepEqual(pricing.readPendingCheckout(storage, t0 + 60000), {kind: 'plan', id: 'pro', currency: 'INR'});
  assert.equal(pricing.readPendingCheckout(storage, t0 + 16 * 60000), null, 'Pending checkout intents expire');
  store.set(pricing.PENDING_CHECKOUT_KEY, '{not json');
  assert.equal(pricing.readPendingCheckout(storage, t0), null);
  store.set(pricing.PENDING_CHECKOUT_KEY, JSON.stringify({kind: 'charge', id: 'pro', created: t0}));
  assert.equal(pricing.readPendingCheckout(storage, t0), null);
}

// API client and checkout payload validation
assert.equal(checkout.safeHttpsUrl('https://rzp.io/i/x'), 'https://rzp.io/i/x');
for (const bad of ['javascript:alert(1)', 'http://rzp.io/i/x', '/relative', 'https://user:pw@rzp.io/', '', null, 42]) assert.equal(checkout.safeHttpsUrl(bad), '');
assert.equal(checkout.siteUrl('/pricing', '127.0.0.1'), '/pricing');
assert.equal(checkout.siteUrl('/pricing', 'dashboard.zero-x.live'), 'https://zero-x.live/pricing');
assert.equal(checkout.siteUrl('/', 'dashboard.zero-x.live'), 'https://zero-x.live/');
assert.equal(checkout.dashboardUrl('#billing', 'zero-x.live'), 'https://dashboard.zero-x.live/#billing');
assert.equal(checkout.dashboardUrl('#billing', 'localhost'), '/dashboard#billing');
assert.equal(checkout.dashboardUrl('#"><script>', 'zero-x.live'), 'https://dashboard.zero-x.live/');
assert.equal(checkout.normalizeCurrency('inr'), 'INR');
assert.equal(checkout.normalizeCurrency('EUR'), 'USD');
{
  const error = checkout.parseApiError(429, {error: {message: 'Daily limit reached', type: 'insufficient_quota', code: 'insufficient_quota', param: null, request_id: 'req_1', upgrade_url: 'https://zero-x.live/pricing', resets_at: '2026-10-17T00:00:00Z'}});
  assert.equal(error.code, 'insufficient_quota');
  assert.equal(error.upgradeUrl, 'https://zero-x.live/pricing');
  assert.equal(error.resetsAt, '2026-10-17T00:00:00Z');
  assert.equal(error.requestId, 'req_1');
  assert.equal(checkout.describeError(error), 'Daily limit reached');
  const limited = checkout.parseApiError(429, {error: {message: 'Slow down.', code: 'rate_limited'}}, '7');
  assert.equal(limited.retryAfterSeconds, 7);
  assert.equal(checkout.describeError(limited), 'Slow down. Try again in 7 s.');
  const legacy = checkout.parseApiError(503, {error: 'Service temporarily unavailable.', code: 'service_unavailable'});
  assert.equal(legacy.message, 'Service temporarily unavailable.');
  assert.equal(legacy.code, 'service_unavailable');
  assert.equal(checkout.parseApiError(401, null).code, 'invalid_session');
  assert.equal(checkout.parseApiError(500, 'oops').message, 'Zero-X is temporarily unavailable. Try again shortly.');
  assert.equal(checkout.parseApiError(400, {error: {message: 'x', upgrade_url: 'javascript:alert(1)'}}).upgradeUrl, '');
  assert.match(checkout.describeError(checkout.parseApiError(409, {error: {code: 'already_subscribed', message: 'raw'}})), /already have an active subscription/);
  assert.match(checkout.describeError(checkout.parseApiError(503, {error: {code: 'billing_not_configured', message: 'raw'}})), /support@zero-x\.live/);
  assert.equal(checkout.describeError(new TypeError('internal detail')), 'Something went wrong. Try again.', 'Internal errors are not shown to users');
}
{
  const handlers = {onPayment() {}, onDismiss() {}};
  const sub = checkout.checkoutOptions({provider: 'razorpay', key_id: 'rzp_live_AbCdEf123456', subscription_id: 'sub_ABC123456', name: 'Zero-X', description: 'Pro plan', prefill: {email: 'a@b.c', name: 'A'}, notes: {plan: 'pro', user_id: 'u1', '__proto__': 'x', nested: {a: 1}}}, handlers);
  assert.equal(sub.key, 'rzp_live_AbCdEf123456');
  assert.equal(sub.subscription_id, 'sub_ABC123456');
  assert.equal(sub.order_id, undefined);
  assert.deepEqual(sub.theme, {color: '#3B82F6'});
  assert.deepEqual(sub.notes, {plan: 'pro', user_id: 'u1'});
  assert.equal(sub.handler, handlers.onPayment);
  assert.equal(sub.modal.ondismiss, handlers.onDismiss);
  const order = checkout.checkoutOptions({provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', order_id: 'order_ABC123456', amount_minor: 44900, currency: 'INR'}, handlers);
  assert.deepEqual([order.order_id, order.amount, order.currency, order.subscription_id], ['order_ABC123456', 44900, 'INR', undefined]);
  for (const bad of [null, {provider: 'stripe', key_id: 'rzp_test_AbCdEf123456', order_id: 'order_1234'}, {provider: 'razorpay', key_id: 'sk_live_x', order_id: 'order_1234'}, {provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456'}, {provider: 'razorpay', key_id: 'rzp_test_AbCdEf123456', order_id: 'order_<x>'}]) {
    assert.throws(() => checkout.checkoutOptions(bad, handlers), error => error.code === 'billing_not_configured');
  }
  assert.deepEqual(checkout.verifyPayload({razorpay_payment_id: 'pay_ABC1234567', razorpay_subscription_id: 'sub_ABC123456', razorpay_signature: 'a1'.repeat(32), razorpay_order_id: 'order_ignored', extra: 1}),
    {razorpay_payment_id: 'pay_ABC1234567', razorpay_signature: 'a1'.repeat(32), razorpay_subscription_id: 'sub_ABC123456'});
  for (const bad of [{}, {razorpay_payment_id: 'pay_ABC1234567', razorpay_signature: 'zz'}, {razorpay_payment_id: 'pay_ABC1234567', razorpay_signature: 'a1'.repeat(32)}]) {
    assert.throws(() => checkout.verifyPayload(bad), error => error.code === 'payment_unverified');
  }
}
{
  const calls = [];
  const fetchImpl = async (path, options) => { calls.push([path, options]); return new Response(JSON.stringify({ok: true}), {status: 200}); };
  const auth = {async getAccessToken() { return 'tok'; }};
  assert.deepEqual(await checkout.apiFetch('/api/keys', {method: 'POST', body: {name: 'x'}, auth, fetchImpl}), {ok: true});
  assert.equal(calls[0][1].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.equal(calls[0][1].body, '{"name":"x"}');
  assert.equal(calls[0][1].credentials, 'same-origin');
  await checkout.apiFetch('/api/plans', {fetchImpl});
  assert.equal(calls[1][1].headers.Authorization, undefined, 'Anonymous calls send no credential');
  for (const bad of ['https://evil.example/api/keys', '//evil.example/api', '/api/../admin/overview', 'api/keys', '/admin/overview']) {
    await assert.rejects(checkout.apiFetch(bad, {fetchImpl}), TypeError);
  }
  await assert.rejects(checkout.apiFetch('/api/account', {auth: {async getAccessToken() { return ''; }}, fetchImpl}), error => error.code === 'invalid_session' && error.status === 401);
  assert.equal(calls.length, 2, 'Missing tokens and foreign URLs never reach the network');
  await assert.rejects(checkout.apiFetch('/api/account', {fetchImpl: async () => { throw new TypeError('Failed to fetch'); }}), error => error.code === 'network_error');
  await assert.rejects(checkout.apiFetch('/api/account', {fetchImpl: async () => new Response('{"error":{"message":"Nope","code":"account_suspended"}}', {status: 403})}), error => error.code === 'account_suspended' && error.status === 403);
}

/* Homepage: install commands, plan slots, live model list and its helpers */
{
  const html = read('index.html');
  for (const command of [INSTALL_NPM, INSTALL_PIP, INSTALL_SH, INSTALL_PS1, INSTALL_CMD, 'neuron login', 'curl https://zero-x.live/v1/models']) {
    assert.ok(html.includes(command), 'index.html shows ' + command);
  }
  // The hero, the first step and the closing call to action each carry the install bar, the hero's first.
  assert.deepEqual(installBars(html).map(bar => bar.match(/id="([\w-]+)-cmd"/)[1]), ['hero', 'step', 'cta'], 'index.html: install bars in the hero, step 1 and the call to action');
  assert.ok(html.indexOf('data-install-bar') < html.indexOf('<figure class="zx-term"'), 'index.html: the install bar sits under the hero copy, before the terminal illustration');
  // The old tabs are gone (the inline tab script on neuron-cli.html too).
  for (const file of ['index.html', 'neuron-cli.html']) assert.doesNotMatch(read(file), /data-install-tabs|data-tab-label/, file + ': no install tabs');
  for (const file of ['index.html', 'neuron-cli.html', 'docs.html', 'dashboard.html', 'pricing.html', 'download.html',
    'docs/trust.html', 'changelog.html']) {
    const page = read(file);
    assert.doesNotMatch(page, /pip install neuroncli/, file + ': pip install without --pre installs the unsupported 6.2.4');
    assert.doesNotMatch(page, /install script is not published|installer is not published/, file + ': stale installer notice');
    assert.doesNotMatch(page, /releases\/latest\/download\/install\./, file + ': unpinned installer (the alpha is a pre-release)');
    assert.doesNotMatch(page, /href="https:\/\/neuron\.zero-x\.live\/(?:#[\w-]*)?"/, file + ': NeuCockpit lives at https://zero-x.live/neucockpit');
  }
  // docs.html lists `neuron auth login` as the alias it is; the pages that only name one command use neuron login.
  for (const file of ['download.html', 'docs/trust.html', 'changelog.html']) {
    assert.doesNotMatch(read(file), /neuron auth login/, file + ': the sign-in command is neuron login');
  }
  for (const id of ['get-started', 'features', 'models', 'pricing', 'docs', 'faq', 'products']) assert.ok(ids(html).includes(id), 'index.html section #' + id);
  // The hero's command has a copy button.
  assert.ok(tags(html, 'button').some(b => b['data-copy-target'] === 'hero-cmd'), 'index.html copies #hero-cmd');
  assert.match(html, /<a class="zx-btn zx-btn--primary" href="#get-started">Start free<\/a>/, 'index.html: the free plan call to action');
  for (const plan of ['free', 'pro', 'max']) assert.match(html, new RegExp(`data-plan-price="${plan}"`), 'index.html hydrates the ' + plan + ' price');
  assert.match(text('index.html'), /The paid plans \(Athlete, Speed, Pro and Max\) raise the limits/, 'index.html names every paid plan');
  assert.match(html, /<main id="main" data-pricing-root>/, 'pricing.js hydrates the homepage');
  for (const button of tags(html, 'button').filter(b => 'data-copy-target' in b)) assert.ok(ids(html).includes(button['data-copy-target']), 'copy target ' + button['data-copy-target']);
  // The live model pane (home.js), on the homepage and the Neuron CLI page.
  const home = await import(new URL('home.js', root));
  for (const file of ['index.html', 'neuron-cli.html']) {
    const page = read(file);
    for (const id of ['models-list', 'models-note', 'models-live', 'models-live-text']) assert.ok(ids(page).includes(id), `${file}: live model pane #${id}`);
    assert.match(page, /<div class="zx-modelpane" data-live-models>/, file + ': home.js drives the pane');
    assert.ok(tags(page, 'script').some(s => s.src === '/home.js' && s.type === 'module'), file + ': loads home.js');
    // The built-in list (before JavaScript, without it, or when the gateway cannot be reached)
    // checked nothing: no row says Available, no switched-off or removed model, no provider, no route id.
    const staticList = page.slice(page.indexOf('id="models-list"'), page.indexOf('</ul>', page.indexOf('id="models-list"')));
    const staticRows = staticList.match(/<li class="zx-model"[^>]*>/g) || [];
    assert.ok(staticRows.length >= 5, file + ': a built-in model list');
    assert.ok(staticRows.every(row => row.includes('data-tone="unknown"')), file + ': built-in rows are not checked');
    assert.doesNotMatch(staticList, />Available</, file + ': a built-in row never claims Available');
    assert.doesNotMatch(staticList, /MiniMax|Gemini|Workers AI|Groq|OpenRouter|Cloudflare|@cf\/|groq\/|nvidia\/|:free/i, file + ': only offered models, by their makers');
    assert.doesNotMatch(staticList, /<code\b/, file + ': no model ids in the pane');
    // [maker logo] [model name] [usable context] [status] in every row.
    for (const row of staticList.split('<li class="zx-model"').slice(1)) {
      const maker = row.match(/<span class="zx-maker" data-maker="([\w-]+)"/)?.[1];
      assert.ok(maker && home.MAKERS[maker], file + ': a known maker badge in every row');
      assert.ok(home.MAKER_LOGOS.includes(maker) === / data-logo /.test(row.slice(0, row.indexOf('</span>'))), `${file}: ${maker} logo or monogram`);
      assert.match(row, /class="zx-model__name">[^<]+</, file + ': model name');
      assert.match(row, /class="zx-model__ctx[^"]*" title="[^"]+">(?:\d+(?:\.\d)?[KM]|Fits request)</, file + ': usable context with the native window on hover');
      assert.match(row, /class="zx-model__status"><span class="zx-model__dot" aria-hidden="true"><\/span>Not checked recently</, file + ': status with a text label');
    }
    assert.match(page, /<li data-tone="unknown">Not checked recently<\/li>/, file + ': the legend names the not-checked state');
    for (const tone of ['ok', 'warn', 'busy', 'off']) assert.match(page, new RegExp(`<li data-tone="${tone}">`), `${file}: the legend shows ${tone}`);
  }
  for (const maker of home.MAKER_LOGOS.filter(maker => maker !== 'zero-x')) {
    assert.ok(isFile(`Assets/makers/${maker}.svg`), `Assets/makers/${maker}.svg is vendored`);
    assert.match(read(`Assets/makers/${maker}.svg`), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"><title>[^<]+<\/title><path d="[^"]+"\/><\/svg>\s*$/, `${maker}.svg is path data only`);
    assert.match(read('zx-tokens.css'), new RegExp(`\\.zx-maker\\[data-maker="${maker}"\\] \\{ --zx-logo: url\\("/Assets/makers/${maker}\\.svg"\\); \\}`), `zx-tokens.css draws the ${maker} logo`);
  }
  assert.match(html, /NeuCockpit local AI/, 'NeuCockpit stays on the homepage');

  assert.equal(home.formatContext(1048576, 'x'), '1M');
  assert.equal(home.formatContext(131072, 'x'), '131K');
  assert.equal(home.formatContext(24000, 'auto'), 'Fits request');
  assert.equal(home.formatContext(0, 'x'), '—');
  const now = Date.parse('2026-10-20T10:00:00Z');
  const state = model => home.modelState(model, now);
  assert.deepEqual(state({available: true, status: 'available'}), {tone: 'ok', label: 'Available'});
  assert.equal(state({available: true, status: 'degraded'}).tone, 'warn');
  assert.equal(state({available: true, status: 'busy'}).tone, 'busy');
  assert.deepEqual(state({available: true, status: 'blurred', available_again_at: '2026-10-20T10:04:10Z'}), {tone: 'off', label: 'Back in about 5 min'});
  assert.equal(state({available: true, status: 'blurred', available_again_at: null}).label, 'Temporarily unavailable');
  // The gateway's health checker (contract section 15): unavailable replaces blurred, and a model
  // nobody confirmed lately is unknown, never shown as available.
  assert.deepEqual(state({available: true, status: 'unavailable', available_again_at: '2026-10-20T10:04:10Z'}), {tone: 'off', label: 'Back in about 5 min'});
  assert.deepEqual(state({available: true, status: 'unknown'}), {tone: 'unknown', label: 'Not checked recently'});
  assert.equal(state({available: true}).tone, 'unknown', 'no status: not shown as available');
  assert.equal(state({available: true, status: 'something-new'}).tone, 'unknown');
  assert.deepEqual(state({available: false, unavailable_reason: 'upgrade_required'}), {tone: 'locked', label: 'Paid plans'});
  assert.equal(state({available: false, unavailable_reason: 'region_unavailable'}).label, 'Not offered in your region');
  assert.equal(state({available: false, unavailable_reason: 'not_configured'}).tone, 'off');
  assert.equal(state(null).tone, 'off');
  // section 15.1: availability (section 15 words) wins over status (the v1.3 words alpha.4 reads).
  assert.equal(home.healthWord({availability: 'unavailable', status: 'blurred'}), 'unavailable');
  assert.equal(home.healthWord({status: 'blurred'}), 'blurred', 'an older gateway: status');
  assert.equal(home.healthWord({}), 'unknown');
  // section 15.2: each row's verdict expires after its own horizon, between polls too.
  const fresh = {available: true, status: 'available', checked_at: '2026-10-20T09:00:00Z', stale_after_seconds: 5400};
  assert.deepEqual(state(fresh), {tone: 'ok', label: 'Available'}, 'a Groq verdict 60 min old within its 90 min horizon');
  assert.deepEqual(state({...fresh, stale_after_seconds: 1350}), {tone: 'unknown', label: 'Not checked recently'}, 'an NVIDIA one past 22.5 min');
  assert.equal(state({...fresh, status: 'busy', stale_after_seconds: 60, available_again_at: '2026-10-20T10:01:00Z'}).tone, 'busy',
    'a timed state still running is not expired');
  assert.equal(state({...fresh, stale_after_seconds: null}).tone, 'ok', 'no horizon: the gateway decides');
  assert.equal(home.verdictExpired({checked_at: null, stale_after_seconds: 60}, now), false);

  assert.equal(home.modelRows({nope: true}), null, 'unusable payload keeps the static catalog');
  const rows = home.modelRows({data: [
    {id: 'gemini/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', owned_by: 'gemini', context_length: 1048576, capabilities: {reasoning: true, vision: true}, tiers: ['paid'], available: false, unavailable_reason: 'upgrade_required', status: 'available'},
    {id: '', display_name: 'empty id'}, {id: 'x'.repeat(121)}, null,
    {id: 'odd/model', display_name: '<img src=x onerror=alert(1)>', owned_by: 'someone-else'},
  ]});
  assert.equal(rows.length, 2, 'invalid ids are dropped');
  assert.deepEqual(rows[0], {id: 'gemini/gemini-2.5-pro', family: 'google/gemini-2.5-pro', maker: 'google', name: 'Gemini 2.5 Pro', context: 1048576, native: 1048576,
    reasoning: true, vision: true, paidOnly: true, available: false, unavailable_reason: 'upgrade_required', status: 'available', available_again_at: null,
    checked_at: null, stale_after_seconds: null},
    'a route of an older gateway is shown by its model and maker, never its provider');
  assert.equal(rows[1].name, '<img src=x onerror=alert(1)>', 'names stay plain text (rendered with textContent)');
  assert.equal(rows[1].maker, 'other', 'an unknown maker gets a neutral badge');
  // The family view (contract section 14): maker, family and the usable and native windows.
  const [family] = home.modelRows({data: [{id: 'openai/gpt-oss-120b', display_name: 'GPT-OSS 120B', owned_by: 'openai', maker: 'openai', family: 'openai/gpt-oss-120b',
    context_window: 8000, context_length: 8000, native_context_window: 131072, tiers: ['free']}]});
  assert.deepEqual([family.family, family.maker, family.name, family.context, family.native], ['openai/gpt-oss-120b', 'openai', 'GPT-OSS 120B', 8000, 131072]);
  assert.equal(home.formatContext(family.context, family.id), '8K');
  assert.equal(home.contextNote(family), 'Up to 8K tokens per request on the Free plan. The model itself takes up to 131K.');
  // An older gateway's routes of one model become one row, named without the provider.
  const routes = home.modelRows({data: [
    {id: 'groq/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Groq)', owned_by: 'groq', context_window: 8000, native_context_window: 131072, tiers: ['free'], status: 'busy'},
    {id: 'nvidia/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (NVIDIA)', owned_by: 'nvidia', context_window: 131072, tiers: ['free'], status: 'available'},
    {id: 'openrouter/cohere/north-mini-code:free', display_name: 'North Mini Code (OpenRouter, free)', owned_by: 'openrouter', context_window: 256000, tiers: ['free'], status: 'unknown'},
    {id: 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', display_name: 'Nemotron 3 Ultra 550B (NVIDIA)', owned_by: 'nvidia', context_window: 1048576, tiers: ['free']},
    {id: 'zai/glm-4.7-flash', display_name: 'GLM-4.7 Flash (Z.ai)', owned_by: 'zai', context_window: 200000, tiers: ['free']},
    {id: 'groq/qwen/qwen3.8-27b', display_name: 'Qwen 3.8 27B (Groq)', owned_by: 'groq', context_window: 8000, tiers: ['free']},
  ]});
  const families = home.familyRows(routes);
  assert.deepEqual(families.map(row => [row.family, row.maker, row.name]), [
    ['openai/gpt-oss-120b', 'openai', 'GPT-OSS 120B'], ['cohere/north-mini-code', 'cohere', 'North Mini Code'],
    ['nvidia/nemotron-3-ultra-550b', 'nvidia', 'Nemotron 3 Ultra 550B'], ['zhipu/glm-4.7-flash', 'zhipu', 'GLM-4.7 Flash'],
    ['qwen/qwen3.8-27b', 'alibaba', 'Qwen 3.8 27B']]);
  assert.deepEqual([families[0].status, families[0].context, families[0].native], ['available', 131072, 131072],
    'a model takes the best route status and the context of the routes with it');
  assert.doesNotMatch(JSON.stringify(families.map(({id, ...shown}) => shown)), /Groq|NVIDIA\)|OpenRouter|Z\.ai\)|groq|openrouter/, 'nothing shown names a provider');
  // The live indicator.
  assert.equal(home.sinceLabel(now - 12000, now), '12 s ago');
  assert.equal(home.sinceLabel(now - 2000, now), 'just now');
  assert.equal(home.sinceLabel(now - 180000, now), '3 min ago');
  assert.equal(home.liveText('live', now - 12000, now), 'Live · checked 12 s ago');
  assert.equal(home.liveText('stale', now - 120000, now), 'Reconnecting · last checked 2 min ago');
  assert.equal(home.liveText('offline', 0, now), 'Offline · built-in list, not checked');
  assert.equal(home.liveText('live', 0, now), 'Live · not checked yet', 'no checked_at: no time is invented');
  assert.equal(home.liveText('stale', 0, now), 'Reconnecting');
  assert.equal(home.staleAfterSeconds({stale_after_seconds: 1200}), 1200);
  assert.equal(home.staleAfterSeconds({}, 30), 60, 'without the payload value, two poll intervals');
  assert.equal(home.staleAfterSeconds({stale_after_seconds: -5}, 45), 90);
  assert.equal(home.verdictsExpired({answeredAt: now - 33000, poll: 30}, now), false, 'one missed poll keeps the verdicts');
  assert.equal(home.verdictsExpired({answeredAt: now - 61000, poll: 30}, now), true, 'two missed polls: not being checked');
  assert.equal(home.verdictsExpired({answeredAt: now - 10000, poll: 30}, now), false, 'an answering gateway: rows expire one by one');
  assert.equal(home.verdictsExpired({answeredAt: 0}, now), true, 'never answered: never checked');
  assert.equal(home.modelRows({data: Array.from({length: 80}, (_, i) => ({id: 'm' + i}))}).length, 60, 'list is capped');

  const updated = home.applyStatus(rows, {data: [{id: 'gemini/gemini-2.5-pro', available: true, status: 'blurred', available_again_at: '2026-10-20T10:30:00Z'}, {id: 'unknown'}]});
  assert.equal(updated.length, 2, 'unknown ids are ignored');
  assert.equal(updated[0].available, true);
  assert.equal(updated[0].status, 'blurred', 'a model that goes down greys out');
  assert.equal(home.applyStatus(updated, {data: [{id: 'gemini/gemini-2.5-pro', available: true, status: 'available'}]})[0].status, 'available', 'and brightens again');
  const split = home.applyStatus(rows, {stale_after_seconds: 1200, checked_at: '2026-10-20T09:59:00Z', data: [
    {id: 'gemini/gemini-2.5-pro', available: true, status: 'blurred', availability: 'unavailable', checked_at: '2026-10-20T09:58:00Z', stale_after_seconds: 2700},
    {id: 'odd/model', available: true, status: 'available'}]});
  assert.deepEqual([split[0].status, split[0].checked_at, split[0].stale_after_seconds], ['unavailable', '2026-10-20T09:58:00Z', 2700],
    'the row reads availability and its own horizon');
  assert.deepEqual([split[1].checked_at, split[1].stale_after_seconds], ['2026-10-20T09:59:00Z', 1200], 'an older gateway: the payload horizon');
  assert.equal(home.stateSignature(split, now), home.stateSignature(split, now), 'a stable signature');
  assert.notEqual(home.stateSignature(split, now), home.stateSignature(split, now + 3600000), 'and it changes once a verdict expires');
  assert.equal(home.pollSeconds({poll_interval_seconds: 30}), 30);
  assert.equal(home.pollSeconds({poll_interval_seconds: 1}), 30, 'too-fast polling falls back to 30 s');
  assert.equal(home.pollSeconds(null), 30);
}

/* Download page (A6), trust page and support (A8), gateway logging policy (A17) */
{
  const html = read('download.html');
  for (const command of [INSTALL_NPM, INSTALL_PIP, INSTALL_SH, INSTALL_PS1, INSTALL_CMD, 'neuron login', 'Get-FileHash',
    'shasum -a 256', 'gh attestation verify']) {
    assert.ok(html.includes(command), 'download.html shows ' + command);
  }
  assert.ok(tags(html, 'button').some(b => b['data-copy-target'] === 'download-cmd'), 'download.html copies the install bar command');
  assert.match(text('download.html'), /status bar under the prompt/, 'download.html says what the release brings');
  assert.ok(html.includes('href="https://zero-x.live/neucockpit#downloads"'), 'download.html links the NeuCockpit downloads');
  for (const id of ['desktop', 'cli', 'mobile', 'verify', 'desktop-note', 'cli-release-note', 'cli-binaries', 'checksums-link', 'copy-status']) {
    assert.ok(ids(html).includes(id), 'download.html #' + id);
  }
  for (const os of ['windows', 'macos', 'linux']) {
    const card = html.match(new RegExp(`<article class="zx-card" id="desktop-${os}"[\\s\\S]*?</article>`))?.[0] || '';
    assert.ok(card.includes('data-status') && card.includes('data-links') && /data-your-os hidden/.test(card), 'download.html desktop card ' + os);
  }
  assert.match(text('download.html'), /Mobile app Coming soon/);
  {
    const at = id => html.indexOf(`<section id="${id}"`);
    assert.ok(at('cli') > 0 && at('cli') < at('verify') && at('verify') < at('desktop') && at('desktop') < at('mobile') && at('mobile') < at('more'), 'download.html order: command line, verify, desktop and mobile (coming soon), more');
    assert.ok(html.indexOf('id="cli-binaries"') < at('desktop'), 'available release binaries come before the coming-soon apps');
    assert.match(html, /<th scope="col">Size<\/th><th scope="col">SHA-256<\/th>/, 'the direct-downloads table has a size column before the checksum');
    assert.match(read('download.js'), /element\(doc, 'td', entry\.size \|\| 'n\/a'\)/, 'download.js fills the size cell');
  }
  assert.match(html, /<body data-download>/);
  for (const button of tags(html, 'button').filter(b => 'data-copy-target' in b)) assert.ok(ids(html).includes(button['data-copy-target']), 'copy target ' + button['data-copy-target']);

  const trust = read('docs/trust.html');
  for (const id of ['folder-trust', 'permissions', 'data', 'gateway', 'account', 'report']) assert.ok(ids(trust).includes(id), 'docs/trust.html #' + id);
  assert.match(text('docs/trust.html'), /stores usage metadata only/);
  assert.match(text('docs/trust.html'), /Until you trust the folder, Neuron ignores all four/);
  assert.match(trust, /support@zero-x\.live/);
  assert.match(read('docs.html'), /<section id="support"[\s\S]*support@zero-x\.live[\s\S]*href="\/docs\/trust#report"/, 'docs.html help and support section');

  const privacy = text('privacy.html');
  assert.ok(ids(read('privacy.html')).includes('gateway-logging'), 'privacy: gateway logging paragraph');
  assert.match(privacy, /The gateway stores usage metadata only/);
  assert.match(privacy, /never written to our database or logs/);
  assert.match(privacy, /Prompt and response text Not stored In memory/);
  assert.match(privacy, /Operational logs Request ID[^.]*never keys At most 14 days on our server/);
  assert.doesNotMatch(privacy, /at most 7 days/i, 'privacy: the server journal keeps 14 days (deploy/aws/gateway-vm.yaml MaxRetentionSec)');
}

{
  const download = await import(new URL('download.js', root));
  assert.deepEqual(download.MANIFEST_PATHS, {cli: '/releases/cli/latest.json', desktop: '/releases/desktop/latest.json'});
  for (const path of Object.values(download.MANIFEST_PATHS)) assert.ok(isFile('.' + path), path + ' is committed');
  assert.equal(download.detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(download.detectOs('', 'macOS'), 'macos');
  assert.equal(download.detectOs('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(download.detectOs('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android', 'Android is not desktop Linux');
  assert.equal(download.detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios', 'iPhones are not Macs');
  assert.equal(download.detectOs(''), null);
  assert.equal(download.safeDownloadUrl('https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v6.3.0/x.exe'), 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v6.3.0/x.exe');
  for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x', 'https://user:pw@github.com/x', 'javascript:alert(1)', 'https://github.com:8443/x', null]) {
    assert.equal(download.safeDownloadUrl(bad), '', String(bad));
  }
  assert.equal(download.formatBytes(31457280), '30 MB');
  assert.equal(download.formatBytes(5 * 1024 * 1024 + 1), '5.0 MB');
  assert.equal(download.formatBytes(2048), '2 KB');
  assert.equal(download.formatBytes(-1), '');
  assert.equal(download.formatReleaseDate('2026-11-02T09:30:00Z'), 'Nov 2, 2026');
  const cliView = download.releaseView(JSON.parse(read('releases/cli/latest.json')), 'cli');
  assert.equal(cliView.version, '7.0.0-alpha.5', 'the CLI release is published');
  assert.equal(cliView.downloads.length, 10, 'the direct-downloads table has a row per binary');
  assert.ok(cliView.downloads.every(entry => entry.size && entry.url.startsWith('https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.5/')), 'sizes and per-file links');
  assert.ok(cliView.checksumsUrl.endsWith('/SHA256SUMS'));
  assert.equal(download.releaseView(JSON.parse(read('releases/desktop/latest.json')), 'desktop'), null);
  const sha = 'ab'.repeat(32);
  const view = download.releaseView({schema_version: 1, product: 'desktop', version: '0.2.0', released_at: '2026-11-02T09:30:00Z',
    notes_url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/tag/desktop-v0.2.0', checksums_url: 'https://evil.example/SHA256SUMS', downloads: [
      {platform: 'windows-x64', kind: 'installer', file: 'Neuron_0.2.0_x64-setup.exe', url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/desktop-v0.2.0/Neuron_0.2.0_x64-setup.exe', sha256: sha, size: 31457280},
      {platform: 'macos-universal', kind: 'installer', file: 'Neuron.dmg', url: 'https://evil.example/Neuron.dmg', sha256: sha},
      {platform: 'linux-x64', kind: 'installer', file: 'neuron.AppImage', url: 'https://github.com/x/neuron.AppImage', sha256: 'not-a-hash'},
      {platform: 'plan9', kind: 'installer', file: 'x', url: 'https://github.com/x/x', sha256: sha},
    ]}, 'desktop');
  assert.equal(view.version, '0.2.0');
  assert.equal(view.released, 'Nov 2, 2026');
  assert.equal(view.checksumsUrl, '', 'off-allowlist links are dropped');
  assert.deepEqual(view.downloads.map(entry => [entry.platform, entry.size]), [['windows-x64', '30 MB']], 'unsafe or malformed entries are never shown');
  assert.equal(download.releaseView({schema_version: 1, product: 'cli', version: '0.2.0', downloads: []}, 'desktop'), null, 'product must match');
  assert.equal(download.releaseView({schema_version: 2, product: 'cli', version: '1.0.0'}, 'cli'), null, 'unknown schema versions are ignored');
}

{
  const changelog = await import(new URL('changelog.js', root));
  assert.match(read('changelog.html'), /<body data-changelog>/);
  for (const id of ['changelog-status', 'changelog-list']) assert.ok(ids(read('changelog.html')).includes(id), 'changelog.html #' + id);
  assert.deepEqual(changelog.inlineParts('Run `neuron update` or see [the docs](https://zero-x.live/docs) **now**'), [
    {type: 'text', text: 'Run '}, {type: 'code', text: 'neuron update'}, {type: 'text', text: ' or see '},
    {type: 'link', text: 'the docs', href: 'https://zero-x.live/docs'}, {type: 'text', text: ' '}, {type: 'strong', text: 'now'}]);
  assert.deepEqual(changelog.inlineParts('[bad](javascript:alert(1)) <img src=x onerror=alert(1)>'),
    [{type: 'text', text: '[bad](javascript:alert(1)) <img src=x onerror=alert(1)>'}], 'only https links; HTML stays text');
  assert.deepEqual(changelog.markdownBlocks(['## Added', '- Trust screen', '- `/usage` panel', '', 'Fixes a crash', 'on resume.', '### Notes', 'text'].join('\n')), [
    {type: 'heading', level: 3, parts: [{type: 'text', text: 'Added'}]},
    {type: 'list', items: [[{type: 'text', text: 'Trust screen'}], [{type: 'code', text: '/usage'}, {type: 'text', text: ' panel'}]]},
    {type: 'paragraph', parts: [{type: 'text', text: 'Fixes a crash on resume.'}]},
    {type: 'heading', level: 4, parts: [{type: 'text', text: 'Notes'}]},
    {type: 'paragraph', parts: [{type: 'text', text: 'text'}]}]);
  assert.deepEqual(changelog.markdownBlocks(''), []);
  assert.equal(changelog.changelogView({nope: 1}), null);
  const view = changelog.changelogView({data: [
    {product: 'cli', version: '6.3.0', title: 'Neuron 6.3.0', published_at: '2026-11-02T09:30:00Z', prerelease: false, url: 'https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/tag/v6.3.0', notes: '- New'},
    {product: 'neucockpit', version: '1.0.0', url: 'https://github.com/x'}, {product: 'cli', version: '1.0.0', url: 'https://evil.example/'}]});
  assert.equal(view.length, 1, 'unknown products and foreign links are dropped');
  assert.equal(view[0].published, 'November 2, 2026');
}

/* ───────────── Copy buttons on command blocks (copy-code.js) ───────────── */

// Every command block carries one icon-only copy button: a native button with an accessible name, the
// copy and check icons from the sprite, and a target id that names the block's own <code>. Only pure
// response samples (marked data-sample) have none. Pages other than the dashboard announce through
// #copy-status and load /copy-code.js after the header script; the dashboard keeps its toast binding.
{
  const COPY_PAGES = ['index.html', 'download.html', 'neuron-cli.html', 'docs.html', 'ai-coding-agent.html', 'free-ai-coding-agent.html', 'claude-code-alternative.html', 'dashboard.html'];
  const sprite = read('icons.svg');
  for (const icon of ['copy', 'check']) assert.match(sprite, new RegExp(`<symbol id="${icon}"`), 'icons.svg has #' + icon);
  for (const file of COPY_PAGES) {
    const html = read(file);
    const blocks = [...html.matchAll(/<div class="(zx-code\b[^"]*)"([^>]*)>([\s\S]*?)<\/pre>([\s\S]*?)<\/div>/g)];
    assert.ok(blocks.length > 0, file + ': has command blocks');
    assert.equal(blocks.length, (html.match(/<pre><code/g) || []).length, file + ': every <pre><code> sits in a zx-code block');
    let copies = 0;
    for (const [, cls, extra, body, after] of blocks) {
      const where = `${file}: ${body.replace(/<[^>]+>/g, '').slice(0, 40)}`;
      if (/\bdata-sample\b/.test(extra)) {
        assert.ok(!after.includes('zx-copy'), where + ': a response sample has no copy button');
        assert.match(body.replace(/<[^>]+>/g, '').trim(), /^\{/, where + ': only JSON response samples skip the copy button');
        continue;
      }
      const buttons = tags(after, 'button');
      assert.equal(buttons.length, 1, where + ': one copy button');
      const b = buttons[0];
      assert.equal(b.class, 'zx-copy', where + ': icon-only zx-copy button');
      assert.equal(b.type, 'button', where + ': type=button');
      assert.equal(b.title, 'Copy', where + ': title');
      assert.match(b['aria-label'] || '', /^Copy [a-zA-Z]/, where + ': aria-label names what it copies');
      assert.ok(b['data-copy-label'], where + ': data-copy-label');
      assert.match(body, new RegExp(`<code id="${b['data-copy-target']}">`), where + ': target is the block\'s own <code>');
      assert.ok(/\bzx-code--copy\b/.test(cls), where + ': zx-code--copy reserves room for the button');
      assert.match(after, /<svg class="zx-icon zx-copy__idle" aria-hidden="true"><use href="\/icons\.svg#copy"\/><\/svg>/, where + ': copy icon');
      assert.match(after, /<svg class="zx-icon zx-copy__done" aria-hidden="true"><use href="\/icons\.svg#check"\/><\/svg>/, where + ': check icon');
      assert.doesNotMatch(after, />\s*Copy\s*</, where + ': no text label');
      copies++;
    }
    // The install bar's copy button sits in its pill, beside the command it copies.
    for (const bar of installBars(html)) {
      const pill = bar.match(/<div class="zx-getbar__pill">([\s\S]*?)\n\s*<\/div>\n/)[1];
      const [b] = tags(pill, 'button');
      assert.ok(b && b.class === 'zx-copy' && b.type === 'button' && b.title === 'Copy' && /^Copy [a-zA-Z]/.test(b['aria-label'] || '') && b['data-copy-label'], file + ': install bar copy button');
      assert.match(pill, new RegExp(`<code class="zx-getbar__cmd" id="${b['data-copy-target']}"`), file + ': the install bar copies its own command');
      assert.match(pill, /<svg class="zx-icon zx-copy__idle" aria-hidden="true"><use href="\/icons\.svg#copy"\/><\/svg><svg class="zx-icon zx-copy__done" aria-hidden="true"><use href="\/icons\.svg#check"\/><\/svg>/, file + ': install bar copy and check icons');
      copies++;
    }
    const targets = tags(html, 'button').filter(b => 'data-copy-target' in b).map(b => b['data-copy-target']);
    assert.equal(targets.length, copies, file + ': every copy button sits in a command block or an install bar');
    assert.equal(new Set(targets).size, targets.length, file + ': copy target ids are unique');
    for (const id of targets) assert.equal(ids(html).filter(x => x === id).length, 1, `${file}: #${id} exists once`);
    const scripts = tags(html, 'script').filter(s => s.src).map(s => s.src);
    if (file === 'dashboard.html') {
      assert.ok(!scripts.includes('/copy-code.js'), 'dashboard.html keeps its own toast binding');
      continue;
    }
    const status = tags(html, 'p').find(p => p.id === 'copy-status');
    assert.ok(status && status.role === 'status' && status['aria-live'] === 'polite' && /\bzx-visually-hidden\b/.test(status.class), file + ': visually hidden #copy-status live region');
    assert.ok(tags(html, 'script').some(s => s.src === '/copy-code.js' && s.type === 'module'), file + ': loads /copy-code.js as a module');
    assert.ok(scripts.indexOf('/site-nav.js') >= 0 && scripts.indexOf('/copy-code.js') > scripts.indexOf('/site-nav.js'), file + ': copy-code.js after site-nav.js');
  }
  // home.js and download.js share the one implementation; nothing gates it on [data-home].
  assert.match(read('home.js'), /export \{ copyButtons \} from '\.\/copy-code\.js';/, 'home.js re-exports copyButtons');
  assert.doesNotMatch(read('home.js'), /navigator\.clipboard/, 'home.js has no second copy implementation');
  assert.match(read('download.js'), /import \{ copyButtons \} from '\.\/copy-code\.js';/, 'download.js imports copy-code.js');
  const home = await import(new URL('home.js', root));
  const copyModule = await import(new URL('copy-code.js', root));
  assert.equal(home.copyButtons, copyModule.copyButtons, 'one copyButtons');
  // Styles: a 32px icon button (40px for touch), room reserved in the block, the check in the success colour.
  const css = read('zx-tokens.css');
  assert.match(css, /\.zx-copy \{[^}]*width: 32px; height: 32px;/, 'zx-copy is 32px');
  assert.match(css, /@media \(pointer: coarse\) \{[^}]*\.zx-copy \{ width: 40px; height: 40px;/, 'zx-copy is 40px on touch');
  assert.match(css, /\.zx-code--copy pre, \.zx-code--copy \.zx-code__label \{ padding-right: 48px; \}/, 'the block reserves room for the button');
  assert.match(css, /\.zx-copy\[data-state="copied"\] \{[^}]*color: var\(--zx-success\)/, 'copied shows the check in --zx-success');
  assert.match(css, /^\.zx-copy \{[^}]*background: inherit;/m, 'the button takes its code block background (also the homepage CTA override)');
  assert.doesNotMatch(css, /^\.zx-copy \{[^}]*background: var\(--zx-code-bg\)/m, 'no fixed code background on the button');
  assert.match(css, /^\.zx-copy\[data-state="selected"\] \{[^}]*color: var\(--zx-ink\);[^}]*border-color: var\(--zx-border-strong\);[^}]*background: var\(--zx-bg\);/m, 'a refused clipboard shows a visible selected state');
  assert.match(css, /\.zx-copy:focus-visible \{[^}]*box-shadow: var\(--zx-focus\)/, 'visible keyboard focus');
  assert.doesNotMatch(css, /padding-right: 84px/, 'the old text-button padding is gone');
}

/* ───────────── Dark/light switch (site-nav.js installThemeToggle) ───────────── */

// Every page with the shared header carries one icon-only theme button between the mark and the
// Menu button (CSS order puts it after the nav on desktop and beside Menu on phones), and the same
// inline head script before the first stylesheet, which applies a saved choice before first paint
// and adds html.zx-js so the button (hidden without JavaScript) never shifts the bar.
{
  const THEME_PRESET = `<script>(function(d){if('noModule'in HTMLScriptElement.prototype)d.classList.add('zx-js');try{var t=localStorage.getItem('zx-theme');if(t==='dark'||t==='light')d.dataset.theme=t}catch(e){}})(document.documentElement)</script>`;
  const THEME_BUTTON = /<button class="zx-theme-toggle" type="button" aria-label="Dark mode" aria-pressed="false" title="Switch to dark mode"><svg class="zx-icon zx-icon--moon" aria-hidden="true"><use href="\/icons\.svg#moon"\/><\/svg><svg class="zx-icon zx-icon--sun" aria-hidden="true"><use href="\/icons\.svg#sun"\/><\/svg><\/button>/;
  const candidates = [...readdirSync(root).filter(name => name.endsWith('.html')), ...readdirSync(new URL('docs/', root)).filter(name => name.endsWith('.html')).map(name => 'docs/' + name)];
  const headerPages = candidates.filter(file => read(file).includes('<header class="zx-header">'));
  for (const file of [...PUBLIC_PAGES, 'dashboard.html', '404.html', 'about.html', 'neucockpit.html']) assert.ok(headerPages.includes(file), file + ': has the shared header');
  for (const file of headerPages) {
    const html = read(file);
    assert.equal((html.match(/class="zx-theme-toggle"/g) || []).length, 1, file + ': one theme button');
    assert.match(html, THEME_BUTTON, file + ': an icon-only native button named "Dark mode" with aria-pressed, a title and the moon and sun icons');
    assert.match(html, new RegExp('<a class="zx-brand"[^>]*>[\\s\\S]*?</a>\\s*' + THEME_BUTTON.source + '\\s*<button class="zx-nav-toggle"'), file + ': between the mark and the Menu button (Menu stays right before the nav)');
    assert.equal(html.split(THEME_PRESET).length - 1, 1, file + ': the theme preset inline script once');
    const head = html.slice(0, html.indexOf('</head>'));
    const preset = head.indexOf(THEME_PRESET);
    const firstStylesheet = head.search(/<link rel="stylesheet"/);
    assert.ok(preset > 0 && firstStylesheet > preset, file + ': the theme preset runs before the first stylesheet');
    assert.ok(tags(html, 'script').some(a => a.type === 'module' && a.src === '/site-nav.js'), file + ': loads /site-nav.js, which wires the button');
  }
  // Pages whose checks forbid inline scripts, and pages without the shared header, get no button.
  for (const file of ['neuroncli/device/index.html', 'neuroncli/admin/keys/index.html', 'neuroncli/admin/models/index.html', 'neuroncli/login/index.html', 'neuroncli/callback/index.html', 'start.html']) {
    assert.doesNotMatch(read(file), /zx-theme-toggle|zx-theme/, file + ': no theme switch');
  }
  const {INLINE_SCRIPT_HASHES} = await import('./src/csp-hashes.js');
  const {hashOf} = await import('./build-csp-hashes.mjs');
  assert.ok(INLINE_SCRIPT_HASHES.includes(hashOf(THEME_PRESET.slice('<script>'.length, -'</script>'.length))), 'the theme preset is allowed by its sha256');
  // Styles: hidden until html.zx-js. No flex `order` anywhere in the header, so the visual order is
  // the DOM (and tab) order at every width: the button opens the right-hand group (it takes the
  // auto margin from the nav), then Menu on phones, then the nav;
  // the icon shows what a click switches to, in both the forced and the system dark theme.
  const css = read('zx-tokens.css');
  assert.match(css, /^\.zx-theme-toggle \{ display: none; \}$/m, 'the theme button is hidden without JavaScript');
  assert.match(css, /^\.zx-js \.zx-theme-toggle \{[^}]*display: inline-flex;[^}]*margin-left: auto;/m, 'with JavaScript it shows and starts the right-hand group');
  assert.match(css, /^\.zx-js \.zx-theme-toggle ~ \.zx-nav \{ margin-left: 0; \}$/m, 'the nav gives up its auto margin to the button, so both stay right-aligned');
  assert.match(css, /^\.zx-header__inner > \.zx-nav \{ margin-left: auto; \}$/m, 'without the button the nav is right-aligned');
  const headerCss = css.slice(css.indexOf('header and navigation'), css.indexOf('.zx-crumbs'));
  assert.doesNotMatch(headerCss, /order:/, 'no flex order in the header: focus order matches visual order (WCAG 2.4.3)');
  assert.match(css, /^\.zx-theme-toggle:focus-visible \{[^}]*box-shadow: var\(--zx-focus\)/m, 'visible keyboard focus');
  assert.match(css, /^\.zx-theme-toggle \.zx-icon--sun \{ display: none; \}$/m, 'light: the moon shows');
  assert.match(css, /^:root\[data-theme="dark"\] \.zx-theme-toggle \.zx-icon--moon \{ display: none; \}$/m, 'forced dark hides the moon');
  assert.match(css, /^:root\[data-theme="dark"\] \.zx-theme-toggle \.zx-icon--sun \{ display: inline; \}$/m, 'forced dark shows the sun');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \.zx-theme-toggle \.zx-icon--moon \{ display: none; \}\s*:root:not\(\[data-theme="light"\]\) \.zx-theme-toggle \.zx-icon--sun \{ display: inline; \}\s*\}/,
    'system dark swaps the icons unless forced light');
  const phone = css.match(/@media \(max-width: 720px\) \{([\s\S]*?)^\}/m)[1];
  assert.match(phone, /\.zx-header\[data-nav\] \.zx-theme-toggle \{[^}]*margin-left: auto;/, 'phones: right-aligned, just before the Menu button');
  const themeHeight = Number(phone.match(/\.zx-header\[data-nav\] \.zx-theme-toggle \{[^}]*min-height: (\d+)px/)[1]);
  const inner = phone.match(/\.zx-header\[data-nav\] \.zx-header__inner \{ min-height: (\d+)px; padding-block: (\d+)px; \}/);
  assert.ok(themeHeight >= 44 && Math.max(Number(inner[1]), themeHeight + 2 * Number(inner[2])) + 1 <= 64, 'phones: a 44 px target in a header of at most 64 px');
}

/* ───────────── Signed-in account chip (site-nav.js installAccountChip) ───────────── */

// Every header page has exactly one account button in its nav, the target installAccountChip
// fills: the Dashboard button to dashboard.zero-x.live with the user icon, or on the dashboard
// itself a pending Account button (space reserved, invisible until dashboard.js has the profile). No inline script is added.
{
  const candidates = [...readdirSync(root).filter(name => name.endsWith('.html')), ...readdirSync(new URL('docs/', root)).filter(name => name.endsWith('.html')).map(name => 'docs/' + name)];
  const USER_ICON = '<svg class="zx-icon zx-icon--sm" aria-hidden="true"><use href="/icons.svg#user"/></svg>';
  for (const file of candidates.filter(name => read(name).includes('<header class="zx-header">'))) {
    const html = read(file);
    const nav = (/<nav class="zx-nav" id="site-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html) || [])[1] || '';
    const buttons = nav.match(/<a class="zx-btn[^"]*"[^>]*>[\s\S]*?<\/a>/g) || [];
    const expected = file === 'dashboard.html'
      ? '<a class="zx-btn zx-btn--sm" href="https://dashboard.zero-x.live/#account" data-account-link data-pending>' + USER_ICON + 'Account</a>'
      : '<a class="zx-btn zx-btn--sm" href="https://dashboard.zero-x.live/">' + USER_ICON + 'Dashboard</a>';
    assert.deepEqual(buttons, [expected], file + ': one account button in the header nav');
    assert.doesNotMatch(html, /zx-nav-avatar/, file + ': the avatar is added by site-nav.js, not in the HTML');
  }
  assert.match(read('site-nav.js'), /export function installAccountChip\(doc/, 'site-nav.js exports installAccountChip');
  assert.match(read('site-nav.js'), /installAccountChip\(document\);[\s\S]*addEventListener\("pageshow"/, 'the bootstrap runs it and again on pageshow');
  assert.doesNotMatch(read('site-nav.js'), /\bfetch\(|XMLHttpRequest/, 'no network call to show the account');
}

console.log('PASS: ' + (PUBLIC_PAGES.length + PRIVATE_PAGES.length) + ' pages: structure, landmarks, aria references, robots, resolvable links, legal sections, contract prices/limits/error codes, CSP origins, pinned SDK, no secrets or unsafe sinks; download, trust and support pages and the gateway logging policy; pure helpers for formatting, chart scaling, normalisation, routing, checkout validation and release manifests');
