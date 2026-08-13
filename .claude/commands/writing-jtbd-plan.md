# Writing JTBD Plan

Derive an execution spec from a completed JTBD design doc. The plan governs the build.

## When to use

After `/writing-jtbd-design` is complete. This doc is what the implementer reads — it locks decisions, defines scope, and embeds the tests.

## Two rules that cannot be broken

1. **The plan does not re-decide.** Decisions are locked from the design doc (§3). If a decision needs revisiting, update the design doc first, then re-derive the plan.
2. **TDD at plan-authoring time.** Complete test code is written INTO the plan as a frozen deliverable before implementation starts. The implementer's job is: make this exact test green.

## Output

File: `docs/plans/YYYY-MM-DD-<topic>.md`

Status badge in the title tracks lifecycle: `[Proposed]` → `[IMPLEMENTATION-COMPLETE]`

## Template

```markdown
# Plan: <Topic> — YYYY-MM-DD [Proposed]

> Derived from: docs/dev-notes/YYYY-MM-DD-<topic>.md

## Locked Decisions (from design §3)

These are frozen. Do not re-decide here.

| Decision | What we're doing |
|---|---|
| <from design §3> | <short-term choice> |

## Completeness Map

Every file this plan touches. Auditors check this section against implementation.

| File | Action | Notes |
|---|---|---|
| `path/to/file.ext` | NEW / MODIFY / DELETE / RENAME | What changes |

## Pinned Interfaces

Every external symbol, flag, or API this plan depends on — verified against source before writing this plan.

| Symbol | Source | Verified at |
|---|---|---|
| `FunctionName` | `path/to/file.ext:42` | YYYY-MM-DD |

## Frozen Test Deliverable

Complete test code written now. Implementation makes this green.

```<language>
// <test file path>
<full test code here>
```

## Implementation Steps

Each step has an acceptance gate — a condition that must be true before moving to the next step.

### Step 1: <name>

<what to do>

**Gate:** <condition that must be true to proceed>

### Step 2: <name>

...

## Review Checklist

- [ ] All locked decisions match the design doc §3 (no new decisions)
- [ ] Completeness map lists every file that will change
- [ ] Every pinned interface has a file:line citation
- [ ] Test code is complete and runnable as written
- [ ] Each step has a gate
- [ ] Implementer could execute this without asking clarifying questions
```

## Process

1. Open the design doc. Copy the §3 decisions table into Locked Decisions — do not modify them.
2. Walk through what needs to change and fill the Completeness Map.
3. Pin every external interface with a real `file:line` citation. If you can't cite it, you don't know it well enough.
4. Write the complete test code. This is the hardest part. Don't shortcut it.
5. Break implementation into steps with gates.
6. Run the review checklist.

Once approved, update the status badge to `[IMPLEMENTATION-COMPLETE]` when done.

## Emit Issues (after plan approval)

**When:** after the plan is approved (Review Checklist all green), before any branch is cut. Each independently-shippable unit in the Completeness Map becomes exactly one issue. 1 unit = 1 issue = 1 branch = 1 PR (D3).

### 1. Create the milestone

`gh` has no `gh milestone` sub-command. Use the REST API directly and capture the returned `number`:

```sh
MILESTONE_NUM=$(gh api repos/{owner}/{repo}/milestones \
  -X POST \
  -f title="<plan topic>" \
  -f description="Plan: docs/plans/YYYY-MM-DD-<topic>.md" \
  | jq '.number')
```

You need `MILESTONE_NUM` only if you later reassign via `gh api … -X PATCH -F milestone=<number>`. For `gh issue create -m`, pass the milestone **name string** (not the number) — see the name-vs-number gotcha in `gh-schema.md`.

### 2. Create one issue per Completeness Map unit

Pipe the body via stdin (`-F -`). One `-l` flag per label — do not comma-separate them.

```sh
gh issue create \
  -t "<unit title>" \
  -F - \
  -l "type:feature" \
  -l "source:planned" \
  -l "priority:p1" \
  -m "<milestone title>" <<'EOF'
## Job
<one-line job this unit serves — from plan §X>

## Acceptance criteria (frozen tests that must pass)
- <test file::case> — <what it proves>

## Plan slice
Completeness-map rows: <files NEW/MODIFY/DELETE>

## Dependencies
- [ ] #<N>   (blocked-by; unchecked = unmerged)

Source: plan docs/plans/YYYY-MM-DD-<topic>.md §Step X
EOF
```

Labels to apply (all defined in `gh-schema.md`):

| Category | Values | Rule |
|---|---|---|
| type | `type:feature` / `type:bug` / `type:chore` / `type:security` | exactly one |
| source | `source:planned` | always, for plan-derived issues |
| priority | `priority:p0` / `priority:p1` / `priority:p2` | at most one |

### 3. Encode the dependency DAG (D4)

Express blocked-by edges in each issue's `## Dependencies` section as unchecked task-list items:

```
## Dependencies
- [ ] #12   (blocked-by; unchecked = unmerged)
- [ ] #13   (blocked-by; unchecked = unmerged)
```

- An **unchecked** `- [ ] #N` means #N has not yet merged → this issue is blocked.
- A **checked** `- [x] #N` means #N merged → the block is lifted.
- `/ship` reads this section before branching: if any `- [ ] #N` dependency is still open, the issue is skipped until #N merges.
- A dep is **not** satisfied by closure alone — only by a merged PR. A dep closed without a merge (won't-do / duplicate / not-planned) keeps its dependents blocked; `/ship` will escalate that chain (see ship.md Stop Conditions).

**Partition and concurrent-conflict check (mandatory before filing):**
1. **Partition:** every row in the Completeness Map must appear in exactly one issue — no row dropped, no row duplicated across two issues.
2. **No concurrent file conflicts:** two issues with no blocked-by edge between them (would run in parallel on separate branches) must NOT modify the same file. If they would, add a blocked-by edge between them to serialize execution and prevent lost-update conflicts on parallel branches.

Cross-reference the file column of every concurrently-runnable issue pair. Any file overlap between un-edged issues → add the dependency edge before filing.

### 4. Traceability

Each issue's `Source:` line links back to the exact plan section. `/ship` drives the full chain:

```
plan §X  →  issue #N (source:planned)  →  branch issue/<N>-<slug>  →  commits (ref #N)  →  PR "Closes #N"  →  reviews + coverage gate  →  merge  →  issue auto-closed
```

### Worked example

Three units: a schema migration, an API endpoint (blocked by the migration), and a UI component (blocked by the API).

```sh
# Step 1 — milestone
MILESTONE_NUM=$(gh api repos/antonioekk14/my-app/milestones \
  -X POST \
  -f title="Feature: user profiles" \
  -f description="Plan: docs/plans/2026-06-28-user-profiles.md" \
  | jq '.number')

# Issue A — no dependencies
gh issue create \
  -t "Add user_profiles table migration" \
  -F - \
  -l "type:chore" \
  -l "source:planned" \
  -l "priority:p1" \
  -m "Feature: user profiles" <<'EOF'
## Job
Create the DB schema that all user-profile features depend on.

## Acceptance criteria (frozen tests that must pass)
- tests/db/test_migrations.bats::user_profiles table exists with correct columns

## Plan slice
Completeness-map rows:
- db/migrations/0042_user_profiles.sql NEW

## Dependencies
(none)

Source: plan docs/plans/2026-06-28-user-profiles.md §Step 1
EOF

# Issue B — blocked by #42 (the migration above)
gh issue create \
  -t "Implement GET /api/users/:id/profile endpoint" \
  -F - \
  -l "type:feature" \
  -l "source:planned" \
  -l "priority:p1" \
  -m "Feature: user profiles" <<'EOF'
## Job
Expose user profile data over REST for consumption by the UI.

## Acceptance criteria (frozen tests that must pass)
- tests/api/test_user_profile.bats::returns 200 with profile JSON for valid user
- tests/api/test_user_profile.bats::returns 404 for unknown user

## Plan slice
Completeness-map rows:
- src/api/users/profile.ts NEW
- src/api/users/profile.test.ts NEW

## Dependencies
- [ ] #42   (blocked-by; unchecked = unmerged)

Source: plan docs/plans/2026-06-28-user-profiles.md §Step 2
EOF

# Issue C — blocked by #43 (the API endpoint above)
gh issue create \
  -t "Add ProfileCard component to dashboard" \
  -F - \
  -l "type:feature" \
  -l "source:planned" \
  -l "priority:p2" \
  -m "Feature: user profiles" <<'EOF'
## Job
Surface the user profile in the dashboard so the team can see who owns each item.

## Acceptance criteria (frozen tests that must pass)
- tests/ui/ProfileCard.test.tsx::renders name and avatar from API response
- tests/ui/ProfileCard.test.tsx::shows skeleton while loading

## Plan slice
Completeness-map rows:
- src/components/ProfileCard.tsx NEW
- src/components/ProfileCard.test.tsx NEW

## Dependencies
- [ ] #43   (blocked-by; unchecked = unmerged)

Source: plan docs/plans/2026-06-28-user-profiles.md §Step 3
EOF
```

Result: three issues filed, DAG encoded, milestone set. `/ship` opens #42 first, then unblocks #43 once #42 merges, then unblocks #44 once #43 merges.
