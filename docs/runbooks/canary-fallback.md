# CanaryFallingBack

**Means:** requests that belong to a canary were served by stable, because the canary's circuit breaker is open (5 consecutive failures). Clients are protected, but the canary is broken.

**Confirm**
- The endpoint page: the *Release* card shows the canary's latest check (error rate, fallbacks). Grafana → *ModelOps · Drift & releases* → *Canary checks*.

**Act**
1. Usually nothing: fallbacks count as canary failures, so the worker's analysis (every 15 s) FAILS and aborts the canary once it has `minRequests` requests. The timeline then shows *Canary aborted: automatic: …*.
2. If the canary has little traffic, the analysis may not have enough requests yet: abort it by hand (*Abort canary*).
3. Find out why it failed: `docker logs mo-rev-<canary revision id>`. A model that answers 500 *"model produced non-finite values"* has a numerical bug on inputs its golden examples did not cover (the M8 `latent-nan` fixture is an example).
