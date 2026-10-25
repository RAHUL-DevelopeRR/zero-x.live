# Zero-X — NeuCockpit website

Official website: <https://zero-x.live/>. It is the home of [Neuron](https://zero-x.live/neuron-cli), Zero-X's AI coding agent for the terminal. [NeuCockpit](https://zero-x.live/neucockpit) is Zero-X's local AI desktop application for finding documents by meaning on Windows, macOS and Linux. [NeuCockpit's source and releases](https://github.com/RAHUL-DevelopeRR/deepseekfs) live in a separate repository.

## Architecture

Static HTML/CSS and vanilla JavaScript provide crawlable public pages. `neuroncli/auth-server/src/index.js` is the production Hono/Cloudflare Worker: it routes website/product/dashboard hosts and serves authenticated APIs. Supabase supports identity and account persistence. The legacy Express server is not the production Worker.

Public pages are listed in `seo-pages.json`. Product pages, guides, film and policies use clean paths, including `/neuron-cli` and `/neucockpit`. `neuron.zero-x.live` belongs to Neuron: `/` redirects to `https://zero-x.live/neuron-cli` and `/device` is the CLI's device sign-in page. `/neuron` redirects to `/neuron-cli`, `/download` and `/start` to `/neuron-cli#install`, and `/legacy` and `/features` to the NeuCockpit page. WWW marketing pages redirect to HTTPS apex; the dashboard subdomain remains. Dashboard/auth/API pages are intentionally not indexed.

## Develop and verify

Use Node.js 22 and locked dependencies:

```sh
cd neuroncli/auth-server
npm ci
npm run build:seo
npm run check:production
npm audit --omit=dev
npx wrangler deploy --dry-run
```

After deployment run `node check-seo.mjs --live`. Use Wrangler development with local bindings for production-like routing. A plain static HTTP server previews layout only; it does not implement production routes/auth APIs. No lint or TypeScript typecheck script is configured.

GitHub Actions deploys main after production checks. Credentials belong in Cloudflare/GitHub secret stores. `.assetsignore` excludes server source, internal reports, prototypes, dependencies/cache and known private patterns. Keep public asset references working when adjusting it.

## SEO maintenance

- [Audit and verification](SEO_AUDIT.md)
- [Content plan](SEO_CONTENT_PLAN.md)
- [Search Console instructions](GOOGLE_SEARCH_CONSOLE_SETUP.md)
- [External identity checklist](SEO_OFFSITE_CHECKLIST.md)

Add meaningful public destinations to `seo-pages.json` and regenerate the sitemap. Use consistent Zero-X/NeuCockpit naming and truthful schema. Search Console and successful product use determine progress; metadata or Lighthouse scores do not guarantee rankings.
