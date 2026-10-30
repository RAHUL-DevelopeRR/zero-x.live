#!/bin/bash
# Host setup for the gateway VM, run by the operator as ubuntu once the first boot is done
# (README.md, "Host setup"), and again whenever the units or the sudoers file change. Safe to
# run again: it only replaces what differs. push-release.sh --setup runs it from the release.
#   sudo bash deploy/aws/host-setup.sh
#
# Installs from this directory:
#   - zerox-gateway@.service, zerox-cron.service and .timer, cloudflared.service;
#   - /etc/sudoers.d/zerox-deploy, checked with visudo before and after; cloud-init's older rule
#     for deploy (restart of the single-instance unit) is removed, so the file is all deploy may
#     run as root, and the run fails if any other sudo rule or an administrators group names deploy;
#   - /etc/sysctl.d/60-zerox.conf (connections queued on a stopping instance move to the other).
# Then: removes the single-instance zerox-gateway.service of the smoke test (it drains first),
# enables zerox-gateway@0 for boot (the unit starts nothing before the first release), and enables
# cloudflared once /etc/cloudflared/token exists. It never enables or starts zerox-cron.timer:
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
if [ -f "$units/zerox-gateway.service" ]; then
  echo "removing the single-instance zerox-gateway.service (it drains first, up to 110 s)"
  systemctl disable --now zerox-gateway.service
  rm -f "$units/zerox-gateway.service"
  changed="$changed $units/zerox-gateway.service"
fi
if [ -L "$sys/opt/zerox/gateway" ]; then rm -f "$sys/opt/zerox/gateway"; fi
for name in zerox-gateway@.service zerox-cron.service zerox-cron.timer cloudflared.service; do
  put "$kit/$name" "$units/$name" 0644
done
if [[ "$changed" == *"$units/"* ]]; then systemctl daemon-reload; fi
systemd-analyze verify zerox-gateway@0.service zerox-cron.service zerox-cron.timer cloudflared.service ||
  fail "systemd-analyze verify found errors in the units above"
systemctl enable zerox-gateway@0.service

# ── Cloudflare Tunnel (README.md, "Cloudflare Tunnel token") ──
token="$sys/etc/cloudflared/token"
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
