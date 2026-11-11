# 13 — Technology Stack and Verified Versions

> Versions were **looked up from the official registries on 2026-11-03** (npm registry, PyPI, Docker Hub, GitHub releases, nodejs.org release index). Exact patch versions are locked in `pnpm-lock.yaml` / `uv.lock` when installed (M1+). Re-verify before each milestone; see [ADR-0007](adr/0007-version-policy.md).

## Runtimes

| Component | Chosen | Latest seen | Reason |
|---|---|---|---|
| Node.js | **24 LTS** ("Krypton", 24.22.x) | 26.13 LTS ("Lithium"), 27 alpha | 24 is in long-term maintenance with the widest native-module support (argon2, Prisma engines). 26 became LTS very recently. **Reviewed in M11: staying on 24** (supported to April 2028; ADR-0007 addendum 4) |
| Python | **3.12** | — | Installed locally; supported by every ML dependency below (onnxruntime, torch, scikit-learn need ≥ 3.11) |
| pnpm | **12.16.1** (installed with npm; pinned in `packageManager`) | 12.16.1 | Enforces minimum release age and deny-by-default install scripts |

## Frontend

| Package | Version (npm `latest`) | Note |
|---|---|---|
| next | **16.4.3** (installed M1) | 16.4.4 and 16.4.5 were blocked by pnpm's release-age policy (published 0–1 days earlier) |
| react / react-dom | **19.3.1** (installed M1) | |
| typescript | **6.0.3** (installed M1) | TS 7.0.2 spike: decorators OK, but no stable compiler API and typescript-eslint requires `<6.1.0` (ADR-0007 addendum) |
| tailwindcss / @tailwindcss/postcss | **4.3.3** (installed M1) | 4.3.4 blocked by release-age policy |
| shadcn/ui | CLI at install time | Components are copied into the repo |
| @tanstack/react-query | 5.105.x | |
| recharts | **3.10.1** (installed M3) | |
| openapi-typescript / openapi-fetch | 7.13.x | Typed client from OpenAPI |
| vitest | **5.1.0** (installed M1) | API uses `unplugin-swc` 2.0.0 + `@swc/core` 1.16.21 for decorator metadata |
| @playwright/test | 1.64.x | |

## Backend (Node)

| Package | Version | Note |
|---|---|---|
| @nestjs/core, common, platform-express, testing | **12.3.2** (installed M1) | Express 5 underneath; swagger added in M2 |
| prisma / @prisma/client | **7.10.x (stable)** | npm `latest` tag points to `8.0.0-rc.30`; we do not use release candidates (risk R4) |
| bullmq | 6.5.x | Redis-backed queues |
| fastify (gateway) | pin at M5 | |
| OpenTelemetry (JS) | **api 1.10.0, sdk-node / exporter-trace-otlp-http / instrumentation-http 0.300.0, instrumentation-undici 0.34.0, -pg 0.77.0, -ioredis 0.72.0, resources 3.0.0, semantic-conventions 1.44.0** (installed M10) | Gateway (ESM: explicit spans) and API/worker (auto-instrumentation). Tests use `@opentelemetry/sdk-trace` 3.0.0 |
| @kubernetes/client-node | **2.0.2** (installed M10) | KubernetesDriver; ESM-only, loaded from the CommonJS API via Node 24's `require(esm)` |
| argon2 | pin at M2 | |
| pg / ioredis / zod | **8.23.1 / 6.0.0 / 4.6.7** (installed M1) | Readiness checks and config validation |
| eslint / typescript-eslint / prettier | **10.14.0 / 8.72.1 / 3.9.10** (installed M1) | Type-aware strict lint |

## ML / Python

| Package | Version (PyPI) | Note |
|---|---|---|
| mlflow (server) / mlflow-skinny (client) | **3.17.2** (installed M1 / M3) | Aliases instead of stages |
| fastapi | 0.162.x | |
| uvicorn | 0.54.x | |
| pydantic | 2.14.x | |
| onnx / onnxscript | **1.23.2 / 0.7.2** (installed M3) | Checker, external-data detection; onnxscript for the torch.export-based exporter |
| onnxruntime | **1.31.1** (installed M3) | CPU build |
| scikit-learn / skl2onnx | **1.9.1 / 1.20.0** (installed M3) | Compatible for GradientBoosting; parity 3e-7 (risk R6) |
| torch | **2.14.1+cpu** (installed M3) | 2.15.0 was 6 days old; training only, never in serving images |
| opentelemetry-sdk / -exporter-otlp-proto-http / -instrumentation-fastapi | **1.45.2 / 1.45.2 / 0.66b2** (installed M10, model server) | Continues the gateway's trace; only active when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| evidently | **0.7.23** (installed M7, ml-worker only) | Drift tests per feature (risk R5). Needs **pandas < 3**: the ml-worker pins pandas 2.3.3, while the training env keeps pandas 3.1.0. Telemetry off (`EVIDENTLY_DISABLE_TELEMETRY=1`) |

## Infrastructure

| Component | Version / image | Note |
|---|---|---|
| Docker Engine / Compose | 29.9 / v5.6 (installed) | Docker Desktop, free for personal and educational use |
| PostgreSQL | `postgres:18.6` (M1) | Official image |
| Redis | `redis:8.8.4` (M1) | Official image. Redis 8 is open source under AGPLv3 (among its licence options); Valkey is a drop-in alternative |
| Object storage | **SeaweedFS** `chrislusf/seaweedfs:4.52` (M1) | Replaces MinIO, whose Community Edition stopped publishing images in Oct 2025 ([ADR-0003](adr/0003-object-storage-seaweedfs.md)) |
| MLflow server | Custom image `modelops/mlflow:3.17.2`: `python:3.12.16-slim` + `mlflow==3.17.2` + `psycopg2-binary==2.9.13` + `boto3==1.43.123` | The upstream image lacks the Postgres/S3 drivers |
| kind / node image | **0.33.0 / `kindest/node:v1.37.0`** (installed M10) | CI downloads kind 0.33.0 and checks its SHA-256. kindnet enforces NetworkPolicy (its `kube-network-policies` engine) |
| kubectl | 1.36.1 (installed) | One minor version behind the 1.37 cluster: inside kubectl's supported skew |
| Terraform / AWS provider | **1.17.1 / 6.71.0** (M11, `hashicorp/terraform` image, validate only) | Provider pinned exactly, lock file for 4 platforms; 6.72.0 was under 7 days old. OpenTofu is an equivalent open-source alternative |
| tflint / AWS ruleset | **0.65.0 / 0.50.0** (M11) | 0.66.0 was 3 days old |
| checkov | **3.4.3** (M11) | 449 passed, 0 failed, every skip with an inline reason |
| actionlint | **1.7.12** (M11) | Lints the workflows (expressions, job wiring, shellcheck) |
| GitHub Actions (by SHA) | **checkout 7.0.1, setup-node 7.1.0, pnpm/action-setup 6.1.1, upload-artifact 7.0.2, cache 5.1.0, setup-uv 10.3.2, paths-filter 4.0.3, setup-buildx 4.4.1, metadata 6.2.0, build-push 7.4.0, login 4.7.0** (M11) | login-action 4.8.0 was 6 days old |
| Prometheus | `prom/prometheus:v3.15.1` (M6) | `promtool` from the same image tests the alert rules (M10) |
| Grafana / OTel Collector / Tempo | **`grafana/grafana:13.3.0` / `otel/opentelemetry-collector:0.164.0` / `grafana/tempo:3.1.1`** (M10) | Official images. Tempo 3 moved retention to `backend_worker.compaction`. Collector and Tempo are distroless (no healthcheck possible: documented hardening exceptions) |
| Platform images (M10) | `modelops/api:dev` (API + worker), `modelops/web:dev` | Built from `node:24.22.2-slim` like the gateway; non-root, run read-only on Kubernetes |
| k6 | pin at M12 | |

## Sources
- npm registry: `https://registry.npmjs.org/<pkg>/latest` and `/-/package/<pkg>/dist-tags`
- PyPI JSON API: `https://pypi.org/pypi/<pkg>/json`
- Node.js release index: `https://nodejs.org/dist/index.json`
- Docker Hub tags API; GitHub Releases API (kind, terraform, mlflow, minio)
- MinIO status: [itsfoss news](https://itsfoss.com/news/minio-moves-away-from-open-source/), [DEV Community guide](https://dev.to/rosgluk/minio-ce-in-2026-retired-upstream-source-only-and-what-to-use-1k02); MinIO's last GitHub release is `RELEASE.2025-10-15T17-29-55Z`
