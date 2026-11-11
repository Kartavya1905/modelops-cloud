variable "name" {
  description = "Repository name prefix, e.g. modelops-demo (repositories are <name>/<image>)."
  type        = string
}

variable "repositories" {
  description = "Image names, e.g. api, web, gateway, ml-worker, model-server, mlflow."
  type        = list(string)
}

variable "keep_images" {
  description = "How many images each repository keeps."
  type        = number
  default     = 5
}

variable "force_delete" {
  description = "Allow `terraform destroy` to delete repositories that still hold images (teardown)."
  type        = bool
  default     = false
}
