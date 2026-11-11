# The AWS demo environment (docs/11): everything ModelOps needs on ECS Fargate, RDS and S3.
#
# ZERO-COST POLICY (ADR-0008): this is validated in CI (fmt, validate, tflint, checkov) and never
# applied by this project. Secrets are never in Terraform: each component reads SSM SecureString
# parameters under /modelops/<environment>/<component>/ that an operator creates out of band
# (docs/runbooks/aws-teardown.md lists them), so no secret value ever lands in the state file.

data "aws_caller_identity" "current" {}

locals {
  name       = "modelops-${var.environment}"
  ssm_prefix = "modelops/${var.environment}"
  ns         = "modelops.internal"

  images = ["web", "api", "gateway", "ml-worker", "model-server", "mlflow"]
  image  = { for i in local.images : i => "${module.ecr.repository_urls[i]}:${var.image_tag}" }

  # Same buckets as local SeaweedFS; captured inputs and staging uploads expire (docs/06).
  buckets = {
    "mlflow-artifacts" = {}
    "model-artifacts"  = {}
    "datasets"         = {}
    "reports"          = {}
    "drift-captures"   = { expire_days = 7 }
    "uploads-staging"  = { expire_days = 7 }
  }

  components = ["web", "api", "worker", "gateway", "ml-worker", "mlflow", "redis", "model-server"]

  # Settings shared by the API and the worker (secrets come from SSM, see `secrets` below).
  app_env = {
    NODE_ENV                      = "production"
    MO_API_HOST                   = "0.0.0.0"
    MO_PORT_API                   = "4000"
    MO_WEB_URL                    = "https://${var.domain}"
    MO_COOKIE_SECURE              = "true"
    MO_API_DOCS                   = "false"
    MO_S3_ENDPOINT                = "https://s3.${var.region}.amazonaws.com"
    MO_S3_INTERNAL_ENDPOINT       = "https://s3.${var.region}.amazonaws.com"
    MO_S3_REGION                  = var.region
    MO_ARTIFACT_BUCKET            = module.s3.bucket_names["model-artifacts"]
    MO_CAPTURE_BUCKET             = module.s3.bucket_names["drift-captures"]
    MO_MLFLOW_URL                 = "http://mlflow.${local.ns}:5000"
    MO_ML_WORKER_URL              = "http://ml-worker.${local.ns}:8000"
    MO_GATEWAY_URL                = "https://${var.domain}"
    MO_GATEWAY_ADMIN_URL          = "http://gateway.${local.ns}:8081"
    MO_MODEL_SERVER_IMAGE         = local.image["model-server"]
    MO_MODEL_SERVER_OTLP_ENDPOINT = ""
    MO_INSTANCE_ID                = local.name
  }
  app_secrets = [
    "DATABASE_URL",
    "REDIS_URL",
    "MO_API_SESSION_PEPPER",
    "MO_S3_ACCESS_KEY",
    "MO_S3_SECRET_KEY",
    "MO_ML_WORKER_TOKEN",
    "MO_GATEWAY_INTERNAL_TOKEN",
    "MO_API_KEY_PEPPER",
  ]

  roles = {
    for c in local.components : replace(c, "-", "_") => {
      execution_role_arn = module.iam.execution_role_arns[replace(c, "-", "_")]
      task_role_arn      = module.iam.task_role_arns[replace(c, "-", "_")]
      security_group_id  = module.network.security_group_ids[replace(c, "-", "_")]
    }
  }

  services = {
    web = merge(local.roles.web, {
      image          = local.image["web"]
      cpu            = 256
      memory         = 512
      user           = "1000:1000"
      port           = 3300
      writable_paths = ["/tmp", "/app/apps/web/.next/cache"]
      route          = { paths = [], priority = 100, health_path = "/login" }
    })
    api = merge(local.roles.api, {
      image       = local.image["api"]
      cpu         = 512
      memory      = 1024
      user        = "1000:1000"
      port        = 4000
      environment = local.app_env
      secrets     = local.app_secrets
      route       = { paths = ["/api/*"], priority = 10, health_path = "/api/v1/health/live" }
    })
    worker = merge(local.roles.worker, {
      image       = local.image["api"]
      cpu         = 512
      memory      = 1024
      user        = "1000:1000"
      command     = ["node", "--enable-source-maps", "dist/worker.js"]
      environment = local.app_env
      secrets     = local.app_secrets
    })
    gateway = merge(local.roles.gateway, {
      image      = local.image["gateway"]
      cpu        = 256
      memory     = 512
      user       = "1000:1000"
      port       = 8080
      extra_port = 8081 # admin: worker probes, /metrics (security group: api and worker only)
      environment = {
        NODE_ENV               = "production"
        MO_MODEL_SERVER_DOMAIN = local.ns
      }
      secrets = ["REDIS_URL", "MO_API_KEY_PEPPER", "MO_GATEWAY_INTERNAL_TOKEN"]
      route   = { paths = ["/v1/*"], priority = 20, health_path = "/healthz", health_port = 8081 }
    })
    ml_worker = merge(local.roles.ml_worker, {
      image  = local.image["ml-worker"]
      cpu    = 1024
      memory = 2048 # ONNX Runtime + Evidently: 714 MiB measured after drift checks (M7)
      user   = "10001:10001"
      port   = 8000
      environment = {
        MO_S3_ENDPOINT     = "https://s3.${var.region}.amazonaws.com"
        MO_S3_REGION       = var.region
        MO_ARTIFACT_BUCKET = module.s3.bucket_names["model-artifacts"]
      }
      secrets = ["MO_ML_WORKER_TOKEN", "MO_S3_VALIDATOR_ACCESS_KEY", "MO_S3_VALIDATOR_SECRET_KEY"]
    })
    mlflow = merge(local.roles.mlflow, {
      image  = local.image["mlflow"]
      cpu    = 512
      memory = 1024
      user   = "10001:10001"
      port   = 5000
      command = [
        "mlflow", "server", "--host", "0.0.0.0", "--port", "5000", "--workers", "2",
        "--serve-artifacts", "--artifacts-destination", "s3://${module.s3.bucket_names["mlflow-artifacts"]}",
      ]
      environment = {
        MLFLOW_SERVER_ALLOWED_HOSTS        = "mlflow.${local.ns},mlflow.${local.ns}:5000"
        MLFLOW_SERVER_ENABLE_JOB_EXECUTION = "false"
        AWS_DEFAULT_REGION                 = var.region
      }
      secrets = ["MLFLOW_BACKEND_STORE_URI"]
    })
    # Ephemeral by design (docs/11): routing snapshots and queues are rebuilt from Postgres.
    redis = merge(local.roles.redis, {
      image          = "public.ecr.aws/docker/library/redis:8.8.4"
      cpu            = 256
      memory         = 512
      user           = "999:999"
      port           = 6379
      command        = ["sh", "-c", "exec redis-server --requirepass \"$REDIS_PASSWORD\" --appendonly no --maxmemory 256mb --maxmemory-policy noeviction"]
      writable_paths = ["/data", "/tmp"]
      secrets        = ["REDIS_PASSWORD"]
    })
  }
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  azs                = var.azs
  namespace          = local.ns
  log_retention_days = 7
}

module "logging" {
  source         = "../../modules/logging"
  name           = local.name
  components     = local.components
  retention_days = 7
}

module "ecr" {
  source       = "../../modules/ecr"
  name         = local.name
  repositories = local.images
  keep_images  = 5
  force_delete = var.teardown
}

module "s3" {
  source        = "../../modules/s3"
  name          = local.name
  buckets       = local.buckets
  force_destroy = var.teardown
}

module "iam" {
  source            = "../../modules/iam"
  name              = local.name
  cluster_name      = local.name
  namespace_arn     = module.network.namespace.arn
  repository_arns   = module.ecr.repository_arns
  bucket_arns       = module.s3.bucket_arns
  log_group_arns    = module.logging.log_group_arns
  ssm_prefix        = local.ssm_prefix
  github_repository = var.github_repository
}

module "database" {
  source              = "../../modules/database"
  name                = local.name
  subnet_ids          = module.network.public_subnet_ids # no public address: publicly_accessible = false
  security_group_id   = module.network.security_group_ids["db"]
  deletion_protection = var.deletion_protection
  skip_final_snapshot = var.teardown
}

module "ecs" {
  source                = "../../modules/ecs"
  name                  = local.name
  account_id            = data.aws_caller_identity.current.account_id
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.public_subnet_ids
  alb_security_group_id = module.network.security_group_ids["alb"]
  certificate_arn       = var.certificate_arn
  namespace_id          = module.network.namespace.id
  log_group_names       = module.logging.log_group_names
  ssm_prefix            = local.ssm_prefix
  desired_count         = var.desired_count
  deletion_protection   = var.deletion_protection
  services              = local.services
}

# A budget alarm costs nothing (the first two budgets of an account are free).
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:project$modelops-cloud"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
