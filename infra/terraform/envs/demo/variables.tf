variable "region" {
  description = "AWS region (prices in infra/terraform/envs/demo/cost.md are for us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "azs" {
  description = "Two availability zones in the region."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "environment" {
  description = "Environment name; part of every resource name."
  type        = string
  default     = "demo"
}

variable "ttl" {
  description = "Date (YYYY-MM-DD) after which this deployment should be torn down; a tag on every resource."
  type        = string

  validation {
    condition     = can(regex("^\\d{4}-\\d{2}-\\d{2}$", var.ttl))
    error_message = "ttl must be a date, YYYY-MM-DD."
  }
}

variable "domain" {
  description = "Public host name of the deployment (the ACM certificate must cover it)."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener."
  type        = string
}

variable "image_tag" {
  description = "Image tag to run from ECR (CI tags images with the git commit SHA)."
  type        = string
}

variable "desired_count" {
  description = "Tasks per service. Keep 0 except during a demo (docs/11 §4)."
  type        = number
  default     = 0
}

variable "budget_limit_usd" {
  description = "Monthly cost budget; alerts at 80 % of actual and 100 % of forecast spend."
  type        = number
  default     = 5
}

variable "budget_email" {
  description = "Where budget alerts go."
  type        = string
}

variable "github_repository" {
  description = "owner/name whose main branch may push images (CI role, OIDC)."
  type        = string
  default     = "Kartavya1905/modelops-cloud"
}

variable "deletion_protection" {
  description = "Deletion protection on the database and the load balancer. Set to false (and apply) only as the first step of the teardown (docs/runbooks/aws-teardown.md)."
  type        = bool
  default     = true
}

variable "teardown" {
  description = "true only right before `terraform destroy`: allows deleting non-empty buckets and repositories and skips the final DB snapshot (docs/runbooks/aws-teardown.md)."
  type        = bool
  default     = false
}
