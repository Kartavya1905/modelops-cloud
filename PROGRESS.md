# Progress Checklist

> The **only** source of truth for what is done. A box is ticked only when its code is merged **and** its tests pass. Nothing unticked may be described as implemented in the README or in interviews.

Legend: ✅ done · 🚧 in progress · ⬜ not started

## Phase 0 — Design ✅ (2026-11-03)
- [x] Business problem statement — `docs/00`
- [x] PRD, functional and nonfunctional requirements — `docs/01`
- [x] System architecture, frontend components, backend modules, failure modes — `docs/02`
- [x] ER diagram — `docs/03`
- [x] API specification — `docs/04`
- [x] Deployment sequence diagram + state machine + consistency guarantees — `docs/05`
- [x] Artifact security strategy + RBAC + adversarial test list — `docs/06`
- [x] Repository structure — `docs/07`
- [x] 12-milestone roadmap — `docs/08`
- [x] Testing plan + success metrics — `docs/09`
- [x] Free local setup — `docs/10`
- [x] Optional AWS architecture + cost estimate — `docs/11`
- [x] Risk register + scope reduction — `docs/12`
- [x] Verified tech stack versions — `docs/13`
- [x] ADRs 0001–0008
- [ ] Owner review of design docs (you) ← **next action**

## Milestones
| # | Milestone | Status | Acceptance evidence |
|---|---|---|---|
| M1 | Repository and local environment | ✅ | [m1-local-environment.md](docs/milestones/m1-local-environment.md): smoke 17/17, unit 25/25 (2026-11-03); **CI green on Linux**: [run 41775591802](https://github.com/Kartavya1905/modelops-cloud/actions/runs/41775591802) |
| M2 | Auth, orgs, projects, frontend foundation | ✅ | [m2-auth-orgs-projects.md](docs/milestones/m2-auth-orgs-projects.md): unit 33 + 27, integration 88/88, e2e 4/4 incl. axe, smoke 17/17 (2026-11-04); **CI green on Linux**: [run 41784543609](https://github.com/Kartavya1905/modelops-cloud/actions/runs/41784543609) |
| M3 | MLflow, registry, experiments | ✅ | [m3-experiments-registry.md](docs/milestones/m3-experiments-registry.md): ML 32, unit 54 + 35, integration 142/142, e2e 5/5 with real training (2026-11-04); **CI green on Linux**: [run 41792113922](https://github.com/Kartavya1905/modelops-cloud/actions/runs/41792113922) |
| M4 | Model validation and artifact storage | 🚧 | [m4-validation-artifacts.md](docs/milestones/m4-validation-artifacts.md): validator 31 (Linux image), ML 32, unit 57 + 35, integration 172/172, e2e 6/6, smoke 20/20 (2026-11-04); **CI on Linux pending** |
| M5 | Inference deployment pipeline | ⬜ | — |
| M6 | Playground and operational dashboard | ⬜ | — |
| M7 | Drift monitoring and evaluation | ⬜ | — |
| M8 | Canary and rollback | ⬜ | — |
| M9 | Reliability and security hardening | ⬜ | — |
| M10 | kind and observability | ⬜ | — |
| M11 | CI/CD and Terraform (validate-only) | ⬜ | — |
| M12 | Benchmarks, docs, demo | ⬜ | — |

## Local prerequisites
- [x] Node 24.22.2 via fnm (add fnm to your PowerShell profile, see docs/10)
- [x] pnpm 12.16.1 (installed with npm; `corepack enable` failed on this machine)
- [x] uv 0.13.7 (now required: `uv sync --directory ml`)
- [ ] Docker Desktop WSL2 memory ≥ 12 GB (`.wslconfig`): optional, the stack currently uses ~0.7 GB
- [ ] `git config --global core.autocrlf input`: optional, the repo enforces LF via `.gitattributes`

## Decisions
- [x] TypeScript 7 vs 6.x → **6.0.3** (M1 spike, ADR-0007 addendum), risk R3
- [x] SeaweedFS presigned URL + path-style → verified by smoke checks 9–10 (ADR-0003)
- [x] Prisma 7.x vs 8.0 → **7.10.1 stable** (8.0 still RC on 2026-11-04), risk R4
- [x] Dependency age rule → newest stable **≥ 7 days old** (ADR-0007 addendum 2)
- [x] Outbox + idempotency tables → deferred from M2 to **M5**, where they are first used
- [x] scikit-learn ONNX parity (risk R6) → scaler removed from the GBM pipeline; parity 3e-7
- [x] MLflow aliases (`champion`/`challenger`) → deferred to **M7** with the evaluation gate
- [x] Bundle upload → direct multipart to the API with hard limits instead of presigned URLs (M4 deviation; revisit in M9)
- [x] Validation queue → version status as the durable intent + sweeper, no outbox table (ADR-0004 addendum); outbox still in **M5**
- [x] SEC-6 (deploy-unvalidated trigger) → **M5**, with revisions

## Next actions
1. Commit and push M4; tick it once CI is green on Linux
2. Start M5: inference deployment pipeline
