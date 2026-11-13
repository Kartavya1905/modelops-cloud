# 14 — ModelOps Cloud on AWS, inside the free plan

A live deployment of the whole platform on **one EC2 server**, paid for by the AWS free plan's credits (ADR-0009). The full managed-services design in [docs/11](11-aws-optional.md) stays validate-only: it would spend the credits in about a month.

```text
your laptop (your IP only) ──► :3300  web console ─┐
                           ──► :18088 gateway      ├─ one EC2 server (m7i-flex.large, 2 vCPU, 8 GiB)
                           ──► :13001 Grafana     ─┘   Ubuntu 26.04 + Docker: the same Compose stack
                                                        as a laptop, plus API, worker, web as containers
```

| Piece | Where |
|---|---|
| Terraform (server, firewall, Systems Manager role) | `infra/terraform/envs/free-plan/` |
| First-boot setup (Docker, code, systemd units) | `infra/terraform/envs/free-plan/user-data.sh.tftpl` |
| Start on every boot | `infra/cloud/start.sh` |
| The server's stack | `infra/compose/docker-compose.yml` + `docker-compose.cloud.yml` |
| Commands on your laptop | `scripts/aws-free.mjs` (`pnpm aws:*`), `scripts/cloud-smoke.mjs` |

## 1. What it costs

Nothing out of pocket: a free-plan account cannot be charged. It uses credits (about $0.10 per running hour for the server, plus about $2.40 a month for the 30 GB disk, at us-east-1 list prices; check the EC2 pricing page for current numbers).

| Usage | Credits per month (approx.) |
|---|---|
| Stopped all month (disk only) | $2.40 |
| 2 hours a day | $8.50 |
| 4 hours a day | $14.50 |
| Running 24/7 (don't) | $75 |

Guards: the server **powers itself off 4 hours after every start** (`auto_stop_hours`), there is no Elastic IP, NAT gateway or load balancer (each would cost credits even while idle), and the account has a zero-spend and a $10 monthly budget alert. **Billing and Cost Management → Credits** shows what is left.

## 2. One-time setup (your laptop)

1. An AWS account on the **free plan**, with the two budget alerts (zero spend; monthly cost $10).
2. The AWS CLI, signed in without access keys:

   ```bash
   winget install --id Amazon.AWSCLI -e
   ```

   Open a new PowerShell window, then:

   ```bash
   aws login
   ```

   ```bash
   aws sts get-caller-identity
   ```

   The last command prints your account: the CLI is connected. Sessions expire; run `aws login` again when a command says you are not signed in.
3. Docker Desktop running (Terraform runs in a container, as for `pnpm tf:check`).

## 3. Deploy

```bash
pnpm aws:up
```

It finds your public IP, shows what Terraform will create (a security group with three rules for your IP, an IAM role and instance profile for Systems Manager, one EC2 server) and waits. Type **yes**.

The server then sets itself up: installs Docker, clones this repository, generates its own secrets, builds every image and starts the platform. **The first start takes about 10–15 minutes** (in a test sized like this server, 2 vCPUs and 8 GiB: 7 minutes of image builds, under 2 to start everything); later starts take 1–3 minutes.

```bash
pnpm aws:status
```

prints the addresses and says when the platform answers. Then open the web console address, **register a new account** (the server has its own database; your laptop's accounts are not there), and follow the same walkthrough as locally (the end-to-end guide, Part 2). Replace `127.0.0.1` with the server's IP in every command, e.g. the gateway URL for predictions.

To check everything at once (creates a throwaway user, uploads and deploys the sample model, sends predictions, checks Grafana):

```bash
pnpm aws:smoke
```

## 4. Every day: start, stop, status

| Command | What it does |
|---|---|
| `pnpm aws:start` | Starts the server and waits until it runs. **It gets a new public IP**: the platform adopts it at boot; `aws:status` prints the new addresses |
| `pnpm aws:stop` | Stops it: compute stops using credits, the disk and all data stay |
| `pnpm aws:status` | State, addresses, whether the platform answers, and whether your IP is still allowed |
| `pnpm aws:up` | Run again whenever your own IP changed (home routers change it): updates only the firewall rules |

`--allow` adds addresses, e.g. to let someone else look for a day:

```bash
pnpm aws:up --allow 198.51.100.23/32
```

Run `pnpm aws:up` without it afterwards to remove them again.

## 5. On the server

There is no SSH port and no key pair. To get a shell: AWS console → **EC2 → Instances** → select `modelops-free-plan` → **Connect → Session Manager → Connect**. Then:

| Task | Command |
|---|---|
| Progress of the first boot | `sudo tail -f /var/log/modelops-bootstrap.log` |
| Progress of a start | `sudo journalctl -u modelops -f` |
| Containers | `sudo docker ps` |
| Logs of one service | `sudo docker logs --tail 100 modelops-api-1` (also `-worker-1`, `-web-1`, `-gateway-1`) |
| Grafana password | `sudo grep MO_GRAFANA_ADMIN_PASSWORD /opt/modelops/.env` |
| Run the newest code from GitHub | `cd /opt/modelops && sudo git pull && sudo systemctl restart modelops` |
| Restart the platform | `sudo systemctl restart modelops` |
| Skip the auto-stop this time | `sudo systemctl stop modelops-autostop.timer` (it is armed again at the next start) |

## 6. Security

- **Who can reach it:** only the addresses in `allowed_cidrs` (your IP as `/32`), on three ports. `0.0.0.0/0` is refused by the Terraform: the console has open sign-up, so the whole internet would mean strangers using your credits.
- **No HTTPS.** Traffic is plain HTTP to an IP address, which is why access stays limited to known addresses. HTTPS needs a domain name: with one, a reverse proxy such as Caddy in front of port 3300 gets a free Let's Encrypt certificate; then set `MO_COOKIE_SECURE=true` and `MO_WEB_URL=https://<domain>`.
- **No stored AWS credentials anywhere:** your laptop uses `aws login` sessions; the server's role can only be reached by Systems Manager; IMDSv2 with a hop limit of 1 keeps containers away from the instance metadata.
- **Secrets** are generated on the server (`/opt/modelops/.env`, root-only) and are not in Terraform state.
- The same container hardening as locally: read-only filesystems, no capabilities, resource limits, model servers on an internal network (docs/06).

## 7. Delete everything

```bash
pnpm aws:down
```

Type **yes**: the server, its disk (with all data), the firewall and the role are deleted. Do this before the free plan ends.

If the Terraform state on your laptop is lost (`infra/terraform/envs/free-plan/terraform.tfstate`), find leftovers by tag: every resource carries `project = modelops-cloud` and `environment = free-plan` (AWS console → **Resource Groups & Tag Editor → Tag Editor**, region us-east-1), and delete them there: the instance first, then the security group, instance profile and role.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `not signed in (run aws login)` | The CLI session expired: `aws login` |
| `aws login`: invalid choice | The CLI is older than 2.32: run the `winget install` line again |
| Page does not load, `aws:status` says your IP is not admitted | Your IP changed: `pnpm aws:up` |
| Page does not load, IP admitted | Still starting: `aws:status` until it says up; the first start takes 10–15 minutes. Otherwise the Session Manager logs (§5) |
| The server stopped by itself | The 4-hour auto-stop did its job: `pnpm aws:start` |
| `InsufficientInstanceCapacity` on start | AWS has no spare `m7i-flex.large` in that zone right now: try again in a few minutes |
| `aws:up` fails with an instance type error | Check that the account is on the free plan and the region is us-east-1 |
| Login works but every form says "forbidden" | The page was opened on an old IP after a restart: use the address `aws:status` prints |
