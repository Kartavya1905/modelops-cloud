# 07 — Repository Structure

> Status: **Design (Phase 0)**. Folders are created milestone by milestone. A folder appears only when it has working code in it.

Tooling: **pnpm workspaces** for TypeScript, **uv** for Python (both free). One repo, one CI pipeline.

```text
modelops-cloud/
├── README.md                      # Pitch, architecture image, quickstart, demo GIF, benchmarks
├── PROGRESS.md                    # Milestone checklist (source of truth for "what is done")
├── LICENSE                        # MIT
├── package.json                   # Root scripts: dev, lint, typecheck, test, e2e
├── pnpm-workspace.yaml
├── .nvmrc / .node-version         # Node 24 LTS
├── .editorconfig  .gitattributes  # LF line endings (important on Windows)
├── .env.example                   # Placeholders only; real .env is gitignored
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                 # lint, typecheck, unit, integration, contract drift
│   │   ├── e2e.yml                # compose up + Playwright
│   │   ├── security.yml           # gitleaks, trivy, pnpm audit, pip-audit
│   │   └── terraform.yml          # fmt, validate, tflint, checkov (no apply, ever)
│   └── dependabot.yml
│
├── apps/
│   ├── web/                       # Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui
│   │   ├── src/app/               # routes: (auth), [org]/dashboard, projects, models, endpoints…
│   │   ├── src/features/          # experiments, models, deployments, monitoring, playground, org, audit
│   │   ├── src/components/ui/     # shadcn primitives (generated, then owned)
│   │   ├── src/components/common/ # DataTable, StatusBadge, PermissionGate, ConfirmDialog…
│   │   ├── src/lib/               # api client, query keys, auth hooks, formatters
│   │   └── tests/                 # Vitest + Testing Library component tests
│   ├── api/                       # NestJS 12 control plane + worker entrypoint
│   │   ├── prisma/                # schema.prisma, migrations/, seed.ts
│   │   ├── src/main.ts            # HTTP entrypoint
│   │   ├── src/worker.ts          # BullMQ processors, outbox relay, reconciler, schedulers
│   │   ├── src/common/            # config, prisma, errors (problem+json), tenancy, authz, logging, otel
│   │   ├── src/modules/           # auth, organizations, projects, api-keys, experiments, registry,
│   │   │                          # artifacts, validation, evaluation, deployments, approvals,
│   │   │                          # releases, monitoring, audit, outbox, health
│   │   ├── src/runtime/           # RuntimeDriver interface, docker.driver.ts, kubernetes.driver.ts
│   │   └── test/                  # unit/, integration/ (Testcontainers or compose services)
│   └── gateway/                   # Fastify inference gateway (data plane)
│       ├── src/                   # auth (key cache), rate limit, routing, schema validation, proxy, metrics
│       └── test/
│
├── services/
│   ├── model-server/              # Generic serving image: FastAPI + ONNX Runtime
│   │   ├── app/                   # main.py, loader.py (checksum), predict.py, metrics.py
│   │   ├── tests/
│   │   ├── pyproject.toml  uv.lock
│   │   └── Dockerfile
│   └── ml-worker/                 # Internal FastAPI: /validate, /evaluate, /drift
│       ├── app/validation/        # checks V1–V11, sandbox runner
│       ├── app/evaluation/
│       ├── app/drift/             # Evidently reports
│       ├── tests/                 # incl. adversarial artifacts generated at test time
│       ├── pyproject.toml  uv.lock
│       └── Dockerfile
│
├── ml/                            # Trusted training code (runs on the host or in a container)
│   ├── datasets/churn.py          # Seeded synthetic generator with drift knobs
│   ├── training/train_sklearn.py  # Pipeline → skl2onnx → MLflow
│   ├── training/train_pytorch.py  # MLP → torch.onnx.export → MLflow
│   ├── training/common.py         # signature + golden examples writer, dataset hashing
│   ├── pyproject.toml  uv.lock
│   └── tests/                     # ONNX vs native parity tests
│
├── packages/
│   ├── api-contract/              # openapi.json (generated, committed) + generated TS types
│   ├── shared/                    # shared TS enums/types (RevisionState, Role), zod schemas
│   └── config/                    # tsconfig base, eslint config, prettier
│
├── infra/
│   ├── compose/
│   │   ├── docker-compose.yml     # core services
│   │   ├── docker-compose.observability.yml  # prometheus, grafana, otel-collector, tempo, cadvisor
│   │   ├── postgres/init.sql      # creates modelops + mlflow databases and roles
│   │   ├── seaweedfs/s3.json      # S3 identities (dev only, generated)
│   │   └── mlflow/Dockerfile      # mlflow + psycopg + boto3
│   ├── observability/
│   │   ├── prometheus/prometheus.yml, rules/*.yml
│   │   ├── grafana/provisioning/, dashboards/*.json
│   │   └── otel-collector/config.yaml
│   ├── k8s/
│   │   ├── kind-config.yaml
│   │   ├── base/                  # kustomize: deployments, services, configmaps, networkpolicies
│   │   └── overlays/local/
│   └── terraform/                 # Validate-only (zero-cost policy)
│       ├── modules/{network,iam,ecr,s3,ecs-service,logging}/
│       └── envs/demo/             # main.tf, variables.tf, cost.md
│
├── tests/
│   ├── e2e/                       # Playwright: login → register → deploy → predict → rollback
│   ├── load/                      # k6 scripts + results/ (raw JSON from real runs)
│   └── chaos/                     # worker kill, redis restart, duplicate submit scripts
│
├── scripts/                       # dev.ps1 / dev.sh, init-env, seed-demo, demo-traffic, cleanup
│
└── docs/
    ├── README.md                  # Index of design docs
    ├── 00…13-*.md                 # This design set
    ├── adr/                       # Architecture Decision Records
    ├── runbooks/                  # deployment stuck, high latency, drift alert, rollback, restore
    ├── benchmarks/                # Reports generated from tests/load results
    └── images/                    # Diagrams + screenshots
```

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Containers created by orchestrator | `mo-rev-<revisionId>` + labels `modelops.managed=true`, `modelops.org`, `modelops.revision` | `mo-rev-8e1c…` |
| Queues | `<domain>` | `deploy`, `validate`, `evaluate`, `drift`, `cleanup` |
| Job ids | `<queue>:<aggregateId>[:<attempt-scope>]` | `deploy:8e1c…` |
| Metrics | `modelops_<component>_<thing>_<unit>` | `modelops_gateway_request_duration_seconds` |
| Audit actions | `<aggregate>.<verb-past>` | `deployment.promoted` |
| Env vars | `MO_<COMPONENT>_<NAME>` | `MO_API_SESSION_PEPPER` |
