output "log_group_names" {
  description = "Log group name per component."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.name }
}

output "log_group_arns" {
  description = "Log group ARN per component."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.arn }
}
