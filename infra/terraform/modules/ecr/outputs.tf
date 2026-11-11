output "repository_urls" {
  description = "Repository URL per image."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "repository_arns" {
  description = "Repository ARN per image (the CI role may push to these only)."
  value       = { for k, r in aws_ecr_repository.this : k => r.arn }
}
