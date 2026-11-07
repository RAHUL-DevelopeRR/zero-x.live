# Hosted connectors: owner checklist

Status when this was written (2026-11-07): the code and the nine 20261106 migrations are on
production; `HOSTED_CONNECTORS` is unset, so hosted connectors are off. This file is the order of
work to switch them on, one vendor at a time, and to switch them off again. Background and the
exact behaviour are in `GATEWAY_SETUP.md` ("Hosted connectors") and `PLATFORM_CONTRACT.md`
sections 18.4 and 18.5. No step here is done by the code; every secret stays with the owner.

## 1. What the gateway does in each state

| State | `/api/connectors/*`, `/mcp/<id>` | `GET /api/account` `policy.connectors.hosted` |
|---|---|---|
| `HOSTED_CONNECTORS` unset or not exactly `true` (today) | 404 `not_found` ("Unknown API route."). The routes do not exist. | `[]` for every plan; clients offer local connectors only. |
| `true`, but no database or no valid `CONNECTOR_TOKENS_KEK` (not 32 bytes of base64) | 503 `connectors_unavailable` on every route. Nothing is stored or proxied. | `[]` |
| `true` and a valid key, vendor OAuth app not configured | 503 `connector_not_configured` for that vendor (connect and `/mcp/<id>`); it is listed as `unavailable`. | The vendor is left out. |
| `true`, key valid, vendor configured | Served for plans whose policy lists the vendor (Free: none; Pro, Max, ultrawork: all five). | The configured vendors only. |

The key is read on every runtime that serves `/mcp/` and `/api/connectors` (Worker and EC2) and
must be the same value on both.

## 2. How configuration reaches the runtimes

`.github/workflows/deploy.yml` passes these as optional secrets to both the Worker and the VM
(unset = skipped, nothing fails). A repository variable never reaches the Worker, so the switch
travels as a secret too.

- `HOSTED_CONNECTORS` (`true` serves, anything else is off)
- `CONNECTOR_TOKENS_KEK`
- `CONNECTOR_<ID>_CLIENT_ID` and `CONNECTOR_<ID>_CLIENT_SECRET` for `ATLASSIAN`, `GITHUB`, `LINEAR`, `NOTION`, `SLACK`

Public values go in `wrangler.toml` `[vars]` in a reviewed commit (the VM reads `[vars]` too):
`CONNECTOR_<ID>_SCOPES`, the URL overrides (`_AUTHORIZE_URL`, `_TOKEN_URL`, `_MCP_URL`,
`_REVOKE_URL`, https only), and for staging `CONNECTORS_CALLBACK_URL`, `CONNECTORS_RETURN_URL`,
`HOSTED_CONNECTORS_BASE_URL`. Production needs none of the last three: the defaults are
`https://dashboard.zero-x.live/api/connectors/callback`, `https://dashboard.zero-x.live/` and
`https://zero-x.live`.

Set secrets on the `production` environment only when you are ready for production, never on the
repository (run logs are public and any branch workflow can read repository secrets).

## 3. Make the key (nothing is printed)

From `neuroncli/auth-server`:

```
node scripts/connector-kek.mjs --out "D:/secure/zerox-connector-kek.txt"
node scripts/connector-kek.mjs --check "D:/secure/zerox-connector-kek.txt"
node scripts/connector-kek.mjs --gh-secret --dry-run --env production
```

- `--out` creates the file owner-only (mode 0600; on Windows the ACL is cut down to your user) and
  refuses a path inside the repository or an existing file (`--force` replaces it).
- `--check` says only `valid` or an error.
- `--gh-secret` pipes a new key to `gh secret set CONNECTOR_TOKENS_KEK` (add `--env production` and
  `--repo RAHUL-DevelopeRR/zero-x.live`). Each run makes a fresh key, so use `--out` and
  `--gh-secret` in one command to keep the backup file and the secret identical. Drop `--dry-run`
  to do it, and run it yourself.
- Keep a backup of the file. Losing the key makes every linked account unreadable: users connect
  again (nothing else is lost). Do not reuse `PROVIDER_KEYS_KEK`; the script refuses that name.

Recommended for production: `node scripts/connector-kek.mjs --out <path> --gh-secret --env production
--repo RAHUL-DevelopeRR/zero-x.live`.

## 4. Preflight (names and states only, never values)

```
node scripts/connector-preflight.mjs                                   # this shell's environment
node scripts/connector-preflight.mjs --env-file neuroncli/auth-server/.env.staging
node scripts/connector-preflight.mjs --gh --env production --repo RAHUL-DevelopeRR/zero-x.live
node scripts/connector-preflight.mjs --gh --env production --strict    # exit 1 unless ready
```

It prints whether `HOSTED_CONNECTORS` is on or off, the key's state (`unset`, `set`, `set but
invalid`, a warning if it equals `PROVIDER_KEYS_KEK`), the shared names, and for each vendor which
names are set and which are missing, ending in `ready` or `not ready (missing ...)`. `--gh` reads
only secret and variable names through the `gh` CLI (`gh secret list --json name`, `gh variable
list --json name`); it cannot see values, so it cannot tell a bad key from a good one. `.env.*`
files are git-ignored; keep them outside shared folders anyway. `--json` gives the same data for a
script.

## 5. OAuth apps, per vendor

Make every app twice: a test app for rehearsal and staging, then the production app owned by the
Zero-X organisation. Redirect URI for production: `https://dashboard.zero-x.live/api/connectors/callback`.
Staging: `https://<staging host>/api/connectors/callback` (the same path on the staging origin).
A local Node rehearsal may use `http://127.0.0.1:8787/api/connectors/callback` where the vendor
accepts an http loopback URI; the gateway accepts it only on loopback. Vendor consoles change:
check each console and the vendor's MCP page as you go, and tell me where this text is stale.

| Vendor | App to create | Scopes | Names to set |
|---|---|---|---|
| GitHub | An OAuth app (or a GitHub App with user tokens, which adds refresh tokens). An OAuth app has one callback URL, so make a separate test app. | Default `repo read:org`. Narrow them if the toolsets you allow need less. | `CONNECTOR_GITHUB_CLIENT_ID`, `_CLIENT_SECRET`. Optional `_SCOPES`. |
| Linear | An OAuth application in Linear settings, API. Add the staging and production callback URLs. | Default `read,write`. | `CONNECTOR_LINEAR_CLIENT_ID`, `_CLIENT_SECRET`. |
| Slack | A Slack app with user token scopes for the MCP tools you allow. Slack allows MCP only for Marketplace-published or internal apps, so a public alpha needs the Marketplace listing first. Use a test workspace you own. | No default: set `CONNECTOR_SLACK_SCOPES` (comma or space separated). | `CONNECTOR_SLACK_CLIENT_ID`, `_CLIENT_SECRET`, `_SCOPES`. |
| Notion | Register a client with the authorization server that `https://mcp.notion.com/mcp` advertises (read its protected-resource metadata for the endpoints). | The server's own; the catalog default is none. | `CONNECTOR_NOTION_CLIENT_ID`, `_CLIENT_SECRET` if issued, `_AUTHORIZE_URL`, `_TOKEN_URL`. |
| Atlassian | An OAuth 2.1 client with the authorization server that `https://mcp.atlassian.com/v2/mcp` advertises. | No default: set `CONNECTOR_ATLASSIAN_SCOPES` from that server. | `CONNECTOR_ATLASSIAN_CLIENT_ID`, `_CLIENT_SECRET`, `_AUTHORIZE_URL`, `_TOKEN_URL`, `_SCOPES`. |

Where the vendor offers RFC 7009 revocation, also set `CONNECTOR_<ID>_REVOKE_URL` so Disconnect
revokes the grant at the vendor. Without it Disconnect deletes the stored tokens but the grant
stays until the user removes the app in the vendor's settings.

Switch vendors on one at a time: a vendor is reported as hosted only after its client id (and any
URL or scope list it has no default for) is set. Start with GitHub (all defaults known), then
Linear, then the three that need endpoint discovery.

## 6. Rollout, staging first

0. **Rehearsal on your machine (no hosts, no production data).** `node scripts/dev-db.mjs --data-dir
   D:/neuron-build/zerox-db --email dev@example.test --plan pro --credits-usd 5`, then run the Node
   server with `DATABASE_DRIVER=pglite`, `PGLITE_DATA_DIR` as above, `DEV_AUTH_ENABLED=true`,
   `HOSTED_CONNECTORS=true`, a key made with step 3, `CONNECTORS_CALLBACK_URL` set to the
   loopback URI and the test app for one vendor. Link it, open `/mcp/<id>` from Neuron.
1. **Staging.** A second gateway on its own origin (for example `staging.zero-x.live` through
   `EXTRA_WEB_HOSTS` on a separate VM or process) with its own Supabase project, the migrations
   applied there, `HOSTED_CONNECTORS=true` and the test apps only, and `CONNECTORS_CALLBACK_URL`,
   `CONNECTORS_RETURN_URL`, `HOSTED_CONNECTORS_BASE_URL` set to the staging origin. Run the
   preflight with `--env-file` against its environment file. Staging values never go in the
   production environment of the workflow.
2. **Acceptance run on staging** (all must pass): link GitHub from the dashboard Connectors tab;
   `neuron` shows it ready with no local secret; Disconnect turns it to `needs_connect`; a Free
   account sees no hosted connector; a destructive tool asks before it runs (JSON-RPC `-32010`
   without `x-neuron-confirmed: 1`); with the key unset the same routes answer 503, with
   `HOSTED_CONNECTORS` unset they answer 404; compare each vendor's `tools/list` with
   `src/connector-catalog.js` (Atlassian's map follows its list, Notion's names come from
   third-party listings, Linear publishes none).
3. **Decide where `/mcp/` runs** (Worker or EC2; `EC2_PROXY_PREFIXES` gets `/mcp/` if EC2). A long
   tool call counts against Worker request limits and not on EC2.
4. **Legal text first** (privacy policy and terms; see `GATEWAY_SETUP.md` step 5) and the vendors'
   developer terms accepted.
5. **Production**, in this order, re-running the deploy after each change and checking `/health`
   on all three hosts: (a) make the key and set `CONNECTOR_TOKENS_KEK` in the `production`
   environment; (b) set one vendor's client id and secret (and its `[vars]` lines in a commit);
   (c) preflight with `--gh --env production`; (d) last, set `HOSTED_CONNECTORS` to `true`; (e) link
   your own account and run the acceptance list on the real hosts; (f) next vendor.
   Do (d) only after (a) to (c): with the flag on and no key every route answers 503.

## 7. Rollback

Smallest first. None of these loses another user's data except the last.

1. **One vendor off:** remove (or blank) its `CONNECTOR_<ID>_CLIENT_ID` secret and re-run the
   deploy. A deploy never deletes a Worker secret, so for an immediate effect run
   `wrangler secret delete CONNECTOR_<ID>_CLIENT_ID` or set it to an empty value with
   `wrangler secret put`. Its `/mcp/<id>` answers 503 `connector_not_configured`; links and
   sealed tokens stay and work again when it is configured.
2. **All connectors off:** set the `HOSTED_CONNECTORS` secret to `false` and re-run the deploy, or
   at once `wrangler secret put HOSTED_CONNECTORS` with `false`. Every route answers 404 and
   `hosted` is `[]` within seconds of the Worker update (EC2: next activation). Links, sealed
   tokens and audit rows stay in the database; the 30-day audit purge pauses while off.
3. **Revoke at the vendors** if a token may have leaked: users disconnect, or remove the app grant
   in the vendor console; deleting the OAuth app invalidates every token it issued.
4. **Remove the data (only after step 2):** run `migrations/down/20261106000400_connector_accounts.sql`
   (deletes every link and audit row), then, if the policy column must go,
   `migrations/down/20261106000300_connector_policy.sql`. Applies in that order.
5. **Key lost or leaked:** switch off (2), generate a new key (step 3), set it on both runtimes,
   `DELETE FROM public.zerox_connector_accounts;` (the old sealed rows cannot be opened), then
   switch on. Users connect again. Revoke the old grants at the vendors.

## 8. Checks that cover this

```
cd neuroncli/auth-server
node check-connector-scripts.mjs      # the two scripts: no value is ever printed
node check-connectors.mjs             # hosted connectors on a real database with mock vendors
node check-aws-deploy.mjs             # the workflow passes the connector secrets to both runtimes
```
