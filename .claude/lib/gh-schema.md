# GitHub Issue / PR Schema — Operational Reference

Derived from: docs/plans/2026-06-26-github-issue-pr-coverage-workflow.md §Issue / Label / PR Schema (Q5) and §Pinned Interfaces.
All `gh` commands match the Pinned Interfaces table (verified 2026-06-26 against gh 2.59.0).

---

## Labels

Create once per repo. `-f` silently overwrites if a same-name label already exists.

```sh
# type
gh label create "type:feature"  -c "1d76db" -d "New capability or user-facing addition" -f
gh label create "type:bug"      -c "d73a4a" -d "Something is broken or incorrect" -f
gh label create "type:chore"    -c "cfd3d7" -d "Maintenance, refactor, tooling — no behavior change" -f
gh label create "type:security" -c "b60205" -d "Security fix or hardening" -f

# source
gh label create "source:planned"    -c "0e8a16" -d "Issue was part of the original plan" -f
gh label create "source:discovered" -c "fbca04" -d "Issue was found out-of-scope mid-task (D1/D2)" -f

# priority (apply at most one per issue)
gh label create "priority:p0" -c "b60205" -d "Drop everything — blocks current release" -f
gh label create "priority:p1" -c "e4e669" -d "High — address this sprint" -f
gh label create "priority:p2" -c "0075ca" -d "Medium — address next sprint" -f

# status (mutable lifecycle markers)
gh label create "status:blocked"     -c "e99695" -d "Waiting on another issue or external dependency" -f
gh label create "status:in-progress" -c "fef2c0" -d "Actively being worked on in a branch" -f

# quality gate (opt-in)
gh label create "mutation" -c "5319e7" -d "Trigger deep mutation-testing pass on this issue's PR" -f
```

---

## Milestones

`gh` has **no `gh milestone` sub-command**. Use the REST API directly.

### Create a milestone

```sh
# Returns JSON; capture the `number` field — you need it, NOT the title, for assignment.
gh api repos/{owner}/{repo}/milestones \
  -X POST \
  -f title="Sprint 1" \
  -f description="First shippable slice of the feature"
# → { "number": 3, "title": "Sprint 1", ... }
```

> **Name-vs-number gotcha:** `gh issue create -m <name>` accepts a milestone *name* string.
> `gh api … -X PATCH -F milestone=<number>` requires the *integer number*.
> Never use the name when calling the REST PATCH — GitHub will silently ignore it.

### Assign an issue to a milestone (after creation)

```sh
gh api repos/{owner}/{repo}/issues/{issue_number} \
  -X PATCH \
  -F milestone=<milestone_number>
```

---

## Issue Body Template

Use with `gh issue create -t "<title>" -F - -l <label> -m <milestone>` (body via stdin).

```
## Job
<one-line job this unit serves — from plan §X>

## Acceptance criteria (frozen tests that must pass)
- <test file::case> — <what it proves>

## Plan slice
Completeness-map rows: <files NEW/MODIFY/DELETE>

## Dependencies
- [ ] #<N>   (blocked-by; unchecked = unmerged)

Source: plan docs/plans/<file>.md §X
```

Full create example (heredoc → stdin):

```sh
gh issue create \
  -t "Add coverage gate to pre-merge hook" \
  -F - \
  -l "type:feature" \
  -l "source:planned" \
  -l "priority:p1" \
  -m "Sprint 1" <<'EOF'
## Job
Ensure no undertested code reaches main by checking coverage thresholds before `gh pr merge`.

## Acceptance criteria (frozen tests that must pass)
- tests/workflow/test_coverage_gate.bats::vitest fixture at 97% core passes a 95 bar
- tests/workflow/test_pre_merge_gate.bats::merge blocked when coverage gate fails

## Plan slice
Completeness-map rows:
- .claude/hooks/lib/coverage-gate.sh NEW
- .claude/hooks/pre-merge-gate.sh NEW

## Dependencies
- [ ] #12   (blocked-by; unchecked = unmerged)

Source: plan docs/plans/2026-06-26-github-issue-pr-coverage-workflow.md §Step 1
EOF
```

---

## PR Body Template

Use with `gh pr create -t "<title>" -F - -B <base> -H <head>` (body via stdin).

```
Closes #N

## Summary
<what this PR does and why>

## Review verdicts
<!-- Reviewers append their verdict here via gh pr comment -->
```

Full create example:

```sh
gh pr create \
  -t "Add coverage gate (#42)" \
  -F - \
  -B main \
  -H issue/42-coverage-gate <<'EOF'
Closes #42

## Summary
Implements the pre-merge coverage gate that blocks `gh pr merge` when core coverage
falls below 95% or patch coverage falls below 100%.

## Review verdicts
<!-- SOCRATES, PLATO, HOBBES each post their verdict as a PR comment -->
EOF
```

---

## Blocked-by Convention

`gh` has no native sub-issue or dependency command. Encode dependencies as a task list in the issue body's `## Dependencies` section:

```
## Dependencies
- [ ] #12   (blocked-by; unchecked = unmerged)
- [ ] #13   (blocked-by; unchecked = unmerged)
```

- An **unchecked** box (`- [ ]`) means the referenced issue is not yet merged → this issue is blocked.
- A **checked** box (`- [x]`) means the referenced issue merged → this issue is unblocked.
- Query via: `gh issue view <n> --json body | jq -r '.body'` and parse the task list.
- `/ship` reads these before branching: if any `- [ ] #N` dependency has `state: open`, the issue is skipped until #N merges.

---

## Reviewer Verdict Markers

Reviewers (SOCRATES, PLATO, HOBBES) post their verdict as a PR comment. The `pre-merge-gate.sh` hook greps for all three PASS before allowing `gh pr merge`.

### Posting a verdict

```sh
# PASS
gh pr comment <pr_number> --body "SOCRATES: PASS"
gh pr comment <pr_number> --body "PLATO: PASS"
gh pr comment <pr_number> --body "HOBBES: PASS"

# FAIL (n = count of blocking issues found)
gh pr comment <pr_number> --body "SOCRATES: FAIL — 2 blocking"
gh pr comment <pr_number> --body "PLATO: FAIL — 1 blocking"
gh pr comment <pr_number> --body "HOBBES: FAIL — 3 blocking"
```

Format rules (the gate greps these exactly):
- Agent names are ALL-CAPS: `SOCRATES`, `PLATO`, `HOBBES`.
- Verdict is either exactly `PASS` or `FAIL — <n> blocking`.
- No other text on the same line as the verdict keyword.
- The gate greps PR comments via: `gh pr view <n> --json comments --jq '.comments[].body'`
  and checks that each of the three agents has at least one comment matching `<AGENT>: PASS`.
  (Verified 2026-06-26 against gh 2.59.0: `comments` is a valid `--json` field.)

### Merge-gate PR view query (Pinned Interface)

```sh
gh pr view <pr_number> --json reviewDecision,mergeStateStatus,mergeable,statusCheckRollup
```

---

## Traceability Chain

One-liner:

```
plan §X  →  issue #N (source:planned)  →  branch issue/<N>-<slug>  →  commits(ref #N in body)  →  PR "Closes #N"  →  SOCRATES:PASS + PLATO:PASS + HOBBES:PASS + coverage gate green  →  gh pr merge <n> --squash --delete-branch --match-head-commit <SHA>  →  issue auto-closed
```

- Branch naming: `issue/<N>-<slug>` (e.g. `issue/42-coverage-gate`).
- Every commit message body must contain `#N` (enforced by `commit-msg-issue-ref.sh`).
- PR description must contain `Closes #N` (auto-closes issue on merge).
- Merge command (Pinned Interface): `gh pr merge <n> --squash --delete-branch --match-head-commit <SHA>`.
  The `--match-head-commit` guard prevents merging a stale PR whose branch has been force-pushed since review.
- Issue close (if not auto-closed): `gh issue close <n> --reason completed`
  (NOT `gh issue edit --close` — that flag is a phantom and does not exist in gh 2.59.0).
