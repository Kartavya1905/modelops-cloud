# 01 — Product Requirements Document (PRD)

> Status: **Design (Phase 0)**. Requirement IDs (FR-x, NFR-x) are referenced by tests and milestones.

## 1. Product summary

ModelOps Cloud is a multi-tenant web platform for tracking ML experiments, registering validated model versions, deploying them to isolated inference runtimes, and releasing them safely with canaries, approvals, rollback, and monitoring.

## 2. Users and roles

| Role | Scope | Can do |
|---|---|---|
| **Owner** | Organization | Everything, including deleting the org and transferring ownership |
| **Admin** | Organization | Manage members and API keys, approve production deployments, roll back |
| **ML Engineer** | Organization | Create projects and models, upload and register versions, deploy to staging, *request* production deployments, run canaries in staging |
| **Viewer** | Organization | Read-only access to everything except secrets |

Full permission matrix: [`06-security.md`](06-security.md#3-authorization-model-rbac).

## 3. Core user journeys

**J1 — From trained model to live endpoint (the vertical slice)**
1. An ML Engineer runs `ml/training/train_sklearn.py`. Metrics, parameters, the dataset hash, and an ONNX model are logged to MLflow.
2. In the UI they open *Models → Import from MLflow*, pick the run, and click *Register*.
3. The platform copies the artifact into immutable storage and validates it. The UI shows each validation check passing.
4. They click *Deploy to staging*. A timeline shows `Queued → Provisioning → Loading → Verifying → Ready`.
5. They open the *Playground*, enter features, and get a prediction tagged with the model version.
6. They create an API key and call the endpoint with `curl`.

**J2 — Safe production release**
1. A PyTorch candidate is registered and validated.
2. An evaluation compares the candidate against the production baseline on a held-out dataset version, and the gate passes.
3. The engineer requests a production canary at 10%. An Admin, who must be a different person, approves it.
4. The dashboard compares canary and stable error rate and p95 latency side by side.
5. The Admin promotes the candidate (100%), or rolls back with one click.

**J3 — Detecting drift**
1. The demo traffic script sends normal traffic, then *shifted* traffic.
2. The drift job flags features whose distribution moved away from the training data. The dashboard shows per-feature drift scores.
3. The script then sends ground-truth labels (feedback) whose relationship to the inputs has changed. Measured accuracy drops, which is **concept drift**, and it is shown separately from data drift.

## 4. Functional requirements

### 4.1 Identity and tenancy
- **FR-1** Users register and log in with email and password. Passwords are hashed with Argon2id.
- **FR-2** Sessions use opaque, httpOnly, SameSite cookies. Logout revokes the session on the server.
- **FR-3** A user can belong to several organizations, with a role in each.
- **FR-4** Owners and Admins invite members with a one-time invite link. No email sending, which keeps the project at zero cost.
- **FR-5** Every tenant-owned resource belongs to exactly one organization. Cross-org access returns `404`.

### 4.2 Projects and experiments
- **FR-6** CRUD for projects inside an organization. Each project maps to one MLflow experiment.
- **FR-7** List MLflow runs for a project, with parameters, metrics, tags, and dataset version.
- **FR-8** Compare 2–5 runs side by side: a metrics table plus charts.
- **FR-9** Register dataset versions (URI, SHA-256, row count, schema, generator parameters).

### 4.3 Model registry and validation
- **FR-10** Create registered models inside a project. The registered model is mirrored to the MLflow Model Registry.
- **FR-11** Create a model version either by importing an MLflow run artifact or by uploading an ONNX bundle (`model.onnx`, `signature.json`, `golden_examples.json`).
- **FR-12** Model versions are immutable after creation. The artifact is addressed by its SHA-256.
- **FR-13** Each new version is validated asynchronously. Checks: allowed format, size limit, parseable ONNX, allowed opset and operator domains, no external data, signature matches the graph, golden examples produce the expected outputs, load time and memory within limits.
- **FR-14** Only versions with status `VALIDATED` can be deployed (enforced in the API *and* the worker).
- **FR-15** Lineage: each version records its training dataset version, MLflow run, parent version (if fine-tuned or derived), and creator.

### 4.4 Deployments
- **FR-16** An **Endpoint** is a stable, named inference address in a project, with environment `STAGING` or `PRODUCTION`.
- **FR-17** Deploying creates an immutable **DeploymentRevision** (model version + resources). `POST` requires an `Idempotency-Key`.
- **FR-18** Each revision follows the state machine in [`05-deployment-lifecycle.md`](05-deployment-lifecycle.md). Every transition is recorded as an event.
- **FR-19** Revision history per endpoint, with a timeline view of events.
- **FR-20** Cancel a revision that is not yet `READY`.
- **FR-21** Production revisions require approval from an Admin or Owner who is not the requester.

### 4.5 Inference
- **FR-22** `POST /v1/endpoints/{slug}/predict` on the gateway, authenticated with a project API key.
- **FR-23** Requests are validated against the model signature (names, types, shapes) before they reach the model.
- **FR-24** Responses include `predictionId`, model name and version, and revision id.
- **FR-25** Per-API-key rate limiting, returning `429` with `Retry-After`.
- **FR-26** `POST /v1/endpoints/{slug}/feedback` accepts ground-truth labels for earlier predictions.
- **FR-27** The UI playground builds its form from the signature and calls the endpoint through the API.

### 4.6 Safe release
- **FR-28** Canary: route a configurable percentage (1–50%) of traffic to a candidate revision. Routing is sticky per routing key.
- **FR-29** Automatic canary abort when the canary's error rate or p95 latency breaches thresholds relative to stable.
- **FR-30** Promote: the canary becomes stable at 100%, and the previous stable revision drains and stays available as a rollback target for a grace period.
- **FR-31** Rollback: switch traffic back to the last healthy revision in under 10 seconds if it is still warm. Otherwise redeploy that model version as a new revision.
- **FR-32** Evaluation gate: a candidate can be marked `production-eligible` only if its evaluation report against the baseline passes the project's policy.

### 4.7 Monitoring
- **FR-33** Operations dashboard per endpoint: requests/s, p50/p95/p99 latency, error rate, traffic split by model version, CPU and memory per revision.
- **FR-34** Platform metrics: queue depth, job failures, deployment stage durations, model load failures.
- **FR-35** Drift: scheduled and on-demand comparison of captured inputs against the training dataset version, with per-feature drift scores and a dataset-level drift flag.
- **FR-36** Measured performance: accuracy, F1, and ROC-AUC over time windows, computed from feedback labels, shown separately from drift.
- **FR-37** Input capture for drift is **opt-in per endpoint**, with a retention limit.

### 4.8 Governance
- **FR-38** An append-only audit log of security-relevant and lifecycle actions, filterable in the UI.
- **FR-39** API keys: create (secret shown once), list (prefix only), revoke, expire, scope to a project.

## 5. Non-functional requirements

| ID | Category | Requirement | How verified |
|---|---|---|---|
| NFR-1 | Cost | Runs entirely on free, local tooling. No paid service needed for any feature | Setup doc, CI on a public repo |
| NFR-2 | Footprint | Core stack ≤ 6 GB RAM with 2 model revisions running (target, to be measured) | `docker stats` capture in benchmarks |
| NFR-3 | Latency | Gateway overhead p95 ≤ 10 ms; demo models p95 ≤ 25 ms end-to-end at 50 req/s on the dev laptop (targets) | k6 load test |
| NFR-4 | Deploy time | Click → `READY` p95 ≤ 60 s locally with images cached (target) | Lifecycle timing from events table |
| NFR-5 | Reliability | No duplicate runtimes under duplicate or concurrent deploy requests; crashed worker recovers in-flight deployments | Duplicate-job and chaos tests |
| NFR-6 | Correctness | Unvalidated artifacts never serve traffic | Adversarial tests |
| NFR-7 | Security | No pickle loading, no user code execution, non-root containers, CPU/memory limits, secrets out of git | Security tests, Trivy, gitleaks |
| NFR-8 | Isolation | Tenant A can never read or modify tenant B's data | Permission test suite |
| NFR-9 | Observability | Every request has a trace id; logs are structured JSON with no request bodies by default | Log assertion tests |
| NFR-10 | Accessibility | WCAG 2.2 AA for core flows: keyboard navigable, labelled controls, status not conveyed by colour alone | Playwright + axe checks |
| NFR-11 | Maintainability | Strict TypeScript, typed API client generated from OpenAPI, lint and format in CI | CI gates |
| NFR-12 | Reproducibility | `git clone` + one setup command reproduces the demo; models are re-trainable from seeded datasets | Fresh-clone CI job |
| NFR-13 | Honesty | No benchmark or test result in docs without a script that produced it | Review checklist |

## 6. Scope tiers (what gets cut first if time runs short)

| Tier | Contents | Milestones |
|---|---|---|
| **Tier 1 — must ship** | Auth, orgs, projects, MLflow experiments, register + validate ONNX, deploy, predict, ops metrics, audit, tests, Compose, CI | M1–M6, part of M11 |
| **Tier 2 — should ship** | Evaluation gates, drift, approvals, canary, rollback, chaos tests, Grafana | M7–M10 |
| **Tier 3 — nice to have** | kind manifests, Terraform (validate-only), tracing with Tempo, Postgres RLS, hash-chained audit log, live updates over SSE | M10–M12 |

## 7. Demo data

- **Dataset**: a seeded synthetic **customer churn** generator (`ml/datasets/churn.py`). Synthetic data costs nothing, avoids licensing and privacy issues, and lets us **inject** controlled data drift and concept drift for the demo.
- **Model A**: scikit-learn `Pipeline(StandardScaler → GradientBoostingClassifier)` → ONNX via `skl2onnx`.
- **Model B**: PyTorch MLP with normalization inside `forward()` → ONNX via `torch.onnx.export`.
- Both solve the same task with the same signature, so they can be compared, canaried, and rolled back against each other.
