# Phase 3 — CI/CD: path-aware gating, manifest validation, GHCR

## Vocabulary

- **Path filter**: a CI step that inspects which files changed in a
  push/PR and produces boolean outputs other jobs gate on via `if:`. Lets
  a workflow skip expensive/irrelevant jobs (e.g. app tests) when only
  unrelated files (e.g. `infra/`) changed.
- **Job output**: a value one job produces (`outputs:`) that other jobs can
  read via `needs.<job>.outputs.<name>` — the mechanism path filtering
  uses to pass its verdict downstream.
- **Required status check**: a specific named job (matched by its GitHub
  Actions job id, called a "context") that GitHub's branch protection
  refuses to let a PR merge without. Only jobs actually listed in a
  repo's branch protection settings are required — every other job can
  fail without blocking a merge button.
- **Container registry**: a place to store built container images so they
  can be pulled elsewhere without rebuilding. **GHCR** (GitHub Container
  Registry, `ghcr.io`) is GitHub's own, usable with the same
  `GITHUB_TOKEN` a workflow already has — no extra account/credentials
  needed for basic push access.

## What problem this solves, and how it connects to earlier phases

Phase 1's Compose stack and Phase 2's Kubernetes manifests/Helm chart both
exist now, but the CI pipeline from before Phase 1 (`ci.yml`) still treats
every change the same way: run the full app test suite, build the image,
smoke-test it, deploy to Fly on merge — even for a change that only edits
a Kubernetes YAML file and touches zero application code. That's wasted CI
time and, more importantly, unrelated to what actually needs verifying for
an infra-only change. This phase makes the pipeline **aware** of what kind
of change it's looking at: skip the app-specific jobs for infra-only
changes, but run manifest validation instead; and publish the same image
Fly deploys to GHCR too, so infra (Kubernetes, eventually Terraform) has
something real to reference instead of only the `kind`-only `:local` tag.

## What was built

- `changes` job (`.github/workflows/ci.yml`): runs `dorny/paths-filter`
  once, producing `non_infra`/`infra`/`terraform` booleans every other job
  gates on.
- `ci`/`web` jobs: unchanged internally, now gated on `needs.changes.outputs.non_infra == 'true'`.
- `validate-manifests` job: gated on `infra` — installs `kubeconform`,
  validates every raw manifest under `infra/k8s/` against the real
  Kubernetes API schemas, then does the same against the Helm chart's
  *rendered* output (`helm template | kubeconform`), plus `helm lint`.
- `ghcr` job: builds and pushes the app image to `ghcr.io`, tagged
  `latest` and by commit SHA, gated on `[ci, web]` succeeding and only on
  pushes to `main`.
- `terraform` job (Phase 4, added here since it lives in the same file):
  `fmt`/`validate`/`plan` on PRs touching `infra/terraform/**`.
- `deploy`'s existing `needs: [ci, web]` needed no changes — GitHub
  Actions already skips a job if any of its `needs` were skipped, so
  infra-only changes transitively skip `deploy` too without any new logic
  there.

## Key lines

| # | File:Line | What | Break it and... |
|---|---|---|---|
| 1 | `changes` job: `non_infra: - '!infra/**'` | The actual gating mechanism | See the corrected-bug note below — a `'**'` entry here silently defeats the whole thing |
| 2 | `ci`/`web`/`ghcr`: `if: needs.changes.outputs.non_infra == 'true'` | Skips app work for infra-only changes | Remove and every infra-only PR pointlessly runs the full app suite |
| 3 | `validate-manifests`: `helm template budget-tracker infra/helm/budget-tracker \| kubeconform -strict -summary -` | Validates the *rendered* chart output, not just the template source | Skip this and a chart could `helm lint` clean while still rendering invalid Kubernetes YAML (lint checks chart structure, not schema conformance of the output) |
| 4 | `ghcr`: `permissions: packages: write` | Least-privilege — only this job can push, and only `contents: read` + `packages: write`, nothing broader | Omit it and the job fails outright (default `GITHUB_TOKEN` permissions for this repo are read-only) |
| 5 | `deploy`'s unchanged `needs: [ci, web]` | Relies on GitHub Actions' default skip-propagation | Nothing to break here — it's the reason nothing else needed to change |

## A real bug this doc exists partly to document

The first version of the `non_infra` filter used `['**', '!infra/**']`,
written on the assumption that dorny/paths-filter combines a filter's
pattern list gitignore-style (later, more specific patterns override
earlier general ones). **It does not.** It compiles the whole list into
one `picomatch` matcher and ORs the patterns — verified directly:

```
picomatch(['**', '!infra/**'])('infra/k8s/x.yaml')  // => true (bug)
picomatch(['!infra/**'])('infra/k8s/x.yaml')        // => false (correct)
```

Since `'**'` alone already matches every file, OR-ing it with anything
else always returns `true` — the negation was permanently short-circuited
and the "skip app CI for infra-only changes" feature never actually
worked, despite passing an (incorrectly modeled) manual simulation at the
time. The fix is to drop the redundant `'**'` — a lone negated pattern
already means "matches anything that does NOT match the inner pattern,"
which is exactly what was wanted. This was caught by SOCRATES during
pre-merge review, not by the author, and re-verified independently with
the real `picomatch` package before trusting the correction.

## Quiz (for your own later self-study)

1. Why does `validate-manifests` run `helm template | kubeconform` *in
   addition to* `helm lint`, instead of relying on lint alone?
2. `ghcr` needs `[ci, web]` to succeed before it runs. What would happen
   to an infra-only PR if `ghcr` were instead gated only on
   `github.ref == 'refs/heads/main'`, with no `needs`?
3. Why does GitHub Actions treat a job whose `needs` were skipped as
   itself skipped by default, rather than running it anyway? What would
   go wrong here (specifically with `deploy`) if it didn't?

## Decisions

- `dorny/paths-filter` chosen over splitting into separate workflow files
  with `on.push.paths` triggers — the latter would skip the *entire*
  workflow run for infra-only changes, including manifest validation,
  which needs to run precisely for those changes.
- `kubeconform` chosen over `kubectl apply --dry-run=server` for manifest
  validation — kubeconform validates against schemas offline, no live
  cluster required, which fits a CI runner with no cluster available.
- GHCR over Docker Hub — no extra account/secret needed, uses the
  workflow's own `GITHUB_TOKEN`.
