# ADR-0004 — Postgres as source of truth, transactional outbox, BullMQ at-least-once

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
Deployments are long-running and can fail half-way. If the API writes to the database and then enqueues a job, a crash between the two steps loses or orphans work (the "dual-write problem"). Redis is fast but is not our durable store.

## Decision
- All intent and state live in **PostgreSQL**.
- The API writes the aggregate change **and** an `outbox_messages` row in **one transaction**.
- An outbox relay (in the worker) dispatches rows to **BullMQ** with deterministic job ids, then marks them dispatched.
- Handlers are **idempotent** and use **compare-and-set** on `state_version`.
- A **reconciler** periodically compares desired state (Postgres) with actual state (runtime) and repairs differences, including jobs lost when Redis loses data.

## Consequences
- ➕ No lost deployments; duplicates are harmless; Redis can be wiped and the system recovers.
- ➕ Clear, documented guarantees: at-least-once delivery, effectively-once state transitions.
- ➖ Extra moving parts (relay, reconciler) and a small dispatch delay (poll interval ~500 ms, or `LISTEN/NOTIFY` to wake the relay).

## Alternatives considered
- **Enqueue directly from the API:** rejected (dual-write problem).
- **Postgres-only queue (pg-boss / SKIP LOCKED):** viable and simpler, but the brief asks for BullMQ and its tooling (delays, retries, metrics). The outbox keeps BullMQ replaceable.
- **Kafka / Temporal:** rejected as too heavy for a local, single-machine footprint.

## Addendum — M4 validation (2026-11-04)
Model validation is the first BullMQ workload. It uses **state as the outbox** instead of an `outbox_messages` table:
- The durable intent is the version row itself: `status = PENDING_VALIDATION` is committed in the same transaction that creates the version.
- After the commit, the API enqueues `validate-<versionId>` on a best-effort basis. If that enqueue is lost (crash, Redis down), the worker's **sweeper** finds every `PENDING_VALIDATION` row and enqueues it (deduplicated by job id). It also returns expired `VALIDATING` leases to pending.
- Handlers claim with compare-and-set (`PENDING_VALIDATION → VALIDATING`) and finalize with CAS on `VALIDATING`, so duplicate or late jobs are no-ops.

This keeps the guarantee (no lost work, at-least-once delivery, effectively-once transitions) without the dual-write problem, because the enqueue is never the source of truth. Tests cover a deleted Redis job, an expired lease and concurrent duplicate delivery. Deployments (M5) still get the outbox table: one endpoint can have several pending intents (deploy, scale, rollback) that a single status column cannot express.

