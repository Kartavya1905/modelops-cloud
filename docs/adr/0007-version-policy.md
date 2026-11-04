# ADR-0007 — Dependency version policy

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
The brief asks for current, maintained, compatible versions. "Latest" is not always stable: on 2026-11-03 Prisma's npm `latest` tag pointed to a release candidate, TypeScript 7 (native compiler) had just shipped, and Node 26 had only just become LTS.

## Decision
1. Use the newest **stable** release (never RC, beta, or canary tags) that is compatible with the rest of the stack.
2. Prefer **LTS runtimes** with broad ecosystem support: Node 24 LTS, Python 3.12.
3. Brand-new majors (TypeScript 7) get a **compatibility spike** in the milestone that first needs them, with a written fallback.
4. Lock everything: `pnpm-lock.yaml`, `uv.lock`, container images pinned by digest.
5. Upgrades happen **between milestones**, in dedicated commits, with the test suite as the gate. Dependabot opens PRs; we merge them deliberately.
6. [`13-tech-stack-versions.md`](../13-tech-stack-versions.md) records versions and the date they were verified.

7. Respect pnpm's **minimum release age**. pnpm 12 refuses packages published very recently, giving the ecosystem time to catch a hijacked release. When it blocks a version, we pin the previous patch instead of adding it to `minimumReleaseAgeExclude`.
8. Dependency **install scripts are deny-by-default**. Each one is approved by name in `pnpm-workspace.yaml` (`allowBuilds`). Only `@swc/core` is approved so far.

## Consequences
- ➕ Reproducible builds; no surprise breakage mid-milestone.
- ➖ We may trail the newest major by a few months, which is an intentional trade-off.

## Addendum — M1 results (2026-11-03)

**TypeScript 7 spike (risk R3).** In a scratch project, TypeScript 7.0.2 compiled NestJS-style decorators and emitted correct `design:paramtypes` metadata. However, its package no longer exposes the stable compiler API (`require('typescript').createProgram` is `undefined`; only `unstable/*` entry points exist), and `typescript-eslint@8.72.1` declares `typescript >=4.8.4 <6.1.0`. **Decision: pin TypeScript 6.0.3** (the bridge release with TS 7 semantics) for the whole workspace. Revisit when typescript-eslint supports TS 7.

**Release-age policy in practice.** pnpm blocked `next@16.4.5` and `next@16.4.4` (published 2026-11-02/03) and `tailwindcss@4.3.4` (2026-11-02). Pinned instead: `next@16.4.3` (2026-10-23) and `tailwindcss` / `@tailwindcss/postcss@4.3.3` (2026-07-16).

## Addendum 2 — M2 (2026-11-04)

- **Age rule tightened:** new dependencies use the newest stable release that is **at least 7 days old** (e.g. `@nestjs/swagger` 12.0.5 instead of 12.1.0 published the day before, `lucide-react` 1.62.0 instead of 1.67.0 published the same day).
- **Prisma:** 7.10.1 stable. npm's `latest` tag still pointed to `8.0.0-rc.30`.
- **Install scripts:** approved `argon2`, `prisma`, `@prisma/engines`. **Denied `@scarf/scarf`** (install-time telemetry pulled in by `swagger-ui-dist`).
- **Peer exception:** `openapi-typescript@7.13.0` declares `typescript: ^5.x`. Generation and typecheck were verified with TS 6.0.3, and the exception is recorded in `pnpm-workspace.yaml` (`peerDependencyRules`).
