#!/bin/bash
# Runs on the VM as the deploy user, from the release it activates: install-release.sh calls it
# after unpacking a release, zerox-gateway-refresh runs it again for the current release after an
# upgrade replaced node or a library the gateway uses, and a manual rollback runs an older
# release's copy (README.md, "Rollback"):
#   bash /opt/zerox/releases/<commit>/deploy/aws/activate-release.sh <commit> [--env <file>]
#
# Swaps the two gateway instances (zerox-gateway@.service) without refusing a connection:
#   1. With --env, that file becomes /etc/zerox/gateway.env and the old one is kept as
#      gateway.env.prev. Without it the environment stays as it is: nothing is picked up from
#      /etc/zerox implicitly. The operator's /etc/zerox/gateway.env.next, passed with --env, is
#      removed once it is live.
#   2. /opt/zerox/instance-N, the link of the idle instance N, points at the release. Each instance
#      runs what its own link names; the serving instance's link and /opt/zerox/current are not
#      touched, so if the serving instance crashes meanwhile, systemd restarts it on its release.
#   3. The idle instance starts and must answer 200 on /ready on its own loopback READY_PORT
#      (879N): plan limits, the session store and the catalog load from the database, so a wrong
#      SUPABASE_SECRET_KEY, a missing RPC or an unreachable database fails here (anonymous
#      /health answers a static ok). Its /health must then report this commit.
#   4. /opt/zerox/current (the cron, operators) flips to the release, and the old instance stops:
#      it drains its streams for up to 110 s while the new one, on the same port (reusePort),
#      takes every new connection. Then its link points at the release too, so either instance,
#      and @0 at boot, starts on the live release.
# A failed check stops the new instance, points its link back and restores the environment; the
# old instance and /opt/zerox/current were never touched, so users see nothing (if nothing was
# running, the previous release is started again). Keeps the current release and the three most
# recently activated others; releases that never went live are removed first.
# Only the systemctl commands in zerox-deploy.sudoers run as root. ZEROX_ROOT and ZEROX_ETC stand
# in for /opt/zerox and /etc/zerox in check-aws-deploy.mjs, which runs this against a temporary
# tree with a stub systemctl and curl.
set -euo pipefail
release="${1:-}"
[[ "$release" =~ ^[0-9a-f]{7}$ ]] || { echo "invalid release id (the commit's first 7 hex digits)"; exit 2; }
shift
env_file=''
while [ $# -gt 0 ]; do
  case "$1" in
    --env) [ $# -ge 2 ] || { echo "--env needs a file"; exit 2; }; env_file="$2"; shift 2 ;;
    *) echo "unknown argument $1 (usage: activate-release.sh <commit> [--env <file>])"; exit 2 ;;
  esac
done
root="${ZEROX_ROOT:-/opt/zerox}"
etc="${ZEROX_ETC:-/etc/zerox}"
dir="$root/releases/$release"
umask 077
[ -f "$dir/neuroncli/auth-server/server.js" ] && [ -d "$dir/neuroncli/auth-server/node_modules" ] &&
  [ "$(cat "$dir/REVISION" 2>/dev/null)" = "$release" ] || { echo "release $release is incomplete"; exit 2; }
if [ -n "$env_file" ] && [ ! -s "$env_file" ]; then echo "no environment file at $env_file"; exit 2; fi

# One deploy at a time (CI, a laptop push and the upgrade refresh could overlap). install-release.sh
# already holds it.
if [ -z "${ZEROX_DEPLOY_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$root/.deploy.lock"
  flock -n 9 || { echo "another deploy is running on this VM"; exit 2; }
fi

# Atomic switch of a symlink: point <target> <link>.
point() { ln -sfn "$1" "$2.next" && mv -Tf "$2.next" "$2"; }
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
link="$root/instance-$new"
previous="$(readlink "$root/current" || true)"
before="$(readlink "$link" || true)"

replaced_env=false
if [ -n "$env_file" ]; then
  # Copied first: --env may name gateway.env.prev itself (putting the previous environment back).
  install -m 0600 "$env_file" "$etc/gateway.env.new"
  if [ -e "$etc/gateway.env" ]; then cp -p "$etc/gateway.env" "$etc/gateway.env.prev"; else : > "$etc/gateway.env.prev"; fi
  mv -f "$etc/gateway.env.new" "$etc/gateway.env"
  replaced_env=true
fi
point "$dir" "$link"
echo "starting zerox-gateway@$new on $release"
if sudo systemctl start "zerox-gateway@$new.service" && ready "$new" "$release"; then
  point "$dir" "$root/current"
  echo "zerox-gateway@$new serves $release; stopping zerox-gateway@$old (its in-flight streams drain first, up to 110 s)"
  sudo systemctl stop "zerox-gateway@$old.service"
  point "$dir" "$root/instance-$old"
  touch "$dir/.activated"   # when the release last went live, for pruning
  if [ "$env_file" = "$etc/gateway.env.next" ]; then rm -f "$env_file"; fi
  echo "release $release is live"
else
  echo "release $release failed its checks; rolling back"
  sudo systemctl stop "zerox-gateway@$new.service" || true
  if [ -n "$before" ]; then point "$before" "$link"; else rm -f "$link"; fi
  if $replaced_env; then cp -p "$etc/gateway.env.prev" "$etc/gateway.env"; fi
  if active "$old"; then
    # Its link was never touched: even restarted after a crash meanwhile, it runs what it ran.
    echo "zerox-gateway@$old never stopped; it serves $(basename "$(readlink "$root/instance-$old" || echo nothing)")"
  elif [ -n "$previous" ]; then
    point "$previous" "$root/instance-$old"
    sudo systemctl start "zerox-gateway@$old.service" && ready "$old" "$(basename "$previous")" &&
      echo "previous release is live again" || true
  fi
  systemctl status --no-pager --lines=20 "zerox-gateway@$new.service" || true
  exit 1
fi

cd "$root/releases"
# Newest activation first; releases never activated (installed, then refused) after them, so they
# go first. .partial-* directories (an install in progress) are not listed. On the first deploys
# grep has nothing left to print and exits 1: not a failure (pipefail).
activated="$(ls -1t -- */.activated 2>/dev/null | sed 's#/\.activated$##' || true)"
printf '%s\n' "$activated" "$(ls -1d -- */ | sed 's#/$##')" | awk 'NF && !seen[$0]++' |
  { grep -vxF "$release" || true; } | tail -n +4 | xargs -r rm -rf --
