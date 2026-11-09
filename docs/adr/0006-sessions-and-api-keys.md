# ADR-0006 — Server-side sessions for the UI, HMAC-hashed API keys for inference

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
Browser users and machine clients have different needs. JWTs in localStorage are exposed to XSS and are hard to revoke. Inference must authenticate every request with minimal latency.

## Decision
- **UI:** opaque 256-bit session token in an `HttpOnly; SameSite=Lax` cookie. Only a SHA-256 of the token is stored server-side. Explicit CSRF token header on mutations. Instant revocation on logout or role change.
- **Inference:** project-scoped API keys `mo_<prefix>_<secret>`. The DB stores `HMAC-SHA256(pepper, secret)`. The gateway caches verified keys for ≤ 30 s, which bounds how long a revoked key keeps working.
- **Passwords:** Argon2id.

## Consequences
- ➕ Revocation works; secrets are never stored in plain text; fast hot path.
- ➖ Session lookup on each management request (cheap: indexed and cacheable).
- ➖ Revocation takes up to 30 s to reach the gateway (documented, tested by SEC-10).

## Alternatives considered
- **JWT access + refresh tokens:** rejected for the UI (revocation complexity, no benefit with a single backend).
- **Argon2 for API keys:** rejected, because high-entropy secrets don't need slow hashing and it would add latency per request.
- **Third-party auth (Auth0, Clerk):** rejected because of the zero-cost and self-hosted constraints, and because building auth correctly is part of the learning goal.

## Addendum — M5 implementation (2026-11-04)
- **Format:** `mo_<10-char prefix>_<43-char base64url secret>`. The prefix alphabet has no `_`, so the key splits unambiguously. Postgres stores `HMAC-SHA256(MO_API_KEY_PEPPER, secret)`. The secret is returned once and never listed, logged or audited; the audit row records only the prefix.
- **Gateway lookup:** the gateway never queries Postgres. The API publishes `{projectId, hash, scopes, revoked, expiresAt}` to Redis (`mo:apikey:<prefix>`) on create and revoke, and the reconciler re-syncs every key every 15 s.
- **Verification:** constant-time comparison. Verified keys are cached for at most `MO_GATEWAY_KEY_CACHE_MS` (30 s); unknown prefixes for 5 s, so random keys can't hammer Redis.
- **Revocation:** besides the bounded TTL, a revoke publishes on `mo:apikeys:changed` and gateways evict immediately. Measured in the integration test: under 5 s (SEC-10).
- **Scope:** keys are project-scoped. Routing is keyed by `<projectId>/<slug>`, so another project's endpoint simply doesn't exist for a key (404, SEC-11).
