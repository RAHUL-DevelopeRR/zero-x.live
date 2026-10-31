# Zero-X gateway on AWS (EC2, ap-south-1)

One Ubuntu 24.04 arm64 VM (t4g.small) runs the Node gateway (`neuroncli/auth-server/server.js`): the
website, sign-in, accounts, `/v1` streams, billing and admin, as two systemd instances that take
turns on every deploy. Users reach it only through Cloudflare Tunnel, which dials out from the VM;
during the Phase 1 cutover the Worker forwards to it ([CUTOVER.md](CUTOVER.md)). Admin and CI SSH
reach it only through an EC2 Instance Connect Endpoint, so no port faces the internet.

| File | What it is |
|---|---|
| `gateway-vm.yaml` | CloudFormation stack `zerox-gateway`: key pair, two security groups, the endpoint, the launch template (cloud-init) and the instance. No IAM resources. |
| `stack-policy.json` | Denies replacing or deleting the instance, the endpoint and the key pair, until lifted for a planned change. |
| `ci-role.yaml` | Stack `zerox-ci`: the GitHub OIDC provider and the role `zerox-github-deploy` for job `ec2` of `deploy.yml` ("CI role" below). |
| `host-setup.sh` | Run once as `ubuntu` after the first boot, and again after kit changes: units, deploy sudoers, kernel setting, upgrade handling, cloudflared. Never enables the cron timer. |
| `zerox-gateway@.service` | The gateway, instances `@0` and `@1`: both on `127.0.0.1:8787` (`reusePort`), each with its own loopback `/ready` on `8790`/`8791` and its own release link `/opt/zerox/instance-N`, sandboxed, 110 s drain on stop. |
| `zerox-needrestart.conf`, `zerox-apt-refresh.conf`, `zerox-gateway-refresh.service`, `zerox-gateway-refresh.sh` | Upgrades without a gap: needrestart never restarts the gateway; after each apt run, the refresh swaps the instances when node or a library they use was replaced. |
| `zerox-cron.service`, `zerox-cron.timer` | `scripts/cron.mjs` every 10 minutes; installed, enabled only at the cutover's cron step. |
| `cloudflared.service` | The tunnel client, reading its token from `/etc/cloudflared/token`. |
| `zerox-deploy.sudoers` | All `deploy` may run as root: start, stop, restart, is-active and status of the two instances, and `zerox-install-env install`, `next` or `restore`. |
| `zerox-install-env.sh` | Root's `/usr/local/sbin/zerox-install-env`: checks a new environment file and puts it in place in root's `/etc/zerox`, keeping the previous one. |
| `zerox-sysctl.conf` | Connections queued on a stopping instance move to the other one. |
| `package-release.sh` | The release tarball from a commit (`git archive`): website per `.assetsignore` with the sitemap built for the commit, the gateway without tests, this kit's VM half, `REVISION`. |
| `push-release.sh` | Laptop and CI: one-time key, one SSH connection through the endpoint, install and activate as `deploy` (or, with `--setup-only`, host setup alone). |
| `install-release.sh`, `activate-release.sh` | On the VM: unpack, `npm ci --omit=dev`, then swap the instances; roll back on a failed check. |
| `gateway-env.mjs`, `gateway.env.example` | The environment file CI writes, and every variable the gateway reads (names only). |
| `CUTOVER.md`, `SESSIONS.md` | The Phase 1 cutover runbook, and the session store move it starts with. |
| `loadtest.mjs`, `loadtest-probe.mjs` | Capacity check of the gateway with a fake upstream. |

Use an IAM admin user signed in with `aws login`, not the root user.

## Laptop shell (Git Bash on Windows)

Every block below assumes this, once per shell (a new terminal does not have it, and an `aws`
command without it silently uses the default profile and region):

```bash
P="--profile zerox --region ap-south-1"   # every aws command below ends in $P
```

Git Bash rewrites an argument that looks like a POSIX path before a Windows program (`aws.exe`)
sees it: `--name /aws/service/...` arrives as `C:/Program Files/Git/aws/service/...`, so such a
command is prefixed with `MSYS_NO_PATHCONV=1` (only that command: exported, it would break the
kit's scripts, which hand `/tmp` paths to `git` and `node`). A `file://$HOME/...` argument is not
rewritten at all and reaches `aws.exe` as `file:///c/Users/...`, which it cannot open: the commands
below pass a file's contents with `"$(cat ...)"`, and `file://` only with paths relative to the
repository root.

## What it creates, and what it does not

- **Instance security group:** no inbound rule except SSH from the endpoint's security group.
  Outbound is open (apt, NodeSource, Cloudflare on 7844 TCP/UDP, Supabase, model providers, Razorpay).
- **Endpoint:** IAM decides who may open a tunnel (`ec2-instance-connect:OpenTunnel`), and
  CloudTrail logs each one. A tunnel lasts at most 1 hour; 20 connections at once.
- **Instance:**
  - IMDSv2 only (hop limit 1). The metadata service stays on, because EC2 Instance Connect reads one-time keys from it.
  - 20 GB gp3, encrypted.
  - Standard CPU credits, so no surplus charges.
  - Termination protection on.
  - No instance profile in Phase 1, because the VM calls no AWS API.
- **cloud-init (first boot only):**
  - users `deploy` (CI, one-time keys only; `host-setup.sh` replaces the sudo rule cloud-init gives it) and `zerox` (runs the gateway);
  - Node.js 22.12+ and cloudflared from their signed apt repositories;
  - unattended upgrades at 02:15 IST with no automatic reboot;
  - sshd key-only, with `AllowUsers ubuntu deploy`;
  - ufw: SSH from the VPC only;
  - the Ubuntu image's SSM Agent removed.
  It holds no secret.

## Applying a change: always through a change set

Never use `aws cloudformation deploy` here. It executes at once, and it sends any parameter you
did not pass as its previous value. Create the change set, read it, then execute it.

```bash
P="--profile zerox --region ap-south-1"   # "Laptop shell" above
aws cloudformation create-change-set --stack-name zerox-gateway --change-set-name <name> --change-set-type UPDATE \
  --template-body file://deploy/aws/gateway-vm.yaml \
  --parameters ParameterKey=SshPublicKey,UsePreviousValue=true ParameterKey=VpcId,UsePreviousValue=true \
    ParameterKey=SubnetId,UsePreviousValue=true ParameterKey=ImageId,UsePreviousValue=true \
    ParameterKey=InstanceType,UsePreviousValue=true ParameterKey=TerminationProtection,UsePreviousValue=true $P
aws cloudformation wait change-set-create-complete --stack-name zerox-gateway --change-set-name <name> $P
aws cloudformation describe-change-set --stack-name zerox-gateway --change-set-name <name> \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output table $P
# Read the Replacement column, then execute in the console (CloudFormation > zerox-gateway > Change sets) or:
aws cloudformation execute-change-set --stack-name zerox-gateway --change-set-name <name> $P
```

These replace the **instance**: `ImageId`, `SubnetId`, the key pair or `SshPublicKey`, and any edit
to `LaunchTemplateData`, including one character of the cloud-init. `InstanceType` is only a
stop/start (1-3 minutes, new public IPv4). Phase 2's instance profile goes on the Instance
(`IamInstanceProfile`, no interruption), never into the launch template.

### First apply (from the stack the Oracle-era template created)

The old stack allowed SSH from one home address, which the ISP's NAT pool keeps changing. This
update replaces the instance, which holds nothing yet. The new instance launches unprotected, so a
failed endpoint can still be rolled back. A second update turns protection on.

```bash
aws cloudformation create-change-set --stack-name zerox-gateway --change-set-name eice-endpoint-1 --change-set-type UPDATE \
  --template-body file://deploy/aws/gateway-vm.yaml \
  --parameters ParameterKey=SshPublicKey,UsePreviousValue=true ParameterKey=VpcId,ParameterValue=vpc-06aaaa0855e3d66bb \
    ParameterKey=SubnetId,ParameterValue=subnet-05ad027c3f4deb778 ParameterKey=ImageId,ParameterValue=ami-072d8688e7b3aba7a \
    ParameterKey=InstanceType,ParameterValue=t4g.small ParameterKey=TerminationProtection,ParameterValue=false $P
```

Expected changes:

| Change | Resources |
|---|---|
| Add | `EndpointSecurityGroup`, `InstanceSecurityGroup`, `SshFromEndpoint`, `InstanceConnectEndpoint` |
| Modify, no replacement | `LaunchTemplate` |
| Modify, Replacement True | `Instance` |
| Remove | `SecurityGroup` |

After it completes:

1. Create change set `protect-instance` with `TerminationProtection=true` and every other parameter `UsePreviousValue`. Expect only `Instance`, Modify, Replacement False. Execute it.
2. Turn on stack termination protection, and apply the stack policy:

```bash
aws cloudformation update-termination-protection --enable-termination-protection --stack-name zerox-gateway $P
aws cloudformation set-stack-policy --stack-name zerox-gateway --stack-policy-body file://deploy/aws/stack-policy.json $P
```

### Replacing the instance later (new image, key or cloud-init)

With termination protection on, CloudFormation cannot delete the old instance. It drops it from the
stack (`DELETE_FAILED`), leaves it running and billed, and still reports `UPDATE_COMPLETE`. The
stack policy (`stack-policy.json`) denies replacing the instance, and a change set cannot carry a
policy override (`execute-change-set` has no `--stack-policy-during-update-body`; only
`update-stack` does). So the policy is lifted with `set-stack-policy` before executing and put
back right after:

```bash
lift() { aws cloudformation set-stack-policy --stack-name zerox-gateway \
  --stack-policy-body '{"Statement":[{"Effect":"Allow","Action":"Update:*","Principal":"*","Resource":"*"}]}' $P; }
restore() { aws cloudformation set-stack-policy --stack-name zerox-gateway --stack-policy-body file://deploy/aws/stack-policy.json $P; }
```

1. A change set with only `TerminationProtection=false` (Instance, Modify, Replacement False). This
   one the policy allows: execute it as usual.
2. The replacing change set with `TerminationProtection=true`. Read it, then `lift`,
   `aws cloudformation execute-change-set ... $P`, wait for `UPDATE_COMPLETE`
   (`aws cloudformation wait stack-update-complete --stack-name zerox-gateway $P`), and `restore`
   (also after a failed update: the policy stays lifted until you do). The new instance launches
   protected. Then check that nothing was left behind:

```bash
aws cloudformation describe-stack-events --stack-name zerox-gateway $P \
  --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[Timestamp,LogicalResourceId,PhysicalResourceId]" --output text   # must print nothing
aws cloudformation get-stack-policy --stack-name zerox-gateway --query StackPolicyBody --output text $P   # the Deny statements are back
```

To pick a new image (`MSYS_NO_PATHCONV=1`: "Laptop shell" above):

```bash
MSYS_NO_PATHCONV=1 aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text $P
```

A new instance starts empty. Before replacing a live one, plan the tunnel token, the environment
file and the current release onto the new VM (sections below), and run host setup with
`push-release.sh --profile zerox --setup-only` ("Host setup"). It also has a new id, private
address and host key: "Host key" and "CI role" below.

### Changing the endpoint

Every endpoint property (`SubnetId`, `SecurityGroupIds`, `PreserveClientIp`) forces a replacement.
So does a `GroupDescription` edit on `EndpointSecurityGroup`. AWS allows one endpoint per VPC, so a
replacement always fails. The stack policy also denies removing `InstanceConnectEndpoint`
(`Update:Delete`). Instead, each update with `lift` before `execute-change-set` and `restore` after,
as above:

1. Update with `InstanceConnectEndpoint` removed (and the group, if it changes). Admin and CI SSH are down from here.
2. Update again with the new definition. Then update stack `zerox-ci` with the new `EndpointId`
   ("CI role" below), or CI's tunnel is refused.

## Connecting

```bash
aws cloudformation describe-stacks --stack-name zerox-gateway --query "Stacks[0].Outputs" --output table $P
aws ec2-instance-connect ssh --instance-id <id> --connection-type eice --os-user ubuntu $P
```

`--os-user ubuntu` matters: the CLI defaults to `ec2-user`, which Ubuntu does not have, and sshd
then refuses with "Permission denied (publickey)". The console path is EC2 > instance > Connect >
EC2 Instance Connect > connect using a private IP through the endpoint, with user `ubuntu`.

**Host key.** On the first connection, compare the fingerprint with the serial console:

```bash
aws ec2 get-console-output --instance-id <id> --latest --output text $P | sed -n "/BEGIN SSH HOST KEY FINGERPRINTS/,/END SSH HOST KEY FINGERPRINTS/p"
```

**Copying files** (scp/rsync through the endpoint). Push a one-time key, valid for 60 s, or use the
key pair's private key:

```bash
aws ec2-instance-connect send-ssh-public-key --instance-id <id> --instance-os-user ubuntu --ssh-public-key "$(cat ~/.ssh/id_ed25519.pub)" $P
scp -o HostKeyAlias=zerox-gateway -o UserKnownHostsFile=~/.ssh/zerox_known_hosts \
  -o ProxyCommand="aws ec2-instance-connect open-tunnel --instance-id %h --profile zerox --region ap-south-1" <files> ubuntu@<id>:/tmp/
```

## First boot

From the laptop, without SSH:

```bash
aws ec2 get-console-output --instance-id <id> --latest --output text $P | grep -E 'ZEROX-BOOTSTRAP|Cloud-init v.*finished'
```

On the VM:

```bash
sudo cloud-init status --wait --long; echo "exit $?"          # status: done, exit 0
grep 'bootstrap: ok' /var/log/zerox-bootstrap.txt && cat /var/log/zerox-apt-keys.txt
uname -m; node -v; cloudflared --version; sudo ufw status verbose
sudo ls -ld /opt/zerox /opt/zerox/releases /etc/zerox /etc/zerox/gateway.env /etc/cloudflared
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required.pkgs   # the first-boot upgrade may want a reboot
sudo cloud-init schema --system --annotate
```

- Expect `aarch64` and Node 22.12 or later.
- After fixing a failure, run `sudo /usr/local/sbin/zerox-bootstrap` again. It is idempotent.


## Host setup

Once after the first boot, and again whenever a unit, `zerox-deploy.sudoers`, `zerox-sysctl.conf`,
`zerox-install-env.sh` or one of the upgrade files changes. On a new VM, before the tunnel token
and the environment file exist (the next sections), set up the host alone: no release could pass
its `/ready` check yet, so `--setup` would end in "failed its checks; rolling back" and exit 1
although the host setup itself worked.

```bash
deploy/aws/push-release.sh --profile zerox --setup-only   # a new VM: host setup, no release
deploy/aws/push-release.sh --profile zerox --setup        # later: host setup, then the release
```

or on the VM, from a copy of `deploy/aws`: `sudo bash host-setup.sh`. It:

- installs `zerox-gateway@.service`, `zerox-cron.service` and `.timer`, `cloudflared.service`,
  `zerox-gateway-refresh.service` and `/etc/sysctl.d/60-zerox.conf`, and checks the units with
  `systemd-analyze verify`. A tunnel that already runs from a unit of its own (`cloudflared service
  install`) keeps that unit until `/etc/cloudflared/token` exists: replaced before, the next restart
  would start the tunnel without its token;
- installs the upgrade handling ("Timeouts, upgrades and restarts" below):
  `/etc/needrestart/conf.d/60-zerox-gateway.conf`, `/usr/local/sbin/zerox-gateway-refresh` (root's
  own copy) and the apt hook `/etc/apt/apt.conf.d/80zerox-gateway-refresh`;
- makes `/etc/zerox` and the environment file root's (0700, 0600; the first boot made them
  `deploy`'s, and the cloud-init is not edited, since that replaces the instance) and installs
  `/usr/local/sbin/zerox-install-env`, root's copy of `zerox-install-env.sh`, through which alone
  `deploy` changes the file. A link in `/etc/zerox` fails the run: only `deploy` could have made one,
  for systemd to read some root-only file as the environment;
- makes every file under `/opt/zerox/releases` the deploy user's (the smoke test's release was
  installed by hand), so pruning never fails on one;
- installs `/etc/sudoers.d/zerox-deploy` (checked with `visudo` before and after), removes
  cloud-init's older rule for `deploy`, and fails if any other sudo rule or an administrators group
  names `deploy`. Check: `sudo -l -U deploy` lists the ten `systemctl` commands and the three
  `zerox-install-env` ones, and nothing else;
- removes the smoke test's single-instance `zerox-gateway.service` if there is one (it drains
  first) and its `/opt/zerox/gateway` link. `activate-release.sh` refuses to deploy while either
  is left;
- enables `zerox-gateway@0` for boot (it starts nothing before the first release) and, once the
  token file exists, `cloudflared`;
- **never enables `zerox-cron.timer`**: the Worker's cron owns that schedule until the cutover's
  cron step ([CUTOVER.md](CUTOVER.md), step 5).

It restarts nothing that runs: a changed gateway unit takes effect at the next deploy, a changed
`cloudflared.service` at `sudo systemctl restart cloudflared` at a quiet hour (it cuts open streams).

## Cloudflare Tunnel

Create tunnel `zerox-aws` in the Cloudflare dashboard (Zero Trust > Networks > Tunnels,
"Cloudflared" type) and copy only its token. Public hostnames, in this order:

| Hostname | Service | Why |
|---|---|---|
| `aws.zero-x.live` | `http://127.0.0.1:8787` | The test host, and the origin the Worker forwards to (`EC2_PROXY_ORIGIN`). |
| `relay.zero-x.live` | `http://127.0.0.1:8787` | Only once the Node relay (C7) ships. |
| everything else | `http_status:404` | Catch-all. |

Leave the hostnames' **Keep-alive timeout** (Additional application settings > HTTP settings) at
cloudflared's default of 90 s, or anything under 95 s: the gateway keeps an idle connection for
95 s (`server.js`, `KEEP_ALIVE_MS`), so cloudflared always closes one first and never sends a
request (a POST it cannot replay) on a connection the gateway is closing. The server itself decides
who may use `aws.zero-x.live`: requests the Worker forwards carry its proxy secret, and without it
only the hosts in `EXTRA_WEB_HOSTS` are served (empty in production: only `/health`, `/ready` and
the relay host).

Never pass the token on a command line. `sudo cloudflared service install <TOKEN>` writes it to the
journal, which the `deploy` user can read, and to the shell history. Never run
`cloudflared tunnel login` on the VM either: its `cert.pem` can change the whole zone. On the VM:

```bash
read -rs -p 'tunnel token: ' T; echo
printf '%s' "$T" | sudo install -o root -g root -m 0600 /dev/stdin /etc/cloudflared/token; unset T
sudo bash host-setup.sh        # or push-release.sh --setup from the laptop: enables and starts cloudflared
curl -s -o /dev/null -w 'tunnel %{http_code}\n' http://127.0.0.1:20241/ready
```

If a token was ever typed on a command line or installed with `cloudflared service install`, it
is in the shell history, on that unit's command line and in the journal: refresh it in the
dashboard (tunnel > Overview > Refresh token; running connectors stay connected), write only the
new one as above, remove the old unit (`sudo cloudflared service uninstall`), delete the tunnel's
connections through the API (a connector started elsewhere with the old token keeps its
connections otherwise), run host setup, and drop the journal that held it
(`sudo journalctl --rotate && sudo journalctl --vacuum-time=1s`: all units' history goes).
[CUTOVER.md](CUTOVER.md) step 3 of "Before this kit reaches `main`" does this for the smoke
test's tunnel, with the commands.

## Environment file

`/etc/zerox/gateway.env` and its directory are root's (0600, 0700, from host setup on). systemd
reads the file as root, and neither the gateway user `zerox` nor `deploy` can read it. `deploy`
never writes there itself: an activation hands the new file to `/usr/local/sbin/zerox-install-env`
on stdin (the only root command for it in `zerox-deploy.sudoers`), which checks every line (the
names and quoting `gateway-env.mjs` writes, printable ASCII, none of the refused names), keeps the
live file as `gateway.env.prev`, and renames the new one into place. Owning the file or its
directory, `deploy` could have pointed it at a root-only file (the tunnel token, a host key) for
systemd to read into the gateway's environment or the journal. Once job `ec2` deploys, it writes
the whole file on every run (`gateway-env.mjs`: `wrangler.toml` `[vars]`, the Worker's secrets,
the VM's own `SUPABASE_SECRET_KEY` from the GitHub secret `SUPABASE_SECRET_KEY_EC2`,
`EC2_PROXY_SECRET`, during a rotation `EC2_PROXY_SECRET_ROTATION`, and `EXTRA_WEB_HOSTS` from the
repository variable). Hand edits are replaced then. A new file only ever goes live through an
activation, which puts the previous one back if the release then fails `/ready`.

For the smoke test, before CI deploys, write a minimal one by hand on the VM: `SUPABASE_URL`, a
**separate Supabase secret key created for EC2**, one free provider key, and
`EXTRA_WEB_HOSTS="aws.zero-x.live"`. Write it as `gateway.env.next`, never straight over
`gateway.env`: a typo then fails the activation and the previous file stays live, instead of
waiting for the next restart to take the gateway down. Type the values on the VM, never in chat
or the repository, then Ctrl-D (syntax: `KEY="value"`, one per line, see `gateway.env.example`):

```bash
sudo install -o root -g root -m 0600 /dev/stdin /etc/zerox/gateway.env.next
```

Then, from the laptop, push the commit with it (`push-release.sh` reuses an installed release and
swaps the instances; root's installer checks the file, and the push removes it once it is live; a
refused file or a failed activation keeps it, and the previous environment stays):

```bash
deploy/aws/push-release.sh --profile zerox --env-next
```

## Host key

ssh checks the VM's host key under the name `zerox-gateway`, wherever the instance is. On the
laptop, `push-release.sh` asks on the first connection and shows the fingerprints from the
instance's console next to the question; compare them, answer within a minute. It keeps the key
in `~/.ssh/zerox_known_hosts`. For CI, the environment `production` holds the instance and its
key as variables (both public), as the EC2 smoke test set them: `EC2_INSTANCE_ID` and
`EC2_HOST_KEY`, the ED25519 line from the console prefixed with the instance id. Job `ec2` refuses
a key line that names another instance and writes it under `zerox-gateway` for `push-release.sh`:

```bash
ID=<instance id>
aws ec2 get-console-output --instance-id $ID --output text $P | sed -n '/BEGIN SSH HOST KEY KEYS/,/END/p' | grep ed25519 | sed "s/^/$ID /"
gh variable set EC2_INSTANCE_ID --env production --body "$ID"
gh variable set EC2_HOST_KEY --env production --body '<that line>'
```

A replaced instance has a new id and host key: update the laptop's file, both variables and
stack `zerox-ci` ("CI role" below). On the laptop, drop the old key, and the next push asks again
next to the new console fingerprints (otherwise ssh stops with "REMOTE HOST IDENTIFICATION HAS
CHANGED"):

```bash
ssh-keygen -R zerox-gateway -f ~/.ssh/zerox_known_hosts
```

## Deploys

A release is `git archive` of one commit (`package-release.sh`): never a working tree, which may
hold untracked `output/`, `tmp/` or secrets. On the VM it lives in `/opt/zerox/releases/<commit>`
(7 hex digits) with its own `node_modules` (`npm ci --omit=dev --ignore-scripts`, as `deploy`).
Each instance runs the release its own link names, `/opt/zerox/instance-0` or `instance-1`, and
`/opt/zerox/current` (the cron, operators) points at the live one. Activation points the idle
instance's link at the new release, starts it, requires `/ready` (database, plan limits, session
store and catalog load) and the commit in `/health` on that instance's own loopback port, then
flips `current` and stops the old instance, which drains its streams for up to 110 s while the new
one takes every new connection; then the old instance's link follows, so either instance (and `@0`
at boot) starts on the live release. The new instance takes no connection before it is ready:
`server.js` binds the shared port only once the app's own `/ready` answered 200 (until then its
`READY_PORT` says 503), and gives up after 30 s (`READY_TIMEOUT_MS`) with exit 1, after which
systemd starts it again until the activation's checks give up. A failed check stops the new
instance and puts its link and the environment back; the old instance and `current` were never
touched, and even a crash and restart of the old instance meanwhile brings it back on its own
release. The current release and the three most recently activated others are kept; a release
that never went live goes first.

**From the laptop** (smoke test, or by hand), as `ubuntu`, which installs as `deploy` through sudo.
It never sends a secret:

```bash
deploy/aws/push-release.sh --profile zerox                 # HEAD
deploy/aws/push-release.sh --profile zerox --ref <commit>  # another commit
```

**From CI**: job `ec2` of `.github/workflows/deploy.yml`, once the repository variable `EC2_DEPLOY`
is `true`. Every push first runs job `verify` (the checks, `check-aws-deploy.mjs` included, with no
secret): nothing ships unless it passes. Then the Worker (job `deploy`) and job `ec2` both wait for
approval in the environment `production`, at the same time: one approval in the run's "Review
deployments" starts both, so the two runtimes change within the same couple of minutes and
neither ships ahead of the other's approval. Job `same-commit` then requires both to report the
commit. With `EC2_DEPLOY` off, only the Worker waits for that approval. The environment's
deployment branches must include `main` (the smoke test allowed only `ops/ec2-smoke`), or every
push stops at the Worker deploy: [CUTOVER.md](CUTOVER.md), "Before this kit reaches `main`", has
that and the VM's move from the smoke test's single unit. Job `ec2` needs, besides the Worker's
secrets:

| Where | Name | Value |
|---|---|---|
| Environment `production`, secret | `SUPABASE_SECRET_KEY_EC2` | The VM's own Supabase secret key. |
| Environment `production`, secret | `EC2_PROXY_SECRET` | Random printable ASCII, 32 characters or more: `openssl rand -hex 32 \| gh secret set EC2_PROXY_SECRET --env production`. The Worker gets it too (its job runs in `production`). Never a repository secret: a workflow pushed on any branch could read that, without the environment's reviewer. |
| Environment `production`, secret, only during a rotation | `EC2_PROXY_SECRET_ROTATION` | "Rotating the proxy secret" below; unset otherwise (the job then warns that it is not set). |
| Secret (already there) | `SESSION_ENCRYPTION_KEY`, `PROVIDER_KEYS_KEK`, `DEVICE_APPROVAL_SECRET` | The Worker's values: required for the VM. |
| Environment `production`, secret (already there) | `AWS_DEPLOY_ROLE_ARN` | Output `RoleArn` of stack `zerox-ci`. A secret because run logs are public; the job also masks the account id. |
| Environment `production`, variables (already there) | `EC2_INSTANCE_ID`, `EC2_HOST_KEY` | "Host key" above. |
| Variable | `EXTRA_WEB_HOSTS` | `aws.zero-x.live` during the smoke test and the cutover; delete it at the cutover's close-out. |
| Variable | `EC2_DEPLOY` | `true` to turn the job on. |

Job `ec2` builds the environment file (a missing required secret fails here, before AWS or the
VM), assumes the role for 30 minutes and runs `push-release.sh --os-user deploy`, which hands the
file to the activation under the deploy lock (a failed install leaves no environment behind).
Job `same-commit` then requires `https://zero-x.live/health` (and `https://aws.zero-x.live/health`
while `EXTRA_WEB_HOSTS` is set) to report the commit. If one deploy job fails, `same-commit` does
not run and the runtimes may be on different commits: re-run the failed job, or see
[CUTOVER.md](CUTOVER.md), "Rollback summary".

Before each deploy: production's database has every migration of the commit, since both runtimes
share it. From `neuroncli/auth-server`, with `psql` installed (Windows: the PostgreSQL installer's
"Command Line Tools" only, or `scoop install postgresql`; check with `command -v psql`) and the
database's connection string typed, not pasted into history:

```bash
read -rs -p 'DATABASE_URL: ' DATABASE_URL; echo; export DATABASE_URL
node scripts/apply-migrations.mjs --status    # lists applied and pending; read-only
unset DATABASE_URL
```

Without `psql`: in Supabase's SQL editor,
`select version, name from supabase_migrations.schema_migrations order by version desc limit 20;`
and compare with the newest files in `neuroncli/auth-server/migrations/`.

### Rotating the proxy secret

`EC2_PROXY_SECRET` is one GitHub secret that both runtimes read, and one approval deploys both,
the Worker usually a minute or two before the VM (job `ec2` installs and checks the release). A
plain rotation would leave the VM refusing every forward (403 `proxy_secret_mismatch`) for those
minutes, and for good if job `ec2` then failed and kept the old environment. So the VM accepts a
second value, `EC2_PROXY_SECRET_ROTATION`, while the Worker switches. Two approved runs (a push, or
"Re-run all jobs" on the latest run of `main`), the second only once job `same-commit` passed on
the first; the new value lives in one shell variable, never in a file or on a command line, and
the old value is never needed:

1. **The VM learns the new value.**
   ```bash
   NEW="$(openssl rand -hex 32)"
   printf '%s' "$NEW" | gh secret set EC2_PROXY_SECRET_ROTATION --env production
   ```
   Approve a run. The VM then accepts the old value (`EC2_PROXY_SECRET`) and the new one; the
   Worker still sends the old one.
2. **The Worker switches, then GitHub follows.** From `neuroncli/auth-server`, in the same shell:
   ```bash
   printf '%s' "$NEW" | npx wrangler@4.147.0 secret put EC2_PROXY_SECRET   # the Worker sends it within seconds
   printf '%s' "$NEW" | gh secret set EC2_PROXY_SECRET --env production
   gh secret delete EC2_PROXY_SECRET_ROTATION --env production
   unset NEW
   ```
   Approve a run. The VM accepts the new value before its activation (as the rotation value) and
   after it (as `EC2_PROXY_SECRET`), and the Worker sends nothing else, whichever finishes first.

If a forward is refused meanwhile, the gateway's journal says so (one line a minute at most, with
the count), and `npx wrangler@4.147.0 secret delete EC2_PROXY_PREFIXES` puts everything back on
the Worker in seconds ([CUTOVER.md](CUTOVER.md), "Rollback summary").

## CI role (stack zerox-ci)

`ci-role.yaml` is the template stack `zerox-ci` runs (applied 2026-10-30): the GitHub OIDC provider
(`GitHubOidcProvider`), the customer-managed policy `zerox-github-deploy-gateway-ssh`
(`GatewaySshPolicy`) and the role `zerox-github-deploy` (`DeployRole`), which only jobs in the
environment `production` of this repository can assume, for at most an hour. It may open a tunnel
through the gateway's endpoint to port 22 of the VM's private address, push a one-time key for
`deploy` on the gateway instance, and describe instances and endpoints (needed to find them),
nothing else. Parameters: `InstanceId`, `InstancePrivateIp`, `EndpointId` (and `Repository`,
`Environment`, whose defaults name this repository and `production`).

Keep the logical ids, the names and the parameters as they are (`check-aws-deploy.mjs` holds them):
IAM allows one OIDC provider per URL in an account, and renaming `GitHubOidcProvider` would make
CloudFormation delete it and create another, which breaks every role that trusts it.

The stack exists, so a change is an UPDATE change set. After the instance is replaced (new id and
private address), for example:

```bash
ID=$(aws cloudformation describe-stacks --stack-name zerox-gateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text $P)
IP=$(aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text $P)
aws cloudformation create-change-set --stack-name zerox-ci --change-set-name new-instance --change-set-type UPDATE \
  --template-body file://deploy/aws/ci-role.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=InstanceId,ParameterValue=$ID ParameterKey=InstancePrivateIp,ParameterValue=$IP \
    ParameterKey=EndpointId,UsePreviousValue=true ParameterKey=Repository,UsePreviousValue=true \
    ParameterKey=Environment,UsePreviousValue=true $P
aws cloudformation wait change-set-create-complete --stack-name zerox-ci --change-set-name new-instance $P
aws cloudformation describe-change-set --stack-name zerox-ci --change-set-name new-instance \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output table $P
# Expect only GatewaySshPolicy, Modify. Never execute a change set that replaces or removes GitHubOidcProvider.
aws cloudformation execute-change-set --stack-name zerox-ci --change-set-name new-instance $P
```

Then update the environment variables `EC2_INSTANCE_ID` and `EC2_HOST_KEY` ("Host key" above), or
CI's key push is refused.

## Rollback

- **Traffic**: the Worker serves everything again as soon as `EC2_PROXY_PREFIXES` loses the entry
  ([CUTOVER.md](CUTOVER.md)); no deploy needed.
- **Release**: run the workflow for the previous commit, push it from the laptop
  (`push-release.sh --ref <commit>`), or activate an older release already on the VM (no
  download, no npm), on the VM as `ubuntu` (`/opt/zerox` is readable by `deploy` and `zerox` only):
  ```bash
  sudo -u deploy bash -c 'cd /opt/zerox/releases && ls -1t */.activated'   # newest activation first
  sudo -u deploy bash /opt/zerox/releases/<commit>/deploy/aws/activate-release.sh <commit>
  # the same, also putting the previous environment back (only if the environment changed); root's
  # installer checks it like any new one, and the copy is removed once live:
  sudo cp -p /etc/zerox/gateway.env.prev /etc/zerox/gateway.env.next
  sudo -u deploy bash /opt/zerox/releases/<commit>/deploy/aws/activate-release.sh <commit> --env-next &&
    sudo rm /etc/zerox/gateway.env.next
  ```
  Without `--env-next` the environment stays as it is; nothing else in `/etc/zerox` is picked up.

## Health checks and logs

On the VM:

```bash
systemctl status 'zerox-gateway@*' cloudflared --no-pager
for port in 8790 8791; do curl -s --max-time 3 http://127.0.0.1:$port/health; echo; done   # the running instance answers
sudo -u deploy readlink /opt/zerox/current /opt/zerox/instance-0 /opt/zerox/instance-1   # live release, each instance's
sudo -u deploy cat /opt/zerox/current/REVISION
journalctl -u zerox-gateway-refresh --since -1d        # after the night's upgrades
journalctl -u 'zerox-gateway@*' -f                     # ubuntu, or deploy (systemd-journal group)
journalctl -u zerox-cron --since -1h                   # after the cutover's cron step
systemctl is-enabled zerox-cron.timer                  # disabled until then
```

journald keeps at most 1 GB and 14 days. The gateway logs no prompts, keys or request bodies.

## Load test on the VM

`loadtest.mjs` runs its own gateway process on a random loopback port against a fake upstream, so
nothing leaves the VM; it needs the gateway's development files, which a release does not carry.
It shares the CPU with the live instance: run it before go-live or at a quiet hour, at low
concurrency. From the laptop, the commit's gateway and this kit through the endpoint (README,
"Copying files"), then on the VM:

```bash
git archive --format=tar.gz -o loadtest.tar.gz HEAD neuroncli/auth-server deploy/aws        # laptop
mkdir -p ~/loadtest && tar -xzf /tmp/loadtest.tar.gz -C ~/loadtest                           # VM
cd ~/loadtest/neuroncli/auth-server && npm ci --ignore-scripts --no-audit --no-fund
node ../../deploy/aws/loadtest.mjs --streams 10,25,50 --tokens 300 --rate 50
```

A step passes when every stream ends with `[DONE]`, the event loop is busy under 80 % of the time
and its p99 delay stays under 100 ms.

## Timeouts, upgrades and restarts

- Cloudflare closes a proxied request when the origin sends nothing for 125 s. Streams send an SSE
  keep-alive comment after 30 s of silence; non-streaming calls are capped at about 90 s with a
  JSON 504 (`upstream_timeout`).
- An idle connection from cloudflared stays open 95 s on the gateway, above cloudflared's own 90 s,
  so the proxy always closes it first ("Cloudflare Tunnel"). A stopping instance closes its idle
  connections at once and answers its last responses with `Connection: close`.
- A starting instance binds the shared port only once its own `/ready` passed ("Deploys"); a
  release that crashes or cannot reach the database never takes a connection.
- unattended-upgrades installs security updates and new `nodejs` and `cloudflared` packages
  between 20:45 and 20:55 UTC (02:15 IST). needrestart then restarts the services whose binary or
  libraries changed, `cloudflared` included (that cuts open streams), but never a gateway instance
  (`60-zerox-gateway.conf`): restarting the only running instance would close the listener for
  the whole drain, and cloudflared would answer 502 meanwhile. Instead apt starts
  `zerox-gateway-refresh.service` after each run (`80zerox-gateway-refresh`): when a running
  instance maps a file the upgrade replaced (`/usr/bin/node`, libc, libstdc++), it activates the
  current release again as `deploy`, so the idle instance starts on the new files and passes
  `/ready` before the old one drains, like a deploy. If a deploy holds the lock at that moment, the
  refresh fails (`journalctl -u zerox-gateway-refresh`) and the deploy's new instance runs on the
  new files anyway. The refresh runs as root but opens nothing under `/opt/zerox` (the deploy
  user's): the release id is the name of the directory `/opt/zerox/current` resolves to, which must
  be a release, and `activate-release.sh` (as `deploy`) checks that release's `REVISION`. (The
  cloud-init comments on needrestart and on `/etc/zerox` belonging to `deploy` in `gateway-vm.yaml`
  predate this kit; they are left as they are, since any edit to the cloud-init replaces the
  instance.)
- A kernel update waits for a reboot by hand (`ls /var/run/reboot-required`): `sudo reboot` at a
  quiet hour; `zerox-gateway@0` starts on the live release at boot.
