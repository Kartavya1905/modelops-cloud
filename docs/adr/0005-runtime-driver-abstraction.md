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

## Addendum — M10 implementation (2026-11-11)
- **Built:** `KubernetesDriver` (`apps/api/src/modules/deployments/runtime/kubernetes.driver.ts`, `@kubernetes/client-node` 2.0.2). `MO_RUNTIME_DRIVER=kubernetes` selects it; the deploy processor and reconciler are unchanged. The same lifecycle suite (`deployments.int.spec.ts`) passes against both drivers: `pnpm test:integration` on Docker, `pnpm --filter @modelops/api test:k8s` on kind.
- **A bare Pod, not a Deployment** (deviation from the decision above). A Deployment's ReplicaSet restarts a crashed model server forever and hides its exit code. Here restarts are the reconciler's decision, with the same budget as on Docker (3 in 10 minutes, then `FAILED`), and exit codes 3 (checksum mismatch) and 4 (load error) stay visible as the failure reason. So each revision is one Pod (`restartPolicy: Never`) + one Service (`mo-rev-<id>`, its DNS name) + one NetworkPolicy.
- **Same semantics as Docker:** `ensure` waits (up to 60 s) until the pod leaves Pending, as `docker start` returns a running container; `remove` waits until the pod object is gone, as `docker rm -f` does, so a restart (remove, then ensure) never finds the old, terminating pod. A pod being deleted reports `exited`.
- **Pod hardening:** non-root 10001, `runAsNonRoot`, RuntimeDefault seccomp, read-only root, all capabilities dropped, no privilege escalation, no service-account token, no service links, requests = limits, `/tmp` as a 16 MiB memory `emptyDir`. Both namespaces enforce the `restricted` Pod Security Standard. Per-pod PID limit 256 via the kubelet (`podPidsLimit`).
- **Isolation:** the namespace is default-deny; each revision's policy allows ingress only from pods labelled `app.kubernetes.io/name=gateway` on 8000, and egress only to DNS and `MO_K8S_EGRESS` (`cidr:port` pairs: S3 8333 and the collector 4318 on the compose network, never Postgres or Redis). Probed from real pods in the Kubernetes test run.
- **CPU request (M12):** by default a pod requests its full CPU limit (Guaranteed QoS). `MO_K8S_CPU_REQUEST` (e.g. `100m`) lowers only the request, so more model servers fit on a small node while each stays capped at its limit; memory is always reserved in full. The kind test run uses it on 4-CPU CI runners.
- **Credentials:** only the worker has a ServiceAccount, bound to a Role in `modelops-models` with get/list/create/delete on pods, services and networkpolicies, and get on pods/log. No exec, no secrets, no other namespace. This removes the root-equivalent Docker socket from the Kubernetes setup.
- **Addressing:** the gateway takes `MO_MODEL_SERVER_DOMAIN` (`modelops-models.svc.cluster.local`) and only proxies to `mo-rev-<uuid>.<that domain>`; the routing snapshot carries the same URL.
