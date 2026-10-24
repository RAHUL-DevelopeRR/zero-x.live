# External identity and discovery

Consistent description: **Zero-X builds Neuron, an open-source AI coding agent for the terminal, and NeuCockpit, local AI file search for desktop.** Website: <https://zero-x.live/>. Neuron: <https://zero-x.live/neuron-cli>. NeuCockpit: <https://zero-x.live/neucockpit>. (`neuron.zero-x.live` now redirects to `/neuron-cli` and keeps only the `/device` sign-in page.)

Use the same name everywhere: **Zero-X** (the site also accepts Zero X and ZeroX as alternate names). Google matches a brand query by seeing the same name, description and link on the site and on profiles it already trusts.

## Genuine official destinations

- [Website source](https://github.com/RAHUL-DevelopeRR/zero-x.live)
- [Neuron source and releases](https://github.com/RAHUL-DevelopeRR/neuron-v2)
- [NeuCockpit source and releases](https://github.com/RAHUL-DevelopeRR/deepseekfs)
- [Instagram](https://www.instagram.com/zerox.corporation/). Keep the existing handle; use Zero-X, Neuron and NeuCockpit in the visible bio and link the canonical website.
- A LinkedIn result titled "ZERO-X" appears for the query, but no verified LinkedIn page is recorded here. Add a profile to the Organization `sameAs` list on the homepage only after confirming the owner controls it.

## AI search and AI assistants (24 October 2026)

Assistants answer from two sources: a live search index (ChatGPT search and Copilot lean on Bing; Perplexity, Claude and Google AI Overviews run their own crawlers) and what a model learned in training.

1. **Cloudflare blocks the training crawlers.** A request with the GPTBot, ClaudeBot or CCBot user agent gets a Cloudflare 403 ("Your request was blocked"), from the zone's AI crawler setting, not the Worker. OAI-SearchBot, ChatGPT-User, Claude-SearchBot, PerplexityBot, Bingbot and Googlebot get 200. If you want future models to know Zero-X, allow the training crawlers in Cloudflare (Security → Bots / AI Crawl Control); the trade-off is that public pages may be used for training. `robots.txt` already allows everything.
2. **Bing Webmaster Tools.** Import the verified Search Console property, submit `https://zero-x.live/sitemap.xml`, and check that IndexNow submissions appear after each deploy. Bing's index is what ChatGPT search and Copilot cite.
3. **IndexNow** runs in the deploy workflow (`submit-indexnow.mjs`) and sends only the public pages a push changed. The key file `/<key>.txt` must stay at the site root.
4. **`/llms.txt`** is a plain summary for assistants. It is a proposal, not a standard Google uses; keep it short and accurate. `check-seo.mjs` fails if it links a non-canonical page or names an old Neuron version.

## Owner actions

1. Update the `neuron-v2` repository: description "Neuron by Zero-X: an open-source AI coding agent for your terminal", homepage `https://zero-x.live/neuron-cli`, and topics such as `ai-coding-agent`, `coding-agent`, `ai-agent`, `cli`, `terminal`, `rust`, `llm`. Update the `zero-x.live` repository description to name Neuron too. GitHub repositories rank in Google and appear on GitHub topic pages.
2. In Search Console, inspect `https://zero-x.live/` and request indexing once after this deploy; Google still shows the old NeuCockpit title. Inspect `/ai-coding-agent` and request indexing once. Follow `GOOGLE_SEARCH_CONSOLE_SETUP.md`.
3. Verify Bing Webmaster Tools (above).
4. Create and link genuine profiles that use the exact name Zero-X and link `https://zero-x.live/`: a GitHub organisation, X/Twitter, LinkedIn company page, Product Hunt. Then add their URLs to the Organization `sameAs` list on the homepage.
5. Get Neuron listed where people and assistants look for coding agents: curated GitHub "awesome" lists for AI coding agents and CLI tools (open a pull request following each list's rules), Product Hunt, a Show HN post, and relevant subreddits that allow project posts. Roundup articles such as "free AI coding agents in 2026" are what AI answers cite; contact their authors with a short factual note and the install command.
6. Publish authentic demonstrations: a short terminal recording of a real task, a dev.to or Hashnode write-up of how the agent loop works in Neuron. Disclose affiliation, link the canonical page and state alpha limitations.
7. Ask actual users whether they want to share their experience. Obtain permission for names, quotes and screenshots.

Search Console, Bing Webmaster Tools, PageSpeed Insights, Lighthouse and the repository's Node checks give a free baseline. The existing Cloudflare Worker already serves static crawlable HTML; a paid SEO plugin or framework migration is unnecessary.

Do not buy link packages, create thin keyword pages, manufacture reviews, bulk-tag followers or scrape emails. Measure relevant visits and successful installs alongside rankings.
