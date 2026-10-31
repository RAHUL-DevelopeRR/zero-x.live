#!/bin/bash
# Builds the release tarball the gateway VM runs, from a commit, never from a working tree (one
# may hold untracked output/, tmp/ or secrets). Runs on the laptop (Git Bash on Windows, Linux,
# macOS) and in CI, from anywhere inside the repository:
#   deploy/aws/package-release.sh [<commit, default HEAD>] [<out, default ./zerox-release-<commit>.tar.gz>]
# Prints the release id (the commit's first 7 hex digits) on stdout; the rest goes to stderr.
#
# The tarball's root is a release root (/opt/zerox/releases/<commit> on the VM):
#   - the website: every file of the commit that the Worker's asset upload keeps, i.e. the root
#     .assetsignore applied with gitignore rules and ignoring case, as wrangler applies it, plus
#     .assetsignore itself (server.js derives its allow-list from it);
#   - neuroncli/auth-server without its tests and fixtures, migrations (applied from a laptop,
#     not read at runtime), docs, Markdown, Worker and Docker configuration, the CI-only tools
#     and dotfiles; scripts/ stays (cron.mjs runs on the VM);
#   - the VM's half of deploy/aws (install, activation, host setup, units, sudoers, the upgrade
#     refresh and its apt and needrestart settings, the environment installer);
#   - sitemap.xml built for this commit as job deploy builds the Worker's (build-sitemap.mjs, each
#     page's lastmod from the history), in place of the committed copy, whose dates always lag: a
#     page and the sitemap entry that dates it never change in one commit. Needs node, and the
#     history (CI's checkout has fetch-depth: 0);
#   - REVISION: the release id, which server.js reports in /health.
# No node_modules: install-release.sh runs `npm ci --omit=dev --ignore-scripts` on the VM from the
# release's package-lock.json (integrity-checked). The production dependencies are plain
# JavaScript, so nothing has to be built for arm64, and the laptop and CI ship the same bytes.
# A path that looks like a secret or a working file (.env, .dev.vars, keys, output/, tmp/) fails
# the build instead of shipping: it would mean one was committed.
set -euo pipefail
die() { echo "package-release: $*" >&2; exit 2; }
ref="${1:-HEAD}"
repo="$(git rev-parse --show-toplevel)"
full="$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}")" || die "unknown commit $ref"
release="${full:0:7}"
out="${2:-$PWD/zerox-release-$release.tar.gz}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Files as committed: without core.autocrlf=false, git archive on a Windows checkout writes CRLF.
git_() { git -C "$repo" -c core.quotePath=false -c core.autocrlf=false -c core.eol=lf "$@"; }

src="$work/src"
mkdir "$src"
git_ archive --format=tar "$full" | tar -xf - -C "$src"
for path in .assetsignore neuroncli/auth-server/server.js neuroncli/auth-server/package.json \
  neuroncli/auth-server/package-lock.json deploy/aws/install-release.sh deploy/aws/activate-release.sh; do
  [ -f "$src/$path" ] || die "$ref has no $path"
done
# The commit's own build-sitemap.mjs, reading the commit's pages, dating them from this repository
# at this commit. Its output goes to stderr with the rest. A commit whose script cannot date pages
# from another directory (older than SITEMAP_GIT_DIR) keeps its committed sitemap. The ceiling
# keeps git from ever taking a repository around the temporary directory for the release's.
if [ -f "$src/seo-pages.json" ] && grep -qs SITEMAP_GIT_DIR "$src/neuroncli/auth-server/build-sitemap.mjs"; then
  command -v node >/dev/null 2>&1 || die "node is needed to build the release's sitemap.xml"
  GIT_CEILING_DIRECTORIES="$work" SITEMAP_GIT_DIR="$repo" SITEMAP_REF="$full" \
    node "$src/neuroncli/auth-server/build-sitemap.mjs" >&2 || die "build-sitemap.mjs failed for $ref"
fi

# Website. git evaluates the patterns: in a scratch repository, ls-files --others lists every
# file of the tree except those .assetsignore matches, and reads no other ignore file (no
# .gitignore, info/exclude or core.excludesFile without --exclude-standard). wrangler matches
# without regard to case (the ignore package's default); git does only with core.ignoreCase, which
# `git init` sets on Windows and macOS but not on Linux. Set here, so the laptop and CI ship the
# same files, and never one the Worker leaves out (Assets/demo.MP4 under Assets/*.mp4).
git init -q --bare "$work/scan.git"
git -c core.ignoreCase=true -c core.quotePath=false --git-dir="$work/scan.git" --work-tree="$src" ls-files --others \
  --exclude-from="$src/.assetsignore" > "$work/site"
# Gateway: what server.js and scripts/ need at runtime.
git_ ls-tree -r --name-only "$full" -- neuroncli/auth-server | grep -vE \
  '^neuroncli/auth-server/(.*/)?\.|^neuroncli/auth-server/(check-[^/]*|test\.js|e2e-[^/]*|wrangler[^/]*\.toml|Dockerfile|build-sitemap\.mjs|submit-indexnow\.mjs)$|^neuroncli/auth-server/(fixtures|migrations|docs|node_modules)/|\.md$' \
  > "$work/gateway" || true
grep -qx neuroncli/auth-server/server.js "$work/gateway" || die "could not list neuroncli/auth-server"
# The VM's half of the deploy kit (the laptop- and CI-side files ship only if the website list
# has them, as the Worker uploads them).
git_ ls-tree --name-only "$full" -- deploy/aws/ | grep -E \
  '^deploy/aws/(install-release\.sh|activate-release\.sh|host-setup\.sh|[a-z@-]+\.(service|timer|sudoers)|zerox-[a-z-]+\.(conf|sh))$' \
  > "$work/kit" || true
grep -qx deploy/aws/host-setup.sh "$work/kit" || die "$ref has no deploy/aws/host-setup.sh"

printf '%s\n' "$release" > "$src/REVISION"
printf '%s\n' REVISION .assetsignore | cat - "$work/site" "$work/gateway" "$work/kit" | sort -u > "$work/list"
# Names that need quoting in git's output (quotes, backslashes, control characters) are not
# shipped; tar would read them differently.
if grep -q '^"' "$work/list"; then die "unsupported file name: $(grep -m1 '^"' "$work/list")"; fi
forbidden='(^|/)(\.env|\.dev\.vars|\.npmrc|id_rsa|id_ed25519|freeapi\.txt|credentials)([.]|$)|\.(pem|key|p12|pfx)$|^(output|tmp|Microsoft)/|(^|/)(\.git|node_modules|\.wrangler)/'
if grep -qE "$forbidden" "$work/list"; then
  die "refusing to ship $(grep -cE "$forbidden" "$work/list") file(s) that look like secrets or working files, e.g. $(grep -m1 -E "$forbidden" "$work/list")"
fi

(cd "$src" && COPYFILE_DISABLE=1 tar -czf - -T "$work/list") > "$out.partial"
mv -f "$out.partial" "$out"
echo "release $release: $(wc -l < "$work/site" | tr -d ' ') site, $(wc -l < "$work/gateway" | tr -d ' ') gateway and $(wc -l < "$work/kit" | tr -d ' ') kit files -> $out" >&2
echo "$release"
