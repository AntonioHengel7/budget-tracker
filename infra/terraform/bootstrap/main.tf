# Chicken-and-egg fix for remote state: the S3 bucket + DynamoDB lock table
# that infra/terraform/environments/staging uses as its *remote* backend
# have to exist somewhere before that config can point at them, so this
# tiny module uses plain LOCAL state (there's no bucket to point at yet)
# and is applied exactly once, rarely touched again afterward.
#
# Apply order: `bootstrap` first (once), then `environments/staging`.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "tf_state" {
  bucket = var.state_bucket_name

  # Disposable-learning-environment posture: still worth versioning so a
  # bad `apply` doesn't silently destroy the only copy of the state file.
  tags = {
    Project = "budget-tracker"
    Purpose = "terraform-remote-state"
  }
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# State files can contain secrets (e.g. resource attributes); this bucket
# must never be reachable except via authenticated AWS API calls.
resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tf_locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST" # no idle cost -- pay only per lock operation
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Project = "budget-tracker"
    Purpose = "terraform-state-locking"
  }
}
