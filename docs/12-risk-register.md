# 12 — Risk Register and Scope Reduction Plan

> Likelihood / Impact: **H**igh, **M**edium, **L**ow. Reviewed at the end of every milestone.

## 1. Risk register

| ID | Risk | L | I | Mitigation | Trigger → response |
|---|---|:-:|:-:|---|---|
| R1 | **Scope too large for one person**; project never reaches a demoable state | H | H | Vertical slice first (M1–M6 = complete product); scope tiers; one milestone at a time | Milestone > 2× planned time → cut the next Tier 3 item |
| R2 | **MinIO Community Edition discontinued**: no official images since Oct 2025, repo archived 2026 | Confirmed | M | Use **SeaweedFS** (Apache-2.0, actively maintained) behind the plain S3 API ([ADR-0003](adr/0003-object-storage-seaweedfs.md)) | SeaweedFS issue → swap to RustFS or Garage via env vars only |
| R3 | **TypeScript 7 (native compiler) compatibility** with NestJS decorators, the Nest CLI, Prisma, or ESLint | Confirmed | M | **Resolved in M1:** spike showed decorators work but the stable compiler API is gone and typescript-eslint needs `<6.1.0`, so the workspace pins TS 6.0.3 (ADR-0007 addendum) | Re-evaluate when typescript-eslint supports TS 7 |
| R4 | **Prisma major transition**: npm `latest` currently points to an 8.0 **RC** | M | M | Pin newest **stable 7.x**; re-check at M2 | 8.0 GA with needed fixes → upgrade in a dedicated PR |
| R5 | **Evidently API churn** (major API rework in 0.7.x) | M | L | Wrapped behind `services/ml-worker/ml_worker/drift.py`; pinned `evidently==0.7.23`; tests on outputs (an injected shift is found, a same-distribution sample is not), not internals. **Seen in M7:** 0.7.23 breaks on pandas 3 (`infer_dtype_from_object` removed), so the ml-worker pins pandas 2.3.3 | Breakage → compute PSI/KS directly with scipy (already a dependency) |
| R6 | **skl2onnx lag** behind scikit-learn releases | Confirmed | M | **Hit in M3:** the parity check caught a 4.3e-2 difference caused by float32/float64 scaling, not a converter bug. Fixed by removing the scaler; parity tests guard every export | Converter fails → pin sklearn one minor lower |
| R7 | **Docker socket = root on the host** | M | H | Socket proxy limited to container/image/network endpoints; only the worker can reach it; Kubernetes driver uses namespaced RBAC | Documented as accepted local-dev risk. **M10:** on kind the worker holds a Role limited to one namespace (no exec, no secrets), so this path no longer needs the socket |
| R8 | **Windows-specific issues** (CRLF, paths, file watching in WSL, `python` Store alias) | H | L | `.gitattributes` LF, scripts in both PowerShell and bash, run services in containers, `py` launcher | Fix in setup docs on first occurrence |
| R9 | **RAM pressure** with Compose + kind + training | L | M | 31 GB available; observability as an optional profile; kind runs only the control plane and model servers, the data services stay single copies in Compose | `docker stats` > 12 GB → stop observability profile. **Measured in M10:** kind node 2.9 GiB (4 platform pods + 5 model servers) next to the full Compose stack with observability |
| R10 | **Flaky end-to-end and lifecycle tests** (timing) | H | M | Poll-until-deadline helpers (no fixed sleeps), deterministic seeds, Playwright traces on failure | > 2% flake rate → quarantine + fix before new features |
| R11 | **MLflow 3 changes** (model stages deprecated in favour of aliases) | M | L | Use aliases (`champion`/`challenger`) from day one; adapter module isolates the MLflow REST API | — |
| R12 | **Secret committed to git** | L | H | gitleaks pre-commit + CI; `.env` gitignored; generated secrets | Leak → rotate + `git filter-repo` + note in security doc |
| R13 | **Paywalled or removed container images** (e.g. Bitnami catalog moved behind a subscription in 2025) | M | M | Only official images (`postgres`, `redis`, `node`, `python`) or upstream project images; pin by digest | Image disappears → build from official Dockerfile |
| R14 | **Overclaiming** in README or interviews | M | H | `PROGRESS.md` as the only source of "done"; every number links to a results file; NFR-13 | Review checklist before each commit to the README |
| R15 | **Version drift** during a long project | H | L | Version table with dates ([`13-tech-stack-versions.md`](13-tech-stack-versions.md)); Dependabot; upgrade only between milestones | — |
| R16 | **Burnout / losing motivation** | M | H | Each milestone ends in something demoable; commit often; small PRs | Two stalled weeks → reduce to the Tier 1 finish line |

## 2. Scope reduction plan (in cut order)

If time runs short, cut from the **top** of this list first. Each cut keeps the project honest and demoable.

| Order | Cut | What remains | Impact on the story |
|---|---|---|---|
| 1 | Tempo / distributed tracing | Prometheus metrics + structured logs with request ids | Low |
| 2 | Postgres RLS + audit hash chain | App-level tenancy + append-only trigger | Low. **M9:** the hash chain was built; RLS was cut (needs a transaction around every query to carry the tenant; see the M9 doc) |
| 3 | Terraform modules | Written AWS design doc + cost estimate | Low–Medium |
| 4 | Kubernetes driver on kind | Docker driver; kind manifests for platform services only | Medium |
| 5 | Automated canary analysis | Manual canary weight + promote/rollback + side-by-side dashboard | Medium |
| 6 | Approvals workflow | RBAC (Admin-only production actions) | Medium |
| 7 | Evidently | Hand-written PSI/KS drift per feature | Low |
| — | **Never cut** | Validation of artifacts, idempotent deployment state machine, reconciler, gateway auth, tests, honest docs | These are the core of the project |

## 3. Definition of "done enough to show"

The project is portfolio-ready at the end of **M6** if, from a fresh clone:
1. One command starts the stack.
2. One command trains and registers both models.
3. A browser flow deploys a model and gets a prediction.
4. Tests run green in CI.
5. README states exactly what works, with no claims about later milestones.
