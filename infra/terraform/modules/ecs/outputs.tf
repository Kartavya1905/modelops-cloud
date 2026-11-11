output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "load_balancer_dns_name" {
  description = "Point the domain of the ACM certificate at this name."
  value       = aws_lb.this.dns_name
}

output "service_names" {
  description = "ECS service name per component (scale with `aws ecs update-service --desired-count`)."
  value       = { for k, s in aws_ecs_service.this : k => s.name }
}
