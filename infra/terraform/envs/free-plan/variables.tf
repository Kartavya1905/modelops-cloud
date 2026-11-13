variable "region" {
  description = "AWS region. us-east-1 offers every free-plan instance type."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type. Must be on the AWS free plan's list; the stack needs ~4 GiB, so only the two 'large' types fit."
  type        = string
  default     = "m7i-flex.large" # 2 vCPU, 8 GiB

  validation {
    condition     = contains(["m7i-flex.large", "c7i-flex.large"], var.instance_type)
    error_message = "Use m7i-flex.large (8 GiB, recommended) or c7i-flex.large (4 GiB, tight): both are free-plan eligible; the smaller free types cannot hold the stack."
  }
}

variable "allowed_cidrs" {
  description = "Addresses allowed to reach the web console, gateway and Grafana. `pnpm aws:up` passes your current public IP as a /32."
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0))])
    error_message = "Give at least one CIDR, e.g. [\"203.0.113.7/32\"]."
  }

  validation {
    # Open registration plus plain HTTP: the whole internet is not a safe audience (docs/14 §6).
    condition     = !anytrue([for c in var.allowed_cidrs : endswith(c, "/0")])
    error_message = "0.0.0.0/0 is refused: anyone could sign up and use your credits. List specific addresses."
  }
}

variable "ami_parameter" {
  description = "SSM public parameter holding the current Ubuntu image id (Canonical publishes it)."
  type        = string
  default     = "/aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

variable "repo_url" {
  description = "Git repository the server clones (public, so no token is needed)."
  type        = string
  default     = "https://github.com/Kartavya1905/modelops-cloud.git"
}

variable "git_ref" {
  description = "Branch or tag the server runs."
  type        = string
  default     = "main"
}

variable "volume_gb" {
  description = "Root disk size (gp3). Images and build cache need ~15 GB; data the rest."
  type        = number
  default     = 30

  validation {
    condition     = var.volume_gb >= 20 && var.volume_gb <= 40
    error_message = "Between 20 and 40 GB: less cannot hold the images, more only burns credits."
  }
}

variable "auto_stop_hours" {
  description = "The server powers itself off this many hours after each start, so a forgotten demo cannot drain the credits. 0 disables."
  type        = number
  default     = 4

  validation {
    condition     = var.auto_stop_hours >= 0 && var.auto_stop_hours <= 24 && floor(var.auto_stop_hours) == var.auto_stop_hours
    error_message = "A whole number of hours between 0 and 24."
  }
}
