# The AWS free-plan deployment (docs/14-aws-free-plan.md, ADR-0009): ModelOps Cloud on ONE EC2
# server running the same Docker Compose stack as a laptop. Built to fit inside the AWS free
# plan's credits, unlike envs/demo (ECS Fargate + RDS + NAT, ~$0.29/hour, ADR-0008).
#
#   pnpm aws:up       create or update (asks for confirmation; passes your IP as allowed_cidrs)
#   pnpm aws:stop     stop the server: compute stops using credits, the disk keeps the data
#   pnpm aws:start    start it again (new public IP; the platform picks it up on boot)
#   pnpm aws:down     delete everything this file creates
#
# What it creates: a security group (your IP only, three ports in; HTTP/HTTPS out), an IAM role
# that only lets AWS Systems Manager open a shell (no SSH port, no key pair), and the server.
# Secrets are generated ON the server at first boot; none are in Terraform or its state.

data "aws_vpc" "default" {
  default = true
}

# Not every availability zone offers every instance type: use one that has the chosen type.
data "aws_ec2_instance_type_offerings" "here" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }

  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.here.locations
  }
}

# Canonical publishes the current Ubuntu image id here; Docker's apt repository supports 26.04.
data "aws_ssm_parameter" "ubuntu" {
  name = var.ami_parameter
}

locals {
  name = "modelops-free-plan"

  # The three ports reachable from allowed_cidrs. Postgres, Redis, object storage, MLflow,
  # Prometheus, the API itself and the gateway's admin port are never exposed.
  ports = {
    web     = 3300
    gateway = 18088
    grafana = 13001
  }
  ingress = {
    for pair in setproduct(keys(local.ports), var.allowed_cidrs) :
    "${pair[0]}-${pair[1]}" => { port = local.ports[pair[0]], cidr = pair[1], what = pair[0] }
  }
}

# ---- Network ------------------------------------------------------------------------------------
resource "aws_security_group" "server" {
  name        = local.name
  description = "ModelOps Cloud free-plan server: web console, gateway and Grafana from allowed_cidrs only"
  vpc_id      = data.aws_vpc.default.id

  tags = { Name = local.name }
}

resource "aws_vpc_security_group_ingress_rule" "app" {
  for_each = local.ingress

  security_group_id = aws_security_group.server.id
  description       = "ModelOps ${each.value.what} from an allowed address"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
}

# Out: only HTTP and HTTPS (Ubuntu packages, Docker Hub, GitHub, PyPI, npm, Systems Manager).
# DNS and time sync use the VPC's link-local services, which security groups do not filter.
resource "aws_vpc_security_group_egress_rule" "web_out" {
  for_each = { http = 80, https = 443 }

  security_group_id = aws_security_group.server.id
  description       = "Outbound ${each.key}: packages, images, source code, Systems Manager"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
  cidr_ipv4         = "0.0.0.0/0"
}

# ---- Access: AWS Systems Manager instead of SSH ---------------------------------------------
resource "aws_iam_role" "server" {
  name        = local.name
  description = "ModelOps free-plan server: Systems Manager shell access only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "server" {
  name = local.name
  role = aws_iam_role.server.name
}

# ---- The server ---------------------------------------------------------------------------------
resource "aws_instance" "server" {
  #checkov:skip=CKV_AWS_88:It needs a public IP to be reachable at all; the security group admits only allowed_cidrs (a /32 by default), and an Elastic IP or load balancer would cost credits
  #checkov:skip=CKV_AWS_126:Detailed monitoring is billed; basic 5-minute metrics are enough for one demo server
  ami                                  = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type                        = var.instance_type
  subnet_id                            = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids               = [aws_security_group.server.id]
  iam_instance_profile                 = aws_iam_instance_profile.server.name
  associate_public_ip_address          = true
  instance_initiated_shutdown_behavior = "stop" # the auto-stop timer stops, never terminates
  ebs_optimized                        = true
  monitoring                           = false

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    repo_url        = var.repo_url
    git_ref         = var.git_ref
    auto_stop_hours = var.auto_stop_hours
  })

  # IMDSv2 only, and one network hop: the host's start script can read its public IP, containers
  # (one hop further, behind Docker's bridge) cannot reach the metadata service at all.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  lifecycle {
    # A newer Ubuntu image, or edited user data, must never replace the server and its data:
    # code updates go through `git pull` on the server (docs/14 §5).
    ignore_changes = [ami, user_data]
  }

  tags = { Name = local.name }
}
