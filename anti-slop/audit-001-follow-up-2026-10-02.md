# AFTER audit follow-up

The owner's request to make the site work approved findings 1-10 from `audit-001-2026-10-02.md`. This work retains the restored dark layout. It does not reinstate the rejected light redesign.

## Design read

Reading this as a desktop-product website for technical users, retaining the owner's restored dark visual identity. ENERGY 2 / RHYTHM 2 / MOTION 1.

The supplied `Assets/zero-x/DESIGN.md` remains the original light/green direction. The later explicit rollback request overrides that appearance for this work. Cyan identifies actions and focus; purple distinguishes secondary product technology. Cabinet Grotesk headings and Satoshi body text preserve the restored brand. Monospace is limited to paths, code, and technology labels. Alternating screenshot/text sections explain the actual workflow; platform cards group genuinely different installers. Rounded dialogs separate interaction from the page. Native video controls replace the inaccessible custom scrubber. Decorative drift, floating effects, grain animation, and headline shimmer are stopped; content is visible before scripts run. Existing artwork and navigation are reused.

## Approved findings

| Finding | Change | Verification / remaining work |
| --- | --- | --- |
| 1: sign-in | Resumed the connected Supabase project; configured public key and exact return URLs; added enabled-provider discovery, native dialog, email magic-link form, Microsoft OAuth scope, SMS send/verify flow, and useful errors. | Project reports ACTIVE_HEALTHY. Owner/team email was delivered to Gmail; its callback created a real signed-in session, and the dashboard accepted it across subdomains. Worker checks cover disabled providers and outages. Public-user email still needs SMTP; Google/Microsoft/SMS credentials remain missing. |
| 2: fake visitors | Removed random active users, growth estimates, counters, and their fallback scripts. | Source contains no visitor-counter implementation. No traffic is reported as real from this code. |
| 3: contrast | Brightened muted/faint colors; made headline cyan; removed dimmed platform text. | Installed checker: faint #9999A5 on card #18181C = 6.28:1. Product DOM text-color inspection found no non-whitespace text below its AA threshold in the tested rendering; this does not validate pixels embedded in product screenshots. |
| 4: mobile menu | Native dialog, named 44 px opener/closer, expanded state, Escape/focus management, visible focus. | Homepage tested at 390 x 844: opener 44 x 44; Escape closed dialog and restored focus. Product mobile width 375 within 390 px viewport. |
| 5: realistic mock data | Clearly labeled simulation and illustrative results; removed invented search latency, scores, and vault counts. | Browser sample query returns an example; unmatched query shows a real empty state. Example paths and file sizes are explicitly illustrative. |
| 6: dead controls | Static vault/category labels; real sample-path copy button with success/failure state. | Browser click showed “Copied sample path”; unavailable-clipboard fallback is implemented. No card claims to open a visitor's local file. |
| 7: conflicting claims | Model corrected to Qwen 2.5 Coder 1.5B; removed unverifiable trial/price/file-size structured data, parser counts, and absolute offline/performance claims. | Model matches product implementation inspected in the baseline audit. Local versus online modes are distinguished in visible copy. |
| 8: host routing | Host-specific index rewrite precedes generic assets; Worker runs before assets; company links use the company domain. | Runnable check covers both root and /index.html for www, apex, product, and dashboard hosts, plus static CSS. Live deployment verification is recorded in the task response. |
| 9: motion/purpose | Reduced-motion rules, native controls, visible-by-default content, stopped decorative motion, documented hierarchy above. | Source/build checks confirm overrides; video does not autoplay on initial load. Explicit video-tab activation can start playback. |
| 10: CTA labels | Labels identify product details, search features, or downloads. | Generic Explore label removed from visible actions. |

## Checks run

- `node neuroncli/auth-server/check-worker.mjs`: PASS for host routes, provider availability, outage behavior, rejecting service-role keys from public config, and unauthenticated /auth/me returning 401.
- `node --check zerox-auth.js`: PASS.
- `node neuroncli/auth-server/check-dashboard.mjs`: PASS for server-derived quotas, empty/unavailable states, no fake history, and failed gateway sessions producing no dummy token.
- Pinned Tailwind 3.4.17 CSS compilation: PASS. Marketing pages no longer depend on Tailwind's runtime CDN.
- `npm audit --omit=dev` in the auth server: PASS, zero reported vulnerabilities after updating the existing lockfile.
- `git diff --check`: PASS.
- Static browser preview: product images loaded; no mobile overflow at 390 px; sample-result, empty-result, copy feedback, menu Escape, and temporary auth-unavailable states exercised. Static preview has no /auth/config endpoint, so its expected auth error is not evidence of a live backend failure.

## Live verification and dashboard corrections

Cloudflare and GitHub Pages deployments succeeded for `50d7ef0` and the routing correction `6599bbe`. Production initially ignored `run_worker_first` because the deployment action installed Wrangler 3.90.0. Pinning Wrangler 4.147.0 fixed the cause; `https://neuron.zero-x.live/index.html` now returns the NeuCockpit product title.

On the live product page, empty email submission invoked native validation. A controlled test used the Supabase organization's confirmed owner email, received the confirmation email in Gmail, followed the Supabase callback, and displayed the authenticated account menu with no captured JavaScript errors. The same session opened the authenticated dashboard. This proves owner/team email login, not public-user SMTP readiness or an external customer acquisition.

That authenticated test exposed existing dashboard fallbacks covered by the data/functional findings: fabricated weekly/monthly usage, outdated 44K/three-model plan copy, and a dummy session token on gateway failure. These are removed. Limits/model counts come from the gateway; activity records only successful account requests in the current browser session; unavailable data is labeled. Copy feedback waits for clipboard success. The API endpoint now matches the deployed Worker route. Billing buttons called routes that do not exist in this Worker, so the unsupported payment path and unverifiable comparison were removed and the page clearly states that paid plan changes are unavailable. Billing has not been implemented or charged.

The owner-login proof is saved privately at `C:/Users/DELL/deepseekfs/growth-2026-10-02/auth-fixes/owner-signed-in.png`; credentials and temporary sign-in links are not published.

Final live checks after `4ede808`: both deployment jobs passed; Overview, Usage, Subscription, Models, API Keys, Profile, and Activity tabs opened correctly. API URL copy acknowledged success. The account produced a real gateway session token, displayed masked; no dummy fallback remained. At an actual 390 px dashboard viewport, the closed sidebar was inert, the menu focused its first navigation button, Escape closed it and restored opener focus, and document width remained within the viewport. Viewport overrides were cleared. Sign Out returned to the sign-in gate, with no captured JavaScript errors. Dashboard proof: `C:/Users/DELL/deepseekfs/growth-2026-10-02/auth-fixes/dashboard-verified.png`. The sign-in test was for the owner, not a new external customer.

October 2 configuration check: email enabled; Google, Microsoft, and phone disabled; custom SMTP absent. The Microsoft setup portal requires the owner's sign-in. Exact setup instructions are in `auth-setup.md`.

### October 3 OAuth verification

The owner selected Google project `phrasal-descent-465317-c2`, created its web OAuth client, and configured Supabase. A real Google login initially returned to the product page without retaining a session. The shared cookie storage split raw characters before URL encoding; encoded chunks could exceed the browser's 4096-byte cookie limit and be silently dropped. A runnable check reproduced rejected cookie writes. Storage now counts encoded size and preserves Unicode code points; ASCII and punctuation/Unicode sessions round-trip, and cleanup passes.

Commit `321fd77` deployed successfully through both Cloudflare and GitHub Pages. The repeated Google login displayed the owner account, opened the authenticated dashboard on its separate subdomain, and showed **Email, Google** under Connected Accounts. Sign-out returned to the sign-in gate with no captured JavaScript errors. Proof is saved privately as `google-signed-in.png` and `google-dashboard-profile.png` in the auth-fixes evidence directory. This is an owner login, not a new customer.

GitHub was absent from the website's provider allowlist. The same commit adds it and the correct GitHub button label, with checks for both enabled and disabled availability. Its OAuth registration form was prepared with the exact Supabase callback. Private credential generation/entry remains an owner handoff; GitHub was disabled at the last public-settings check and is not claimed working.

## Delivery gate

The full anti-slop delivery gate remains open. This is a fix report, not a claim that every legacy page, authenticated dashboard state, payment flow, or provider has passed.

- R-02/R-17/R-18/R-36/R-38: PASS for the changed marketing copy: visible em dashes and unsourced visitor/performance claims removed; samples labeled; no testimonials added.
- R-03/R-25/R-32: PASS for the recorded viewport, token contrast, and menu checks above. Exhaustive viewport and screenshot-pixel contrast checks are not claimed.
- R-23/R-24/R-33/R-34/R-37: PASS for the scoped changes: existing assets/navigation reused, native source edits, approved restored dark direction, no theme toggle introduced; host routing covered by the runnable check.
- R-26/R-27/R-35/C-2/C-4: NOT CLEARED for the full request. Owner email and Google sign-in have scoped live evidence; GitHub/Microsoft/SMS sessions and public email delivery remain unverified. Dashboard/payment/legacy-page exhaustive click-through is not complete.
- R-28: no FAQ added in these changes.
- Purpose, liveliness, and quality locks: restored brand, dials, hierarchy, motion, and technique purposes are documented above. A whole-site visual-compliance PASS is not claimed while the full gate is open.

Next required owner action: follow `auth-setup.md`, create the remaining provider credentials directly in their consoles, and enter them in Supabase. The website can then discover the methods without another code change; successful real sessions must still be tested.
