output "bucket_names" {
  description = "Bucket name per key (MO_ARTIFACT_BUCKET, MO_CAPTURE_BUCKET, ... point at these)."
  value       = { for k, b in aws_s3_bucket.this : k => b.bucket }
}

output "bucket_arns" {
  description = "Bucket ARN per key (IAM policies are scoped to these)."
  value       = { for k, b in aws_s3_bucket.this : k => b.arn }
}
