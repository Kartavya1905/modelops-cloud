# Cost estimate: the AWS demo environment

> **This project never applies this Terraform (ADR-0008), so it costs nothing.** The figures say
> what it *would* cost someone who does. Prices are us-east-1, Linux/x86, on-demand, as published
> by AWS and summarised by third-party price trackers, checked on **2026-11-11**. Re-check them in
> the [AWS Pricing Calculator](https://calculator.aws/) before any real use.

## Unit prices used

| Item | Price | Source |
|---|---|---|
| Fargate vCPU | $0.04048 per vCPU-hour | [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/) (rate as reported by price trackers) |
| Fargate memory | $0.004445 per GB-hour | same |
| Application Load Balancer | $0.0225 per hour + $0.008 per LCU-hour | [ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/) |
| RDS PostgreSQL db.t4g.micro, Single-AZ | $0.016 per hour | [RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/) |
| RDS gp3 storage | about $0.115 per GB-month (not confirmed today; check the calculator) | same |
| Public IPv4 address | $0.005 per address-hour | [AWS announcement](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/) |
| CloudWatch Logs ingestion | $0.50 per GB | [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| Secrets Manager | $0.40 per secret-month (the RDS-managed master secret) | [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/) |
| SSM Parameter Store, standard parameters | free | [Systems Manager pricing](https://aws.amazon.com/systems-manager/pricing/) |
| S3 gateway endpoint, AWS Budgets (first two) | free | — |

## What runs (desired_count = 1)

| Component | vCPU | Memory (GB) |
|---|---|---|
| web | 0.25 | 0.5 |
| api | 0.5 | 1 |
| worker | 0.5 | 1 |
| gateway | 0.25 | 0.5 |
| ml-worker | 1 | 2 |
| mlflow | 0.5 | 1 |
| redis | 0.25 | 0.5 |
| one model server (default limits) | 0.5 | 0.5 |
| **Total** | **3.75** | **7.0** |

## Per hour

| | Running a demo | Idle (`desired_count = 0`) |
|---|---|---|
| Fargate vCPU (3.75 × $0.04048) | $0.152 | $0 |
| Fargate memory (7.0 × $0.004445) | $0.031 | $0 |
| Load balancer (1 LCU at demo traffic) | $0.031 | $0.023 |
| RDS instance + 20 GB gp3 | $0.019 | $0.019 |
| Public IPv4: 8 tasks + the load balancer's 2 | $0.050 | $0.010 |
| Logs, ECR and S3 storage, secret, Cloud Map | ~$0.010 | ~$0.005 |
| **Total** | **≈ $0.29 per hour** | **≈ $0.06 per hour** |

- **A 4-hour demo:** about **$1.20** of running time.
- **Left idle for a month** with every service scaled to 0: about **$40** (load balancer, database,
  two public addresses), because those bill by the hour whether or not a task runs. Scaling to 0 is
  not a teardown; `terraform destroy` is (see [the teardown runbook](../../../../docs/runbooks/aws-teardown.md)).
- **Always on:** about **$210 per month**.

docs/11 §4 estimated $0.20–0.25 per hour at design time. The difference is the ml-worker's 2 GB
(measured in M7) and counting the load balancer's two public addresses.

## Cost controls in the code

| Control | Where |
|---|---|
| Services start at `desired_count = 0` | `modules/ecs`, `var.desired_count` |
| No NAT gateway (~$33/month + data), no interface endpoints; free S3 gateway endpoint | `modules/network` |
| Smallest Graviton database, Single-AZ, 20 GB growing to 50 GB at most | `modules/database` |
| 7-day log retention; flow logs record rejected traffic only | `modules/logging`, `modules/network` |
| ECR keeps 5 images per repository; untagged layers expire after 1 day | `modules/ecr` |
| S3: staging uploads and captured inputs expire after 7 days; old versions after 30; failed multipart uploads after 1 | `modules/s3` |
| AWS-managed KMS keys only (a customer key is $1/month each) | all modules (documented checkov skips) |
| Monthly budget of $5 with e-mail alerts at 80 % actual and 100 % forecast | `envs/demo/main.tf` |
| `ttl` tag on every resource (a date after which it should be gone) | `envs/demo/versions.tf` |
