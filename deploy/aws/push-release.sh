#!/bin/bash
# Ships a release to the gateway VM through the EC2 Instance Connect Endpoint and activates it:
# no open port, no stored SSH key.
#
# From the laptop (Git Bash on Windows, Linux or macOS; AWS CLI v2 signed in with `aws login`),
# for the smoke test (plan section 2, step 5) and by hand. --setup runs host-setup.sh first;
# --env-next activates the release with the environment file the operator wrote on the VM as
# /etc/zerox/gateway.env.next (README.md, "Environment file"):
#   deploy/aws/push-release.sh --profile zerox [--ref <commit>] [--setup] [--env-next]
# From CI (.github/workflows/deploy.yml, job ec2), as deploy, with the environment file:
#   deploy/aws/push-release.sh --os-user deploy --lookup tags --env-file <file> --known-hosts <file>
#
# 1. package-release.sh builds the tarball from the commit (git archive, never the working tree).
# 2. The instance id comes from the zerox-gateway stack's outputs (laptop), or from the tags
#    CloudFormation puts on the stack's instance (--lookup tags: CI's role may only describe
#    instances), or from --instance-id.
# 3. A key pair is made for this run only; `aws ec2-instance-connect send-ssh-public-key` pushes
#    its public half for one OS user (ubuntu from the laptop, deploy from CI), valid for 60 s.
# 4. One ssh connection, tunnelled by `aws ec2-instance-connect open-tunnel` (ProxyCommand),
#    carries the tarball (and CI's environment file) on stdin and runs install-release.sh as
#    deploy (from ubuntu through sudo -u deploy), which installs and activates the release. CI's
#    environment file stays in the connection's temporary directory (removed at exit) and reaches
#    activate-release.sh as --env, under the deploy lock: a failed install leaves none behind.
#    The host key is checked against --known-hosts under the name zerox-gateway; on the laptop's
#    first connection ssh asks, next to the fingerprints from the instance's console.
# The key pair is deleted at exit. Never sends a secret from the laptop: --env-file is accepted
# only with --os-user deploy (CI writes it from GitHub's production secrets); the operator
# writes the environment file on the VM by hand otherwise (README.md, "Environment file").
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "push-release: $*" >&2; exit 2; }
usage() {
  echo 'usage: push-release.sh [--ref <commit>] [--setup] [--profile <name>] [--region <region>]' >&2
  echo '                       [--instance-id <id> | --lookup stack|tags] [--os-user ubuntu|deploy]' >&2
  echo '                       [--env-file <file> | --env-next] [--known-hosts <file>]' >&2
  exit 2
}
ref=HEAD setup=0 profile="${AWS_PROFILE:-}" region=ap-south-1 instance='' lookup=stack user=ubuntu env_file='' env_next=0
known_hosts="$HOME/.ssh/zerox_known_hosts"
stack=zerox-gateway
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="${2:?}"; shift 2 ;;
    --setup) setup=1; shift ;;
    --profile) profile="${2:?}"; shift 2 ;;
    --region) region="${2:?}"; shift 2 ;;
    --instance-id) instance="${2:?}"; shift 2 ;;
    --lookup) lookup="${2:?}"; shift 2 ;;
    --os-user) user="${2:?}"; shift 2 ;;
    --env-file) env_file="${2:?}"; shift 2 ;;
    --env-next) env_next=1; shift ;;
    --known-hosts) known_hosts="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
case "$user" in ubuntu|deploy) ;; *) die "--os-user is ubuntu (laptop) or deploy (CI)" ;; esac
case "$lookup" in stack|tags) ;; *) die "--lookup is stack or tags" ;; esac
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "invalid region $region"
[[ "$profile" =~ ^[A-Za-z0-9_.-]*$ ]] || die "invalid profile name"
if [ -n "$env_file" ] && [ "$user" != deploy ]; then die "--env-file only with --os-user deploy (CI): the laptop never sends secrets"; fi
if [ -n "$env_file" ] && [ ! -s "$env_file" ]; then die "no environment file at $env_file"; fi
if [ -n "$env_file" ] && [ "$env_next" = 1 ]; then die "--env-file or --env-next, not both"; fi
if [ "$setup" = 1 ] && [ "$user" != ubuntu ]; then die "--setup needs --os-user ubuntu (deploy may not run host-setup.sh)"; fi

aws_() { aws "$@" --region "$region" ${profile:+--profile "$profile"}; }
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

release="$(cd "$here" && bash ./package-release.sh "$ref" "$work/release.tar.gz")"
if [ -n "$env_file" ]; then cp "$env_file" "$work/gateway.env"; fi

if [ -z "$instance" ] && [ "$lookup" = stack ]; then
  instance="$(aws_ cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text | tr -d '\r\n')"
elif [ -z "$instance" ]; then
  instance="$(aws_ ec2 describe-instances --filters "Name=tag:aws:cloudformation:stack-name,Values=$stack" \
    "Name=tag:aws:cloudformation:logical-id,Values=Instance" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text | tr -d '\r' | xargs)"
fi
[[ "$instance" =~ ^i-[0-9a-f]{8,17}$ ]] || die "expected one running instance of stack $stack, found: ${instance:-none}"

ssh_base=(-o "ProxyCommand=aws ec2-instance-connect open-tunnel --instance-id %h --region $region${profile:+ --profile $profile}"
  -o HostKeyAlias=zerox-gateway -o "UserKnownHostsFile=$known_hosts" -o ConnectTimeout=60
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# First connection from this laptop: ssh shows the host key and asks; nothing authenticates
# (no method is offered), so this only records the key under the name zerox-gateway.
if ! ssh-keygen -F zerox-gateway -f "$known_hosts" >/dev/null 2>&1; then
  if [ "$user" != ubuntu ] || [ ! -t 0 ]; then die "no host key for zerox-gateway in $known_hosts (README.md, \"Host key\")"; fi
  echo "First connection: compare the key ssh shows with the instance's console:" >&2
  aws_ ec2 get-console-output --instance-id "$instance" --latest --output text | tr -d '\r' |
    sed -n '/BEGIN SSH HOST KEY FINGERPRINTS/,/END SSH HOST KEY FINGERPRINTS/p' >&2 || true
  mkdir -p "$(dirname "$known_hosts")"
  echo "(the \"Permission denied\" after you answer is expected: this connection only records the key)" >&2
  ssh "${ssh_base[@]}" -o StrictHostKeyChecking=ask -o PubkeyAuthentication=no -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no -o GSSAPIAuthentication=no -o HostbasedAuthentication=no \
    "$user@$instance" true || true
  ssh-keygen -F zerox-gateway -f "$known_hosts" >/dev/null 2>&1 || die "the host key was not accepted"
fi

# Runs on the VM as the OS user (bash -c, with the release id, --setup, the user and the
# environment source, none, file or next, as $1..$4).
remote="$(cat <<'REMOTE'
set -euo pipefail
release="$1" setup="$2" user="$3" env="$4"
etc="${ZEROX_ETC:-/etc/zerox}"
cd /
umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/zerox-push.XXXXXX")"
trap 'rm -rf "$work"' EXIT
tar -xf - -C "$work"
mkdir "$work/kit"
tar -xzf "$work/release.tar.gz" -C "$work/kit" deploy/aws
kit="$work/kit/deploy/aws"
if [ "$setup" = 1 ]; then sudo bash "$kit/host-setup.sh"; fi
env_args=()
case "$env" in
  file) env_args=(--env "$work/gateway.env") ;;
  next) env_args=(--env "$etc/gateway.env.next") ;;
esac
if [ "$user" = deploy ]; then
  bash "$kit/install-release.sh" "$work/release.tar.gz" "$release" "${env_args[@]}" < /dev/null
else
  if [ -e "$work/gateway.env" ]; then echo "an environment file only comes from CI, as deploy" >&2; exit 2; fi
  # deploy reads the tarball and the scripts (public code, no secret) from ubuntu's directory.
  chmod 0711 "$work"
  chmod -R a+rX "$work/kit" "$work/release.tar.gz"
  sudo -u deploy bash "$kit/install-release.sh" "$work/release.tar.gz" "$release" "${env_args[@]}" < /dev/null
fi
REMOTE
)"

ssh-keygen -q -t ed25519 -N '' -C "zerox-push-$release" -f "$work/key"
echo "pushing release $release ($(git -C "$here" log -1 --format=%s "$release" | head -c 72)) to $instance as $user" >&2
aws_ ec2-instance-connect send-ssh-public-key --instance-id "$instance" --instance-os-user "$user" \
  --ssh-public-key "$(cat "$work/key.pub")" --query Success --output text | tr -d '\r' | grep -qx True ||
  die "send-ssh-public-key was refused"
payload=(release.tar.gz) env_source=none
if [ -n "$env_file" ]; then payload+=(gateway.env) env_source=file; elif [ "$env_next" = 1 ]; then env_source=next; fi
tar -cf - -C "$work" "${payload[@]}" |
  ssh "${ssh_base[@]}" -i "$work/key" -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
    -o StrictHostKeyChecking=yes "$user@$instance" "bash -c $(printf %q "$remote") zerox-push $release $setup $user $env_source"
echo "release $release is live on $instance" >&2
