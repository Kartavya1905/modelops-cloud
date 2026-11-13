# Milestone 11 — CI/CD and Optional AWS Infrastructure (validate-only)

> **Status: done.** Verified locally on 2026-11-11 (Windows 11), then on GitHub: the new pipeline's second run, [run 43080634686](https://github.com/Kartavya1905/modelops-cloud/actions/runs/43080634686), is green end to end, including `migrations`, `terraform`, `ci-ok` and the first GHCR publish. **No `terraform apply`, no AWS account, no cost (ADR-0008).**

## A. Problem being solved

Two gaps were left after M10:

1. **CI was one long workflow that always ran everything**, with actions pinned by moving tags and images by tags only. A docs change waited 40 minutes; a hijacked tag could change what CI executes; nothing published the images.
2. **The AWS design (docs/11) existed only as prose.** Nothing proved that the IAM was least privilege, that the network admitted only what it should, or what it would cost.

M11 turns both into code that is checked on every pull request, while keeping the rule that this project never spends money.

## B. Architecture decisions

| Decision | Why |
|---|---|
| **One pipeline with path filters** (`dorny/paths-filter`): `quality` and `security` always run; the Python jobs, `migrations`, `terraform`, `stack` and `kind` only when their files changed; pushes to `main` and manual runs test everything | A pull request pays only for what it touches. A change to `.github/` runs everything |
| **`ci-ok`, the single required check**: green only if no job failed or was cancelled (skipped by a filter is fine) | Branch protection cannot require jobs that are sometimes skipped; one aggregating job solves that |
| **Every action pinned by commit SHA** (version in a comment), **every image by digest** (Dockerfiles, compose, kind node image, CI steps, scripts), **least `permissions` per job** (`contents: read` by default; `packages: write` only in `publish`) | A moved or compromised tag cannot change what runs. Dependabot keeps the pins current |
| **Dependabot with `cooldown: default-days: 7`** for npm, uv, actions, Dockerfiles, compose and Terraform, grouped weekly | The 7-day rule of ADR-0007, enforced by the tool that proposes the updates |
| **actionlint** in `quality` | Workflow expressions, `needs`/`outputs` wiring and every `run:` script (shellcheck) are checked like code |
| **Service container job `migrations`**: every migration on an empty PostgreSQL 18, then `prisma migrate diff` against `schema.prisma`; only the reviewed raw-SQL differences in `known-drift.sql` are allowed | Catches a model change without a migration (tested: an added column fails the job). Raw SQL objects Prisma cannot express (the M9 `NULLS NOT DISTINCT` index) are listed, not ignored |
| **`publish` on `main` only, after `ci-ok`**: six images built with Buildx (GitHub Actions cache per image), **scanned with Trivy before push**, pushed to GHCR with an **SBOM and max provenance**, tagged with the commit SHA and `main` | Free for public packages. New GHCR packages start private; making them public is the owner's choice in package settings |
| **Playwright traces as artifacts**: on failure, the HTML report and `test-results/**/trace.zip` | A failed browser test can be replayed step by step (`npx playwright show-trace`) |
| **Terraform: seven modules + `envs/demo`**, checked by `pnpm tf:check` (fmt, validate, tflint with the AWS ruleset, checkov) in pinned containers, locally and in CI | No credentials needed; the same command everywhere |
| **Secrets never in Terraform state**: SSM SecureString parameters per component path, created out of band; RDS keeps its own master password in Secrets Manager | `terraform.tfstate` is a plain file; secret values do not belong in it |
| **HTTPS-only load balancer** (no port 80 at all), path routing `/api/*`, `/v1/*`, default → web | No redirect listener to get wrong; checkov's TLS checks pass rather than being skipped |
| **Per-component IAM**: an execution role and a task role for each of 8 components; only 4 task roles have any permission (S3, bucket-scoped); the worker may manage only `mo-rev-*` services in its cluster and pass only the model-server roles; CI assumes a role through GitHub OIDC, from `main`, to push to these repositories only | docs/11 §3, now enforced by code |
| **Web image with Next.js standalone output** (opt-in by `NEXT_OUTPUT=standalone`, so `next start` in dev and CI is unchanged) | 1.06 GB → 390 MB, verified serving on kind |

### Deviations from the roadmap (honest list)

- **"The PR pipeline is green end to end" is not verified yet.** Everything it runs was run locally (section H), and the workflow passes actionlint, but GitHub has not executed it: nothing is committed. It will be recorded after the push.
- **Integration tests do not use service containers.** They need the whole compose stack (SeaweedFS with its bucket set-up, MLflow, ml-worker, the Docker socket proxy, internal networks), which service containers cannot express. The new `migrations` job is the service-container job.
- **No `terraform plan` in CI.** Plan needs AWS credentials (it reads the account), which this project does not have by design. `validate` + tflint + checkov is the strongest check possible without an account.
- **Two application changes would be needed before an AWS deployment could run:** an `EcsDriver` and S3 access through the task role instead of static keys. Both are written down in the [teardown runbook](../runbooks/aws-teardown.md); building them would be work for a deployment nobody will run.
- **Node.js 26 was reviewed and not adopted** (ADR-0007 addendum 4).
- **docs/11's cost claim was wrong:** `desired_count = 0` does not make the deployment free; the load balancer, database and two public addresses still cost about $40 a month. Corrected in docs/11 and in `cost.md`.

## C. Dependencies

No product dependencies. Tools (containers, pinned by digest; versions ≥ 7 days old): Terraform 1.17.1, AWS provider 6.71.0, tflint 0.65.0 + AWS ruleset 0.50.0, checkov 3.4.3, actionlint 1.7.12. Actions: see docs/13.

## D/E. Repository changes and file paths

```text
.github/workflows/ci.yml                 path filters, SHA pins, migrations, terraform, ci-ok, publish
.github/dependabot.yml                   6 ecosystems, 7-day cooldown
infra/terraform/modules/                 network, logging, ecr, s3, iam, database, ecs
infra/terraform/envs/demo/               main.tf (+ budget), variables, outputs, versions, lock file,
                                         terraform.tfvars.example, cost.md
infra/terraform/.tflint.hcl, .gitignore
scripts/terraform-check.mjs              pnpm tf:check
scripts/check-migrations.mjs             migrations vs schema.prisma
apps/api/prisma/known-drift.sql          reviewed raw-SQL differences
apps/web/Dockerfile, next.config.ts      standalone output (390 MB)
infra/k8s/base/web.yaml                  cache mount for the new layout
Dockerfiles, docker-compose.yml, infra/kind/cluster.yaml, scripts/*.mjs   images by digest
docs/runbooks/aws-teardown.md            deploy (for completeness) and teardown, in order
```

## G. Setup commands

```bash
pnpm tf:check     # Docker only; ~1 min after the first run (provider and plugin caches in volumes)
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:15432/<empty database> node scripts/check-migrations.mjs
```

## H. Results (real outputs, 2026-11-11)

**Terraform** (`pnpm tf:check`):

```text
== terraform fmt
== terraform init
== terraform validate
Success! The configuration is valid.
== tflint --init
== tflint
== checkov
Passed checks: 450, Failed checks: 0, Skipped checks: 63
terraform-check: fmt, validate, tflint and checkov all passed
```

The first checkov run had 31 failures. One was real (the database's deletion protection was an expression checkov could not evaluate; it is now its own variable, default `true`). Twenty were false positives from checkov not following `for_each` across resources: they disappeared after indexing the S3 sibling resources by bucket key, which checkov resolves (the buckets now pass encryption, versioning, public-access-block and lifecycle checks). The last ten (security groups "not attached", because they are attached in other modules) are one documented skip.

**Every skip, with its reason** (inline in the code; 63 skipped = 17 comments × the resources they cover):

| Check | Where | Reason |
|---|---|---|
| CKV_AWS_158, CKV_AWS_338 | log groups | AWS-managed key (a customer key is $1/month); 7-day retention on purpose |
| CKV_AWS_136 | ECR | AES-256 by ECR; a customer key adds cost and no control a demo needs |
| CKV_AWS_18, CKV_AWS_144, CKV2_AWS_62 | S3 | access logs need another unbounded bucket; replication doubles cost; no consumer for events |
| CKV_AWS_157, CKV_AWS_118, CKV_AWS_354 | RDS | Single-AZ, no enhanced monitoring, AWS-managed key for Performance Insights: cost |
| CKV_AWS_91, CKV2_AWS_28 | load balancer | access logs (unbounded bucket); WAF ≥ $5/month, and the gateway enforces keys, rate limits and input validation |
| CKV_AWS_378 | target groups | TLS ends at the load balancer; tasks admit only the load balancer's security group |
| CKV_AWS_333 | ECS services | public IPs instead of a NAT gateway (docs/11 §2); security groups admit nothing from the internet |
| CKV_AWS_356 (×2), CKV_AWS_111 | IAM | `ecr:GetAuthorizationToken` and three ECS task-definition actions have no resource-level permissions |
| CKV2_AWS_5 | security groups | attached in other modules (checkov does not follow module inputs); the model-server group is attached at runtime |

**Migrations** (`check-migrations.mjs` against an empty database): `migrations match schema.prisma (1 known raw-SQL difference(s))`. With a column added to `schema.prisma` and no migration: `unexpected drift: ALTER TABLE "organizations" ADD COLUMN "drift_probe" INTEGER;`, exit 1.

**Workflows:** actionlint 0 findings (it found one shellcheck warning in an M5 loop, fixed).

**Images:** every base image builds from its digest (gateway rebuilt and checked). The web image is 390 MB (was 1.06 GB) and serves the console and the `/api` rewrite on kind (HTTP 200 for both).

**Secrets:** gitleaks over every new or changed directory: no leaks. (It does flag `infra/k8s/overlays/kind/secrets.env`, which is generated with the local secrets and gitignored, as designed in M10.)

**Cost** ([cost.md](../../infra/terraform/envs/demo/cost.md)): about $0.29/hour running, $1.20 for a 4-hour demo, about $40/month if left idle, about $210/month always on. Never incurred.

## I. Expected behaviour

- A pull request that only changes `docs/` runs `changes`, `quality`, `security` and `ci-ok` (a few minutes). One that touches `infra/terraform/` adds `terraform`; one that touches `apps/` adds `stack` and `kind`.
- A push to `main` runs everything and then publishes `ghcr.io/<owner>/modelops-{api,web,gateway,model-server,ml-worker,mlflow}:<sha>` and `:main`.
- Dependabot opens grouped pull requests on Mondays, for releases at least 7 days old.

## J. Debugging

| Symptom | Check |
|---|---|
| `ci-ok` red, everything else green or skipped | a job was cancelled (a newer push to the same pull request) |
| `stack`/`kind` skipped unexpectedly | the path filter: does the change touch their paths? A change to `.github/` runs all |
| `terraform` fails at `tflint --init` | GitHub API rate limit: the job passes `GITHUB_TOKEN` for that |
| `migrations` fails with "unexpected drift" | a model changed without `pnpm --filter @modelops/api db:migrate`; or a new raw-SQL object that belongs in `known-drift.sql` after review |
| `publish` fails at the Trivy step | a new CRITICAL vulnerability with a fix: update the base image (Dependabot's PR) |

## K. Acceptance criteria (roadmap M11)

| Criterion | Status |
|---|---|
| Full pipeline: path filters, caching, service containers, Playwright traces, image build + scan, GHCR publish | ✅ [run 43080634686](https://github.com/Kartavya1905/modelops-cloud/actions/runs/43080634686) |
| Terraform modules: network, IAM least privilege, ECR, S3, ECS Fargate, CloudWatch logging (+ database, budget) | ✅ |
| fmt, validate, tflint, checkov | ✅ 0 failures, every skip documented |
| Written cost estimate + teardown runbook | ✅ |
| No `terraform apply`, no AWS account | ✅ |
| The PR pipeline is green end to end | ✅ [run 43080634686](https://github.com/Kartavya1905/modelops-cloud/actions/runs/43080634686) |

## L. Completion checklist

- [x] `pnpm tf:check` green; migrations check green and proven to fail on drift; actionlint clean
- [x] Docs: docs/06, 07, 10, 11 (as built + cost correction), 13, ADR-0007 addendum 4, runbooks, README, PROGRESS
- [x] Committed, pushed, CI green: [run 43080634686](https://github.com/Kartavya1905/modelops-cloud/actions/runs/43080634686)
