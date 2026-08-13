# .jome — Per-repo Workflow Configuration

This directory holds per-project configuration for the Jome assistant workflow.

## coverage.json

Controls the coverage gate and Step 2 enforcement hooks.

### Fields

**`enforce`** (`boolean`, default `false`)
When `true`, activates the Step 2 enforcement hooks for this repo:
- `commit-msg-issue-ref.sh` — blocks commits whose message lacks an issue reference (`#N`)
- `git-preflight.sh` — blocks direct pushes to `main` or `master` (regardless of which branch is
  checked out; the *target* branch in the refspec is what matters)
- `pre-merge-gate.sh` — blocks `gh pr merge` until all three reviewers (SOCRATES, PLATO, HOBBES)
  have posted `<AGENT>: PASS @ <head-sha>` comments **for the current head commit** and the
  coverage gate passes

When `false` or absent, all three hooks are dormant (exit 0, allow through).

> **Enforcement scope:** enforcement is evaluated at the directory the command will actually execute in — the last `cd <path>` target if present, otherwise cwd. So `cd /other-repo && gh pr merge 5` is enforced based on `/other-repo`'s config, not the current working directory.

**`core`** (`string[]`)
Glob patterns matching core source files (domain logic, business rules).
Coverage for files matched by these globs is checked against `thresholds.core`.
Example: `["src/domain/**", "Packages/*/Sources/**"]`.

**`thresholds.core`** (`number`, default `95`)
Minimum line-coverage percentage required across all core files.
The merge gate blocks if coverage falls below this bar.

**`thresholds.patch`** (`number`, default `100`)
Minimum line-coverage required on lines changed in the PR (patch coverage).
Planned — not yet enforced at the gate.

**`mode`** (`"auto" | "bar" | "ratchet"`)
Coverage gate mode:
- `bar` — hard threshold, always
- `ratchet` — current coverage must be >= the baseline in `.jome/coverage-baseline.json`
  (never regress; don't demand a sudden jump)
- `auto` — `bar` for new repos; `ratchet` for repos already below the core threshold

## Opting a repo into the workflow

1. Create `.jome/coverage.json` with `"enforce": true` and set `core` / `thresholds`.
2. Run `gh label create ...` (see `.claude/lib/gh-schema.md`) to create the required labels.
3. From this point on, the three Step 2 hooks are active in that repo:
   - Every commit message must contain `#N`.
   - No direct pushes to `main`/`master`.
   - `gh pr merge` requires all three agents to have posted `<AGENT>: PASS @ <head-sha>`.

## § Branch Protection — the real wall

The hooks in this repo are an **advisory** layer for the common single-operation
case. The **authoritative hard guarantee** that nothing reaches `main` is GitHub
branch protection. Any enforced repo (`.jome/coverage.json` `"enforce": true`)
**MUST** have branch protection enabled or the local hooks are the only guard.

### Enable branch protection on `main`

The following command has been verified against `gh api --help` (bracket-notation
for nested fields; `-F key=null` sends JSON null):

```sh
gh api -X PUT "repos/{owner}/{repo}/branches/main/protection" \
  -F enforce_admins=true \
  -F required_status_checks=null \
  -F restrictions=null \
  -F "required_pull_request_reviews[required_approving_review_count]=1"
```

Replace `{owner}` and `{repo}` with the actual org/user and repository name,
or set `GH_REPO=owner/repo` and use the `{owner}`/`{repo}` placeholders directly
(gh CLI resolves them from the current directory's remote when inside a git repo).

A helper script is available at `.claude/hooks/lib/enable-branch-protection.sh`.

### What the protection enforces

| Setting | Value | Effect |
|---|---|---|
| `required_approving_review_count` | 1 | At least one approved review required to merge |
| `enforce_admins` | true | Applies rules to repo admins too |
| `required_status_checks` | null | No CI checks required (add when you have CI) |
| `restrictions` | null | No push restriction by user/team (org repos only) |

> **Note on `restrictions: null`**: passing `null` means "no user/team push
> restrictions". This is correct for personal repos and is accepted by the API
> for org repos. If your org requires a `restrictions` object, pass
> `--input` with the full JSON body instead.

## Reviewer verdict format

Verdicts are SHA-bound to the PR's current head commit. Before posting:

```sh
HEAD_SHA=$(gh pr view <pr_number> --json headRefOid --jq '.headRefOid')
gh pr comment <pr_number> --body "SOCRATES: PASS @ $HEAD_SHA"
gh pr comment <pr_number> --body "PLATO: PASS @ $HEAD_SHA"
gh pr comment <pr_number> --body "HOBBES: PASS @ $HEAD_SHA"
```

A verdict for a stale SHA (branch pushed after review) does not count.
See `.claude/lib/gh-schema.md` for the full schema and format rules.
