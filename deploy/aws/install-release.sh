#!/bin/bash
# Runs on the VM as the deploy user (push-release.sh runs it from the tarball's own deploy/aws,
# for the laptop and for CI):
#   bash install-release.sh <release.tar.gz> <commit>
# Unpacks a release tarball (package-release.sh) into /opt/zerox/releases/<commit>, installs its
# production dependencies, then hands over to that release's activate-release.sh. The release is
# unpacked into .partial-<commit> and renamed only once complete, so a failed install never
# leaves a release that looks usable, and the live release is never touched. A release already
# installed (the same commit deployed again, for a new environment) is reused as it is.
#
# Dependencies: `npm ci --omit=dev --ignore-scripts` from the release's package-lock.json (npm
# checks every package's integrity hash), as deploy, without install scripts. The production
# dependencies are plain JavaScript, so nothing is built for arm64. npm's cache in ~deploy/.npm
# makes a redeploy of the same lockfile work offline. Files end up readable by the zerox group
# only (/opt/zerox/releases is setgid zerox), and deploy keeps write access.
set -euo pipefail
tarball="${1:-}"
release="${2:-}"
[[ "$release" =~ ^[0-9a-f]{7}$ ]] || { echo "invalid release id (the commit's first 7 hex digits)"; exit 2; }
[ -f "$tarball" ] || { echo "no release tarball at $tarball"; exit 2; }
root="${ZEROX_ROOT:-/opt/zerox}"
dir="$root/releases/$release"
partial="$root/releases/.partial-$release"

# One deploy at a time; activate-release.sh inherits the lock.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$root/.deploy.lock"
  flock -n 9 || { echo "another deploy is running on this VM"; exit 2; }
  export ZEROX_DEPLOY_LOCKED=1
fi

if [ -f "$dir/.installed" ]; then
  echo "release $release is already installed; activating it again"
else
  [ "$(readlink "$root/current" || true)" != "$dir" ] || { echo "release $release is live but incomplete; not touching it"; exit 2; }
  rm -rf -- "$dir" "$partial"
  mkdir -p -- "$partial"
  tar -xzf - -C "$partial" < "$tarball"
  revision="$(head -c 40 "$partial/REVISION" 2>/dev/null | tr -d '\n' || true)"
  if [ "$revision" != "$release" ]; then
    rm -rf -- "$partial"
    echo "the tarball is not release $release (its REVISION: ${revision:-none})"
    exit 2
  fi
  echo "installing the production dependencies of $release (npm ci --omit=dev)"
  (cd "$partial/neuroncli/auth-server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error) < /dev/null
  chmod -R u=rwX,g=rX,o= -- "$partial"
  touch "$partial/.installed"
  mv -T -- "$partial" "$dir"
fi
exec bash "$dir/deploy/aws/activate-release.sh" "$release"
