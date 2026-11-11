variable "name" {
  description = "Name prefix, e.g. modelops-demo."
  type        = string
}

variable "components" {
  description = "ECS components that get an execution role and a task role."
  type        = list(string)
  default     = ["web", "api", "worker", "gateway", "ml_worker", "mlflow", "redis", "model_server"]
}

variable "cluster_name" {
  description = "ECS cluster name (the worker may manage mo-rev-* services in this cluster only)."
  type        = string
}

variable "namespace_arn" {
  description = "Cloud Map namespace the model servers register in."
  type        = string
}

variable "repository_arns" {
  description = "ECR repository ARN per image (from the ecr module)."
  type        = map(string)
}

variable "bucket_arns" {
  description = "S3 bucket ARN per bucket key (from the s3 module)."
  type        = map(string)
}

variable "log_group_arns" {
  description = "CloudWatch log group ARN per component, keys with dashes (from the logging module)."
  type        = map(string)
}

variable "ssm_prefix" {
  description = "SSM parameter path prefix; each component reads /<prefix>/<component>/* only."
  type        = string
}

variable "github_repository" {
  description = "owner/name of the GitHub repository whose main branch may push images."
  type        = string
}
