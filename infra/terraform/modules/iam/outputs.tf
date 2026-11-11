output "execution_role_arns" {
  description = "ECS execution role ARN per component."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}

output "task_role_arns" {
  description = "Application (task) role ARN per component."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}

output "ci_role_arn" {
  description = "Role GitHub Actions assumes (OIDC) to push images from main."
  value       = aws_iam_role.ci.arn
}
