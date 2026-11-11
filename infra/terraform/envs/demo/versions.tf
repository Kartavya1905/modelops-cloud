terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0" # exact: newest release >= 7 days old (ADR-0007); Dependabot proposes bumps
    }
  }

  # State stays local by default: this environment is validated in CI and never applied
  # (ADR-0008). Anyone who does apply it should use a remote, locked backend instead, e.g.
  #
  #   backend "s3" {
  #     bucket       = "<state bucket>"
  #     key          = "modelops/demo.tfstate"
  #     region       = "us-east-1"
  #     use_lockfile = true
  #     encrypt      = true
  #   }
}

provider "aws" {
  region = var.region

  # Every resource is labelled with its project and an expiry date, so a forgotten demo is easy
  # to find (docs/11 §4).
  default_tags {
    tags = {
      project     = "modelops-cloud"
      environment = var.environment
      ttl         = var.ttl
      managed-by  = "terraform"
    }
  }
}
