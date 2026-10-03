# Search Console: Zero-X

Canonical marketing domain: <https://zero-x.live/>. Product: <https://neuron.zero-x.live/>. A Domain property covers HTTP/HTTPS and subdomains; a URL-prefix property covers only its prefix.

1. Open <https://search.google.com/search-console> with the owner account. Select the existing `zero-x.live` Domain property. If absent, choose **Add property → Domain**, enter `zero-x.live` without protocol/path, and copy Google's DNS TXT record.
2. Add the exact TXT record at the DNS provider, preserving existing records. Verify after propagation and retain the record. Do not put private credentials in repository files.
3. Confirm <https://zero-x.live/robots.txt> and <https://zero-x.live/sitemap.xml> return 200 after deployment. Submit **https://zero-x.live/sitemap.xml** in Sitemaps. It contains seven canonical meaningful public destinations including the product subdomain.
4. Inspect **https://zero-x.live/** in URL Inspection. Check crawl permission, response, rendered content and Google's selected canonical. Use **Test live URL** after deployment.
5. If live inspection passes, **Request indexing** once. This requests processing and guarantees neither indexing nor ranking. Inspect product and `/about` as needed; do not repeatedly submit a pending request.
6. Allow Google to recrawl old WWW redirects and new canonical links. Do not use removal tools for an ordinary canonical migration.

## Monitor

- Pages/indexing: investigate unexpected excluded public URLs, server errors and conflicting canonicals. Private dashboard/auth/API exclusion is intentional.
- Search performance: compare clicks, impressions, CTR and average position over matched periods. Separate branded Zero-X/NeuCockpit queries from category/problem intent; filter device/country/page when interpreting changes.
- Core Web Vitals: use field reports when traffic is sufficient. A Lighthouse score is not an INP measurement or proof of field performance.
- Sitemaps: confirm fetch/discovery after meaningful content releases. Lastmod comes from Git history, not daily timestamp changes.
- Manual actions/security: act on actual reported issues; low ranking alone does not prove a penalty.

Site-name/indexing changes may take days or weeks; competitive rankings can take longer. Neither schema nor an indexing request guarantees the top result for "zero x".

[Google SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), [canonicals](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [site names](https://developers.google.com/search/docs/appearance/site-names).
