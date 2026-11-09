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

## Addendum — M5 implementation (2026-11-04)
- **Built:** `RuntimeDriver` (`ensure` / `inspect` / `remove` / `list` / `logs`) and `DockerDriver`, which talks to the Docker Engine API over HTTP through `tecnativa/docker-socket-proxy:v0.5.0`. It never uses the `docker` CLI. Container names are deterministic (`mo-rev-<revisionId>`), so `ensure` is create-or-get. A concurrent create (409) or start (304) counts as success.
- **Proxy permissions:** `CONTAINERS`, `POST`, `ALLOW_START`, `ALLOW_STOP` and `IMAGES` are on. `EXEC`, `VOLUMES`, `NETWORKS`, `BUILD`, `SECRETS` and `SWARM` are off, and the smoke test checks they return 403. The proxy listens on 127.0.0.1 only. Creating an exec instance falls under the containers API; *starting* it is blocked. The containers API itself is still root-equivalent for anyone who can reach the proxy: that is the accepted local-dev risk, removed by the Kubernetes driver in M10.
- **Instance label:** every container is labelled `modelops.instance=<MO_INSTANCE_ID>`, and `list()` filters on it. Two control planes (the dev stack and a test run) can share one Docker host without either reconciler removing the other's containers as orphans.
- **Reaching model servers:** they sit on an `internal: true` network the host can't reach. The worker probes them (`/readyz`, golden predict) through the gateway's token-protected admin port, the only component on both networks. The gateway only proxies to hosts matching `mo-rev-<uuid>`, so it is not an open proxy.
