# Phase 4 — Terraform: disposable AWS staging environment

## Vocabulary

- **Infrastructure as Code (IaC)**: describing cloud resources in files
  instead of clicking through a console — so creating/changing/destroying
  infrastructure is repeatable, reviewable (as a diff), and versioned like
  code.
- **Provider**: a plugin Terraform uses to talk to a specific API (here,
  `hashicorp/aws` talks to AWS's API).
- **Resource**: one thing Terraform manages the lifecycle of (a VPC, a
  security group, an EC2 instance).
- **State**: Terraform's record of what it last created and with what
  settings — needed to compute a diff on the next `plan`/`apply`, and to
  know what to delete on `destroy`.
- **Remote state**: storing that state file somewhere shared (here, S3)
  instead of on one person's laptop — so state isn't lost, and multiple
  people/CI can't corrupt it by running Terraform at the same time
  (enforced via a **lock**, held in DynamoDB here).
- **Module**: a self-contained directory of Terraform config, reusable or
  just organizationally separate from other modules (this phase uses two:
  `bootstrap` and `environments/staging`).

## What problem this solves, and how it connects to earlier phases

Everything through Phase 3 ran either on this laptop (Compose, `kind`) or
on GitHub's runners (CI) — free, local, and disposable by just deleting a
container/cluster. Phase 4 is the first time real cloud infrastructure
enters the picture: an actual VM, on actual AWS, that costs actual money
while it exists. Terraform is how that gets provisioned in a way that's
reviewable before it costs anything (`plan` shows exactly what would be
created, with no side effects) and fully removable afterward
(`destroy`) — the "disposable" requirement this phase was built around.

## What was built

- `infra/terraform/bootstrap/`: creates an S3 bucket (versioned,
  encrypted, public access blocked) and a DynamoDB table, existing purely
  so the *next* module has somewhere to put its remote state. Uses plain
  local state itself — there's no bucket to point at yet when this module
  first runs (a genuine chicken-and-egg problem in Terraform's own design:
  remote state needs a backend to already exist).
- `infra/terraform/environments/staging/`: a dedicated VPC, one public
  subnet (no NAT gateway — a NAT gateway costs money to sit idle and
  exists to let *private* instances reach the internet without being
  reachable from it, which doesn't apply to a single public instance
  meant to be SSH/kubectl-accessible anyway), a security group locked to
  `var.admin_cidr` (required, no default — see Key Lines), and one EC2
  instance running k3s via the official install script in `user_data`.
- `terraform fmt`/`validate`/`plan` wired into CI (`.github/workflows/ci.yml`'s
  `terraform` job) on PRs touching `infra/terraform/**`.
- **Never applied.** Every verification here is `fmt`/`validate` only —
  provisioning a real EC2 instance needs explicit, separate approval and a
  stated cost estimate first, not something a coding session does
  silently.

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `bootstrap/main.tf`: `aws_s3_bucket_public_access_block` (all 4 flags `true`) | State files can contain resource attributes that are secret-shaped; this must never be publicly reachable | Without it, a misconfigured bucket policy could expose the entire infrastructure's state to the internet |
| 2 | `environments/staging/variables.tf`: `admin_cidr` has no `default` **and** a `validation` block requiring a `/32` | No default stops an *accidental* omission; the validation block stops an explicitly-too-broad value | A first attempt only denylisted the exact string `0.0.0.0/0` — HOBBES demonstrated `0.0.0.0/1` sailed straight through unchanged, since it's a different string with the same effect. The fix is an allowlist (`can(cidrhost(...)) && endswith(..., "/32")`) requiring a single host, not a denylist of one specific spelling |
| 3 | `environments/staging/main.tf`: security group only opens 22 and 6443, both to `var.admin_cidr`; egress is the only `0.0.0.0/0` rule | Minimal attack surface — nothing else is reachable from outside | Adding a broader ingress rule "just to test something" is exactly the kind of drift Terraform's plan/diff is meant to catch before it ships |
| 4 | `environments/staging/main.tf`: no NAT gateway | Avoids an idle recurring cost (~$0.045/hr plus data) that a single-instance environment doesn't need | Adding one "for best practice" without checking whether it's actually needed here would be pure waste |
| 5 | `bootstrap/outputs.tf` → `environments/staging/backend.tf` | Manual hand-off: `backend` blocks can't reference another module's outputs directly, so bootstrap's outputs get pasted into staging's backend config by hand, once | This is *why* there are two modules instead of one — a backend block is evaluated before any resource/output in the same config could exist |

## Quiz (for your own later self-study)

1. Why can't `environments/staging`'s `backend "s3"` block simply reference
   `bootstrap`'s Terraform outputs directly, the way a resource in one
   module can reference another resource's attributes?
2. The security group's only `0.0.0.0/0` rule is on **egress**, not
   ingress. Why is an open egress rule a normal, low-risk default, while
   an open ingress rule to port 22 would not be?
3. `data.aws_ami.ubuntu` uses `most_recent = true` with no version pin.
   What could happen the next time `terraform plan`/`apply` runs, even if
   nothing in this repo's `.tf` files changed?

## Decisions

- k3s over full Kubernetes/EKS — a single lightweight binary is enough for
  one learning VM, and the user's spec explicitly ruled out EKS.
- t3.small over t3.micro — k3s's control plane plus containerd is tight in
  1GiB RAM; 2GiB is the practical floor.
- Two modules (bootstrap + staging) over one — required specifically
  because of the remote-state chicken-and-egg problem described above.
- CI's `terraform plan` job uses placeholder `TF_VAR_admin_cidr`/
  `TF_VAR_ssh_public_key` values (an RFC 5737 documentation-only IP, a fake
  key) purely so `plan` can run structurally once AWS credentials exist —
  a real `apply` always uses the operator's actual values via a local,
  gitignored `terraform.tfvars`, never these. This was itself a
  SOCRATES-caught gap: the job would have failed even with real AWS
  credentials configured, because these variables have no default and
  nothing was injecting real values in CI.
