# ModelOps Cloud

A self-service platform to **train → register → validate → deploy → serve → monitor → safely release** machine-learning models, running entirely on a laptop at zero cost.

> **Status: Milestone 1 (local environment) working locally.** It covers the infrastructure stack, a health-checked API and a status page. No ML features yet. See [`PROGRESS.md`](PROGRESS.md) for exactly what is done. This README only describes implemented features.

## What problem does it solve?

Data scientists can train good models, but getting one into production reliably means hand-writing APIs, packaging dependencies, provisioning infrastructure, and wiring up monitoring. The result is unrepeatable releases, unsafe artifacts such as pickle files, no rollback, and models that silently decay as data drifts. ModelOps Cloud makes that path a governed, repeatable pipeline: experiments tracked in MLflow, immutable validated ONNX artifacts, durable idempotent deployments into isolated containers, an authenticated inference gateway, canary releases with rollback, and drift and performance monitoring.

## Quickstart (Milestone 1)

Prerequisites: Docker Desktop, Node 24, pnpm 12. Everything is free.

```bash
pnpm install
pnpm env:init      # generates .env with random secrets
pnpm dev:up        # Postgres, Redis, SeaweedFS (S3), MLflow, all health-checked
pnpm dev           # API http://127.0.0.1:4000 · web http://127.0.0.1:3300
pnpm test:smoke    # 17 end-to-end environment checks
pnpm dev:clean     # remove containers and volumes
```

Details: [M1 write-up](docs/milestones/m1-local-environment.md) · [local development guide](docs/10-local-development.md).

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
