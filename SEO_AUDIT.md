# Zero-X technical and entity SEO audit

Date: 3 October 2026. Scope: website repository, production Worker, seven public destinations, account regression checks and browser verification. Search ranking is an objective, not a promised outcome.

## Architecture / initial issues

Public pages are static HTML with inline compiled CSS, shared styles and vanilla JavaScript. Meaningful content is present before JavaScript executes; no login, hydration or API response is needed. Production is a Hono Cloudflare Worker with static assets on apex, WWW, product and dashboard domains. Supabase supports account identity/storage; the legacy Express server is not production.

Initial gaps: mixed ZeroX/ZeroX Corporation naming; unclear brand/category association; WWW metadata despite the requested apex canonical; prototype duplicates; incomplete policy social metadata; no substantial About page; fragmented setup/indexing-limit information; broken X profile links; a 100,717-byte screenshot JPEG; broad deployment exclusions that missed internal/private file patterns. Existing illustrative video/results disclosure is retained.

## Implementation

| Area | Change |
| --- | --- |
| Entity / copy | Zero-X creates NeuCockpit for local AI desktop file search, in visible headings, copy, About, footer, metadata and README. |
| Useful pages | New `/about`; expanded product setup, readable text extraction, refresh, local/online distinction, limits and native FAQ. Existing guide and film retained. |
| Metadata | Unique title/description, self canonical, robots, OG and Twitter metadata for all seven public pages. |
| Schema | Connected WebSite, Organization, WebPage and SoftwareApplication IDs; one NeuCockpit entity across homepage/product. Subpage breadcrumbs; real VideoObject retained. No fabricated offers, ratings, reviews or version. |
| Canonical / routes | HTTPS apex marketing; clean routes; prototype redirects; `/neucockpit`, `/download`, `/features` use existing substantial product. Auth/API hosts and functional parameters preserved. |
| Crawl controls | Public robots allows assets/content and advertises apex sitemap. Dashboard robots disallows crawling; dashboard/auth/API use noindex headers. Unknown paths return 404. Robots is not access control. |
| Sitemap | Seven canonical meaningful public URLs from `seo-pages.json`, regenerated in CI with real Git lastmod and video fields. Full Git history checked out in CI. |
| Performance | Screenshot WebP 44,542 bytes plus 18,132-byte mobile variant; responsive srcset/lazy decoding/dimensions. Shared OG WebP 9,804 bytes. Heading font preload, unused preconnect removed, video dimensions explicit. |
| Accessibility | One H1 per public page, semantic landmarks, breadcrumbs, skip links, 44px legal navigation/footer targets. Mobile dialog focus/Escape/scroll restoration preserved. |
| Trust / assets | Real source/social/contact/privacy links; server/source/report/prototype/dependency/cache and known ignored private patterns excluded from static upload. Secrets remain server-side. |
| Regression | Metadata/entity/link/image/sitemap checks plus worker, auth storage, dashboard and callback checks. No new app dependency. |

## Destinations / strategy

Homepage owns Zero-X/NeuCockpit brand introduction; `https://neuron.zero-x.live/` owns product/category/features/download/setup intent. `/about` answers identity questions. `/find-files-by-content` solves a filename-forgotten task; `/wheres-that-file` is the disclosed illustrative film watch page. `/privacy` and `/terms` are genuine policies. No thin synonym landing pages were created. Parameters remain functional, while canonical tags consolidate indexing.

## Validation / performance

Local routing, database persistence/outage handling, dashboard quota, session/provider options, callback safety and seven-page SEO checks pass. Dependency audit reports zero vulnerabilities. Worker package dry-run passes. No configured lint or TypeScript typecheck exists in this JavaScript/static repository; neither is claimed as executed.

All seven pages tested at 320, 375 and 768px without horizontal overflow. Product mobile menu opens; Escape closes; aria-expanded resets; focus returns to opener; body scroll restores. Product breadcrumb adjusted after visual review to avoid extending the full-height hero.

PageSpeed mobile baseline (3 October): performance 86, accessibility 100, best practices 100, SEO 100; FCP 3.0s, LCP 3.4s, TBT 0ms, CLS 0.055. No CrUX field data available. Lighthouse SEO 100 is a technical checklist, not evidence of ranking. Post-deployment evidence recorded below.

## Anti-slop after-development audit

Preserved the owner's restored dark/neon identity rather than the stale light-theme export. New copy serves setup, support, privacy and failure cases. No testimonials, invented numbers or filler card sections added. Product heading/film is the focal point; cyan marks actions. About/legal content uses the existing readable document layout. Existing decorative orbs/cards remain part of the requested preserved identity. ENERGY 2 / RHYTHM 2 / MOTION 1 describe the retained restrained motion and varied product/document sections.

## Changed files

Public HTML: index, neuron, dashboard, About, guide, film, privacy, terms. Supporting files: legal.css, two screenshot WebPs, robots.txt, sitemap.xml, seo-pages.json, CNAME, .assetsignore, deploy workflow, worker src/index.js, build-sitemap.mjs, check-seo.mjs, check-worker.mjs, package.json, README and four SEO documents.

## Remaining opportunities / owner actions

1. Monitor indexation and query performance after recrawl. The broad query "zero x" competes with established unrelated entities. Align genuine external profiles with Zero-X/NeuCockpit.
2. Produce real platform walkthroughs from released builds and observed user questions; follow `SEO_CONTENT_PLAN.md`.
3. Seek useful community mentions and permitted genuine user stories; follow `SEO_OFFSITE_CHECKLIST.md`.
4. Fonts, inline CSS and the deferred Supabase client remain measurable performance costs. Further changes should preserve sign-in and follow actual measurements. No field INP claim is possible without data.

## Sources

[People-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), [site names](https://developers.google.com/search/docs/appearance/site-names), [canonicals](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [Organization](https://developers.google.com/search/docs/appearance/structured-data/organization), [breadcrumbs](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb), [software rich-result eligibility](https://developers.google.com/search/docs/appearance/structured-data/software-app). Semantic SoftwareApplication markup does not guarantee a software rich result; never invent an offer/review to meet eligibility rules.

## Deployment evidence

Implementation commits `e9020a6` and `7f76024` are pushed to main. Cloudflare deployment and GitHub Pages workflows completed successfully. The live SEO check passes across all seven pages, redirects, private noindex, static source exclusions, robots, sitemap and media assets. The six installer URLs match assets in the real `v1.0.0-build-202610010440` product release; installers were not downloaded or re-tested by this website audit.

Live browser matrix: all seven destinations at actual 320, 375 and 768px viewports (21 checks), without horizontal overflow. Product menu works at 375px, Escape restores opener focus, and mobile orb animation is disabled. Overrides were cleared after testing. Desktop homepage screenshot and JSON matrix are saved outside the repository in `C:/Users/DELL/deepseekfs/growth-2026-10-03/seo/`.

Two post-deployment mobile PageSpeed runs returned performance 85, accessibility 100, best practices 100 and SEO 100. Latest run after the mobile paint adjustment: FCP 3.0s, LCP 3.5s, TBT 0ms, CLS 0, Speed Index 3.1s. The previous run was LCP 3.4s, CLS 0.053. Report: <https://pagespeed.web.dev/analysis/https-zero-x-live/dcr92o9lm1?form_factor=mobile>. This does not establish a speed gain; LCP still needs improvement and field data is unavailable. Mobile grain/orb work was reduced without altering product functionality, and the final lab run no longer reports forced reflow.

Search Console: verified Domain property accessible. Google live homepage test on 3 October at 18:27 IST says **URL is available to Google / Page can be indexed**. Homepage indexing request accepted and added to priority crawl queue. Stored index report still reflects the old 21 September WWW redirect and has not yet recrawled this deployment. Prior overview: 11 clicks, three indexed pages, seven not indexed; no field Core Web Vitals data. These are current report observations, not proof of newly indexed pages.

Canonical sitemap submission accepted, but Search Console initially reports **Couldn't fetch / Sitemap could not be read**. Direct apex and WWW-followed requests return HTTP 200 application/xml with seven valid URLs, including a Googlebot-user-agent request. One retry was made after full deployment. Do not claim Google successfully processed it until its report changes. Recheck this external processing state later; if it persists, inspect DNS/CDN/WAF logs for verified Google crawler requests rather than broadly weakening protection. The previously submitted WWW sitemap remains in the account and redirects to apex.

## Final gate

Technical SEO, metadata, canonical routing, robots, sitemap XML/delivery, connected structured-data parse/relationship checks, mobile, Worker build and regression tests: PASS. Google sitemap processing: unresolved (last observed fetch failure). Field CWV/INP: no data. Google indexing/ranking: pending recrawl, not guaranteed. No new outreach or fabricated external signals were added.

## Follow-up: broad "zero x" visibility

Same-day browser follow-up after the owner's report: the signed-in Google result included the old "ZeroX | NeuCockpit: Local AI File Search" listing. Clicking Google's **Try without personalisation** removed this result from the first organic results shown. Do not report the signed-in position as a general ranking or evidence of SEO success. Google's owner-only query panel showed one click, 150 impressions and average position 45.1 over the last 90 days; that historical average is not today's universal position.

Search Console has now crawled the apex homepage at **3 October 2026, 18:29:45**. Fetch/crawl/indexing permission succeeded, and it read the new apex canonical. Google nevertheless selected the old WWW URL and labels apex "Duplicate, Google chose different canonical than user". WWW is still indexed with its older **3 October, 09:28:57** crawl and old WWW canonical. The WWW URL currently returns 301 to apex, apex returns 200, and the sitemap returns 200 XML. The canonical migration is not yet reflected in Google's selection. An inspection/indexing request for the old WWW destination was attempted once to expose the current redirect; its outcome is recorded below.

The apex sitemap report still says Couldn't fetch. A valid direct response or an accepted submission does not prove Google's processing succeeded. Do not remove the old indexed URL, reverse the canonical again, weaken crawler security or repeatedly submit the same URL as a ranking shortcut.

Additional external identity correction: both genuine GitHub repositories had blank homepage fields and inconsistent descriptions. Set the website repository to `https://zero-x.live/` with a Zero-X/NeuCockpit/local desktop search description; set the product repository to `https://neuron.zero-x.live/` with its actual product/category/platform description. Read-back and browser verification confirm these fields. No stars, reviews, links or user numbers were manufactured.

Old WWW request outcome: Google accepted the request and added the URL to its priority crawl queue. This is a request to process the current redirect, not a reversal of the preferred apex domain. It does not prove canonical migration, sitemap processing or ranking is complete. The broad-query visibility goal remains unachieved in the non-personalised result checked.
