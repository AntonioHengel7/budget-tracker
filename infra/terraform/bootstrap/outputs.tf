output "state_bucket_name" {
  description = "Pass this into environments/staging's backend \"s3\" block as `bucket`."
  value       = aws_s3_bucket.tf_state.id
}

output "lock_table_name" {
  description = "Pass this into environments/staging's backend \"s3\" block as `dynamodb_table`."
  value       = aws_dynamodb_table.tf_locks.name
}
