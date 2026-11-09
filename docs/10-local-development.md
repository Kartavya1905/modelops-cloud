# 10 — Free Local Development Setup

> Status: **Implemented for M1** (infrastructure, API and web). Later services are marked with their milestone. Everything listed is free for students and personal use.

## 1. Cost policy

**This project costs $0.** No paid service, API key, cloud account, or trial that needs a credit card is required for any feature. Docker Desktop is free for personal and educational use. GitHub Actions is free for public repositories. The AWS milestone is **validate-only** ([`11-aws-optional.md`](11-aws-optional.md)).

## 2. Prerequisites (Windows 11 dev machine)

Checked on 2026-11-03 on the target laptop (31 GB RAM, 10 logical CPUs, ~157 GB free disk):

| Tool | Needed from | Status on this machine | Install (free) |
|---|---|---|---|
| Docker Desktop (WSL2 backend) | M1 | ✅ Docker 29.9.2, Compose v5.6.1 | — |
| Git | M1 | ✅ 2.53.0 | — |
| Python 3.12 | M1 | ✅ via `py` launcher (note: `python` alias points to the Store stub) | — |
| **Node.js 24 LTS** | M1 | ✅ 24.22.2 (installed in M1) | `winget install Schniz.fnm` → `fnm install 24` → `fnm default 24` |
| **pnpm** | M1 | ✅ 12.16.1 (installed in M1) | `npm install -g pnpm@12.16.1` (`corepack enable` failed on this machine) |
| **uv** (Python packaging) | M3 | ✅ 0.13.7 (installed in M1) | `winget install astral-sh.uv` |

**One-time shell setup for fnm (PowerShell).** fnm only puts Node on `PATH` after this line is in your profile. Open it with `notepad $PROFILE`, add the line, and restart the terminal:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```
| kubectl | M10 | ✅ 1.36.1 | — |
| **kind** | M10 | ❌ | `winget install Kubernetes.kind` |
| **Terraform** (or OpenTofu) | M11 | ❌ | `winget install Hashicorp.Terraform` |
| **k6** | M12 | ❌ | `winget install k6 --source winget` |

> Why `fnm` instead of the Node LTS winget package: `OpenJS.NodeJS.LTS` now installs Node **26**. The project pins Node **24** ([ADR-0007](adr/0007-version-policy.md)), and fnm reads `.node-version` automatically.

### Docker Desktop settings
- Use the WSL2 engine. Allow it enough memory in `%UserProfile%\.wslconfig`:
  ```ini
  [wsl2]
  memory=12GB
  processors=6
  ```
- Git: `git config --global core.autocrlf input`. The repo's `.gitattributes` enforces LF so shell scripts and Dockerfiles work inside Linux containers.

## 3. Services and ports

All host ports bind to `127.0.0.1` and are set in `.env`. Defaults deliberately avoid 3000, 5432, 6379, 8080 and 9090, which other local projects on this machine (e.g. `commerceflow`) already use, so both stacks can run side by side.

| Service | Host port | Since | Notes |
|---|---|---|---|
| Web (Next.js) | `3300` | M1 | Proxies `/api/*` → API |
| API (NestJS) | `4000` | M1 | `/api/v1/health/live`, `/api/v1/health/ready` |
| MLflow | `15000` | M1 | UI + REST |
| SeaweedFS S3 | `18333` | M1 | S3 API (path-style) |
| PostgreSQL | `15432` | M1 | Databases `modelops`, `mlflow` |
| Redis | `16379` | M1 | Password-protected, `noeviction` |
| Gateway (public) | `18088` | M5 | Inference API (`/v1/endpoints/<slug>/predict`). 18080 is avoided: another local project uses it |
| Gateway (admin) | `18089` | M5 | Internal: worker probes (token) and `/metrics` |
| Docker socket proxy | `12375` | M5 | Worker only; containers + images APIs only |
| Prometheus | `19090` | M10 | observability profile |
| Grafana | `13001` | M10 | observability profile |
| ML worker (validator) | `18100` | M4 | Bound to 127.0.0.1; every request needs `X-ModelOps-Token` (238 MiB measured idle) |
| Model servers | — | M5 | internal `inference` network only |

## 4. Memory budget

**Measured in M1** (`docker stats`, idle): postgres 65–81 MiB, redis 6 MiB, seaweedfs 36 MiB, mlflow 544 MiB (after disabling MLflow's job runner; 1007 MiB before). Total ≈ 0.66 GB. The rows below are still **estimates** for services that don't exist yet.

| Component | Estimated RSS |
|---|---|
| PostgreSQL | 100–200 MB |
| Redis | 20–50 MB |
| SeaweedFS | 100–200 MB |
| MLflow server | 544 MiB measured (2 workers) |
| API + worker (2 Node processes) | 300–500 MB |
| Gateway | 80–150 MB |
| ML worker (pandas, Evidently, ORT) | 300–600 MB |
| Web (`next dev`) | 400–900 MB |
| Model servers (each, demo models) | 120–250 MB |
| **Core total with 2 revisions** | **≈ 2–3.5 GB** |
| Observability profile (Prometheus, Grafana, OTel Collector, Tempo, cAdvisor) | +0.5–1 GB |
| kind cluster (M10, instead of Compose app services) | +2–3 GB |
| Training PyTorch CPU (transient) | 1–2 GB |

On a 31 GB machine, all of this runs comfortably, with kind and Compose never needing to run their full app stacks at the same time.

## 5. Daily workflow

Available now (M1):

```bash
pnpm install          # TS dependencies for the whole workspace
pnpm env:init         # create .env with random secrets (safe to re-run; never overwrites values)
pnpm dev:up           # build + start Postgres, Redis, SeaweedFS, MLflow; waits for healthchecks
pnpm dev              # API (:4000) + web (:3300) in watch mode
pnpm test:smoke       # end-to-end environment check (run while `pnpm dev` is up)
pnpm dev:ps           # container status
pnpm dev:logs         # last 100 log lines per service
pnpm dev:down         # stop containers, keep data
```

Planned: `pnpm demo:seed` (M3), `pnpm demo:traffic` (M7), `pnpm dev:obs` (M10).

> `pnpm setup` is a built-in pnpm command (it configures `PNPM_HOME`), which is why our script is named `env:init`.

## 6. Cleanup

```bash
pnpm dev:clean        # stop containers AND delete volumes (DB, Redis, S3) + orphaned model servers
docker image rm modelops/mlflow:3.17.2   # optional: remove the locally built MLflow image
kind delete cluster --name modelops      # M10
```

`pnpm env:init -- --force` regenerates every secret. Run `pnpm dev:clean` straight afterwards, because Postgres keeps the passwords it was first initialised with.

## 7. Demo data

- Seeded synthetic churn dataset (no downloads, no licences, no personal data).
- Demo users created by the seed script with **random** passwords written to `.env.demo` (gitignored), never hardcoded in the repo.
