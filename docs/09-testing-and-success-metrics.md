# 09 — Testing Plan and Success Metrics

> Status: **Design (Phase 0)**. No test exists yet, so **no results are reported here**. Real results go into `docs/benchmarks/` and CI logs as they are produced.

## 1. Test pyramid and tools (all free)

| Layer | Tool | Where | Runs in CI |
|---|---|---|---|
| Unit (TS) | Vitest | `apps/*/test/unit`, `packages/*` | Every push |
| Unit (Python) | pytest | `services/*/tests`, `ml/tests` | Every push |
| Component (React) | Vitest + Testing Library + jsdom | `apps/web/tests` | Every push |
| API integration | Vitest + Supertest against a real Postgres/Redis (GitHub service containers / Compose) | `apps/api/test/integration` | Every push |
| Database | Same harness; migrations applied to a fresh DB per suite | `apps/api/test/db` | Every push |
| Inference correctness | pytest + gateway HTTP test | `services/model-server/tests`, `tests/e2e` | Every push / e2e job |
| Artifact validation + adversarial | pytest (artifacts generated at test time) | `services/ml-worker/tests` | Every push |
| Deployment lifecycle, duplicates, worker failure, canary/rollback | Vitest integration with the real Docker driver | `apps/api/test/lifecycle` | e2e job (Docker available on `ubuntu-latest`) |
| Load | k6 | `tests/load` | Manual + nightly (results committed) |
| End-to-end browser | Playwright (+ axe) | `tests/e2e` | e2e job |

How to run (from M1/M2 onward):

```bash
pnpm test                 # all TS unit + component tests
pnpm test:integration     # needs `pnpm dev:up` (Postgres, Redis)
uv run --directory services/ml-worker pytest
pnpm e2e                  # Playwright against the running Compose stack
k6 run tests/load/steady.js
```

## 2. Test specifications (representative cases per category)

Each case: **Setup → Input → Expected → Assertion → Run.**

| # | Category | Case | Setup | Input | Expected | Assertion | Run |
|---|---|---|---|---|---|---|---|
| T1 | Unit | State machine rejects illegal transition | In-memory state machine | `READY → PROVISIONING` | Throws `InvalidTransition` | `expect(() => sm.next(...)).toThrow(InvalidTransition)` | `pnpm --filter api test state-machine` |
| T2 | Unit | Canary bucket distribution | — | 100 000 random request ids, weight 10 | 10% ± 0.5% | `abs(share - 0.10) < 0.005` | `pnpm --filter gateway test routing` |
| T3 | Component | RevisionTimeline renders states accessibly | Mock revision with 4 events | Render | 4 steps, current step `aria-current="step"`, text labels | Testing Library queries by role | `pnpm --filter web test RevisionTimeline` |
| T4 | Component | Deploy button hidden for Viewer | Mock session role VIEWER | Render endpoint page | No "Deploy" button | `queryByRole('button',{name:/deploy/i})` is null | `pnpm --filter web test` |
| T5 | API integration | Create project returns 201 + audit row | Seeded org + ML Engineer session | `POST /projects {name}` | 201, body has id | Response + `audit_events` row `project.created` | `pnpm test:integration projects` |
| T6 | Database | Audit log is append-only | Fresh DB | `UPDATE audit_events SET action='x'` | Exception from trigger | Rejects with SQLSTATE `P0001` | `pnpm test:integration db` |
| T7 | Database | One in-progress revision per endpoint | Endpoint with a `QUEUED` revision | Insert a second `REQUESTED` revision | Unique violation | Prisma error `P2002` | `pnpm test:integration db` |
| T8 | Inference correctness | Gateway == local ONNX Runtime | READY revision of sklearn model | 200 rows from the eval dataset | Identical labels; probabilities within 1e-6 | Element-wise compare | `pnpm e2e inference-parity` |
| T9 | Artifact validation | Golden example mismatch | Valid model + wrong expected outputs | Validate | `REJECTED`, V9 failed | Report check V9 `passed=false` | `pytest -k golden` |
| T10 | Artifact validation (adversarial) | Pickle disguised as ONNX (SEC-1) | Payload writes a sentinel file if unpickled | Upload + validate | `REJECTED` V1; sentinel absent | `not sentinel.exists()` | `pytest -k pickle` |
| T11 | Auth/permission | Matrix: every role × every route | Seeded users per role | Generated table of requests | Status matches `permissions.ts` | Parametrised test | `pnpm test:integration authz` |
| T12 | Auth/permission | Cross-tenant IDOR (SEC-7) | Orgs A, B | B's user GETs A's model | 404 | Status + no body leak | `pnpm test:integration tenancy` |
| T13 | Deployment lifecycle | Happy path to READY | Compose up, validated model | `POST /revisions` | Events `REQUESTED→QUEUED→PROVISIONING→LOADING→VERIFYING→READY` within 60 s | Ordered event list | `pnpm test:lifecycle happy` |
| T14 | Duplicate jobs | Same Idempotency-Key ×10 concurrent | Validated model | 10 parallel POSTs, same key | 1 revision, 1 container, 10 identical responses | DB count = 1, `docker ps` label count = 1 | `pnpm test:lifecycle duplicates` |
| T15 | Duplicate jobs | Different keys, concurrent | Same | 2 parallel POSTs, different keys | 1 × 202, 1 × 409 `DEPLOYMENT_IN_PROGRESS` | Status codes | same |
| T16 | Worker failure | Kill worker during LOADING | Deploy started | `docker kill worker` when state = LOADING, then restart | Reaches READY (or FAILED with code) within deadline; 1 container | Final state + container count | `pnpm test:chaos worker-kill` |
| T17 | Worker failure | Redis flushed mid-queue | Revision QUEUED | `redis-cli FLUSHALL` | Reconciler re-enqueues; READY | Final state | `pnpm test:chaos redis-loss` |
| T18 | Canary | Auto-abort on bad canary | Stable healthy; canary = error-injecting model | 1 000 req at 20% | Canary weight → 0; client errors ≤ canary share during window | Endpoint state + k6 error count | `pnpm test:lifecycle canary-abort` |
| T19 | Rollback | Fast rollback timing | v3 DRAINING warm, v4 stable | `POST /rollback` | Traffic 100% v3 | Time until all responses carry `X-Model-Version: 3` (recorded, not asserted < 10 s until measured) | `pnpm test:lifecycle rollback` |
| T20 | Load | Steady state | 1 READY revision | k6 50 rps × 5 min | Error rate < 0.1% (threshold) | k6 thresholds | `k6 run tests/load/steady.js` |
| T21 | E2E browser | Full vertical slice | Compose up, seeded user | Login → import model → deploy → playground predict | Prediction visible with model version | Playwright assertions + axe no serious violations | `pnpm e2e slice` |

The complete list (≈150 cases) is written alongside code in each milestone. This table defines the shape and the minimum bar.

## 3. Success metrics

### Product and engineering targets (to be **measured**, not assumed)

| Metric | Target | Measured by | Result |
|---|---|---|---|
| Click → READY (p95, images cached) | ≤ 60 s | `deployment_events` timestamps over 20 deploys | _pending (M5)_ |
| Gateway added latency (p95) | ≤ 10 ms | k6 to gateway vs direct to model server | _pending (M12)_ |
| End-to-end predict p95 @ 50 rps | ≤ 25 ms | k6 | _pending (M12)_ |
| Fast rollback traffic switch | ≤ 10 s | T19 | _pending (M8)_ |
| Duplicate runtimes under T14/T15 | 0 | T14/T15 | _pending (M5)_ |
| Chaos scenarios ending in a correct state | 100% | T16, T17 + M9 suite | _pending (M9)_ |
| Adversarial artifacts executed | 0 | SEC-1…6 | _pending (M4)_ |
| Core stack RAM (2 revisions running) | ≤ 6 GB | `docker stats` snapshot | _pending (M1/M12)_ |
| CI time (PR pipeline) | ≤ 15 min | GitHub Actions | _pending (M11)_ |
| Line coverage on domain modules (state machine, authz, routing, validation) | ≥ 85% | Vitest/pytest coverage | _pending_ |

### Portfolio outcomes
- A 3-minute demo video recorded from a fresh clone.
- A README where every number links to a results file.
- Design docs and ADRs good enough to talk through in a system-design interview.
