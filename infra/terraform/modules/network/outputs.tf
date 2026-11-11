output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet ids (one per availability zone)."
  value       = aws_subnet.public[*].id
}

output "namespace" {
  description = "Cloud Map namespace: id, arn and DNS name."
  value = {
    id   = aws_service_discovery_private_dns_namespace.this.id
    arn  = aws_service_discovery_private_dns_namespace.this.arn
    name = aws_service_discovery_private_dns_namespace.this.name
  }
}

output "security_group_ids" {
  description = "Security group id per component: alb, web, api, worker, gateway, ml_worker, mlflow, redis, model_server, db."
  value       = { for k, sg in aws_security_group.this : k => sg.id }
}
