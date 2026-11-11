# network: VPC, two public subnets, no NAT gateway (docs/11 §2: ~$33/month saved), a free S3
# gateway endpoint, VPC flow logs, and one security group per component with the minimum rules.
#
# Why public subnets: tasks pull images and write logs over the internet instead of through a NAT
# gateway or interface endpoints (~$7/month each). Nothing is reachable from the internet except
# the load balancer: every task security group accepts traffic only from other security groups.

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true # Cloud Map private DNS (mo-rev-<id>.<namespace>) needs both
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# The default security group allows all traffic between its members: strip every rule.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-default-unused" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 8, count.index)
  # Tasks get a public IP only where the ECS service asks for one, never by default.
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${var.azs[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Gateway endpoints cost nothing: S3 traffic (artifacts, presigned downloads) stays on AWS's network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]
  tags              = { Name = "${var.name}-s3" }
}

# Private DNS for service-to-service calls: api.<namespace>, and one name per model server,
# mo-rev-<id>.<namespace> (the gateway's MO_MODEL_SERVER_DOMAIN, as on Kubernetes in M10).
resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = var.namespace
  description = "ModelOps services and model servers"
  vpc         = aws_vpc.this.id
}

# ---------------------------------------------------------------------------------------------
# Flow logs (rejected traffic only: what an operator needs to debug a security group, at a
# fraction of the volume of ALL)
# ---------------------------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "flow" {
  #checkov:skip=CKV_AWS_158:Encrypted with the CloudWatch-managed key; a customer KMS key costs $1/month per key for no gain in a demo
  #checkov:skip=CKV_AWS_338:7-day retention on purpose (cost control, docs/11 §4); a year of logs is for production
  name              = "/${var.name}/vpc-flow-logs"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "flow_write" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.flow.arn}:*"]
  }
}

resource "aws_iam_role" "flow" {
  name               = "${var.name}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_assume.json
}

resource "aws_iam_role_policy" "flow" {
  name   = "write-flow-logs"
  role   = aws_iam_role.flow.id
  policy = data.aws_iam_policy_document.flow_write.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "REJECT"
  log_destination = aws_cloudwatch_log_group.flow.arn
  iam_role_arn    = aws_iam_role.flow.arn
}

# ---------------------------------------------------------------------------------------------
# Security groups: one per component; rules reference groups, never CIDRs, except the load
# balancer's public HTTPS listener and HTTPS egress to AWS APIs and image registries.
# ---------------------------------------------------------------------------------------------
locals {
  groups = {
    alb          = "Public load balancer (HTTPS only)"
    web          = "Web console tasks"
    api          = "Management API tasks"
    worker       = "Worker tasks (no inbound)"
    gateway      = "Inference gateway tasks"
    ml_worker    = "Model validator tasks"
    mlflow       = "MLflow tracking server tasks"
    redis        = "Redis task (routing snapshot, queues)"
    model_server = "Model servers, one ECS service per revision"
    db           = "RDS PostgreSQL"
  }

  # who -> whom on which port (the same paths as the local Docker networks, docs/02)
  internal = [
    { from = "alb", to = "web", port = 3300, why = "console" },
    { from = "alb", to = "api", port = 4000, why = "/api/*" },
    { from = "alb", to = "gateway", port = 8080, why = "/v1/* inference" },
    { from = "web", to = "api", port = 4000, why = "Next.js /api rewrite" },
    { from = "api", to = "gateway", port = 8081, why = "gateway admin (playground)" },
    { from = "worker", to = "gateway", port = 8081, why = "model-server probes via the gateway" },
    { from = "api", to = "ml_worker", port = 8000, why = "validation" },
    { from = "worker", to = "ml_worker", port = 8000, why = "validation, drift checks" },
    { from = "api", to = "mlflow", port = 5000, why = "runs, registry" },
    { from = "worker", to = "mlflow", port = 5000, why = "registry mirror" },
    { from = "api", to = "redis", port = 6379, why = "queues, sessions" },
    { from = "worker", to = "redis", port = 6379, why = "queues, routing snapshot" },
    { from = "gateway", to = "redis", port = 6379, why = "routing snapshot, API keys" },
    { from = "gateway", to = "model_server", port = 8000, why = "inference" },
    { from = "api", to = "db", port = 5432, why = "PostgreSQL" },
    { from = "worker", to = "db", port = 5432, why = "PostgreSQL" },
    { from = "mlflow", to = "db", port = 5432, why = "MLflow backend store" },
  ]

  # Tasks reach AWS APIs, ECR and S3 over HTTPS (no NAT, no interface endpoints: docs/11 §2).
  https_out = ["web", "api", "worker", "gateway", "ml_worker", "mlflow", "redis", "model_server"]
}

resource "aws_security_group" "this" {
  #checkov:skip=CKV2_AWS_5:Attached in other modules through inputs checkov does not follow (ALB, ECS services, RDS in envs/demo); model_server is attached at runtime by the worker to each mo-rev-* service
  for_each    = local.groups
  name        = "${var.name}-${replace(each.key, "_", "-")}"
  description = each.value
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-${replace(each.key, "_", "-")}" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.this["alb"].id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "internal" {
  for_each                     = { for r in local.internal : "${r.from}-${r.to}-${r.port}" => r }
  security_group_id            = aws_security_group.this[each.value.to].id
  referenced_security_group_id = aws_security_group.this[each.value.from].id
  description                  = "${each.value.from} -> ${each.value.to}: ${each.value.why}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "internal" {
  for_each                     = { for r in local.internal : "${r.from}-${r.to}-${r.port}" => r }
  security_group_id            = aws_security_group.this[each.value.from].id
  referenced_security_group_id = aws_security_group.this[each.value.to].id
  description                  = "${each.value.from} -> ${each.value.to}: ${each.value.why}"
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "https" {
  for_each          = toset(local.https_out)
  security_group_id = aws_security_group.this[each.key].id
  description       = "HTTPS to AWS APIs, ECR and S3"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
