variable "name" {
  description = "Bucket name prefix, e.g. modelops-demo."
  type        = string
}

variable "buckets" {
  description = "Bucket key => settings. expire_days = null keeps current objects indefinitely."
  type = map(object({
    expire_days = optional(number)
  }))
}

variable "noncurrent_days" {
  description = "Days a replaced or deleted object version is kept."
  type        = number
  default     = 30
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete non-empty buckets (teardown)."
  type        = bool
  default     = false
}
