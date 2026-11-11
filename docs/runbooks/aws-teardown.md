# Runbook: deploy and tear down the AWS demo (never run by this project)

> **ModelOps Cloud never applies its Terraform (ADR-0008).** This runbook exists so that the
> design is complete and honest: it says exactly what someone would have to do, and undo, to run
> it in their own AWS account, and what keeps costing money if a step is skipped. Cost figures:
> [`infra/terraform/envs/demo/cost.md`](../../infra/terraform/envs/demo/cost.md).

## Before any deploy: what the application still lacks

The Terraform is complete; the application is not yet ready for AWS in two places:

1. **No `EcsDriver`.** The worker can run model servers on Docker and Kubernetes (M5, M10), not on
   ECS. The roles, security group, log group and Cloud Map namespace for it exist in Terraform.
2. **Static S3 keys.** The API, worker and ml-worker read `MO_S3_ACCESS_KEY`/`MO_S3_SECRET_KEY`.
   On AWS they should use the task role (the SDK's default credential chain) instead; until then
   an IAM user's keys would have to be stored in SSM, which this design deliberately avoids.

## Deploy (for completeness)

1. Request an ACM certificate for your domain (free) and validate it.
2. Create the secrets as SSM SecureString parameters, one path per component (each execution role
   can read only its own path):

   | Path `/modelops/demo/<component>/` | Parameters |
   |---|---|
   | `api/`, `worker/` | `DATABASE_URL`, `REDIS_URL`, `MO_API_SESSION_PEPPER`, `MO_S3_ACCESS_KEY`, `MO_S3_SECRET_KEY`, `MO_ML_WORKER_TOKEN`, `MO_GATEWAY_INTERNAL_TOKEN`, `MO_API_KEY_PEPPER` |
   | `gateway/` | `REDIS_URL`, `MO_API_KEY_PEPPER`, `MO_GATEWAY_INTERNAL_TOKEN` |
   | `ml-worker/` | `MO_ML_WORKER_TOKEN`, `MO_S3_VALIDATOR_ACCESS_KEY`, `MO_S3_VALIDATOR_SECRET_KEY` |
   | `mlflow/` | `MLFLOW_BACKEND_STORE_URI` |
   | `redis/` | `REDIS_PASSWORD` |

   `aws ssm put-parameter --type SecureString --name /modelops/demo/api/DATABASE_URL --value ...`
   The database password is the RDS-managed secret (`database_master_secret_arn` output).
3. `cp terraform.tfvars.example terraform.tfvars`, fill it in (`ttl` = the date it must be gone).
4. `terraform init && terraform apply` in `infra/terraform/envs/demo` (services at 0 tasks).
5. Push images to the ECR repositories (`ecr_repository_urls`; the `ci_role_arn` role lets the
   main branch of the repository do it via OIDC), run the database migrations, then scale up:
   `terraform apply -var desired_count=1`.
6. Point the domain at `load_balancer_dns_name`.

## Teardown (in this order)

| Step | Command / action | Why |
|---|---|---|
| 1. Stop the tasks | `terraform apply -var desired_count=0` | Stops Fargate and task IPv4 charges immediately |
| 2. Delete model-server services the worker created | `aws ecs list-services --cluster modelops-demo` → `aws ecs delete-service --force` for each `mo-rev-*` | Terraform does not know them; the cluster cannot be deleted while they exist |
| 3. Lift protection | `terraform apply -var deletion_protection=false -var teardown=true` | Database and load balancer refuse deletion otherwise; `teardown` lets non-empty buckets and repositories go and skips the final snapshot |
| 4. Destroy | `terraform destroy -var deletion_protection=false -var teardown=true` | Everything Terraform created |
| 5. Check for leftovers | Cost Explorer filtered by tag `project=modelops-cloud`; the console's EC2 → Elastic IPs and RDS → Snapshots pages | A manual snapshot or a kept final snapshot keeps billing for storage |
| 6. Delete the SSM parameters and the ACM certificate | `aws ssm delete-parameters --names ...` | Free, but they are secrets: leave nothing behind |
| 7. Keep the budget alarm one more month | — | It catches anything step 5 missed |

What keeps costing money if a step is skipped: the load balancer, the database and its storage,
public IPv4 addresses (about $40/month together, idle), ECR images and S3 objects (cents per GB).
