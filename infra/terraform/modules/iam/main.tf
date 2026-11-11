# iam: least privilege per component (docs/11 §3).
#
# Two roles per ECS component:
#   execution role  what ECS itself needs to start the task: pull this component's image, write
#                   to this component's log group, read this component's secrets (SSM path
#                   /<ssm_prefix>/<component>/*). Nothing else.
#   task role       what the application code may call. Most components get no AWS permission at
#                   all (model servers download their artifact through a presigned URL).
# Plus the CI role: GitHub Actions OIDC, push to the project's repositories, from main only.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  region    = data.aws_region.current.region
  partition = data.aws_partition.current.partition

  cluster_arn  = "arn:${local.partition}:ecs:${local.region}:${local.account}:cluster/${var.cluster_name}"
  services_arn = "arn:${local.partition}:ecs:${local.region}:${local.account}:service/${var.cluster_name}"

  # Which image each component runs (the model-server image is shared by every revision).
  image_of = {
    web          = "web"
    api          = "api"
    worker       = "api" # same image, `node dist/worker.js`
    gateway      = "gateway"
    ml_worker    = "ml-worker"
    mlflow       = "mlflow"
    redis        = null # public image (ECR Public / Docker Hub), nothing to grant
    model_server = "model-server"
  }

  # S3 access of the application code, by bucket key: read, write (read + put + delete).
  s3 = {
    api = {
      read  = ["datasets", "reports"]
      write = ["model-artifacts", "uploads-staging"]
    }
    worker = {
      read  = ["datasets"]
      write = ["model-artifacts", "uploads-staging", "drift-captures", "reports"]
    }
    ml_worker = {
      read  = ["uploads-staging", "model-artifacts", "datasets", "drift-captures"]
      write = []
    }
    mlflow = {
      read  = []
      write = ["mlflow-artifacts"]
    }
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account}:*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Execution roles
# ---------------------------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  for_each           = toset(var.components)
  name               = "${var.name}-${replace(each.key, "_", "-")}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  for_each = toset(var.components)

  dynamic "statement" {
    for_each = local.image_of[each.key] == null ? [] : [local.image_of[each.key]]
    content {
      sid       = "PullOwnImage"
      actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
      resources = [var.repository_arns[statement.value]]
    }
  }

  statement {
    #checkov:skip=CKV_AWS_356:ecr:GetAuthorizationToken has no resource-level permissions; it only returns a registry login
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "OwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${var.log_group_arns[replace(each.key, "_", "-")]}:*"]
  }

  statement {
    sid       = "OwnSecrets"
    actions   = ["ssm:GetParameters"]
    resources = ["arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/${var.ssm_prefix}/${replace(each.key, "_", "-")}/*"]
  }

  statement {
    sid       = "DecryptSecureStringsViaSsm"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${local.partition}:kms:${local.region}:${local.account}:alias/aws/ssm"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = toset(var.components)
  name     = "start-task"
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------------------------------
# Task roles
# ---------------------------------------------------------------------------------------------
resource "aws_iam_role" "task" {
  for_each           = toset(var.components)
  name               = "${var.name}-${replace(each.key, "_", "-")}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "s3" {
  for_each = local.s3

  dynamic "statement" {
    for_each = length(concat(each.value.read, each.value.write)) == 0 ? [] : [1]
    content {
      sid       = "ListOwnBuckets"
      actions   = ["s3:ListBucket"]
      resources = [for b in concat(each.value.read, each.value.write) : var.bucket_arns[b]]
    }
  }

  dynamic "statement" {
    for_each = length(each.value.read) == 0 ? [] : [1]
    content {
      sid       = "ReadObjects"
      actions   = ["s3:GetObject"]
      resources = [for b in each.value.read : "${var.bucket_arns[b]}/*"]
    }
  }

  dynamic "statement" {
    for_each = length(each.value.write) == 0 ? [] : [1]
    content {
      sid       = "ReadWriteObjects"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
      resources = [for b in each.value.write : "${var.bucket_arns[b]}/*"]
    }
  }
}

resource "aws_iam_role_policy" "s3" {
  for_each = local.s3
  name     = "s3"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.s3[each.key].json
}

# The worker runs model servers (the EcsDriver, not built: docs/11 §3): one ECS service named
# mo-rev-<revision> per revision, in this cluster only, with the model-server roles only.
data "aws_iam_policy_document" "worker_runtime" {
  statement {
    sid       = "ModelServerServices"
    actions   = ["ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices"]
    resources = ["${local.services_arn}/mo-rev-*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.cluster_arn]
    }
  }

  statement {
    sid       = "ModelServerTasks"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.cluster_arn]
    }
  }

  statement {
    #checkov:skip=CKV_AWS_111:Task definitions have no resource-level permissions for Register/Deregister; the roles they may use are limited by iam:PassRole below
    #checkov:skip=CKV_AWS_356:Same: these three ECS actions only accept "*"
    sid       = "ModelServerTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "PassOnlyModelServerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task["model_server"].arn, aws_iam_role.execution["model_server"].arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "ModelServerDiscovery"
    actions   = ["servicediscovery:CreateService", "servicediscovery:DeleteService", "servicediscovery:GetService"]
    resources = [var.namespace_arn, "arn:${local.partition}:servicediscovery:${local.region}:${local.account}:service/*"]
  }
}

resource "aws_iam_role_policy" "worker_runtime" {
  name   = "run-model-servers"
  role   = aws_iam_role.task["worker"].id
  policy = data.aws_iam_policy_document.worker_runtime.json
}

# ---------------------------------------------------------------------------------------------
# CI: GitHub Actions on main pushes images to these repositories, and nothing else. No long-lived
# keys: the workflow exchanges its OIDC token for this role's short-lived credentials.
# ---------------------------------------------------------------------------------------------
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = "${var.name}-ci-image-push"
  assume_role_policy   = data.aws_iam_policy_document.ci_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ci" {
  statement {
    #checkov:skip=CKV_AWS_356:ecr:GetAuthorizationToken has no resource-level permissions; it only returns a registry login
    sid       = "RegistryLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushProjectImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
    ]
    resources = values(var.repository_arns)
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "push-images"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.ci.json
}
