# EndpointHighLatency

**Means:** the gateway's p95 latency for an endpoint's client requests stayed above 500 ms for 10 minutes. The demo models answer in a few ms, so this is unusual.

**Confirm**
- Grafana → *ModelOps · Endpoint*: *Latency p50/p95/p99* and *Requests per second*. Did traffic rise?
- Open a slow trace (*Recent traces*): is the time in the gateway span, or in the model server's span?

**Act**
1. **Time is in the model server:** it is CPU-bound (0.5 CPU per revision by default). Redeploy with more CPU (`resources.cpus`, up to 2), or lower the endpoint's rate limit.
2. **Time is before the model server:** the gateway itself is saturated (1 CPU in Compose). Check `docker stats modelops-gateway-1`.
3. **Only one model version is slow:** if it is a canary, the analysis compares p95 against stable (×1.25) and aborts it; otherwise roll back.
