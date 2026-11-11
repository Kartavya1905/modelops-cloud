output "load_balancer_dns_name" {
  description = "Create a DNS record for var.domain pointing here."
  value       = module.ecs.load_balancer_dns_name
}

output "ecr_repository_urls" {
  description = "Push images here (CI role: ci_role_arn)."
  value       = module.ecr.repository_urls
}

output "ci_role_arn" {
  description = "Role for GitHub Actions (OIDC) to push images from main."
  value       = module.iam.ci_role_arn
}

output "database_endpoint" {
  description = "RDS endpoint (host:port)."
  value       = module.database.endpoint
}

output "database_master_secret_arn" {
  description = "Secrets Manager secret with the RDS-managed master credentials."
  value       = module.database.master_secret_arn
}

output "bucket_names" {
  description = "S3 bucket per purpose."
  value       = module.s3.bucket_names
}

output "ecs_services" {
  description = "ECS service per component (all at desired_count = var.desired_count)."
  value       = module.ecs.service_names
}
