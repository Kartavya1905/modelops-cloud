# database: RDS PostgreSQL, the smallest instance (db.t4g.micro), single-AZ (docs/11 §2).
# Private (no public address), encrypted, TLS required, IAM authentication available, the master
# password generated and rotated by RDS in Secrets Manager (never in Terraform state).

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg${var.major_version}"
  family = "postgres${var.major_version}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Statement logging for audits and slow queries (CKV2_AWS_30): DDL always, any query > 1 s.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "this" {
  #checkov:skip=CKV_AWS_157:Single-AZ on purpose: Multi-AZ doubles the cost of a short-lived demo (docs/11 §2)
  #checkov:skip=CKV_AWS_118:Enhanced monitoring writes per-second OS metrics to CloudWatch (extra cost); basic metrics and Performance Insights cover a demo
  #checkov:skip=CKV_AWS_354:Performance Insights uses the AWS-managed key; a customer key costs $1/month
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.major_version # RDS picks the newest minor; minor upgrades are automatic
  instance_class = var.instance_class

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                             = "modelops"
  username                            = "modelops_admin"
  manage_master_user_password         = true # RDS-managed secret in Secrets Manager
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  parameter_group_name   = aws_db_parameter_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = var.skip_final_snapshot
  final_snapshot_identifier  = var.skip_final_snapshot ? null : "${var.name}-final"

  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  performance_insights_enabled          = true
  performance_insights_retention_period = 7 # the free tier
}
