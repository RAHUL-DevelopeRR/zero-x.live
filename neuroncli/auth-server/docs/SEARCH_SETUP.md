# Web search: switch-on guide and owner checklist

Scope: `POST /v1/search` (docs/PLATFORM_CONTRACT.md section 17). The code and the nine 20261106
migrations are already live; search answers `503 search_unavailable` only because no backend secret
is set. This guide adds nothing to the gateway: it is configuration, one read-only preflight and a
smoke test. No secret value appears in it or in the preflight output.

## How the gateway reads the backends (verified in the code)

| Item | Where | Behavior |
|---|---|---|
| `SEARXNG_URL` | `src/search.js` `searxngBase` | http or https base URL, no credentials, query or fragment. `/search?format=json&categories=general&safesearch=1&time_range=...` is appended. Asked first. |
| `BRAVE_API_KEY` | `src/search.js` `braveKey` | 8-256 visible ASCII characters, sent as `X-Subscription-Token`. Asked second (fallback). |
| Order and timeout | `runSearch` | SearXNG, then Brave; 8 s per backend; an error or empty answer moves on. A failed search is given back to the user's quota. |
| Neither set | `src/routes/search.js` | `503 search_unavailable`, never unmetered. |

How `.github/workflows/deploy.yml` binds them (verified, and pinned by `check-aws-deploy.mjs`):

- `BRAVE_API_KEY`: environment secret of "production". Bound to the Worker (job worker, secret
  upload) and written to `/etc/zerox/gateway.env` on the VM (job ec2). An unset secret is skipped
  with a warning.
- `SEARXNG_URL`: environment secret, VM only (job ec2, `OPTIONAL_SECRETS`). The Worker never gets
  it (a Worker cannot reach a private host). Job ec2 rewrites `gateway.env` on every deploy, so a
  hand edit on the VM is lost.
- SearXNG is therefore used only for requests the Worker forwards to the VM, which needs
  `EC2_PROXY_PREFIXES` (a Worker secret) to cover `/v1/` (deploy/aws/CUTOVER.md). Without
  forwarding the Worker serves search with Brave alone.

## Choose a backend

| | Brave Search API | Self-hosted SearXNG on the VM |
|---|---|---|
| Effort | one secret | docker compose on the VM, one secret |
| Works on the Worker | yes | no, VM only (needs `/v1/` forwarding) |
| Cost | per query, see below | VM CPU and RAM only |
| Risk | provider rate limit and billing | upstream engines may rate-limit or block the VM's IP; results vary |

The go-live runbook (section 5c) says set one, not both. Both is supported (SearXNG first, Brave
fallback) and is the most resilient once forwarding covers `/v1/`.

### Option A: Brave (easiest)

1. Create a Brave Search API key (the Search plan, not Answers) in the Brave dashboard and set a
   monthly spend limit there.
2. Add it as environment secret `BRAVE_API_KEY` on the GitHub environment "production" (owner step,
   done in the GitHub UI so the value never enters a terminal or this repo).
3. Re-run the deploy.

Limits and cost. The gateway's own ceiling is per user per UTC day: Free 40, Pro 400, Max 2000
searches (research runs 3, 30, 150). One search is one Brave request (count 10 is always asked);
cached answers (10 minutes, per user) do not call Brave but still count against the user's quota,
and a failed search is refunded. Worst-case Brave requests per day are therefore at most
40 x Free users + 400 x Pro users + 2000 x Max users, and in practice the searches actually used.
Brave's price per 1,000 queries, free allowance and requests-per-second limit are not in this
repository and I could not confirm them here (unverified): read them on the Brave API dashboard
before launch, multiply by the worst case above, and cap spend in the dashboard. A rate-limit
answer (HTTP 429) from Brave makes that backend fail for the request, and the user sees
`503 search_unavailable` when there is no other backend.

### Option B: SearXNG on the EC2 VM, private only

SearXNG runs in Docker on the gateway VM, bound to loopback so no security-group rule, public port
or Cloudflare route is involved. `GATEWAY_SETUP.md` also describes a separate host; loopback on the
VM is the smaller setup and equally private. The gateway unit restricts address families, not
destinations, so it can reach loopback. The VM's security group has no search port and must not get
one.

Docker is not installed by `host-setup.sh` today; install it from Docker's signed apt repository
(or `docker.io` from Ubuntu) as an operator step. Files on the VM, outside the release tree
(`/opt/zerox` is replaced on each deploy):

`/opt/searxng/compose.yaml`

```yaml
services:
  searxng:
    # Pin a dated tag or digest you have checked, never :latest.
    image: searxng/searxng:REPLACE_WITH_PINNED_TAG
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8080"        # loopback only: never "8888:8080" or "0.0.0.0"
    env_file:
      - /etc/zerox/searxng.env       # holds SEARXNG_SECRET, root-only
    volumes:
      - /opt/searxng/settings.yml:/etc/searxng/settings.yml:ro
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs: ["/tmp", "/var/cache/searxng"]
    mem_limit: 512m
```

`/opt/searxng/settings.yml`

```yaml
use_default_settings: true
search:
  formats: [html, json]     # the gateway needs json
  safe_search: 1
server:
  # secret_key comes from the SEARXNG_SECRET environment variable (never written here)
  limiter: false            # loopback only, nothing public can reach it; turning it on needs
                            # Valkey and an allowance for the gateway's address (unverified detail)
  image_proxy: false
```

Create the secret without printing it, then start it:

```sh
sudo install -d -m 0755 /opt/searxng
sudo sh -c 'umask 077; printf "SEARXNG_SECRET=%s\n" "$(openssl rand -hex 32)" > /etc/zerox/searxng.env'
cd /opt/searxng && sudo docker compose up -d
```

Verify it is private and answers JSON (on the VM; the first command must show 127.0.0.1 only):

```sh
sudo ss -ltnp | grep 8888
curl -fsS 'http://127.0.0.1:8888/search?q=test&format=json&categories=general' | head -c 200; echo
```

Then set the environment secret `SEARXNG_URL` to `http://127.0.0.1:8888` (GitHub environment
"production", VM only), make sure `EC2_PROXY_PREFIXES` on the Worker covers `/v1/`, and re-run the
deploy. The VM's outbound IP is what search engines see: if they block it, results go empty and the
gateway falls back to Brave (if set) or answers an empty `200`.

Rollback: unset the secret and redeploy (or `docker compose down`); search then uses Brave or
answers 503.

## Preflight (read-only)

```sh
cd neuroncli/auth-server
node scripts/search-preflight.mjs --target vm --from-file /etc/zerox/gateway.env   # on the VM
node scripts/search-preflight.mjs --target worker                                  # process.env
node scripts/search-preflight.mjs --target vm --json
```

It reads only `SEARXNG_URL`, `BRAVE_API_KEY` and `EC2_PROXY_PREFIXES`, makes no network call, and
prints states (`unset`, `set`, `set-but-invalid`), the backend order, problems, warnings and a
verdict. Exit 0 means a 200 is expected, 1 means 503, 2 is bad usage. (The flag is `--from-file`
because Node itself claims `--env-file`.) It can only see what its environment holds: GitHub and
Worker secrets cannot be read back, so on those sides the proof is the smoke test. Covered by
`node check-search-preflight.mjs`.

## Smoke test with a real signed-in alpha.4 prompt

1. Sign in: run Neuron alpha.4 and sign in (`/login` or the device flow) with a real account.
2. In a session, ask: `Search the web for the latest Node.js LTS release and give me the source URLs.`
   Expect a web search tool call, a short list of source URLs and no "search unavailable" text.
3. Confirm through the API without echoing the credential. Type your own session or key at a
   hidden prompt:

```sh
read -rs NEURON_TOKEN; export NEURON_TOKEN
curl -sS -X POST https://zero-x.live/v1/search \
  -H "Authorization: Bearer $NEURON_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"latest Node.js LTS release","count":3}'
```

Expect `200` with `results` (title, url, snippet), `"provider": "brave"` or `"searxng"`,
`"cached": false` and `quota.remaining` one lower than before. Repeat the identical call: expect
`"cached": true` and the quota still going down by one. Failure map: `503 search_unavailable` (no
backend, every backend failed, or migration 20261106000500 missing), `401 invalid_session` (sign
in again), `429 search_quota_exhausted` (wait for `resets_at`; use `curl -i` to see
`Retry-After`). With a SearXNG-only setup, `provider` must be `searxng`, which proves the request
went through the forward.

## Owner checklist

- [ ] Choose Brave, SearXNG or both (runbook 5c advises one).
- [ ] Brave: key created, monthly spend cap set in the Brave dashboard, price and rate limit read there.
- [ ] Brave: environment secret `BRAVE_API_KEY` added on "production".
- [ ] SearXNG: Docker installed on the VM, compose and settings in place, port bound to 127.0.0.1, `ss` check done.
- [ ] SearXNG: environment secret `SEARXNG_URL` = `http://127.0.0.1:8888` (VM only, never a Worker secret).
- [ ] Worker secret `EC2_PROXY_PREFIXES` covers `/v1/` (needed for SearXNG to be used).
- [ ] Migration `20261106000500_search_quota.sql` applied; recheck `SELECT proname FROM pg_proc WHERE proname LIKE 'zerox_search%';` returns two rows.
- [ ] Deploy re-run; preflight on the VM prints verdict 200; `/health` OK on all three hosts.
- [ ] Smoke test in alpha.4 and by curl passed; the cached repeat shows `cached: true`.
- [ ] Rollback known: remove the secret(s), redeploy.
