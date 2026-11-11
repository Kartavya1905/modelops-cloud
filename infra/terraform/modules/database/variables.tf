variable "name" {
  description = "Instance identifier, e.g. modelops-demo."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets of the DB subnet group (two availability zones)."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group that admits only the api, worker and mlflow tasks on 5432."
  type        = string
}

variable "major_version" {
  description = "PostgreSQL major version (local development runs 18)."
  type        = string
  default     = "18"
}

variable "instance_class" {
  description = "Instance class (db.t4g.micro is the smallest Graviton class)."
  type        = string
  default     = "db.t4g.micro"
}

variable "deletion_protection" {
  description = "Refuse deletion; set to false only for the teardown (docs/runbooks/aws-teardown.md)."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy (a kept snapshot keeps costing storage)."
  type        = bool
  default     = false
}
