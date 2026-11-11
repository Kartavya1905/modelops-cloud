output "endpoint" {
  description = "host:port of the instance (build DATABASE_URL from it and the managed secret)."
  value       = aws_db_instance.this.endpoint
}

output "master_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master credentials."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}
