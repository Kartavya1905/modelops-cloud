# ADR-0005 — RuntimeDriver abstraction: Docker (via socket proxy) first, Kubernetes later

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
Model servers must run as isolated, resource-limited workloads. Locally the simplest runtime is Docker; Kubernetes (kind) is a learning goal for M10; ECS would be the AWS target. Mounting the Docker socket gives root-equivalent access to the host.

## Decision
Define a narrow interface:

```ts
interface RuntimeDriver {
  ensure(spec: RevisionRuntimeSpec): Promise<RuntimeStatus>; // idempotent create-or-get
  inspect(revisionId: string): Promise<RuntimeStatus | null>;
  remove(revisionId: string): Promise<void>;                  // idempotent
  list(): Promise<RuntimeStatus[]>;                           // label-filtered
}
```

- `DockerDriver` talks to a **docker-socket-proxy** container that allows only the containers, images, and networks endpoints. Only the worker can reach the proxy.
- `KubernetesDriver` (M10) creates Deployment + Service + NetworkPolicy with a namespaced ServiceAccount.
- `EcsDriver` is documented for AWS but not built (zero-cost policy).

## Consequences
- ➕ The lifecycle test suite runs unchanged against each driver.
- ➕ Socket exposure is reduced and documented as an accepted local-dev risk.
- ➖ Lowest-common-denominator features (e.g. no Kubernetes-native rollouts). Canary routing stays in our gateway for every driver.

## Alternatives considered
- **Orchestrator shells out to the `docker` CLI:** rejected (fragile parsing, harder to test).
- **One long-lived model server that hot-loads models:** rejected (no isolation between versions or tenants, so a canary can't be isolated).
