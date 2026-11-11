# EndpointHighServerErrorRate

**Means:** more than 5 % of an endpoint's *client* requests (`source="api"`; playground calls are excluded) answered 5xx for 5 minutes, with at least 0.2 req/s of traffic.

**Confirm**
- Grafana → *ModelOps · Endpoint* → pick the endpoint: *Server error rate*, and *Requests per second, by model version*. Is one version responsible (a canary)?
- The endpoint page in the app: the *Release* card and the *Latest deployment* timeline.
- *Recent traces through the gateway*: open a failing trace to see whether the model server answered at all.

**Act**
1. **A canary is failing:** the canary analysis should abort it within 15 s once it has 200 requests. If it has not yet, abort it from the endpoint page (*Abort canary*).
2. **The stable revision is failing after a deploy:** *Roll back* on the endpoint page (fast path when the previous revision is still warm: ~0.1 s, M8).
3. **502/504 with no recent deploy:** the model server may be crash-looping. The reconciler restarts it (budget 3 in 10 min, then FAILED). Check `docker logs mo-rev-<revision id>`. Exit code 3 means a checksum mismatch, 4 a load error.
4. **503 NO_READY_REVISION:** nothing healthy is serving. See the revision's state; deploy or roll back.
