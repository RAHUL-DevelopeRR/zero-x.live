# Zero-X search content plan

Primary identity (from 20 October 2026): Zero-X makes Neuron, an AI coding agent for the terminal, and NeuCockpit, local AI desktop file search. The homepage owns the Zero-X brand and Neuron; NeuCockpit lives at `/neucockpit`. The ambiguous phrase "zero x" (Wikipedia's Zero X motorcycle, Infinix ZERO X phones) is not the only success measure.

## Neuron and the Zero-X brand

| Query / intent group | Destination | Title / user problem | Outline | Internal links / product relevance |
| --- | --- | --- | --- | --- |
| Zero X, Zero-X, ZeroX, Zero-X AI, zero x coding agent | `/` and `/about` | Zero-X: Neuron, the free AI coding agent for your terminal | H1 names Zero-X; Organization/WebSite `alternateName` lists Zero X and ZeroX; About states the spelling variants and that Zero-X is not the Infinix phone or the motorcycle | Homepage owns brand intent; About owns identity questions. Every page links home with "Zero-X". |
| AI coding agent, what is an AI coding agent, coding agent vs autocomplete, AI agent for coding | `/ai-coding-agent` (24 October 2026) | What is an AI coding agent? | Definition, agent loop, permission modes, models and data flow, good first tasks, limits, install, FAQ | Linked from the homepage FAQ, Neuron CLI, About, `llms.txt` and every Neuron-site footer. |
| Neuron CLI, Neuron coding agent, terminal coding agent, free AI coding agent, coding agent for Windows | `/neuron-cli` | Neuron CLI: an AI coding agent that works inside your repository | Features, permission modes, install per OS, first run, models, pricing, FAQ | Docs, pricing, guide. |
| Run a coding agent in CI, AI agent GitHub Actions | Proposed `/guides/coding-agent-in-ci` | Run Neuron headless in CI | A tested workflow file with `neuron -p` and an `nzx_` key secret, output, failure handling, limits | Publish only after running it in a real repository on the current release. |
| Neuron vs other terminal coding agents, Claude Code / Gemini CLI alternative | Proposed comparison page | Choosing a terminal coding agent | Dated, sourced facts only (licence, platforms, model access, pricing), what each is better at | Never invent benchmarks; re-check facts before every edit. |

## NeuCockpit

| Query / intent group | Destination | Title / user problem | Outline | Internal links / product relevance |
| --- | --- | --- | --- | --- |
| NeuCockpit, NeuCockpit AI, local AI file search, semantic file search desktop, AI desktop file search | `/neucockpit` | NeuCockpit local AI desktop file search | Actual screenshot, document support, indexing, setup, OS/CPU installers, architecture, limitations, FAQ | Download/setup anchors, guide, About, privacy. One substantial product destination. |
| Forgot filename, find file by contents, search documents by meaning | `/find-files-by-content` (existing) | Find a file when you forgot its name | OS search first, describe contents, index chosen folder, verify original, troubleshoot missing matches | Product/setup. Improve this guide rather than publish synonym duplicates. |
| Search PDFs by meaning, scanned PDF not searchable | Proposed `/guides/search-pdfs-by-meaning` | Search a PDF by meaning | Original permitted samples, semantic versus filename retrieval, scanned/encrypted limits, passages, failed queries | Main guide, product support, privacy. Publish only after testing examples in the current release. |
| Local semantic search Windows, AI search files on my computer | Proposed `/guides/windows-local-document-search` | Set up local document search on Windows | CPU architecture, installation, model setup, chosen folder, measured indexing, refresh, errors | Installer, setup, support. Require a real walkthrough; do not clone for other OSes without native verification. |
| Private AI file search, local document search privacy | Product privacy section and `/privacy` | Which features run locally? | SQLite/FAISS/models, initial downloads, account data, optional cloud transmission, mode selection | Product local/online section, privacy, source. Add a separate explainer only for substantial original detail. |

## Publication requirements

- Document tested build, platform, sample folder and date. Include successful and failed queries and indexing limits.
- Use public sample files; never publish a user's private documents. Timings apply only to the tested device/dataset.
- No invented users, reviews, speed, accuracy or comparisons. Update existing pages before creating new ones.
- Use visible author/source links. Modification dates change only after substantive revisions.

## Measure

Compare branded queries and problem/category groups separately in Search Console over comparable 28-day periods. Track impressions, clicks, CTR, position and destination. Also track successful installations, useful first results and returning users through consented feedback. Views and downloads do not prove successful use on a person's own documents.
