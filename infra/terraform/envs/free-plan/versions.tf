terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0" # exact, the same as envs/demo (ADR-0007); Dependabot proposes bumps
    }
  }

  # Local state (gitignored): one person, one laptop, one server. `pnpm aws:down` destroys
  # everything this state knows about; docs/14 §7 finds leftovers by tag if the state is lost.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "modelops-cloud"
      environment = "free-plan"
      managed-by  = "terraform"
    }
  }
}
