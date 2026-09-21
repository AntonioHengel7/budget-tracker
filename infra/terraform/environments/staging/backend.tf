# Placeholder values -- fill in with bootstrap's actual outputs
# (`terraform output` in infra/terraform/bootstrap) before running
# `terraform init` here. Terraform's backend block can't reference
# variables/outputs from another module, so these have to be hardcoded
# once bootstrap exists.
terraform {
  backend "s3" {
    bucket         = "budget-tracker-tfstate" # bootstrap's state_bucket_name output
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "budget-tracker-tf-locks" # bootstrap's lock_table_name output
    encrypt        = true
  }
}
