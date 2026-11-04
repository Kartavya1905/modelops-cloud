# ModelOps Cloud

A self-service platform to **train → register → validate → deploy → serve → monitor → safely release** machine-learning models, running entirely on a laptop at zero cost.

> **Status: Milestone 4 of 12.** Working today: accounts and organizations with roles, projects, an audit log, training two real models into MLflow, comparing runs, registering versions with lineage, and **validating every version in a sandbox (checks V1–V11) before it can be deployed**. Deployment (M5) comes next, so validated versions cannot be served yet. See [`PROGRESS.md`](PROGRESS.md) for exactly what is done. This README only describes implemented features.

![A validated model version](docs/images/m4-validated.png)

## What problem does it solve?

Data scientists can train good models, but getting one into production reliably means hand-writing APIs, packaging dependencies, provisioning infrastructure, and wiring up monitoring. The result is unrepeatable releases, unsafe artifacts such as pickle files, no rollback, and models that silently decay as data drifts. ModelOps Cloud makes that path a governed, repeatable pipeline: experiments tracked in MLflow, immutable validated ONNX artifacts, durable idempotent deployments into isolated containers, an authenticated inference gateway, canary releases with rollback, and drift and performance monitoring.

## Quickstart

Prerequisites: Docker Desktop, Node 24, pnpm 12, uv. Everything is free.

```bash
pnpm install
pnpm env:init      # generates .env with random secrets
pnpm dev:up        # Postgres, Redis, SeaweedFS (S3), MLflow, ml-worker (validator), all health-checked
pnpm db:deploy     # apply database migrations
uv sync --directory ml   # Python training environment (CPU-only PyTorch)
pnpm dev           # web http://127.0.0.1:3300 · API http://127.0.0.1:4000 (Swagger at /api/docs) · validation worker
pnpm dev:clean     # remove containers and volumes
```

Then create a project in the web app and train both demo models into it (the project page shows the exact command):

```bash
pnpm ml:train --experiment modelops/<org-slug>/<project-slug>
```

## What works today

| Area | Implemented |
|---|---|
| Identity | Email + password (Argon2id), server-side sessions in HttpOnly cookies, CSRF tokens, login rate limiting |
| Tenancy | Organizations with Owner / Admin / ML Engineer / Viewer roles; other tenants' data returns 404 |
| Team | One-time, email-bound invitation links; role changes; "last Owner" protection |
| Projects | Create, rename (optimistic UI), archive, paginated lists |
| Audit | Append-only log (enforced by a database trigger), filterable in the UI |
| Training | Seeded synthetic churn data → scikit-learn GBM and PyTorch MLP → parity-checked ONNX bundles (no pickle) → MLflow |
| Experiments | Each project gets its own MLflow experiment; run list, per-epoch curves, side-by-side comparison with charts |
| Registry | Models and immutable numbered versions with signature, metrics and dataset lineage (SHA-256), mirrored to MLflow's registry; register a run or upload a bundle |
| Validation | Content-addressed storage (`sha256/<hash>`, never overwritten); a sandboxed validator rejects pickles, external data, unknown operators, signature mismatches, golden-example drift, slow models and tampered bytes (V1–V11); live checklist in the UI; durable queue with retries and crash recovery |
| API contract | OpenAPI generated from the NestJS code → typed web client; CI fails on drift |

## Tests

```bash
pnpm test               # unit + component (57 API, 35 web)
pnpm ml:test            # 32 Python tests (dataset determinism, ONNX parity, bundles)
pnpm test:integration   # 172 tests against real Postgres, Redis, MLflow, S3 and the validator (throwaway database)
uv run --directory services/ml-worker pytest   # 31 validator tests incl. adversarial artifacts
pnpm test:e2e           # Playwright journeys incl. real model training + axe accessibility checks
pnpm test:smoke         # 20 environment checks
```

Results and details: [M1](docs/milestones/m1-local-environment.md) · [M2](docs/milestones/m2-auth-orgs-projects.md) · [M3](docs/milestones/m3-experiments-registry.md) · [M4](docs/milestones/m4-validation-artifacts.md) · [local development guide](docs/10-local-development.md).

## Design

Start with the [design index](docs/README.md). Key documents:
- [System architecture](docs/02-system-architecture.md)
- [Deployment lifecycle & state machine](docs/05-deployment-lifecycle.md)
- [Security & artifact strategy](docs/06-security.md)
- [Roadmap](docs/08-roadmap.md)

## Stack

Next.js · React · TypeScript · Tailwind · shadcn/ui · TanStack Query · NestJS · Prisma · PostgreSQL · Redis · BullMQ · Python · FastAPI · ONNX Runtime · scikit-learn · PyTorch · MLflow · Evidently · SeaweedFS (S3) · Docker Compose · kind · Prometheus · Grafana · OpenTelemetry · GitHub Actions · Terraform (validate-only).

## License

MIT (to be added in M1).
