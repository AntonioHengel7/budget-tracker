variable "region" {
  description = "AWS region for the staging environment."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance size for the k3s VM. t3.small (2GiB RAM) is the practical floor for k3s -- t3.micro's 1GiB is tight once containerd + the control plane + any real workload are all running on it."
  type        = string
  default     = "t3.small"
}

# No default on purpose -- a security group that silently defaults to
# 0.0.0.0/0 for SSH/the k3s API is exactly the kind of thing that gets
# scanned and hit within minutes of going live. Must be set explicitly,
# e.g. "<your-ip>/32".
variable "admin_cidr" {
  description = "CIDR block allowed to reach SSH (22) and the k3s API (6443) -- your own IP, as a /32, not 0.0.0.0/0."
  type        = string

  # The comment above and this variable having no default only stop an
  # ACCIDENTAL open-to-the-internet security group -- neither stops someone
  # from explicitly (if unwisely) passing "0.0.0.0/0" itself. This closes
  # that gap structurally instead of relying on the comment being read.
  validation {
    condition     = var.admin_cidr != "0.0.0.0/0"
    error_message = "admin_cidr must not be 0.0.0.0/0 -- use your own IP as a /32."
  }
}

variable "ssh_public_key" {
  description = "Your SSH public key contents (e.g. `cat ~/.ssh/id_ed25519.pub`) -- only the PUBLIC key ever goes into Terraform/state. Never put a private key here."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated staging VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the single public subnet the k3s instance lives in."
  type        = string
  default     = "10.0.1.0/24"
}
