variable "region" {
  description = "AWS region to create the state bucket/lock table in. Must match the region environments/staging's backend config uses."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_name" {
  description = "Globally unique S3 bucket name for Terraform remote state. S3 bucket names are global across ALL AWS accounts, so the default here will very likely already be taken -- override it."
  type        = string
  default     = "budget-tracker-tfstate"
}

variable "lock_table_name" {
  description = "DynamoDB table name used for state locking."
  type        = string
  default     = "budget-tracker-tf-locks"
}
