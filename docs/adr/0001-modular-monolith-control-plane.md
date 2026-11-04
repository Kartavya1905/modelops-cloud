# ADR-0001 — Modular monolith control plane, separate data-plane gateway

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
The platform has many domains (auth, registry, deployments, monitoring). Splitting them into microservices early would add network hops, distributed transactions, and deployment overhead for a one-person project. However, the inference path has very different requirements from the management path: low latency, high request volume, and it must keep working when management is down.

## Decision
- **Control plane:** one NestJS codebase (`apps/api`) with strict module boundaries and **two entrypoints**: `main.ts` (HTTP API) and `worker.ts` (BullMQ processors, outbox relay, reconciler, schedulers). Same code and schema, separate processes, so a slow job never blocks HTTP.
- **Data plane:** a separate small Fastify service (`apps/gateway`) that depends only on Redis (routing snapshot, key cache, rate limits) and, on cache miss, a read-only Postgres lookup. It never calls the control-plane API.
- **Python** is used only where the ML ecosystem requires it: model serving (ONNX Runtime) and validation, evaluation and drift (onnx, Evidently).

## Consequences
- ➕ One schema owner (Prisma), real ACID transactions across modules, simple local dev.
- ➕ Inference keeps serving when the API or worker is down (tested in M9).
- ➖ Module boundaries are enforced by convention plus lint rules (`eslint-plugin-boundaries`), not by the network.
- ➖ The gateway duplicates a small amount of logic (API-key verification), which is shared through `packages/shared`.

## Alternatives considered
- **Microservices per domain:** rejected as premature. We gain nothing measurable at this scale.
- **Gateway as a NestJS module inside the API:** rejected because it couples inference availability to the control plane.
