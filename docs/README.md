# ModelOps Cloud — Design Documents

Phase 0 design set. Read in order for the full picture, or jump to what an interviewer asks about.

| # | Document | Covers (brief §19 item) |
|---|---|---|
| 00 | [Problem statement](00-problem-statement.md) | 1. Business problem |
| 01 | [Product requirements](01-product-requirements.md) | 2. PRD · 3. Functional & nonfunctional requirements |
| 02 | [System architecture](02-system-architecture.md) | 4. Architecture (Mermaid) · 5. Frontend components · 6. Backend modules · failure modes |
| 03 | [Data model](03-data-model.md) | 8. ER diagram, invariants, retention, storage layout |
| 04 | [API specification](04-api-specification.md) | 9. REST conventions, endpoint inventory, inference API |
| 05 | [Deployment lifecycle](05-deployment-lifecycle.md) | 7. Sequence diagram · 10. State machine · reliability & consistency guarantees |
| 06 | [Security](06-security.md) | 11. Artifact security strategy, RBAC, threat model, adversarial tests |
| 07 | [Repository structure](07-repository-structure.md) | 12. Folder layout and naming |
| 08 | [Roadmap](08-roadmap.md) | 13. Twelve milestones with acceptance criteria |
| 09 | [Testing & success metrics](09-testing-and-success-metrics.md) | 14. Test plan and measurable targets |
| 10 | [Local development](10-local-development.md) | 15. Free local setup, ports, RAM budget, cleanup |
| 11 | [AWS (optional)](11-aws-optional.md) | 16. AWS architecture, IAM, cost estimate (validate-only) |
| 12 | [Risk register](12-risk-register.md) | 17. Risks and scope reduction plan |
| 13 | [Tech stack versions](13-tech-stack-versions.md) | Verified versions (2026-11-03) |

## Milestone write-ups

| Milestone | Document |
|---|---|
| M1 | [Repository and local environment](milestones/m1-local-environment.md) |
| M2 | [Authentication, organizations, projects, frontend foundation](milestones/m2-auth-orgs-projects.md) |

## Architecture Decision Records

| ADR | Decision |
|---|---|
| [0001](adr/0001-modular-monolith-control-plane.md) | Modular monolith control plane + separate data-plane gateway |
| [0002](adr/0002-onnx-only-serving.md) | ONNX-only serving, preprocessing inside the graph |
| [0003](adr/0003-object-storage-seaweedfs.md) | SeaweedFS instead of the discontinued MinIO Community Edition |
| [0004](adr/0004-postgres-truth-outbox-bullmq.md) | Postgres source of truth + transactional outbox + BullMQ |
| [0005](adr/0005-runtime-driver-abstraction.md) | RuntimeDriver: Docker (socket proxy) → Kubernetes |
| [0006](adr/0006-sessions-and-api-keys.md) | Cookie sessions for the UI, HMAC-hashed API keys for inference |
| [0007](adr/0007-version-policy.md) | Stable-only, LTS-first, locked dependency policy |
| [0008](adr/0008-zero-cost-constraint.md) | Zero-cost constraint; AWS validate-only |

## Deviations from the original brief (and why)

| Brief said | We do | Reason |
|---|---|---|
| MinIO | SeaweedFS (S3 API) | MinIO CE no longer ships images or patches (ADR-0003) |
| Optional AWS deployment | Terraform validated, never applied | Zero-cost constraint (ADR-0008) |
| "Latest versions" | Latest **stable and ≥ 7 days old**; Prisma 7.x not 8.0 RC; Node 24 LTS; TypeScript 6 | ADR-0007 |
| shadcn/ui (CLI) | shadcn-style components written into the repo (Radix + cva) | CLI installs just-published versions that the release-age policy blocks (M2 doc) |
