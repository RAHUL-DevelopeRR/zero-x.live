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
| `host-setup.sh` | Run once as `ubuntu` after the first boot, and again after kit changes: units, deploy sudoers, kernel setting, cloudflared. Never enables the cron timer. |
| `zerox-gateway@.service` | The gateway, instances `@0` and `@1`: both on `127.0.0.1:8787` (`reusePort`), each with its own loopback `/ready` on `8790`/`8791`, sandboxed, 110 s drain on stop. |
| `zerox-cron.service`, `zerox-cron.timer` | `scripts/cron.mjs` every 10 minutes; installed, enabled only at the cutover's cron step. |
| `cloudflared.service` | The tunnel client, reading its token from `/etc/cloudflared/token`. |
| `zerox-deploy.sudoers` | All `deploy` may run as root: start, stop, restart, is-active and status of the two instances. |
| `zerox-sysctl.conf` | Connections queued on a stopping instance move to the other one. |
| `package-release.sh` | The release tarball from a commit (`git archive`): website per `.assetsignore`, the gateway without tests, this kit's VM half, `REVISION`. |
| `push-release.sh` | Laptop and CI: one-time key, one SSH connection through the endpoint, install and activate as `deploy`. |
| `install-release.sh`, `activate-release.sh` | On the VM: unpack, `npm ci --omit=dev`, then swap the instances; roll back on a failed check. |
| `gateway-env.mjs`, `gateway.env.example` | The environment file CI writes, and every variable the gateway reads (names only). |
| `CUTOVER.md`, `SESSIONS.md` | The Phase 1 cutover runbook, and the session store move it starts with. |
| `loadtest.mjs`, `loadtest-probe.mjs` | Capacity check of the gateway with a fake upstream. |

Everything below uses `--profile zerox --region ap-south-1`. Use an IAM admin user signed in with
`aws login`, not the root user.

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
P="--profile zerox --region ap-south-1"
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
stack (`DELETE_FAILED`), leaves it running and billed, and still reports `UPDATE_COMPLETE`. Two updates:

1. Lift the stack policy for this change (`--stack-policy-during-update-body '{"Statement":[{"Effect":"Allow","Action":"Update:*","Principal":"*","Resource":"*"}]}'` on `execute-change-set`). Then apply a change set with only `TerminationProtection=false` (Instance, Modify, Replacement False).
2. Apply the replacing change with `TerminationProtection=true`, lifting the policy the same way. The new instance launches protected. Then check that nothing was left behind:

```bash
aws cloudformation describe-stack-events --stack-name zerox-gateway $P \
  --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[Timestamp,LogicalResourceId,PhysicalResourceId]" --output text   # must print nothing
```

To pick a new image:

```bash
aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text $P
```

A new instance starts empty. Before replacing a live one, plan the tunnel token, the environment
file and the current release onto the new VM (sections below).

### Changing the endpoint

Every endpoint property (`SubnetId`, `SecurityGroupIds`, `PreserveClientIp`) forces a replacement.
So does a `GroupDescription` edit on `EndpointSecurityGroup`. AWS allows one endpoint per VPC, so a
replacement always fails. Instead:

1. Update with `InstanceConnectEndpoint` removed (and the group, if it changes). Admin and CI SSH are down from here.
2. Update again with the new definition.

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
aws ec2-instance-connect send-ssh-public-key --instance-id <id> --instance-os-user ubuntu --ssh-public-key file://$HOME/.ssh/id_ed25519.pub $P
scp -o ProxyCommand="aws ec2-instance-connect open-tunnel --instance-id %h --profile zerox --region ap-south-1" <files> ubuntu@<id>:/tmp/
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

Once after the first boot, and again whenever a unit, `zerox-deploy.sudoers` or `zerox-sysctl.conf`
changes. Either from the laptop, which also ships a release (next sections need the tunnel token
and the environment file first, so the first time ships nothing useful yet; that is fine):

```bash
deploy/aws/push-release.sh --profile zerox --setup
```

or on the VM, from a copy of `deploy/aws`: `sudo bash host-setup.sh`. It:

- installs `zerox-gateway@.service`, `zerox-cron.service` and `.timer`, `cloudflared.service`
  and `/etc/sysctl.d/60-zerox.conf`, and checks the units with `systemd-analyze verify`;
- installs `/etc/sudoers.d/zerox-deploy` (checked with `visudo` before and after), removes
  cloud-init's older rule for `deploy`, and fails if any other sudo rule or an administrators group
  names `deploy`. Check: `sudo -l -U deploy` lists the ten `systemctl` commands and nothing else;
- removes the smoke test's single-instance `zerox-gateway.service` if there is one (it drains first);
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

For each hostname, under Additional application settings > HTTP settings, set **Keep-alive
timeout** to `4s` (the gateway closes idle connections after 5 s; cloudflared's default of 90 s
would reuse connections the gateway already closed and answer 502). The server itself decides
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

If a token was ever typed on a command line, rotate it in the dashboard.

## Environment file

`/etc/zerox/gateway.env` is mode 0600 and owned by `deploy`, so CI can rotate it. systemd reads it
as root, and the gateway user `zerox` cannot read it. Once job `ec2` deploys, it writes the whole
file on every run (`gateway-env.mjs`: `wrangler.toml` `[vars]`, the Worker's secrets, the VM's own
`SUPABASE_SECRET_KEY` from the GitHub secret `SUPABASE_SECRET_KEY_EC2`, `EC2_PROXY_SECRET`, and
`EXTRA_WEB_HOSTS` from the repository variable). Hand edits are replaced then.

For the smoke test, before CI deploys, write a minimal one by hand on the VM: `SUPABASE_URL`, a
**separate Supabase secret key created for EC2**, one free provider key, and
`EXTRA_WEB_HOSTS="aws.zero-x.live"`. Type the values on the VM, never in chat or the repository,
then Ctrl-D (syntax: `KEY="value"`, one per line, see `gateway.env.example`):

```bash
sudo -u deploy install -m 0600 /dev/stdin /etc/zerox/gateway.env
```

A changed file takes effect when an instance starts: push the same commit again
(`push-release.sh` reuses the installed release and swaps the instances).

## Host key

ssh checks the VM's host key under the name `zerox-gateway`, wherever the instance is. On the
laptop, `push-release.sh` asks on the first connection and shows the fingerprints from the
instance's console next to the question; compare them, answer within a minute. It keeps the key
in `~/.ssh/zerox_known_hosts`. For CI, put the same key in the repository variable
`EC2_KNOWN_HOSTS` (a host key is public):

```bash
ssh-keygen -F zerox-gateway -f ~/.ssh/zerox_known_hosts | grep -v '^#'   # the hashed line, as is
# or, unhashed, from the console of a first boot:
aws ec2 get-console-output --instance-id <id> --output text $P | sed -n '/BEGIN SSH HOST KEY KEYS/,/END/p' | grep ed25519 | sed 's/^/zerox-gateway /'
gh variable set EC2_KNOWN_HOSTS --body '<that line>'
```

A replaced instance has a new host key: update both places.

## Deploys

A release is `git archive` of one commit (`package-release.sh`): never a working tree, which may
hold untracked `output/`, `tmp/` or secrets. On the VM it lives in `/opt/zerox/releases/<commit>`
(7 hex digits) with its own `node_modules` (`npm ci --omit=dev --ignore-scripts`, as `deploy`), and
`/opt/zerox/current` points at the live one. Activation starts the idle instance on the new
release, requires `/ready` (database, plan limits, session store and catalog load) and the commit
in `/health` on that instance's own loopback port, then stops the old instance, which drains its
streams for up to 110 s while the new one takes every new connection. A failed check stops the new
instance and puts the previous release and environment back; the old instance never stopped. The
current release and the three most recently activated others are kept.

**From the laptop** (smoke test, or by hand), as `ubuntu`, which installs as `deploy` through sudo.
It never sends a secret:

```bash
deploy/aws/push-release.sh --profile zerox                 # HEAD
deploy/aws/push-release.sh --profile zerox --ref <commit>  # another commit
```

**From CI**: job `ec2` of `.github/workflows/deploy.yml`, after the Worker deploy of the same push,
once the repository variable `EC2_DEPLOY` is `true` and the run is approved in the environment
`production`. It needs, besides the Worker's secrets:

| Where | Name | Value |
|---|---|---|
| Environment `production`, secret | `SUPABASE_SECRET_KEY_EC2` | The VM's own Supabase secret key. |
| Secret | `EC2_PROXY_SECRET` | Random, 32 bytes or more (`openssl rand -base64 48`); the Worker gets it too. |
| Secret (already there) | `SESSION_ENCRYPTION_KEY`, `PROVIDER_KEYS_KEK`, `DEVICE_APPROVAL_SECRET` | The Worker's values: required for the VM. |
| Variable | `AWS_DEPLOY_ROLE_ARN` | Output `RoleArn` of stack `zerox-ci`. |
| Variable | `EC2_KNOWN_HOSTS` | "Host key" above. |
| Variable | `EXTRA_WEB_HOSTS` | `aws.zero-x.live` during the smoke test and the cutover; delete it at the cutover's close-out. |
| Variable | `EC2_DEPLOY` | `true` to turn the job on. |

The job checks the kit (`check-aws-deploy.mjs`), builds the environment file (a missing required
secret fails here, before AWS or the VM), assumes the role for 30 minutes, runs
`push-release.sh --os-user deploy`, and finally requires `https://zero-x.live/health` (and
`https://aws.zero-x.live/health` while `EXTRA_WEB_HOSTS` is set) to report the commit.

Before each deploy: production's database has every migration of the commit
(`node scripts/apply-migrations.mjs --status`), since both runtimes share it.

## CI role (stack zerox-ci)

`ci-role.yaml` creates the GitHub OIDC provider and the role `zerox-github-deploy`, which only jobs
in the environment `production` of this repository can assume, for at most an hour. It may open a
tunnel to port 22 through the gateway's endpoint, push a one-time key for `deploy` on the gateway
instance, and describe instances and endpoints (needed to find them), nothing else. If the account
already has an OIDC provider for `token.actions.githubusercontent.com`, pass its ARN as
`ExistingGitHubOidcProviderArn`. Through a change set, like the gateway stack:

```bash
ID=$(aws cloudformation describe-stacks --stack-name zerox-gateway --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text $P)
EICE=$(aws cloudformation describe-stacks --stack-name zerox-gateway --query "Stacks[0].Outputs[?OutputKey=='InstanceConnectEndpointId'].OutputValue" --output text $P)
aws cloudformation create-change-set --stack-name zerox-ci --change-set-name create --change-set-type CREATE \
  --template-body file://deploy/aws/ci-role.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=InstanceId,ParameterValue=$ID ParameterKey=InstanceConnectEndpointId,ParameterValue=$EICE $P
aws cloudformation wait change-set-create-complete --stack-name zerox-ci --change-set-name create $P
aws cloudformation describe-change-set --stack-name zerox-ci --change-set-name create \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType]' --output table $P
aws cloudformation execute-change-set --stack-name zerox-ci --change-set-name create $P
aws cloudformation describe-stacks --stack-name zerox-ci --query "Stacks[0].Outputs" --output table $P
```

After the instance is replaced, update the stack with the new `InstanceId` (an UPDATE change set,
the endpoint id `UsePreviousValue=true`), or CI's key push is refused.

## Rollback

- **Traffic**: the Worker serves everything again as soon as `EC2_PROXY_PREFIXES` loses the entry
  ([CUTOVER.md](CUTOVER.md)); no deploy needed.
- **Release**: run the workflow for the previous commit, push it from the laptop
  (`push-release.sh --ref <commit>`), or activate an older release already on the VM (no
  download, no npm), on the VM as `ubuntu`:
  ```bash
  ls -1t /opt/zerox/releases                                         # newest activation first
  sudo -u deploy cp -p /etc/zerox/gateway.env.prev /etc/zerox/gateway.env.next   # only if the environment changed
  sudo -u deploy bash /opt/zerox/releases/<commit>/deploy/aws/activate-release.sh <commit>
  ```

## Health checks and logs

On the VM:

```bash
systemctl status 'zerox-gateway@*' cloudflared --no-pager
for port in 8790 8791; do curl -s --max-time 3 http://127.0.0.1:$port/health; echo; done   # the running instance answers
readlink /opt/zerox/current; cat /opt/zerox/current/REVISION
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
- unattended-upgrades installs security updates and new `nodejs` and `cloudflared` packages
  between 20:45 and 20:55 UTC (02:15 IST); needrestart then restarts the running gateway instance,
  which drains for up to 110 s (cloudflared answers 502 for new requests meanwhile), and
  `cloudflared`, which cuts open streams. A kernel update waits for a reboot by hand
  (`ls /var/run/reboot-required`): `sudo reboot` at a quiet hour; `zerox-gateway@0` starts on the
  current release at boot.
