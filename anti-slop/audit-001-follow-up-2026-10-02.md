# AFTER audit follow-up

The owner's request to make the site work approved findings 1-10 from `audit-001-2026-10-02.md`. This work retains the restored dark layout. It does not reinstate the rejected light redesign.

## Design read

Reading this as a desktop-product website for technical users, retaining the owner's restored dark visual identity. ENERGY 2 / RHYTHM 2 / MOTION 1.

The supplied `Assets/zero-x/DESIGN.md` remains the original light/green direction. The later explicit rollback request overrides that appearance for this work. Cyan identifies actions and focus; purple distinguishes secondary product technology. Cabinet Grotesk headings and Satoshi body text preserve the restored brand. Monospace is limited to paths, code, and technology labels. Alternating screenshot/text sections explain the actual workflow; platform cards group genuinely different installers. Rounded dialogs separate interaction from the page. Native video controls replace the inaccessible custom scrubber. Decorative drift, floating effects, grain animation, and headline shimmer are stopped; content is visible before scripts run. Existing artwork and navigation are reused.

## Approved findings

| Finding | Change | Verification / remaining work |
| --- | --- | --- |
| 1: sign-in | Resumed the connected Supabase project; configured public key and exact return URLs; added enabled-provider discovery, native dialog, email magic-link form, Microsoft OAuth scope, SMS send/verify flow, and useful errors. | Project reports ACTIVE_HEALTHY. Worker checks cover enabled/disabled providers and outages. Actual OAuth, public email, and SMS sessions remain blocked on provider credentials/custom SMTP. |
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
- Pinned Tailwind 3.4.17 CSS compilation: PASS. Marketing pages no longer depend on Tailwind's runtime CDN.
- `npm audit --omit=dev` in the auth server: PASS, zero reported vulnerabilities after updating the existing lockfile.
- `git diff --check`: PASS.
- Static browser preview: product images loaded; no mobile overflow at 390 px; sample-result, empty-result, copy feedback, menu Escape, and temporary auth-unavailable states exercised. Static preview has no /auth/config endpoint, so its expected auth error is not evidence of a live backend failure.

## Delivery gate

The full anti-slop delivery gate remains open. This is a fix report, not a claim that every legacy page, authenticated dashboard state, payment flow, or provider has passed.

- R-02/R-17/R-18/R-36/R-38: PASS for the changed marketing copy: visible em dashes and unsourced visitor/performance claims removed; samples labeled; no testimonials added.
- R-03/R-25/R-32: PASS for the recorded viewport, token contrast, and menu checks above. Exhaustive viewport and screenshot-pixel contrast checks are not claimed.
- R-23/R-24/R-33/R-34/R-37: PASS for the scoped changes: existing assets/navigation reused, native source edits, approved restored dark direction, no theme toggle introduced; host routing covered by the runnable check.
- R-26/R-27/R-35/C-2/C-4: NOT CLEARED for the full request. UI and error paths exist, but Google/Microsoft/SMS credentials and public email delivery are not configured or verified. Dashboard/payment/legacy-page exhaustive click-through is not complete.
- R-28: no FAQ added in these changes.
- Purpose, liveliness, and quality locks: restored brand, dials, hierarchy, motion, and technique purposes are documented above. A whole-site visual-compliance PASS is not claimed while the full gate is open.

Next required owner action: follow `auth-setup.md`, choose the Google Cloud project, create provider credentials directly in their consoles, and enter them in Supabase. The website can then discover the methods without another code change; successful real sessions must still be tested.
