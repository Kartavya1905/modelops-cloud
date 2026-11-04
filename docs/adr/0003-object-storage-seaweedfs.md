# ADR-0003 — S3-compatible object storage: SeaweedFS instead of MinIO

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
The original brief specifies MinIO. As of 2026, MinIO's Community Edition no longer publishes official binaries or Docker images (since October 2025), had admin-console features removed earlier in 2025, and its GitHub repository has been archived. Using the last published image means running unpatched software indefinitely. The project must stay free.

## Decision
Use **SeaweedFS** (Apache-2.0, actively maintained, single-container `weed server -s3` mode) as the local S3-compatible store. All code talks to storage **only through the S3 API** (AWS SDK v3 in Node, boto3 in Python/MLflow), configured by `MO_S3_ENDPOINT`, `MO_S3_ACCESS_KEY`, `MO_S3_SECRET_KEY`, `MO_S3_REGION`, with path-style addressing.

## Consequences
- ➕ Maintained, free, and S3-compatible; swapping backends (RustFS, Garage, real S3) is a config change.
- ➕ A good interview story: we reacted to a real ecosystem change instead of following the brief blindly.
- ➖ Fewer tutorials than MinIO; presigned URL and path-style behaviour must be covered by an integration test in M1.

## Alternatives considered
- **MinIO pinned to last image (2025):** rejected because it receives no security patches.
- **Third-party MinIO rebuilds:** rejected due to unverified supply chain.
- **RustFS:** a strong MinIO-like alternative (Apache-2.0, 1.0 released), kept as fallback #1. It is younger, so SeaweedFS is preferred for maturity.
- **Garage:** fine, but needs more bootstrap steps (layout, keys); fallback #2.
