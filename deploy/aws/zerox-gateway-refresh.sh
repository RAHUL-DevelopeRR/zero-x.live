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
# Reading another user's /proc/<pid>/maps needs root, which is all this runs as root for. Root
# never opens a file under /opt/zerox, which deploy owns: the release id is the name of the
# directory /opt/zerox/current resolves to, checked to be a release directory, never REVISION's
# contents (which deploy could link to the tunnel token or a host key, for root to print to the
# journal and pass on as an argument). activate-release.sh, running as deploy, checks REVISION.
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
[ -e "$root/current" ] || { echo "replaced file in use by$stale, but there is no current release"; exit 1; }
# Both resolved the same way (cd, then the physical path), so links anywhere in them compare equal.
dir="$(cd -- "$root/current" 2>/dev/null && pwd -P || true)"
releases="$(cd -- "$root/releases" 2>/dev/null && pwd -P || true)"
release="${dir##*/}"
if ! [[ "$release" =~ ^[0-9a-f]{7}$ ]] || [ "$dir" != "$releases/$release" ]; then
  echo "replaced file in use by$stale, but $root/current does not name a release in $root/releases; nothing done"
  exit 1
fi
echo "replaced file in use by$stale; activating release $release again"
exec runuser -u deploy -- bash "$dir/deploy/aws/activate-release.sh" "$release"
