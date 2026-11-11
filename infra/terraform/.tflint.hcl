# tflint for every module and environment (`tflint --recursive`, CI job `terraform`).
# The AWS ruleset checks values the AWS API would reject (instance classes, regions, ...)
# without credentials; deep checking (calls to AWS) stays off: no account is involved.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
