#!/bin/bash
# /usr/local/sbin/zerox-gateway-refresh (root, 0755), installed by host-setup.sh and run as root
# by zerox-gateway-refresh.service, which apt starts after every dpkg run (zerox-apt-refresh.conf).
#
# needrestart never restarts a gateway instance (zerox-needrestart.conf): a restart closes the
# only listener for the whole drain. Instead, when a running instance maps a system file that an
# upgrade replaced on disk (the node binary from NodeSource, or libc, libstdc++ and the like show
# as "<path> (deleted)" in /proc/<pid>/maps), the current release is activated again, as deploy,
# by activate-release.sh: the idle instance starts on the new files and must pass /ready before
# the old one drains. Nothing replaced: nothing happens. A deploy running at the same time holds
# the lock (this run then fails, logged); it starts its new instance on the new files anyway.
# Reading another user's /proc/<pid>/maps needs root, which is all this runs as root for.
# ZEROX_ROOT and ZEROX_PROC stand in for /opt/zerox and /proc in check-aws-deploy.mjs.
set -euo pipefail
root="${ZEROX_ROOT:-/opt/zerox}"
proc="${ZEROX_PROC:-/proc}"
stale=''
for n in 0 1; do
  pid="$(systemctl show --property MainPID --value "zerox-gateway@$n.service" 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
  # Only files under /usr count: V8's anonymous memory (/memfd:...) also shows as deleted.
  if grep -qE ' /usr/[^ ]+ \(deleted\)$' "$proc/$pid/maps" 2>/dev/null; then stale="$stale zerox-gateway@$n"; fi
done
if [ -z "$stale" ]; then echo "zerox-gateway: no replaced file in use"; exit 0; fi
[ -e "$root/current" ] || { echo "zerox-gateway:$stale use a replaced file, but there is no current release"; exit 1; }
dir="$(cd "$root/current" && pwd -P)"
release="$(cat "$dir/REVISION")"
echo "zerox-gateway:$stale use a replaced file; activating release $release again"
exec runuser -u deploy -- bash "$dir/deploy/aws/activate-release.sh" "$release"
