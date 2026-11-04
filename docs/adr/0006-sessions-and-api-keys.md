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
