// Static checks for the business website pages (WP-B4) plus DOM-free unit tests of the pure helpers in
// dashboard.js, pricing.js and billing-checkout.js. Browser behaviour lives in check-dashboard.mjs.
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
// Site scripts load as ES modules whatever package.json lies above the checkout.
import './site-modules.mjs';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const isFile = file => existsSync(new URL(file, root)) && statSync(new URL(file, root)).isFile();

const PUBLIC_PAGES = ['index.html', 'pricing.html', 'neuron-cli.html', 'docs.html', 'docs/trust.html', 'download.html', 'changelog.html', 'refund.html', 'contact.html', 'shipping.html', 'privacy.html', 'terms.html'];
const PRIVATE_PAGES = ['dashboard.html', '404.html', 'neuroncli/index.html'];
const SITE_SCRIPTS = ['dashboard.js', 'pricing.js', 'billing-checkout.js', 'home.js', 'download.js', 'changelog.js'];
const RELEASE_MANIFESTS = ['releases/cli/latest.json', 'releases/desktop/latest.json'];
const SITE_FILES = [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...SITE_SCRIPTS, ...RELEASE_MANIFESTS, 'zx-tokens.css', 'home.css', 'zerox-auth.js', 'neuroncli/login/index.html', 'neuroncli/callback/index.html'];
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
const meta = html => Object.fromEntries(tags(html, 'meta').map(a => [a.name || a.property || a['http-equiv'], a.content]));

const seoPages = JSON.parse(read('seo-pages.json'));
const routeFiles = new Map(seoPages.map(page => [new URL(page.url).host + new URL(page.url).pathname, page.file]));
routeFiles.set('zero-x.live/dashboard', 'dashboard.html');
routeFiles.set('dashboard.zero-x.live/', 'dashboard.html');
routeFiles.set('neuron.zero-x.live/device', 'neuroncli/device/index.html');
const {TABS} = await import(new URL('dashboard.js', root));

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

assert.ok(!seoPages.some(page => PRIVATE_PAGES.includes(page.file)), 'Private pages must stay out of seo-pages.json');
for (const file of PUBLIC_PAGES) assert.ok(seoPages.some(page => page.file === file), file + ' is listed in seo-pages.json');
assert.match(read('neuroncli/index.html'), /<meta http-equiv="refresh" content="0; url=\/neuron-cli">/, 'Old /neuroncli/ page points to /neuron-cli');
assert.match(read('neuroncli/index.html'), /<link rel="canonical" href="https:\/\/zero-x.live\/neuron-cli">/);

// Neuron 7.0.0-alpha.1 is a GitHub pre-release, so the installers must name its version (as written in HTML).
const INSTALL_SH = 'curl -fsSL https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.1/install.sh | sh -s -- --version 7.0.0-alpha.1';
const INSTALL_PS1 = '&amp; ([scriptblock]::Create((irm https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v7.0.0-alpha.1/install.ps1))) -Version 7.0.0-alpha.1';

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
  assert.ok(html.includes(INSTALL_SH) && html.includes(INSTALL_PS1), 'Dashboard quick start uses the pinned release installers');
  assert.match(html, /<code id="qs-login">neuron login<\/code>/);
  assert.match(html, /https:\/\/zero-x\.live\/v1/);
  assert.doesNotMatch(read('dashboard.js'), /alert\(|confirm\(/, 'No alert()/confirm() dialogs');
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

/* Footer legal links on every public page (Razorpay requires them to be reachable) */
for (const file of PUBLIC_PAGES) {
  const footer = read(file).match(/<footer[\s\S]*<\/footer>/)[0];
  for (const path of ['/terms', '/privacy', '/refund', '/shipping', '/contact', '/pricing']) assert.ok(footer.includes(`href="${path}"`), `${file}: footer links ${path}`);
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
assert.doesNotMatch(read('zx-tokens.css'), /@import|url\((?!\s*['"]?data:)/, 'zx-tokens.css loads nothing remote');
for (const m of read('site-fonts.css').matchAll(/url\(['"]?(https:[^'")]+)/g)) assert.ok(CSP.font.includes(new URL(m[1]).origin), 'font origin ' + m[1]);
for (const file of [...SITE_SCRIPTS, 'zerox-auth.js']) {
  for (const m of read(file).matchAll(/'(https:\/\/[^'\s]+)'/g)) {
    const host = new URL(m[1].replace(/'.*$/, '')).hostname;
    assert.ok(['checkout.razorpay.com', 'cdn.jsdelivr.net', 'zero-x.live', 'dashboard.zero-x.live', 'www.w3.org'].includes(host), `${file}: unexpected origin ${m[1]}`);
  }
}
assert.match(read('zerox-auth.js'), /SUPABASE_JS_VERSION = '\d+\.\d+\.\d+'/, 'zerox-auth pins supabase-js');
assert.match(read('zerox-auth.js'), /SUPABASE_JS_INTEGRITY = 'sha384-[A-Za-z0-9+/]{64}'/);
assert.match(read('zerox-auth.js'), /getAccessToken: getAccessToken/);

/* .assetsignore must not hide the new public files */
{
  const patterns = read('.assetsignore').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const toRegex = pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + (pattern.endsWith('/') ? '' : '$'));
  for (const file of [...PUBLIC_PAGES, ...PRIVATE_PAGES, ...SITE_SCRIPTS, ...RELEASE_MANIFESTS, 'zx-tokens.css', 'site-fonts.css', 'home.css',
    'neucockpit.html', 'favicon.ico', 'Assets/zerox-share.png']) {
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

  // Claude on Pro and Max (Anthropic as a processor, credit holds, daily spend limits).
  for (const file of ['privacy.html', 'terms.html']) assert.match(text(file), /Effective date: 25 October 2026\. Replaces the (?:policy|terms) dated 24 October 2026/, file + ' effective date');
  const anthropicRow = read('privacy.html').match(/<tr><th scope="row"><a href="https:\/\/www\.anthropic\.com\/legal\/privacy">Anthropic<\/a><\/th>([\s\S]*?)<\/tr>/);
  assert.ok(anthropicRow, 'privacy: Anthropic is listed as a processor');
  assert.match(anthropicRow[1], /does not use these prompts or responses to train its models/);
  assert.doesNotMatch(anthropicRow[1], /\d+[ -]days?/, 'privacy: no Anthropic retention period until it is confirmed in docs/PROVIDER_TERMS.md');
  assert.match(privacy, /On Pro and Max, requests to Claude Sonnet 5\.5 or Claude Opus 5\.5 go to Anthropic/);
  assert.match(privacy, /read from or written to Anthropic's prompt cache/);
  assert.match(text('terms.html'), /including Anthropic, Groq, Google, Cloudflare, NVIDIA and OpenRouter;/);
  assert.match(text('terms.html'), /paid-capacity models, including Claude Sonnet 5\.5 and Claude Opus 5\.5/);
  assert.match(text('terms.html'), /we hold the most it could cost[\s\S]*daily spending limit shared by all users/);
  const pricingPage = text('pricing.html');
  assert.match(pricingPage, /Claude Sonnet 5\.5 \$2\.50 \$0\.25 \$3\.125 \$12\.50/, 'pricing: Sonnet 5.5 at list price plus 25%');
  assert.match(pricingPage, /Claude Opus 5\.5 \$5\.00 \$0\.25 \$6\.25 \$25\.00/, 'pricing: Opus 5.5 at list price plus 25%');
  assert.match(pricingPage, /Anthropic \(Claude Sonnet 5\.5 and Claude Opus 5\.5\)/, 'pricing: the provider FAQ names Anthropic');
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
  assert.match(text('dashboard.html'), /Credits pay for Claude Sonnet 5\.5, Claude Opus 5\.5 and other paid capacity/);
}

/* ───────────── Prices and limits match PLATFORM_CONTRACT.md §1 ───────────── */

const contract = read('neuroncli/auth-server/docs/PLATFORM_CONTRACT.md');
const money = value => Math.round(Number(String(value).replace(/[^0-9.]/g, '')) * 100);
const expectedPlans = ['free', 'pro', 'max'].map(id => {
  const cells = contract.match(new RegExp(`^\\| ${id} \\|(.*)\\|$`, 'm'))[1].split('|').map(cell => cell.trim());
  const [name, price, requests, tokens, rpm, concurrency, tiers, credits] = cells;
  const [usd, inr] = price.split('/');
  return {id, name, usd_cents: money(usd), inr_paise: inr ? money(inr) : 0, daily_requests: Number(requests.replace(/,/g, '')), daily_tokens: Number(tokens.replace(/,/g, '')),
    rpm: Number(rpm), concurrency: Number(concurrency), tiers: tiers.split(',').map(t => t.trim()), monthly_credit_usd: money(credits) / 100};
});
const expectedTopups = [...contract.matchAll(/`(credits_\d+)` \(\$(\d+) credit, \$(\d+) \/ ₹([\d,]+)\)/g)].map(m => ({id: m[1], credit_usd: Number(m[2]), usd_cents: Number(m[3]) * 100, inr_paise: money(m[4])}));
assert.equal(expectedPlans.length, 3);
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
  const software = JSON.parse(read('neuron-cli.html').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find(n => n['@type'] === 'SoftwareApplication');
  assert.deepEqual([software.offers.price, software.offers.priceCurrency], ['0', 'USD']);
  const docsLimits = text('docs.html');
  for (const plan of expectedPlans) {
    assert.ok(docsLimits.includes(`${plan.name} ${formatCount(plan.daily_requests)} ${formatCount(plan.daily_tokens)} ${plan.rpm} ${plan.concurrency}`), 'docs.html limits row for ' + plan.id);
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
assert.equal(limitLabel(PLAN_CATALOG.plans[1], 'daily_tokens'), '10M');
assert.equal(limitLabel(PLAN_CATALOG.plans[1], 'daily_requests'), '2,000');
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
  assert.deepEqual(sub.theme, {color: '#00E5FF'});
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
  for (const command of [INSTALL_SH, INSTALL_PS1, 'npm install --global @zero-x.live/neuron@next', 'neuron login', 'curl https://zero-x.live/v1/models']) {
    assert.ok(html.includes(command), 'index.html shows ' + command);
  }
  // npm without @next installs the unsupported 6.2.0 and PyPI has only the unsupported 6.2.4.
  for (const file of ['index.html', 'neuron-cli.html', 'docs.html', 'dashboard.html', 'pricing.html', 'download.html',
    'docs/trust.html', 'changelog.html']) {
    const page = read(file);
    assert.doesNotMatch(page, /@zero-x\.live\/neuron(?!@next)/, file + ': npm package named without @next');
    assert.doesNotMatch(page, /pip install neuroncli/, file + ': pip install of the old PyPI package');
    assert.doesNotMatch(page, /install script is not published|installer is not published/, file + ': stale installer notice');
    assert.doesNotMatch(page, /releases\/latest\/download\/install\./, file + ': unpinned installer (the alpha is a pre-release)');
    assert.doesNotMatch(page, /href="https:\/\/neuron\.zero-x\.live\/(?:#[\w-]*)?"/, file + ': NeuCockpit lives at https://zero-x.live/neucockpit');
  }
  // docs.html lists `neuron auth login` as the alias it is; the pages that only name one command use neuron login.
  for (const file of ['download.html', 'docs/trust.html', 'changelog.html']) {
    assert.doesNotMatch(read(file), /neuron auth login/, file + ': the sign-in command is neuron login');
  }
  for (const id of ['get-started', 'features', 'models', 'pricing', 'docs', 'faq', 'products']) assert.ok(ids(html).includes(id), 'index.html section #' + id);
  for (const plan of ['free', 'pro', 'max']) assert.match(html, new RegExp(`data-plan-price="${plan}"`), 'index.html hydrates the ' + plan + ' price');
  assert.match(html, /<main id="main" data-pricing-root>/, 'pricing.js hydrates the homepage');
  for (const button of tags(html, 'button').filter(b => 'data-copy-target' in b)) assert.ok(ids(html).includes(button['data-copy-target']), 'copy target ' + button['data-copy-target']);
  assert.ok(ids(html).includes('models-list') && ids(html).includes('models-note'), 'live model list slots');
  assert.match(html, /NeuCockpit local AI/, 'NeuCockpit stays on the homepage');

  const home = await import(new URL('home.js', root));
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
  assert.deepEqual(state({available: false, unavailable_reason: 'upgrade_required'}), {tone: 'locked', label: 'Pro and Max plans'});
  assert.equal(state({available: false, unavailable_reason: 'region_unavailable'}).label, 'Not offered in your region');
  assert.equal(state({available: false, unavailable_reason: 'not_configured'}).tone, 'off');
  assert.equal(state(null).tone, 'off');

  assert.equal(home.modelRows({nope: true}), null, 'unusable payload keeps the static catalog');
  const rows = home.modelRows({data: [
    {id: 'gemini/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', owned_by: 'gemini', context_length: 1048576, capabilities: {reasoning: true, vision: true}, tiers: ['paid'], available: false, unavailable_reason: 'upgrade_required', status: 'available'},
    {id: '', display_name: 'empty id'}, {id: 'x'.repeat(121)}, null,
    {id: 'odd/model', display_name: '<img src=x onerror=alert(1)>', owned_by: 'someone-else'},
  ]});
  assert.equal(rows.length, 2, 'invalid ids are dropped');
  assert.deepEqual(rows[0], {id: 'gemini/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google Gemini', context: '1M', reasoning: true, vision: true,
    paidOnly: true, available: false, unavailable_reason: 'upgrade_required', status: 'available', available_again_at: null});
  assert.equal(rows[1].name, '<img src=x onerror=alert(1)>', 'names stay plain text (rendered with textContent)');
  assert.equal(rows[1].provider, 'someone-else');
  assert.equal(home.modelRows({data: Array.from({length: 80}, (_, i) => ({id: 'm' + i}))}).length, 60, 'list is capped');

  const updated = home.applyStatus(rows, {data: [{id: 'gemini/gemini-2.5-pro', available: true, status: 'blurred', available_again_at: '2026-10-20T10:30:00Z'}, {id: 'unknown'}]});
  assert.equal(updated.length, 2, 'unknown ids are ignored');
  assert.equal(updated[0].available, true);
  assert.equal(updated[0].status, 'blurred', 'a model that goes down greys out');
  assert.equal(home.applyStatus(updated, {data: [{id: 'gemini/gemini-2.5-pro', available: true, status: 'available'}]})[0].status, 'available', 'and brightens again');
  assert.equal(home.pollSeconds({poll_interval_seconds: 30}), 30);
  assert.equal(home.pollSeconds({poll_interval_seconds: 1}), 30, 'too-fast polling falls back to 30 s');
  assert.equal(home.pollSeconds(null), 30);
}

/* Download page (A6), trust page and support (A8), gateway logging policy (A17) */
{
  const html = read('download.html');
  for (const command of [INSTALL_SH, INSTALL_PS1, '<code>@zero-x.live/neuron@next</code>', 'neuron login', 'Get-FileHash',
    'shasum -a 256', 'gh attestation verify']) {
    assert.ok(html.includes(command), 'download.html shows ' + command);
  }
  assert.match(text('download.html'), /pip is not available for the alpha/);
  assert.ok(html.includes('href="https://zero-x.live/neucockpit#downloads"'), 'download.html links the NeuCockpit downloads');
  for (const id of ['desktop', 'cli', 'mobile', 'verify', 'desktop-note', 'cli-release-note', 'cli-binaries', 'checksums-link', 'copy-status']) {
    assert.ok(ids(html).includes(id), 'download.html #' + id);
  }
  for (const os of ['windows', 'macos', 'linux']) {
    const card = html.match(new RegExp(`<article class="zx-card" id="desktop-${os}"[\\s\\S]*?</article>`))?.[0] || '';
    assert.ok(card.includes('data-status') && card.includes('data-links') && /data-your-os hidden/.test(card), 'download.html desktop card ' + os);
  }
  assert.match(text('download.html'), /Mobile app Coming soon/);
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
  assert.match(privacy, /Prompt and response text: not stored/);
  assert.match(privacy, /Operational logs: [^.]*never prompt or response text[^.]*\. Kept for at most 7 days/);
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
  assert.equal(download.releaseView(JSON.parse(read('releases/cli/latest.json')), 'cli'), null, 'nothing released yet');
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

console.log('PASS: ' + (PUBLIC_PAGES.length + PRIVATE_PAGES.length) + ' pages: structure, landmarks, aria references, robots, resolvable links, legal sections, contract prices/limits/error codes, CSP origins, pinned SDK, no secrets or unsafe sinks; download, trust and support pages and the gateway logging policy; pure helpers for formatting, chart scaling, normalisation, routing, checkout validation and release manifests');
