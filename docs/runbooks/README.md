# Runbooks

One page per alert (`infra/compose/prometheus/rules.yml`). Each says what the alert means, how to confirm it, and what to do. Commands assume the local stack (`pnpm dev:up`, `pnpm dev:obs`); Grafana is at <http://127.0.0.1:13001> (user `admin`, password in `.env`).

| Alert | Severity | Runbook |
|---|---|---|
| GatewayDown | critical | [gateway-down.md](gateway-down.md) |
| EndpointHighServerErrorRate | warning | [high-error-rate.md](high-error-rate.md) |
| EndpointHighLatency | warning | [high-latency.md](high-latency.md) |
| CanaryFallingBack | warning | [canary-fallback.md](canary-fallback.md) |
| PredictionEventsDropped | warning | [events-dropped.md](events-dropped.md) |
| RateLimiterFailingOpen | warning | [rate-limiter-fail-open.md](rate-limiter-fail-open.md) |

Not an alert: [aws-teardown.md](aws-teardown.md), how the (never applied) AWS demo would be deployed and torn down, and what keeps costing money if a step is skipped (M11).

The rules are unit-tested (`infra/compose/prometheus/rules.test.yml`, run by `promtool test rules` in CI).
