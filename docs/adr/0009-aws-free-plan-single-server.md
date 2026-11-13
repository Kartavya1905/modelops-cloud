# ADR-0009 — A live AWS deployment inside the free plan: one server

- **Status:** Accepted (amends ADR-0008)
- **Date:** 2026-11-13

## Context
ADR-0008 kept AWS validate-only: no account, no card, no apply. The owner has since opened an AWS account on the **free plan** (accounts created after 15 July 2025): $100 of credits at sign-up plus up to $100 for starter activities, valid for 6 months, and the account cannot be charged; when the credits or the 6 months run out it closes unless upgraded to a paid plan. The owner wants a live deployment that costs nothing.

The validated design in `envs/demo` (ECS Fargate, RDS, load balancer, ~$0.29/hour, docs/11) would spend the whole allowance in about a month. EC2 free-plan instance types draw on the same credits, and only two of them (`c7i-flex.large`, 4 GiB; `m7i-flex.large`, 8 GiB) can hold the stack (2.2–2.8 GiB measured for the containers in M12, plus the API, worker and web console).

## Decision
- A second environment, `infra/terraform/envs/free-plan`, runs ModelOps Cloud on **one `m7i-flex.large` server** with the same Docker Compose stack as a laptop (`infra/compose/docker-compose.cloud.yml` adds the API, worker and web console as containers). `envs/demo` stays validate-only.
- The owner applies it **with their own short-lived credentials** (`aws login`, then `pnpm aws:up`); no access keys exist, CI never holds credentials, and CI still only validates (both environments, in `pnpm tf:check`).
- Spending is bounded by design: the server **powers itself off 4 hours after every start**, is stopped between demos (`pnpm aws:stop`: compute stops using credits), has no Elastic IP, NAT gateway or load balancer, and the account has a zero-spend and a $10/month budget alert.
- Exposure is bounded too: only three ports (web console, gateway, Grafana), only from the owner's IP (`0.0.0.0/0` is rejected by validation); no SSH (AWS Systems Manager opens a shell); IMDSv2 with hop limit 1, so containers cannot read instance credentials; an encrypted disk.
- Secrets are generated on the server at first boot (`scripts/init-env.mjs`, as on a laptop) and never appear in Terraform or its state.

## Consequences
- ➕ A live URL for demos, at no cost, with the deployment reproducible from the repository.
- ➕ The single-server setup is a realistic small-company deployment of the same product.
- ➖ Plain HTTP on an IP address (no domain, no certificate): acceptable only because access is limited to known addresses. HTTPS would need a domain (docs/14 §6).
- ➖ One server, no high availability; the public IP changes on every start (the platform adopts it at boot, `pnpm aws:status` prints it).
- ➖ Time-limited: the free plan ends after 6 months or when the credits are spent. `pnpm aws:down` removes everything before that.
