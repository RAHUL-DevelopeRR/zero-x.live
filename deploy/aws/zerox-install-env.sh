#!/bin/bash
# /usr/local/sbin/zerox-install-env (root, 0755), installed by host-setup.sh. The only way the
# deploy user changes the gateway's environment; zerox-deploy.sudoers allows exactly these forms:
#   sudo /usr/local/sbin/zerox-install-env install < <file>   the new file, on stdin (CI's, through
#                                                             activate-release.sh --env <file>)
#   sudo /usr/local/sbin/zerox-install-env next               the operator's /etc/zerox/gateway.env.next
#                                                             (activate-release.sh --env-next)
#   sudo /usr/local/sbin/zerox-install-env restore            gateway.env.prev back (a failed activation)
#
# Why root: systemd reads /etc/zerox/gateway.env as root (PID 1) for both gateway instances and
# the cron. Owning the file or its directory, deploy could replace the file with a link to a file
# only root may read (the tunnel token, a host key) and have its lines put into the gateway's
# environment, or into the journal, where systemd logs the lines it refuses. So /etc/zerox and its
# files are root's (host-setup.sh), and this script never opens a path deploy controls: the new
# file comes on stdin, which deploy opened.
#
# install and next check every line before anything changes: a comment, a blank line, or
# NAME="value" as gateway-env.mjs writes it (\ " ` $ escaped), or NAME=value with plain characters
# only; printable ASCII; never a name gateway-env.mjs refuses (the same rule, kept in step by
# check-aws-deploy.mjs). Then the live file is kept as gateway.env.prev and the new one is renamed
# into place, both inside this root-owned directory, so nothing follows a link and no instance ever
# reads half a file. Only names and line numbers are ever printed, never values. ZEROX_ETC stands
# in for /etc/zerox in check-aws-deploy.mjs (sudo's env_reset keeps it from deploy on the VM).
set -euo pipefail
export LC_ALL=C
umask 077
etc="${ZEROX_ETC:-/etc/zerox}"
live="$etc/gateway.env"
fail() { echo "zerox-install-env: $*; nothing changed" >&2; exit 2; }

# gateway-env.mjs's refusedName: the unit's own settings, the Worker-only and development-only
# names, and the families that change how Node loads or connects.
refused() {
  case "$1" in
    NODE_*|LD_*|BASH_*|*_PROXY|E2E_*|TRUST_*) return 0 ;;
    NODE_ENV|AUTH_HOST|AUTH_PORT|AUTH_REUSE_PORT|READY_PORT|READY_TIMEOUT_MS|ASSETS_DIR|NEURON_API_ONLY|SHUTDOWN_GRACE_MS|GIT_COMMIT) return 0 ;;
    EC2_PROXY_PREFIXES|EC2_PROXY_ORIGIN) return 0 ;;
    DEV_AUTH_ENABLED|ALLOW_ANONYMOUS_SESSIONS|ALLOW_UNKNOWN_COUNTRY|DATABASE_DRIVER|PGLITE_DATA_DIR|ALLOW_LOCAL_DATABASE|RAZORPAY_API_BASE|NEURON_RUNTIME) return 0 ;;
  esac
  return 1
}

quoted='^([A-Z][A-Z0-9_]{0,63})="(([^"\\`$]|\\["\\`$])*)"$'
plain='^([A-Z][A-Z0-9_]{0,63})=([A-Za-z0-9_./:,@+=-]*)$'
check() {
  local file="$1" line n=0 name names=''
  [ -s "$file" ] || fail "the new environment is empty"
  # Byte by byte (tr), so a carriage return or a NUL counts too, on every grep.
  [ "$(tr -d '\040-\176\n' < "$file" | wc -c)" -eq 0 ] || fail "the new environment has a character other than printable ASCII (a CR, a tab, a non-ASCII letter)"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" =~ $quoted ]] || [[ "$line" =~ $plain ]]; then name="${BASH_REMATCH[1]}"
    else fail "line $n is not NAME=\"value\" (deploy/aws/gateway.env.example)"; fi
    if refused "$name"; then names="$names $name"; fi
  done < "$file"
  # Every refused name at once, so one run says what to take out.
  [ -z "$names" ] || fail "not allowed in the gateway's environment (gateway-env.mjs):$names"
}

[ -d "$etc" ] && [ ! -L "$etc" ] || fail "$etc is not a directory"
for path in "$live" "$live.prev" "$live.next"; do
  [ ! -L "$path" ] || fail "$path is a link (host-setup.sh refuses those too)"
done
new="$(mktemp "$etc/.gateway.env.XXXXXX")"
keep="$(mktemp "$etc/.gateway.env.prev.XXXXXX")"
trap 'rm -f "$new" "$keep"' EXIT

case "${1:-}" in
  install)
    head -c 65537 > "$new"
    [ "$(wc -c < "$new")" -le 65536 ] || fail "the new environment is larger than 64 KiB"
    check "$new"
    ;;
  next)
    [ -f "$live.next" ] || fail "there is no $live.next (README.md, \"Environment file\")"
    cat "$live.next" > "$new"
    check "$new"
    ;;
  restore)
    [ -f "$live.prev" ] || fail "there is no $live.prev to put back"
    cat "$live.prev" > "$new"
    mv -Tf "$new" "$live"
    echo "the previous environment is back"
    exit 0
    ;;
  *) echo "usage: zerox-install-env install|next|restore" >&2; exit 2 ;;
esac
if [ -f "$live" ]; then cat "$live" > "$keep"; fi
mv -Tf "$keep" "$live.prev"
mv -Tf "$new" "$live"
echo "new environment installed ($(grep -c '^[A-Z]' "$live") variables); the previous one is gateway.env.prev"
