# ecs: the cluster, an HTTPS-only application load balancer, and one Fargate service per
# component (task definition + service + Cloud Map name). Model servers are not here: the worker
# creates one service per revision at runtime (EcsDriver, not built; docs/11).
#
# Every service starts with desired_count = 0 (docs/11 §4): applying this costs nothing per hour
# until someone scales it up. Every container runs as a non-root user with a read-only root
# filesystem, no Linux capabilities and an init process; writable paths are task-local volumes.

data "aws_region" "current" {}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------------------------------------------------------------------------------------------
# Load balancer: HTTPS only (no port 80 at all), TLS 1.3/1.2 policy, routes by path:
#   /api/*  -> api       /v1/*  -> gateway       everything else -> web
# ---------------------------------------------------------------------------------------------
resource "aws_lb" "this" {
  #checkov:skip=CKV_AWS_91:Access logs need a log bucket and grow without bound; target-level logs are in CloudWatch
  #checkov:skip=CKV2_AWS_28:AWS WAF costs at least $5/month plus requests; the gateway enforces API keys, rate limits and input validation itself
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.subnet_ids
  security_groups            = [var.alb_security_group_id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  idle_timeout               = 60
}

locals {
  public = { for k, s in var.services : k => s if s.route != null }
}

resource "aws_lb_target_group" "this" {
  #checkov:skip=CKV_AWS_378:TLS ends at the load balancer; inside the VPC traffic goes to task security groups that admit only the load balancer
  for_each    = local.public
  name        = substr("${var.name}-${replace(each.key, "_", "-")}", 0, 32)
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = 30

  health_check {
    path                = each.value.route.health_path
    port                = coalesce(each.value.route.health_port, each.value.port)
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[var.default_route].arn
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each     = { for k, s in local.public : k => s if length(s.route.paths) > 0 }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.route.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.route.paths
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Service discovery: <component>.<namespace>, e.g. api.modelops.internal
# ---------------------------------------------------------------------------------------------
resource "aws_service_discovery_service" "this" {
  for_each = var.services
  name     = replace(each.key, "_", "-")

  dns_config {
    namespace_id   = var.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Task definitions and services
# ---------------------------------------------------------------------------------------------
resource "aws_ecs_task_definition" "this" {
  for_each                 = var.services
  family                   = "${var.name}-${replace(each.key, "_", "-")}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = each.value.execution_role_arn
  task_role_arn            = each.value.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  dynamic "volume" {
    for_each = each.value.writable_paths
    content {
      name = "rw-${volume.key}" # task-local (ephemeral) storage
    }
  }

  container_definitions = jsonencode([
    {
      name                   = replace(each.key, "_", "-")
      image                  = each.value.image
      essential              = true
      user                   = each.value.user
      command                = each.value.command
      readonlyRootFilesystem = true
      privileged             = false
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { drop = ["ALL"] }
      }
      portMappings = [for p in [each.value.port, each.value.extra_port] : {
        containerPort = p
        protocol      = "tcp"
      } if p != null]
      environment = [for k, v in each.value.environment : { name = k, value = v }]
      secrets = [for n in each.value.secrets : {
        name      = n
        valueFrom = "arn:aws:ssm:${data.aws_region.current.region}:${var.account_id}:parameter/${var.ssm_prefix}/${replace(each.key, "_", "-")}/${n}"
      }]
      mountPoints = [for i, p in each.value.writable_paths : {
        sourceVolume  = "rw-${i}"
        containerPath = p
        readOnly      = false
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_names[replace(each.key, "_", "-")]
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = replace(each.key, "_", "-")
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  #checkov:skip=CKV_AWS_333:Public IPs instead of a NAT gateway (docs/11 §2); security groups admit traffic only from the load balancer or other tasks
  for_each               = var.services
  name                   = replace(each.key, "_", "-")
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.this[each.key].arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [each.value.security_group_id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.this[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = each.value.route == null ? [] : [each.value.route]
    content {
      target_group_arn = aws_lb_target_group.this[each.key].arn
      container_name   = replace(each.key, "_", "-")
      container_port   = each.value.port
    }
  }

  depends_on = [aws_lb_listener.https]
}
