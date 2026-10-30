#!/bin/bash
# Runs on the VM as the deploy user (.github/workflows/deploy-oracle.yml pipes it over SSH):
#   ssh zerox bash -s -- <release id> < deploy/oracle/activate-release.sh
# Makes /opt/zerox/releases/<release id> current with /etc/zerox/gateway.env.next as its
# environment, restarts zerox-gateway (in-flight streams drain first, up to 110 s) and checks
# /health on loopback. A failed check puts the previous release and environment back and exits
# 1. Keeps the current release and the three newest others; older ones are deleted.
set -euo pipefail
release="${1:-}"
[[ "$release" =~ ^[0-9]{14}-[0-9a-f]{12}$ ]] || { echo "invalid release id"; exit 2; }
root=/opt/zerox
dir="$root/releases/$release"
[ -f "$dir/server.js" ] && [ -d "$dir/node_modules" ] || { echo "release $release is incomplete"; exit 2; }
previous="$(readlink "$root/gateway" || true)"

# Atomic switch of the /opt/zerox/gateway symlink.
point() { ln -sfn "$1" "$root/gateway.next" && mv -Tf "$root/gateway.next" "$root/gateway"; }
healthy() {
  local code=none
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8787/health || true)"
    [ "$code" = 200 ] && return 0
    sleep 2
  done
  echo "health check: HTTP $code"
  return 1
}

if [ -f /etc/zerox/gateway.env.next ]; then
  if [ -s /etc/zerox/gateway.env ]; then cp -p /etc/zerox/gateway.env /etc/zerox/gateway.env.prev; fi
  mv -f /etc/zerox/gateway.env.next /etc/zerox/gateway.env
fi
point "$dir"
echo "restarting zerox-gateway on $release (in-flight streams drain first, up to 110 s)"
if sudo systemctl restart zerox-gateway.service && healthy; then
  echo "release $release is live"
else
  echo "release $release failed its health check; rolling back to ${previous:-nothing}"
  if [ -f /etc/zerox/gateway.env.prev ]; then cp -p /etc/zerox/gateway.env.prev /etc/zerox/gateway.env; fi
  if [ -n "$previous" ]; then
    point "$previous"
    sudo systemctl restart zerox-gateway.service && healthy && echo "previous release is live again" || true
  fi
  systemctl status zerox-gateway.service --no-pager --lines=0 || true
  exit 1
fi

cd "$root/releases"
ls -1d -- */ | sed 's#/$##' | sort -r | grep -vxF "$release" | tail -n +4 | xargs -r rm -rf --
