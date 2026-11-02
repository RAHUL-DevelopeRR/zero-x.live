# Neuron release manifests

The Neuron clients and the `zero-x.live/download` page read two JSON files to learn about the
latest release (plan rows A6, A7, T23 and D23):

| URL | Read by |
|---|---|
| `https://zero-x.live/releases/cli/latest.json` | the CLI and terminal UI update notice (T23), `/download` |
| `https://zero-x.live/releases/desktop/latest.json` | the desktop "new version" notice (D23, P0), `/download` |

The release workflows in the Neuron repository (WP6: `release.yml` and `desktop-release.yml`)
write them. Nothing in this repository builds or signs releases.

## Serving

`GET /releases/{cli,desktop}/latest.json` is answered by the Worker (`src/routes/releases.js`):

1. If the `RELEASES` R2 binding exists, the object `<product>/latest.json` from that bucket.
2. Otherwise, or when that object is missing, unreadable or fails validation, the copy committed in
   this repository at `releases/<product>/latest.json` (a static asset).
3. As a last resort, a built-in "nothing released yet" manifest.

Every answer is a manifest that passed `validateReleaseManifest`. A malformed upload is logged
(`Release manifest rejected`, with the first five problems) and never reaches clients. Responses
carry `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *` and
`X-Neuron-Manifest-Source: r2 | assets | built-in`.

The committed copies say `"version": null` until the first release, so clients show no notice and
`/download` shows "coming soon".

## Schema (version 1)

```json
{
  "schema_version": 1,
  "product": "cli",
  "channel": "stable",
  "version": "6.3.0",
  "released_at": "2026-11-02T09:30:00Z",
  "notes_url": "https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/tag/v6.3.0",
  "minimum_version": null,
  "downloads": [
    {
      "platform": "windows-x64",
      "kind": "cli",
      "file": "neuron-windows-x64.exe",
      "url": "https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v6.3.0/neuron-windows-x64.exe",
      "sha256": "<64 lowercase hex characters>",
      "size": 31457280
    }
  ],
  "checksums_url": "https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/download/v6.3.0/SHA256SUMS",
  "install": {
    "npm": "npm install -g @zero-x.live/neuron",
    "pip": "python -m pip install neuroncli",
    "powershell": "irm https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/latest/download/install.ps1 | iex",
    "shell": "curl -fsSL https://github.com/RAHUL-DevelopeRR/neuron-v2/releases/latest/download/install.sh | sh"
  }
}
```

| Field | Rule |
|---|---|
| `schema_version` | `1`. A breaking change gets a new number and a new path; clients ignore manifests whose version they do not know. |
| `product` | `cli` or `desktop`, matching the path. |
| `channel` | `stable` or `beta`. Only `stable` is published at these paths today. |
| `version` | Semantic version without a leading `v`, or `null` while nothing is released. |
| `released_at` | ISO UTC time (`…Z`) when `version` is set, else `null`. |
| `notes_url` | Release notes (`github.com` or `zero-x.live`, https), or `null`. |
| `minimum_version` | Clients older than this should block on "update required"; `null` means none. Use only for a security or protocol break. |
| `downloads[]` | Empty while `version` is `null`; at most 32 entries; one per `platform` and `kind`. |
| `downloads[].platform` | CLI: `linux-x64`, `linux-arm64`, `macos-arm64`, `macos-x64`, `windows-x64`, `windows-arm64`. Desktop: `windows-x64`, `windows-arm64`, `macos-universal`, `macos-arm64`, `macos-x64`, `linux-x64`, `linux-arm64`. |
| `downloads[].kind` | CLI: `cli` (the `neuron` binary) or `tui` (the full-screen UI binary). Desktop: `installer` (what a person downloads) or `updater` (the bundle the in-place updater applies, P1). |
| `downloads[].file` | The asset's file name; `url` must end with it. |
| `downloads[].url` | https on `github.com` or `zero-x.live`, no credentials or port. |
| `downloads[].sha256` | Lowercase hex SHA-256 of the file. `/download` shows it. |
| `downloads[].size` | Optional, bytes. |
| `downloads[].signature` | Optional. For desktop `updater` entries, the Tauri updater signature (P1). |
| `checksums_url` | The release's `SHA256SUMS`, or `null`. |
| `install` | CLI only: one-line install commands keyed `npm`, `pip`, `powershell`, `shell`. |

Unknown top-level fields are rejected, so a typo fails loudly. Clients must still ignore fields
they do not understand inside `downloads[]` entries.

### Client rules

- Fetch at most once every 24 hours (T23), with a 5 s timeout. Never block startup on it.
- Compare `version` with the running version by semantic-version order. Show the notice only for a
  newer version on the client's own channel.
- Skip the check when `NEURON_NO_UPDATE_CHECK=1` or `NEURON_NO_NETWORK_EXTRAS=1` (T30).
- The desktop P0 notice links to `https://zero-x.live/download`; it never downloads by itself.
  In-place updates (P1) will use the Tauri updater: the Worker will answer its endpoint from the
  `updater` entries of this manifest (with their `signature`), so there is one file to publish.

## Publishing from a release workflow

Recommended: an R2 bucket, so a release never needs a commit or deploy here.

1. One-time, by Rahul: `wrangler r2 bucket create neuron-releases`, then uncomment the
   `[[r2_buckets]]` block for `RELEASES` in `wrangler.toml` and deploy. Create a Cloudflare API
   token limited to *Workers R2 Storage: Edit* on that bucket, and store it in the Neuron
   repository as the `CLOUDFLARE_R2_TOKEN` secret with `CLOUDFLARE_ACCOUNT_ID`.
2. In the release workflow, after the GitHub release assets are verified, write the manifest,
   validate it, and upload it:

   ```bash
   # write-release-manifest.mjs lives in the Neuron repository (WP6).
   node scripts/write-release-manifest.mjs --product cli --tag "$TAG" > latest.json
   npx wrangler r2 object put neuron-releases/cli/latest.json --file latest.json \
     --content-type application/json --remote
   curl -fsS https://zero-x.live/releases/cli/latest.json | jq -e '.version == "'"${TAG#v}"'"'
   ```

   The last line fails the job when the Worker rejected the upload (it would still serve the
   previous manifest). The `sha256` values come from the per-asset `.sha256` files the release
   already publishes.

Without the bucket, commit the new manifest to `releases/<product>/latest.json` in this repository;
the deploy workflow publishes it with the site.

Rollback: upload the previous manifest again (or delete the R2 object to fall back to the
committed copy). Clients pick it up within 5 minutes plus their own 24-hour check interval.
