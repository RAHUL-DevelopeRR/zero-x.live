#!/bin/bash
# Host setup for the gateway VM, run by the operator as ubuntu once the first boot is done
# (README.md, "Host setup"), and again whenever the units or the sudoers file change. Safe to
# run again: it only replaces what differs. push-release.sh --setup runs it from the release.
#   sudo bash deploy/aws/host-setup.sh
#
# Installs from this directory:
#   - zerox-gateway@.service, zerox-cron.service and .timer, cloudflared.service (once
#     /etc/cloudflared/token exists, if a tunnel already runs from a unit of its own);
#   - /etc/sudoers.d/zerox-deploy, checked with visudo before and after; cloud-init's older rule
#     for deploy (restart of the single-instance unit) is removed, so the file is all deploy may
#     run as root, and the run fails if any other sudo rule or an administrators group names deploy;
#   - /etc/sysctl.d/60-zerox.conf (connections queued on a stopping instance move to the other);
#   - upgrades without a gap: needrestart never restarts a gateway instance
#     (/etc/needrestart/conf.d/60-zerox-gateway.conf); instead apt starts
#     zerox-gateway-refresh.service after each dpkg run (/etc/apt/apt.conf.d/80zerox-gateway-refresh),
#     which runs /usr/local/sbin/zerox-gateway-refresh, a root-owned copy of zerox-gateway-refresh.sh;
#   - /usr/local/sbin/zerox-install-env, root's copy of zerox-install-env.sh, through which alone
#     deploy changes the environment file.
# The environment becomes root's: /etc/zerox and its files root:root, 0700 and 0600 (the first
# boot made them deploy's, and cloud-init is not edited: that would replace the instance). A link
# found there fails the run, since only deploy could have put it there. Every file under
# /opt/zerox/releases becomes deploy's (the smoke test installed its release by hand), so pruning
# old releases never fails on one.
# Then: removes the single-instance zerox-gateway.service of the smoke test (it drains first) and
# its /opt/zerox/gateway link, enables zerox-gateway@0 for boot (the unit starts nothing before
# the first release), and enables cloudflared once /etc/cloudflared/token exists. It never
# enables or starts zerox-cron.timer:
# the Worker's cron owns that schedule until the cutover's cron step (CUTOVER.md, step 5). It
# restarts nothing that runs: changed gateway units take effect at the next deploy, a changed
# cloudflared unit at a restart by hand (it cuts the tunnel's streams). ZEROX_SYSROOT (tests only)
# prefixes every path it reads or writes.
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo bash "$0" "$@"; fi
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sys="${ZEROX_SYSROOT:-}"
units="$sys/etc/systemd/system"
fail() { echo "host-setup: $*" >&2; exit 1; }

# ── What the first boot (cloud-init's zerox-bootstrap) leaves behind ──
for user in zerox deploy; do id "$user" >/dev/null 2>&1 || fail "user $user is missing: the first boot did not finish (README.md, \"First boot\")"; done
[ -d "$sys/opt/zerox/releases" ] && [ -d "$sys/etc/zerox" ] || fail "/opt/zerox/releases or /etc/zerox is missing: run sudo /usr/local/sbin/zerox-bootstrap"
# reusePort (two instances on one port) needs Node 22.12 or later.
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' ||
  fail "node $(node --version) is older than 22.12"

changed=""
# put <kit file> <target> <mode>: installs the file when its content differs.
put() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then return 0; fi
  install -D -m "$3" "$1" "$2"
  changed="$changed $2"
  echo "installed $2"
}

# ── The environment file: root's. systemd reads it as root; deploy hands new ones to
# zerox-install-env (sudoers) and never touches /etc/zerox itself ──
envdir="$sys/etc/zerox"
[ ! -L "$envdir" ] || fail "$envdir is a link; check what it names, then replace it with a directory"
# The directory first: from here on deploy can neither add an entry nor open one.
chown root:root "$envdir"
chmod 0700 "$envdir"
links="$(find "$envdir" -mindepth 1 -type l -printf '%p\n' 2>/dev/null || true)"
[ -z "$links" ] || fail "links in /etc/zerox, which only deploy could have made: $(echo $links); check what they name, remove them and write the environment again"
chown -hR root:root "$envdir"
find "$envdir" -mindepth 1 -type f -exec chmod 0600 {} +
put "$kit/zerox-install-env.sh" "$sys/usr/local/sbin/zerox-install-env" 0755

# ── Releases: deploy's, all of them (pruning removes them as deploy). -execdir and -h: root
# changes each entry from inside the directory find opened, never through a path deploy could
# turn into a link meanwhile ──
deploy_uid="$(id -u deploy)"
find "$sys/opt/zerox/releases" -mindepth 1 ! -uid "$deploy_uid" -execdir chown -h deploy:zerox {} +

# ── Kernel setting ──
put "$kit/zerox-sysctl.conf" "$sys/etc/sysctl.d/60-zerox.conf" 0644
sysctl -q -p "$sys/etc/sysctl.d/60-zerox.conf"

# ── sudo: deploy may run exactly the commands in zerox-deploy.sudoers ──
# sudo skips files in /etc/sudoers.d whose name contains a dot, so the .new and .zerox copies
# below are never read before they are checked and renamed.
visudo -cqf "$kit/zerox-deploy.sudoers" || fail "zerox-deploy.sudoers does not parse; nothing changed"
rules="$sys/etc/sudoers.d/zerox-deploy"
if ! { [ -f "$rules" ] && cmp -s "$kit/zerox-deploy.sudoers" "$rules"; }; then
  install -m 0440 "$kit/zerox-deploy.sudoers" "$rules.new"
  [ -f "$rules" ] && cp -p "$rules" "$rules.old"
  mv -f "$rules.new" "$rules"
  if ! visudo -cq; then
    if [ -f "$rules.old" ]; then mv -f "$rules.old" "$rules"; else rm -f "$rules"; fi
    fail "the sudo configuration does not parse with zerox-deploy; put back as it was"
  fi
  rm -f "$rules.old"
  echo "installed $rules"
fi
cloud="$sys/etc/sudoers.d/90-cloud-init-users"
if [ -f "$cloud" ] && grep -q '^deploy[[:space:]]' "$cloud"; then
  grep -v '^deploy[[:space:]]' "$cloud" > "$cloud.zerox" || true
  chmod 0440 "$cloud.zerox"
  visudo -cqf "$cloud.zerox" || { rm -f "$cloud.zerox"; fail "90-cloud-init-users without the deploy rule does not parse; unchanged"; }
  mv -f "$cloud.zerox" "$cloud"
  visudo -cq || fail "the sudo configuration does not parse after editing 90-cloud-init-users"
  echo "removed cloud-init's sudo rule for deploy (zerox-deploy replaces it)"
fi
others="$(grep -rlE '^[[:space:]]*deploy[[:space:]]' "$sys/etc/sudoers" "$sys/etc/sudoers.d" 2>/dev/null | grep -vxF "$rules" || true)"
[ -z "$others" ] || fail "other sudo rules name deploy: $others"
if id -nG deploy | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then fail "deploy is in an administrators group"; fi

# ── Units ──
# The smoke test's single unit, by its file here or running from wherever it was installed:
# activate-release.sh refuses to deploy while it runs or its /opt/zerox/gateway link is left.
if [ -f "$units/zerox-gateway.service" ] || systemctl is-active --quiet zerox-gateway.service; then
  echo "removing the single-instance zerox-gateway.service (it drains first, up to 110 s)"
  systemctl disable --now zerox-gateway.service
  rm -f "$units/zerox-gateway.service"
  changed="$changed $units/zerox-gateway.service"
fi
if [ -L "$sys/opt/zerox/gateway" ]; then rm -f "$sys/opt/zerox/gateway"; fi
# The refresh unit's script first (systemd-analyze verify checks that ExecStart exists).
put "$kit/zerox-gateway-refresh.sh" "$sys/usr/local/sbin/zerox-gateway-refresh" 0755
for name in zerox-gateway@.service zerox-cron.service zerox-cron.timer zerox-gateway-refresh.service; do
  put "$kit/$name" "$units/$name" 0644
done
# The kit's cloudflared.service reads its token from /etc/cloudflared/token. A tunnel that already
# runs from a unit of its own (the smoke test's: `cloudflared service install` puts the token on
# that unit's command line) keeps it until the file exists; replaced earlier, the next restart or
# reboot would start the tunnel without a token and take every hostname behind it down.
token="$sys/etc/cloudflared/token"
if [ ! -s "$token" ] && { [ -f "$units/cloudflared.service" ] || systemctl is-active --quiet cloudflared.service; }; then
  echo "keeping the cloudflared.service that runs now: write $token (README.md, \"Cloudflare Tunnel\"), then run this again"
else
  put "$kit/cloudflared.service" "$units/cloudflared.service" 0644
fi
if [[ "$changed" == *"$units/"* ]]; then systemctl daemon-reload; fi
systemd-analyze verify zerox-gateway@0.service zerox-cron.service zerox-cron.timer cloudflared.service zerox-gateway-refresh.service ||
  fail "systemd-analyze verify found errors in the units above"
systemctl enable zerox-gateway@0.service

# ── Upgrades: needrestart leaves the gateway alone; apt starts the refresh after each dpkg run.
# The hook last, once the unit it starts is in place. ──
put "$kit/zerox-needrestart.conf" "$sys/etc/needrestart/conf.d/60-zerox-gateway.conf" 0644
put "$kit/zerox-apt-refresh.conf" "$sys/etc/apt/apt.conf.d/80zerox-gateway-refresh" 0644

# ── Cloudflare Tunnel (README.md, "Cloudflare Tunnel token"; $token is set with the units above) ──
if [ -s "$token" ]; then
  chown root:root "$token"
  chmod 0600 "$token"
  systemctl enable cloudflared.service
  if ! systemctl is-active --quiet cloudflared.service; then systemctl start cloudflared.service
  elif [[ "$changed" == *cloudflared.service* ]]; then
    echo "cloudflared.service changed: restart it at a quiet hour (sudo systemctl restart cloudflared; it cuts open streams)"
  fi
else
  echo "no tunnel token yet: write /etc/cloudflared/token (README.md, \"Cloudflare Tunnel token\"), then run this again"
fi

if [[ "$changed" == *zerox-gateway* ]] && { systemctl is-active --quiet zerox-gateway@0.service || systemctl is-active --quiet zerox-gateway@1.service; }; then
  echo "the gateway unit changed: it takes effect at the next deploy (or activate the current release again)"
fi
echo "zerox-cron.timer: $(systemctl is-enabled zerox-cron.timer 2>/dev/null || echo disabled) (enabled only at the cutover's cron step)"
echo "host setup: ok"
