# PredictionEventsDropped

**Means:** the gateway could not write prediction events (or feedback) to the Redis stream `mo:events`. Predictions still succeeded, but the affected predictions are missing from measured performance and drift (M7). Feedback clients got 503 and should retry.

**Confirm**
- `pnpm dev:ps`: Redis healthy? `docker exec modelops-redis-1 redis-cli INFO memory`: Redis runs with `maxmemory 200mb` and `noeviction`, so a full Redis refuses writes.
- Stream length: `docker exec modelops-redis-1 redis-cli XLEN mo:events` (capped at ~200 000).

**Act**
1. Redis down or restarting: it comes back on its own (`restart: unless-stopped`); the M9 chaos run measured ~1 s.
2. Redis full: the events worker may be behind or stopped. Check the worker log (`pnpm dev` output) for *events* errors; restart the worker. It resumes from its consumer group, so nothing that reached the stream is lost.
3. Dropped events are not replayed: the gap is visible as fewer *Labelled* predictions on the endpoint page.
