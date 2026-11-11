# GatewayDown

**Means:** Prometheus has not reached the dev gateway's `/metrics` for a minute. Clients probably cannot predict either.

**Confirm**
- `pnpm dev:ps`: is `modelops-gateway-1` running and healthy?
- `curl -s http://127.0.0.1:18089/healthz` (admin port) and `http://127.0.0.1:18088/healthz`.
- `pnpm dev:logs` and look at the gateway's last lines (it logs one line per request at info, never inputs).

**Act**
1. Container exited: `pnpm dev:up` restarts it. It needs Redis to start (it reads the routing snapshot); check Redis first.
2. Running but unhealthy: restart it (`docker restart modelops-gateway-1`). It reloads the full routing snapshot from Redis, so nothing is lost.
3. Healthy, but Prometheus still says down: the Prometheus target page (<http://127.0.0.1:19090/targets>) shows the scrape error, usually a network change after a Docker restart.

**Why it is safe to restart:** the gateway holds no state of its own (docs/02). M9's chaos run showed predictions continue through a Redis restart while the gateway keeps its last snapshot.
