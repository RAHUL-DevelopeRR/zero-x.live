#!/bin/bash
# Runs on the VM as the deploy user, from the release it activates: install-release.sh calls it
# after unpacking a release, and a manual rollback runs an older release's copy (README.md,
# "Rollback"):
#   bash /opt/zerox/releases/<commit>/deploy/aws/activate-release.sh <commit>
#
# Swaps the two gateway instances (zerox-gateway@.service) without refusing a connection:
#   1. /etc/zerox/gateway.env.next (a new environment from CI), when there is one, becomes
#      gateway.env; the old one is kept as gateway.env.prev.
#   2. /opt/zerox/current flips to the release. The unit's paths go through that symlink and are
#      resolved when a process starts, so the flip comes first: the running instance keeps the
#      release it started on, the next one starts on the new one.
#   3. The idle instance starts and must answer 200 on /ready on its own loopback READY_PORT
#      (879N): plan limits, the session store and the catalog load from the database, so a wrong
#      SUPABASE_SECRET_KEY, a missing RPC or an unreachable database fails here (anonymous
#      /health answers a static ok). Its /health must then report this commit.
#   4. The old instance stops: it drains its streams for up to 110 s while the new one, on the
#      same port (reusePort), takes every new connection.
# A failed check stops the new instance and puts the previous release and environment back; the
# old instance never stopped, so users see nothing (if nothing was running, the previous release
# is started again). Keeps the current release and the three most recently activated others.
# Only the systemctl commands in zerox-deploy.sudoers run as root. ZEROX_ROOT and ZEROX_ETC stand
# in for /opt/zerox and /etc/zerox in check-aws-deploy.mjs, which runs this against a temporary
# tree with a stub systemctl and curl.
set -euo pipefail
release="${1:-}"
[[ "$release" =~ ^[0-9a-f]{7}$ ]] || { echo "invalid release id (the commit's first 7 hex digits)"; exit 2; }
root="${ZEROX_ROOT:-/opt/zerox}"
etc="${ZEROX_ETC:-/etc/zerox}"
dir="$root/releases/$release"
[ -f "$dir/neuroncli/auth-server/server.js" ] && [ -d "$dir/neuroncli/auth-server/node_modules" ] &&
  [ "$(cat "$dir/REVISION" 2>/dev/null)" = "$release" ] || { echo "release $release is incomplete"; exit 2; }

# One deploy at a time (CI and a laptop push could overlap). install-release.sh already holds it.
if [ -z "${ZEROX_DEPLOY_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$root/.deploy.lock"
  flock -n 9 || { echo "another deploy is running on this VM"; exit 2; }
fi

previous="$(readlink "$root/current" || true)"
# Atomic switch of the /opt/zerox/current symlink.
point() { ln -sfn "$1" "$root/current.next" && mv -Tf "$root/current.next" "$root/current"; }
active() { systemctl is-active --quiet "zerox-gateway@$1.service"; }
# Up to 30 polls 2 s apart, each at most 3 s: 60 to 150 s after the start returned. Then the
# instance's /health must report the commit it was started for.
ready() {
  local instance="$1" commit="$2" code=none health
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:879$instance/ready" || true)"
    [ "$code" = 200 ] && break
    sleep 2
  done
  if [ "$code" != 200 ]; then echo "zerox-gateway@$instance readiness check: HTTP $code"; return 1; fi
  health="$(curl -s --max-time 3 "http://127.0.0.1:879$instance/health" || true)"
  if [[ "$health" =~ \"commit\":\ ?\"([0-9a-f]+)\" ]] && [ "${BASH_REMATCH[1]}" = "$commit" ]; then return 0; fi
  echo "zerox-gateway@$instance is ready but its /health reports ${health:0:200}, not commit $commit"
  return 1
}

# The instance that serves now is "old"; the other one takes the release.
if active 0 && active 1; then
  # An earlier run stopped half way: @0 keeps serving while @1 is retired (it drains first).
  echo "both instances are running; stopping zerox-gateway@1 before the swap"
  sudo systemctl stop zerox-gateway@1.service
  new=1 old=0
elif active 0; then new=1 old=0
else new=0 old=1   # @1 serves, or nothing does (first deploy, or after a crash or a reboot)
fi

replaced_env=false
if [ -f "$etc/gateway.env.next" ]; then
  if [ -s "$etc/gateway.env" ]; then cp -p "$etc/gateway.env" "$etc/gateway.env.prev"; fi
  mv -f "$etc/gateway.env.next" "$etc/gateway.env"
  replaced_env=true
fi
point "$dir"
touch "$dir"   # the most recently activated release, for pruning
echo "starting zerox-gateway@$new on $release"
if sudo systemctl start "zerox-gateway@$new.service" && ready "$new" "$release"; then
  echo "zerox-gateway@$new serves $release; stopping zerox-gateway@$old (its in-flight streams drain first, up to 110 s)"
  sudo systemctl stop "zerox-gateway@$old.service"
  echo "release $release is live"
else
  echo "release $release failed its checks; rolling back to ${previous:-nothing}"
  sudo systemctl stop "zerox-gateway@$new.service" || true
  if $replaced_env && [ -f "$etc/gateway.env.prev" ]; then cp -p "$etc/gateway.env.prev" "$etc/gateway.env"; fi
  if [ -z "$previous" ]; then
    rm -f "$root/current"   # first release: nothing for zerox-gateway@0 to start at boot
  else
    point "$previous"
    if active "$old"; then
      echo "previous release is live again (zerox-gateway@$old never stopped)"
    else
      sudo systemctl start "zerox-gateway@$old.service" && ready "$old" "$(basename "$previous")" &&
        echo "previous release is live again" || true
    fi
  fi
  systemctl status --no-pager --lines=20 "zerox-gateway@$new.service" || true
  exit 1
fi

cd "$root/releases"
# Newest first by activation; .partial-* directories (an install in progress) are not listed.
# On the first deploys grep has nothing left to print and exits 1: not a failure (pipefail).
ls -1dt -- */ | sed 's#/$##' | { grep -vxF "$release" || true; } | tail -n +4 | xargs -r rm -rf --
