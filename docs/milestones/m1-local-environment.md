# Milestone 1 — Repository and Local Environment

> **Status: done locally on Windows 11 (2026-11-03).** The GitHub Actions workflow is written but has **not run yet**: the repository has no remote. Linux verification happens on the first push.

## A. Problem being solved

Before any feature work, the project needs a repository and an environment that anyone can recreate with a few commands, at zero cost:
- the infrastructure every later milestone depends on (Postgres, Redis, S3-compatible storage, MLflow)
- a working API and web app that can reach that infrastructure
- generated secrets, never hardcoded
- automated proof that all of it works

## B. Architecture decisions

| Decision | Why |
|---|---|
| **Infrastructure in Compose, apps on the host** (`pnpm dev`) | Fast reload while coding. App containers arrive with the gateway and model servers in M5. |
| **Host ports in a 1xxxx range** (Postgres 15432, Redis 16379, S3 18333, MLflow 15000; web 3300, API 4000) | This machine already runs another project (`commerceflow`) on 5432, 6379, 3000, 8080 and 9090, plus other dev servers on 3100 and 3200. Both stacks now run side by side. All ports bind to `127.0.0.1` only. |
| **One `.env`, generated** by `scripts/init-env.mjs` | Random 256-bit hex secrets (safe in URLs and shell commands). `${VAR}` references are resolved once. Re-running never overwrites existing values. |
| **Two least-privilege DB roles** (`modelops_app`, `mlflow`), each owning only its own database | Verified by the smoke test: the app role is denied the `mlflow` database. |
| **SeaweedFS** as the S3 store ([ADR-0003](../adr/0003-object-storage-seaweedfs.md)) | Credentials file rendered from env at container start, so secrets exist only in `.env`. |
| **Custom MLflow image** (`python:3.12.16-slim` + pinned `mlflow`, `psycopg2-binary`, `boto3`), non-root, read-only filesystem | The upstream image lacks Postgres and S3 drivers. Secrets are passed as env vars, not CLI arguments. |
| **MLflow job runner disabled** (`MLFLOW_SERVER_ENABLE_JOB_EXECUTION=false`) | Measured: MLflow 3 starts 7 background huey consumers. Container memory went from **1007 MiB (98% of its limit) to 544 MiB** with it off. ModelOps uses BullMQ for its own jobs. |
| **Redis `noeviction` + AOF + password** | BullMQ requires `noeviction`. Evicting queue keys would silently lose jobs. |
| **Readiness ≠ liveness** | `/live` says "the process is up" (restart signal). `/ready` says "dependencies are usable" (routing signal), checked in parallel with a timeout, and returns 503 when degraded. |
| **TypeScript 6.0.3**, not 7 | Spike result in the [ADR-0007 addendum](../adr/0007-version-policy.md#addendum--m1-results-2026-11-03). |
| **Respect pnpm's release-age policy** | Pinned `next@16.4.3` and `tailwindcss@4.3.3` instead of exempting just-published versions. |
| **`pnpm env:init`**, not `pnpm setup` | `pnpm setup` is a built-in pnpm command, so a script with that name never runs. |

## C. Dependencies

Exact versions are in [`13-tech-stack-versions.md`](../13-tech-stack-versions.md) and the lockfile.

- **Runtime:** NestJS 12.3.2, pg 8.23.1, ioredis 6.0.0, zod 4.6.7, Next.js 16.4.3, React 19.3.1, Tailwind 4.3.3.
- **Tooling:** TypeScript 6.0.3, Vitest 5.1.0 (+ unplugin-swc for decorator metadata), ESLint 10 + typescript-eslint 8 (strict, type-aware), Prettier 3.9.
- **Images:** `postgres:18.6`, `redis:8.8.4`, `chrislusf/seaweedfs:4.52`, `python:3.12.16-slim`.

## D/E. Repository changes and file paths

```text
.editorconfig  .gitattributes (LF)  .gitignore  .node-version (24)  .env.example  LICENSE
package.json  pnpm-workspace.yaml (allowBuilds: @swc/core)  tsconfig.base.json  eslint.config.mjs  .prettierrc.json
.github/workflows/ci.yml                 quality job (format, lint, typecheck, test, build) + smoke job
infra/compose/docker-compose.yml         postgres, redis, seaweedfs, storage-init, mlflow
infra/compose/postgres/init/01-databases.sh
infra/compose/mlflow/{Dockerfile, requirements.txt, init_buckets.py}
scripts/init-env.mjs                     .env generation
scripts/compose.mjs                      cross-platform `docker compose` wrapper
scripts/cleanup.mjs                      remove containers + volumes (this project only)
scripts/smoke.mjs                        17-check end-to-end environment test
scripts/with-node.mjs                    run pnpm with a specific Node on PATH (IDE/preview launchers)
apps/api/src/{main.ts, setup-app.ts, app.module.ts}
apps/api/src/config/{config.ts, config.module.ts}
apps/api/src/health/{health.controller.ts, health.service.ts, health.module.ts, health.types.ts}
apps/api/src/health/checks/{postgres.check.ts, redis.check.ts}
apps/api/test/unit/{config.spec.ts, health.service.spec.ts, health.controller.spec.ts}
apps/web/src/app/{layout.tsx, page.tsx, globals.css}
apps/web/src/components/platform-status.tsx
apps/web/src/lib/health.ts
apps/web/test/health.test.ts
```

## F. Implementation

The complete code is in the files above. Each file starts with a comment explaining its role.

## G. Setup commands (fresh clone, Windows or Linux)

```bash
pnpm install
pnpm env:init
pnpm dev:up        # first run builds the MLflow image (~10 min on this laptop, cached afterwards)
pnpm dev           # API on http://127.0.0.1:4000, web on http://127.0.0.1:3300
pnpm test:smoke    # in a second terminal
```

Cleanup: `pnpm dev:clean` removes this project's containers and volumes only.

## H. Tests

| Suite | Count | What it proves | Run |
|---|---|---|---|
| API unit + HTTP (Vitest, Nest testing module, supertest) | 16 | Config validation (incl. never echoing secrets); timeout wrapper; check aggregation; `/api/v1` routing; 200/503 mapping; a hanging dependency yields 503 instead of a hung probe; unversioned paths are 404 | `pnpm --filter @modelops/api test` |
| Web unit (Vitest) | 9 | Untrusted readiness JSON is validated, not cast; HTTP outcome → UI state (ready / degraded / unreachable) | `pnpm --filter @modelops/web test` |
| Smoke (real stack) | 17 | See the output below | `pnpm test:smoke` |
| Static gates | — | Prettier, ESLint (strict, type-aware), `tsc --noEmit` for both apps, `next build` | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build` |

### Actual results (2026-11-03, Windows 11, Docker Desktop 29.9.2)

```text
ModelOps Cloud smoke test (full)

PASS  compose: core services running and healthy             394 ms  postgres, redis, seaweedfs, mlflow
PASS  compose: storage-init completed successfully           372 ms  exit 0
PASS  postgres: app role can use the modelops database       430 ms  connected as modelops_app
PASS  postgres: app role is denied the mlflow database       287 ms  permission denied (least privilege)
PASS  redis: authenticated PING and noeviction policy        809 ms  PONG, maxmemory-policy=noeviction
PASS  redis: unauthenticated access is rejected              397 ms  NOAUTH
PASS  s3: all platform buckets exist                          17 ms  6 buckets
PASS  s3: put -> get round trip preserves SHA-256             10 ms  sha256 1e55f9738bfe…
PASS  s3: presigned GET URL works without credentials         17 ms  HTTP 200, checksum ok
PASS  s3: tampered presigned URL is rejected                   4 ms  HTTP 403
PASS  s3: wrong credentials are rejected                       6 ms  HTTP 403
PASS  mlflow: /health returns OK                               4 ms  HTTP 200
PASS  mlflow: run + artifact stored in Postgres and S3       323 ms  experiment 5, run 19b6ab22…
PASS  api: GET /api/v1/health/live                             2 ms  HTTP 200
PASS  api: GET /api/v1/health/ready (postgres + redis up)      3 ms  postgres 1 ms, redis 1 ms
PASS  web: home page renders                                  22 ms  HTTP 200
PASS  web: /api rewrite reaches the API                        4 ms  HTTP 200 via Next.js rewrite

17/17 checks passed.
```

Unit tests: API 16/16, web 9/9. Lint, format, typecheck and `next build` all passed.

### Manual failure-mode check (2026-11-03)

| Step | Observed |
|---|---|
| `docker stop modelops-redis-1` | `/api/v1/health/ready` → **503** `{"redis":{"status":"down","error":"Stream isn't writeable and enableOfflineQueue options is false"}}`, returned immediately (no hang). The web page switched to **Degraded**, with Redis marked Down. |
| `docker start modelops-redis-1` | `/ready` back to **200 after ~3 s** with no API restart; page back to "All systems ready". |
| Polling interval in the browser | 5.01 s between requests (React strict mode is not double-polling). |

### Measured memory (`docker stats`, idle, after the MLflow fix)

| Container | Usage / limit |
|---|---|
| postgres | 65–81 MiB / 512 MiB |
| redis | 6 MiB / 256 MiB |
| seaweedfs | 36 MiB / 512 MiB |
| mlflow (2 workers, job runner off) | 544 MiB / 1 GiB |
| **Total** | **≈ 0.66 GB** |

## I. Expected behaviour

- `pnpm dev:up` returns only when every service is healthy, or fails with the unhealthy service's name.
- http://127.0.0.1:3300 shows "Platform status: All systems ready", listing Postgres and Redis with latencies.
- Stopping any dependency flips the page to "Degraded" within 5 s; restarting it recovers without restarting the API.
- The API refuses to start with a list of the missing or invalid variable **names** (never values) if `.env` is wrong.

## J. Debugging

| Symptom | Cause → fix |
|---|---|
| `pnpm setup` prints something about `PNPM_HOME` | That's pnpm's built-in command. Use `pnpm env:init`. |
| `node` / `pnpm` not found in a new terminal | fnm isn't in your PowerShell profile. See [`10-local-development.md`](../10-local-development.md#2-prerequisites-windows-11-dev-machine). |
| `bind: address already in use` | Another project uses that port. Change the `MO_PORT_*` value in `.env`, then run `pnpm dev:up`. |
| Postgres auth fails after `pnpm env:init -- --force` | Postgres keeps the passwords it was initialised with. Run `pnpm dev:clean`, then `pnpm dev:up`. |
| MLflow `400 Invalid Host header` | Add the host:port you're using to `MLFLOW_SERVER_ALLOWED_HOSTS` in the Compose file. |
| `storage-init` exits non-zero | `pnpm dev:logs storage-init`. Usually SeaweedFS wasn't ready (the script retries 10×) or credentials changed. |
| MLflow restarting / OOM | Check that `MLFLOW_SERVER_ENABLE_JOB_EXECUTION` is `false`, then `docker stats modelops-mlflow-1`. |
| `ERR_PNPM_IGNORED_BUILDS` | A new dependency wants an install script. Review it, then approve it explicitly with `pnpm approve-builds <pkg>`. |
| Shell scripts fail in containers with `\r` errors | CRLF line endings. The repo enforces LF via `.gitattributes`; run `git add --renormalize .` |

## K. Acceptance criteria

| Criterion | Status |
|---|---|
| Fresh setup reaches all-green on Windows (Docker Desktop) | ✅ verified (the commands above, on this machine) |
| Same in Linux CI | ⏳ workflow written, **not yet run** (no GitHub remote) |
| All services healthy, buckets created, MLflow persists to Postgres + S3 | ✅ smoke checks 1–13 |
| API `/health/ready` reports dependencies; web page reaches API via rewrite | ✅ smoke checks 14–17 + manual failure test |
| No secrets in git | ✅ `.env` ignored (`git check-ignore .env` → `.gitignore:17`); only `.env.example` with placeholders |
| Lint, format, typecheck, unit tests, production build | ✅ all pass locally |

## L. Completion checklist

- [x] Tooling installed: Node 24.22.2 (fnm), pnpm 12.16.1, uv 0.13.7
- [x] Git repository initialised (local commits use the GitHub noreply address)
- [x] Workspace, TS/ESLint/Prettier configuration
- [x] Compose stack with healthchecks, limits, localhost-only ports
- [x] Least-privilege database roles
- [x] Bucket bootstrap
- [x] API with validated config and health endpoints
- [x] Web app with live platform status via `/api` rewrite
- [x] Env generation, compose wrapper, cleanup, smoke test
- [x] CI workflow file
- [ ] First commit + push to GitHub, and a green CI run ← next action
