variable "name" {
  description = "Name prefix for every resource, e.g. modelops-demo."
  type        = string
}

variable "cidr" {
  description = "VPC address range."
  type        = string
  default     = "10.40.0.0/16"
}

variable "azs" {
  description = "Availability zones for the public subnets (two: the load balancer requires it)."
  type        = list(string)

  validation {
    condition     = length(var.azs) >= 2
    error_message = "An application load balancer needs subnets in at least two availability zones."
  }
}

variable "namespace" {
  description = "Private DNS namespace (Cloud Map) for service discovery."
  type        = string
  default     = "modelops.internal"
}

variable "log_retention_days" {
  description = "Retention of the VPC flow logs."
  type        = number
  default     = 7
}
