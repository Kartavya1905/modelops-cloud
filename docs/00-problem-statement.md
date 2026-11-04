# 00 — Business Problem Statement

> Status: **Design (Phase 0)**. Nothing described here is implemented yet. See [`PROGRESS.md`](../PROGRESS.md).

## 1. The problem in one sentence

Data scientists can train good models, but turning a model into a **safe, observable, reversible production service** takes weeks of hand-built infrastructure work that is error-prone and rarely repeatable.

## 2. Who feels the pain

| Persona | What they want | What blocks them today |
|---|---|---|
| **Data scientist** | Ship a model they trained and see how it behaves on real traffic | Has to write a Flask/FastAPI wrapper, a Dockerfile, and ask DevOps for infrastructure |
| **ML / platform engineer** | One standard way to run every model | Every model arrives in a different format, with its own dependencies and preprocessing code |
| **Engineering manager / approver** | Know what is in production, who put it there, and whether it is healthy | No audit trail, no approvals, no single dashboard |
| **Security / compliance** | Make sure no untrusted code runs in production | Pickle files can run arbitrary code when loaded, and containers are often over-privileged |
| **Product owner** | Models that keep working after launch | Nobody notices when input data drifts or accuracy quietly decays |

## 3. Current state (the "status quo" we are replacing)

1. A model is trained in a notebook. Metrics live in a spreadsheet or someone's memory.
2. The model is saved as a `.pkl` file and shared over chat or a bucket. Nobody knows which dataset produced it.
3. An engineer writes a one-off API around it and copies the preprocessing code by hand. That copy is often subtly different from training (**training/serving skew**).
4. Deployment is a manual `docker run` or a ticket to the infrastructure team. If it fails half-way, nobody knows what state it is in.
5. A new version replaces the old one for 100% of traffic at once. If it is worse, rollback means repeating the manual process under pressure.
6. Monitoring is limited to "is the server up?". Data drift and accuracy decay go unnoticed for months.

## 4. Why it matters (cost of the status quo)

- **Slow time-to-value.** Weeks between "model is good" and "model serves users".
- **Outages from bad releases.** Without canaries and fast rollback, one bad model hits every user.
- **Silent model decay.** The world changes (data drift) and the relationship between inputs and labels changes (concept drift). Revenue or quality drops before anyone notices.
- **Security exposure.** Loading a pickle can execute arbitrary code, and running uploaded code in privileged containers is a supply-chain risk.
- **No accountability.** Without lineage and audit trails, nobody can answer "which model made this decision, trained on which data, and who approved it?".

## 5. The solution: ModelOps Cloud

A **self-service platform** that turns model deployment into a governed, repeatable pipeline:

1. **Track** experiments, metrics, and dataset versions in MLflow.
2. **Register** models as immutable, checksummed, versioned **ONNX** artifacts. Preprocessing is baked into the graph, so serving runs no custom Python code.
3. **Validate** each artifact before it can be deployed: format, operators, signature, checksum, resource usage, and a functional prediction check.
4. **Deploy** with one click. The request is stored durably, executed by an idempotent background job, and the model is health-checked inside an isolated, resource-limited container before it gets traffic.
5. **Serve** authenticated predictions through a gateway that records model version, latency, errors, and traces.
6. **Release safely** with approvals, evaluation gates, canary traffic splits, and one-click rollback to the last healthy revision.
7. **Monitor** operations (throughput, p50/p95/p99, errors), data drift, and, when labels arrive, measured model performance.
8. **Audit** every action: who did what, to which model, when.

## 6. Goals

- G1. A data scientist can go from a trained model to a working, authenticated prediction endpoint **entirely through the UI**, with no hand-written infrastructure.
- G2. A failed or bad release can be **reverted in seconds** without redeploying anything by hand.
- G3. The platform stays **correct under partial failure**: a crashed worker, a restarted Redis, or a duplicate request never leaves the system in an unknown state.
- G4. **No untrusted code executes** anywhere in the serving path.
- G5. Everything runs **locally at zero cost** on one laptop.

## 7. Non-goals (explicitly out of scope)

- Running arbitrary user-supplied Python, notebooks, or custom containers.
- GPU serving, large language models, or distributed training.
- Automatic retraining or automatic promotion without human approval and evaluation data.
- Multi-region high availability or a real billing system.
- A production SaaS. This is a portfolio-grade reference implementation.

## 8. How we will know it works

Measured, not claimed. See [`09-testing-and-success-metrics.md`](09-testing-and-success-metrics.md). Every number in the final README will come from a script in this repository that anyone can re-run.
