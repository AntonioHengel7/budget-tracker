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

# --- Networking --------------------------------------------------------
# A dedicated VPC + one PUBLIC subnet, no NAT gateway -- the k3s instance
# gets its own public IP directly instead. A NAT gateway costs ~$0.045/hr
# plus data processing charges just to sit there; for a single disposable
# learning VM that's pure waste with no real benefit (a NAT gateway exists
# to let PRIVATE instances reach the internet without being reachable FROM
# it, which doesn't apply here -- there's only one instance, and it's
# meant to be reachable for kubectl/SSH access anyway).

resource "aws_vpc" "staging" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "budget-tracker-staging"
    Project = "budget-tracker"
  }
}

resource "aws_internet_gateway" "staging" {
  vpc_id = aws_vpc.staging.id

  tags = {
    Name = "budget-tracker-staging"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.staging.id
  cidr_block              = var.subnet_cidr
  map_public_ip_on_launch = true
  availability_zone       = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "budget-tracker-staging-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.staging.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.staging.id
  }

  tags = {
    Name = "budget-tracker-staging-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

data "aws_availability_zones" "available" {
  state = "available"
}

# --- Security group ------------------------------------------------------
# SSH and the k3s API are restricted to var.admin_cidr (no default -- see
# variables.tf). Nothing else is opened; a future app-facing port (80/443)
# is a deliberate, separate decision for whoever actually deploys workloads
# here, not something this "just provision the VM" module should assume.

resource "aws_security_group" "k3s" {
  name        = "budget-tracker-staging-k3s"
  description = "SSH + k3s API, restricted to admin_cidr only"
  vpc_id      = aws_vpc.staging.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "k3s API server"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  egress {
    description = "All outbound (package installs, the k3s install script, container image pulls)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "budget-tracker-staging-k3s"
  }
}

# --- Compute ---------------------------------------------------------------

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "budget-tracker-staging-admin"
  public_key = var.ssh_public_key
}

resource "aws_instance" "k3s" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.k3s.id]
  key_name               = aws_key_pair.admin.key_name

  # Official k3s install script, run once at first boot. Installs a
  # single-node k3s server (control plane + worker in one) -- there's no
  # separate "join a cluster" step because this is the only node.
  user_data = <<-EOF
    #!/bin/bash
    set -euxo pipefail
    curl -sfL https://get.k3s.io | sh -
  EOF

  tags = {
    Name    = "budget-tracker-staging-k3s"
    Project = "budget-tracker"
    Purpose = "disposable-learning-environment"
  }
}
