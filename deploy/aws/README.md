# Zero-X gateway on AWS (EC2, ap-south-1)

One Ubuntu 24.04 arm64 VM (t4g.small) runs the Node gateway (`server.js`,
the systemd units, `activate-release.sh`). Users reach it only through Cloudflare Tunnel, which
dials out from the VM. Admin and CI SSH reach it only through an EC2 Instance Connect Endpoint, so
no port faces the internet.

| File | What it is |
|---|---|
| `gateway-vm.yaml` | CloudFormation stack `zerox-gateway`: key pair, two security groups, the endpoint, the launch template (cloud-init) and the instance. No IAM resources. |
| `stack-policy.json` | Denies replacing or deleting the instance, the endpoint and the key pair, until lifted for a planned change. |

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
  - users `deploy` (CI, one-time keys only) and `zerox` (runs the gateway);
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

## Cloudflare Tunnel token

Never pass the token on a command line. `sudo cloudflared service install <TOKEN>` writes it to the
journal, which the `deploy` user can read, and to the shell history. Never run
`cloudflared tunnel login` on the VM either: its `cert.pem` can change the whole zone.

```bash
read -rs -p 'tunnel token: ' T; echo
printf '%s' "$T" | sudo install -o root -g root -m 0600 /dev/stdin /etc/cloudflared/token; unset T
sudo tee /etc/systemd/system/cloudflared.service >/dev/null <<'EOF'
[Unit]
Description=Cloudflare Tunnel client (zerox-aws)
After=network-online.target
Wants=network-online.target
[Service]
TimeoutStartSec=15
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:20241 run --token-file /etc/cloudflared/token
Restart=on-failure
RestartSec=5s
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared
```

If a token was ever typed on a command line, rotate it in the dashboard.

## Environment file

`/etc/zerox/gateway.env` is mode 0600 and owned by `deploy`, so CI can rotate it. systemd reads it
as root, and the gateway user `zerox` cannot read it. Root-only secrets (Phase 2 backups) live
outside `/etc/zerox`. To write it by hand, type the values, then Ctrl-D:

```bash
sudo -u deploy install -m 0600 /dev/stdin /etc/zerox/gateway.env
```

## Units

- Install the gateway unit from `deploy/aws` and check it with `sudo systemd-analyze verify`.
- Do **not** install or enable `zerox-cron.timer` until the cutover runbook's cron step. Until then the Worker's cron owns that schedule.
