# RateLimiterFailingOpen

**Means:** the gateway's per-key rate limiter could not reach Redis, so it let requests through instead of refusing them (fail open: availability before strict limits, docs/02).

**Confirm**
- Redis health (`pnpm dev:ps`) and the gateway log around the alert.

**Act**
1. Short Redis blips (a restart) need nothing: the limiter recovers with Redis.
2. If it lasts, restore Redis first. While it is down, rate limits are not enforced, so watch request rates in Grafana for abusive keys and revoke them (revocation is cached for up to 30 s, SEC-10).
