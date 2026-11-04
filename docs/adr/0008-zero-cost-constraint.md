# ADR-0008 — Zero-cost constraint

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
The project owner is a student with no budget. The brief includes optional AWS deployment.

## Decision
- Every feature must run on free, local, self-hosted tooling: Docker Desktop (free for personal and educational use), kind, open-source images, and GitHub Actions on a public repository.
- No paid APIs, SaaS, or cloud trials that require a payment card.
- AWS Terraform is written and **validated offline only** (`fmt`, `validate`, `tflint`, `checkov`). **No `terraform apply`**, no AWS credentials in CI.
- All scanners and tools used in CI are free (gitleaks, Trivy, pip-audit, pnpm audit, Dependabot).

## Consequences
- ➕ Anyone can clone and run the full project for free, which strengthens the portfolio.
- ➖ No live public URL. Demonstrated instead with a recorded demo, screenshots, and reproducible scripts.
- ➖ Cloud behaviour (IAM, ECS) is proven by validation and design review, not by running workloads. The README states this honestly.
