variable "name" {
  description = "Name prefix, e.g. modelops-demo."
  type        = string
}

variable "components" {
  description = "One log group per component (e.g. api, worker, model-servers)."
  type        = list(string)
}

variable "retention_days" {
  description = "Log retention in days (CloudWatch charges per GB stored)."
  type        = number
  default     = 7
}
