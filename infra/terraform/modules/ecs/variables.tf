variable "name" {
  description = "Cluster and load balancer name, e.g. modelops-demo."
  type        = string
}

variable "account_id" {
  description = "AWS account id (for SSM parameter ARNs)."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the load balancer and the tasks."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "Security group of the load balancer (HTTPS from the internet)."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate for the HTTPS listener (ACM certificates are free; the domain is not)."
  type        = string
}

variable "namespace_id" {
  description = "Cloud Map namespace id."
  type        = string
}

variable "log_group_names" {
  description = "Log group name per component (keys with dashes)."
  type        = map(string)
}

variable "ssm_prefix" {
  description = "SSM path prefix; a component's secrets are /<prefix>/<component>/<NAME>."
  type        = string
}

variable "desired_count" {
  description = "Tasks per service. 0 by default: nothing runs (or costs) until scaled up on purpose."
  type        = number
  default     = 0
}

variable "deletion_protection" {
  description = "Load balancer deletion protection (false only for the teardown)."
  type        = bool
  default     = true
}

variable "default_route" {
  description = "Service that answers paths no rule matches (the web console)."
  type        = string
  default     = "web"
}

variable "services" {
  description = "One Fargate service per component."
  type = map(object({
    image              = string
    cpu                = number
    memory             = number
    user               = string
    port               = optional(number)
    extra_port         = optional(number)
    command            = optional(list(string))
    environment        = optional(map(string), {})
    secrets            = optional(list(string), [])
    writable_paths     = optional(list(string), ["/tmp"])
    security_group_id  = string
    execution_role_arn = string
    task_role_arn      = string
    route = optional(object({
      paths       = list(string)
      priority    = number
      health_path = string
      health_port = optional(number)
    }))
  }))
}
