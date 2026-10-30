#!/bin/bash
# Runs on the VM as the deploy user (.github/workflows/deploy-oracle.yml pipes it over SSH):
#   ssh zerox bash -s -- <release id> < deploy/aws/activate-release.sh
# Makes /opt/zerox/releases/<release id> current with /etc/zerox/gateway.env.next (when there is
# one) as its environment, restarts zerox-gateway (in-flight streams drain first, up to 110 s)
# and checks /ready on loopback: plan limits, the session store and the catalog load from the
# database, so a wrong SUPABASE_SECRET_KEY, a missing RPC or an unreachable database fails here
# (anonymous /health answers a static ok). A failed check puts the previous release and
# environment back and exits 1. Keeps the current release and the three newest others; older
# ones are deleted. ZEROX_ROOT and ZEROX_ETC stand in for /opt/zerox and /etc/zerox in
# check-aws-deploy.mjs, which runs this script against a temporary tree.
set -euo pipefail
release="${1:-}"
[[ "$release" =~ ^[0-9]{14}-[0-9a-f]{12}$ ]] || { echo "invalid release id"; exit 2; }
root="${ZEROX_ROOT:-/opt/zerox}"
etc="${ZEROX_ETC:-/etc/zerox}"
dir="$root/releases/$release"
[ -f "$dir/server.js" ] && [ -d "$dir/node_modules" ] || { echo "release $release is incomplete"; exit 2; }
previous="$(readlink "$root/gateway" || true)"

# Atomic switch of the /opt/zerox/gateway symlink.
point() { ln -sfn "$1" "$root/gateway.next" && mv -Tf "$root/gateway.next" "$root/gateway"; }
# Up to 30 polls 2 s apart, each at most 3 s: 60 to 150 s after the restart returned.
ready() {
  local code=none
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/ready || true)"
    [ "$code" = 200 ] && return 0
    sleep 2
  done
  echo "readiness check: HTTP $code"
  return 1
}

replaced_env=false
if [ -f "$etc/gateway.env.next" ]; then
  if [ -s "$etc/gateway.env" ]; then cp -p "$etc/gateway.env" "$etc/gateway.env.prev"; fi
  mv -f "$etc/gateway.env.next" "$etc/gateway.env"
  replaced_env=true
fi
point "$dir"
echo "restarting zerox-gateway on $release (in-flight streams drain first, up to 110 s)"
if sudo systemctl restart zerox-gateway.service && ready; then
  echo "release $release is live"
else
  echo "release $release failed its readiness check; rolling back to ${previous:-nothing}"
  if $replaced_env && [ -f "$etc/gateway.env.prev" ]; then cp -p "$etc/gateway.env.prev" "$etc/gateway.env"; fi
  if [ -n "$previous" ]; then
    point "$previous"
    sudo systemctl restart zerox-gateway.service && ready && echo "previous release is live again" || true
  fi
  systemctl status zerox-gateway.service --no-pager --lines=0 || true
  exit 1
fi

cd "$root/releases"
# On the first deploy grep has nothing left to print and exits 1: not a failure (pipefail).
ls -1d -- */ | sed 's#/$##' | sort -r | { grep -vxF "$release" || true; } | tail -n +4 | xargs -r rm -rf --
