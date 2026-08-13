# Ship

Drive a set of GitHub issues from open to merged — branch, build, review, cover, merge — without losing traceability or leaking scope. Input is a milestone, a single issue number, or a label set. N=1 is the degenerate case of N≥2; there is no special path for it.

## When to use

- After `/one-shot` Phase 2 emits issues and Antonio approves the plan
- To drive a standalone bug or security finding (`type:bug`, `type:security`) through the full pipeline without a full one-shot
- Any time a set of issues needs to reach `main` under discipline (three-lane review, coverage gate, audit trail)

## The Iron Rule: Separation of Powers

- **The builder never self-approves and never merges.** It commits and pushes its own feature branch only — never `main`, never another issue's branch.
- **Reviewers (SOCRATES, PLATO, HOBBES) never fix.** They post verdicts and finding lists; the builder acts on them.
- **Jome is the switchboard.** All routing — builder → reviewers → builder → merge — goes through the main loop. No peer-to-peer agent chat.
- **Merge authority is Jome's alone** — and in HIP mode (default), the human makes the final merge call.
- **One issue = one branch = one PR. No batching.** (D3) Multiple issues' changes must never share a branch or PR. Cross-ref: writing-jtbd-plan.md Emit Issues §D3.

## Inputs

```
/ship --milestone "Sprint 1"          # all open issues in the milestone
/ship --issue 42                      # single issue (N=1 — same loop, no short-circuit)
/ship --label type:bug                # all open issues with that label
```

These three entry points determine the issue set. `--autonomous` is a **mode modifier**, not a fourth entry point — it can be combined with any entry point:

```
/ship --milestone "Sprint 1" --autonomous
/ship --issue 42 --autonomous
/ship --label type:bug --autonomous
```

All three entry points feed one engine (D7). The label, milestone, or issue number is just how the issue list is fetched.

## Phase 1 — Scope and DAG

Fetch all in-scope open issues:

```sh
gh issue list --milestone "Sprint 1" --json number,title,labels,state,body
# or: --label type:bug --state open
# or (single issue): gh issue view <n> --json number,title,labels,state,body
```

For each issue, read its `## Dependencies` task list to find blocked-by edges:

```sh
gh issue view <n> --json body | jq -r '.body'
```

Parse task items: `- [ ] #N` (unchecked = that issue is not yet merged → this issue is **blocked**) vs `- [x] #N` (merged → clear). Build the dependency DAG.

**CYCLE CHECK (mandatory before proceeding):** If the blocked-by edges contain a cycle (A→B→A or longer), ESCALATE to Antonio immediately and STOP — a cyclic DAG cannot be executed.

An issue is **READY** when every `- [ ] #N` dep was satisfied by a merged PR. **Closed ≠ merged**: a dep is satisfied only when `gh issue view <N> --json state,stateReason` returns `state: closed, stateReason: completed` (the normal outcome when `Closes #N` in a merged PR auto-closes the issue). A dep with `stateReason: not_planned` or any non-`completed` reason was closed without a merge and does NOT satisfy the predicate — mark its dependents `status:blocked-needs-attention` and escalate (see Stop Conditions). Issues that /ship itself merged during this run are always treated as satisfied without the API check.

Apply `status:blocked` to every issue that has at least one unsatisfied dep:

```sh
gh issue edit <n> --add-label "status:blocked"
```

Never start an issue until all its declared dependencies are satisfied by merged PRs. Independent (unblocked) issues are candidates for concurrent execution.

## The Loop

Repeat until every in-scope issue is merged or escalated.

### For each READY issue:

**1. Label and branch.**

```sh
gh issue edit <n> --add-label "status:in-progress"
git checkout -b issue/<n>-<slug>       # slug = kebab-case title fragment
```

**2. Dispatch the builder.**
Spawn a `builder` subagent with the issue body (job, acceptance criteria, plan slice, files NEW/MODIFY/DELETE). The builder implements on `issue/<n>-<slug>` only. Every commit message must reference `#<n>` in the body (the commit-msg hook enforces this and will block commits that don't). Builder pushes on completion:

```sh
git push -u origin issue/<n>-<slug>
```

**3. Open the PR.**

```sh
gh pr create \
  -t "<title> (#<n>)" \
  -F - \
  -B main \
  -H issue/<n>-<slug> <<'EOF'
Closes #<n>

## Summary
<what this PR does and why>

## Review verdicts
<!-- SOCRATES, PLATO, HOBBES each post their verdict as a PR comment -->
EOF
```

**4. Dispatch reviewers in parallel.**
In a single message, spawn SOCRATES, PLATO, and HOBBES against the PR diff. Each reviewer must fetch the current head SHA immediately before posting (do not cache from an earlier step — a concurrent push can move the ref):

```sh
HEAD_SHA=$(gh pr view <pr_number> --json headRefOid --jq '.headRefOid')
```

Then post the verdict as a PR comment — first line only, exact format, no variations:

```sh
# PASS
gh pr comment <pr_number> --body "SOCRATES: PASS @ $HEAD_SHA"
gh pr comment <pr_number> --body "PLATO: PASS @ $HEAD_SHA"
gh pr comment <pr_number> --body "HOBBES: PASS @ $HEAD_SHA"

# FAIL
gh pr comment <pr_number> --body "SOCRATES: FAIL @ $HEAD_SHA — 2 blocking"
gh pr comment <pr_number> --body "PLATO: FAIL @ $HEAD_SHA — 1 blocking"
gh pr comment <pr_number> --body "HOBBES: FAIL @ $HEAD_SHA — 3 blocking"
```

Agent names are ALL-CAPS. Only the exact string `PASS @` satisfies the pre-merge-gate — `PASSED WITH CONCERNS` or any other form does not count. A PASS verdict's first line must end immediately after the SHA with nothing following it (`<AGENT>: PASS @ <sha>` — the gate anchors `$` on PASS); FAIL lines may include trailing text after the SHA. A verdict bound to a stale SHA (the branch was pushed since the review) does not count; the reviewer must re-post bound to the new SHA. HOBBES calibrates depth to the app's real surface: light for a read-only client, full adversarial pass for auth/PII/payments/backend.

**5. Triage findings.**
Separate BLOCKING (must fix before merge) from NOTE (deferred, document why). De-dupe overlaps between lanes. If all three post PASS → go to step 6. Otherwise → fix loop.

**Fix loop, max 3 rounds:**

- Route all BLOCKING findings (from all lanes) to the builder. Builder fixes only the cited issues — no scope creep, no bonus refactors.
- Builder pushes the fix. The head SHA changes.
- **After any builder push that changes the head SHA, ALL THREE reviewers must re-post verdicts bound to the new SHA before a merge can be evaluated.** Reviewers that had no BLOCKING findings may perform a light re-affirm (re-read only the changed lines / delta), but they MUST still post `PASS @ <new-sha>` — the pre-merge-gate is SHA-bound and only counts current-SHA verdicts. This intentionally overrides review-cycle's "recheck only failing lanes" optimization: a PASS verdict is only valid for the exact SHA it names. Each reviewer re-fetches `headRefOid` immediately before posting. The old verdicts (bound to the prior SHA) are stale and do not count.
- Return to triage.
- After 3 rounds with BLOCKING still outstanding → **ESCALATE to Antonio.** Stop the fix loop. Surface the PR URL, the unresolved BLOCKING findings, and the round history. Transitively mark ALL issues that have a blocked-by dependency on this one (directly or via chain) as `blocked-unresolvable` and include them in the escalation report. Do not loop further on this issue or its dependents. If other issues are independent, continue the engine on them.

**6. Merge.**
When all three verdicts are `PASS @ <current-sha>` — the pre-merge-gate hook verifies this plus the coverage gate before allowing the merge command through:

- **HIP mode (default):** surface the PR to Antonio. Provide the PR URL, verdict summary, and current head SHA. Antonio makes the merge call.
- **Autonomous mode (`--autonomous`):** Jome merges:

```sh
HEAD_SHA=$(gh pr view <pr_number> --json headRefOid --jq '.headRefOid')
gh pr merge <pr_number> --squash --delete-branch --match-head-commit "$HEAD_SHA"
```

`--match-head-commit` guards against merging a stale PR whose branch moved between review and the merge command. The pre-merge-gate hook is the actual enforcer — it blocks `gh pr merge` if any verdict is missing, bound to a stale SHA, or FAIL, or if the coverage gate fails.

`Closes #<n>` in the PR body auto-closes the issue on merge. If the issue is not auto-closed:

```sh
gh issue close <n> --reason completed
```

Strip the in-progress label now that the issue is done:

```sh
gh issue edit <n> --remove-label "status:in-progress"
```

**7. Update the DAG.**
After merge, re-evaluate blocked issues: any issue whose `- [ ] #<n>` dependency was just satisfied by this merge becomes READY — remove its `status:blocked` label, add it to the next execution wave, and continue the loop. Dependencies closed without a merged PR (stateReason ≠ completed) do NOT unblock dependents — see Closed-without-merge in Stop Conditions.

```sh
gh issue edit <n> --remove-label "status:blocked"
```

## Parallelism

Independent (unblocked) issues run concurrently. For a large milestone, this is a **Workflow-tool (ultracode) job**: fan out builders across all READY issues simultaneously, each in its own branch/PR/review loop. After each wave converges (all parallel PRs merged or escalated), re-evaluate the DAG and start the next wave of newly-unblocked issues. Repeat until the milestone is drained.

For a small milestone (≤3 independent issues), run inline and sequence them. Don't use ultracode for a 2-issue sprint — it burns usage budget for no gain.

Cap concurrency mindful of subscription usage limits. Default: do not open more than 5 concurrent builders without Antonio's explicit opt-in.

## Discovery Discipline

If the builder or any reviewer finds an out-of-scope problem mid-issue, apply D2 triage:

- **(a) Blocks current issue** — stop work on the issue, surface to Antonio for re-plan. Do not proceed.
- **(b) Separable** — file a new issue immediately, then continue. Do not fix inline.
- **(c) Noise** — drop it, log why.

Filing a discovered issue (class b) — the body is intentionally shorter than the planned-issue template; Acceptance criteria and Plan slice are defined at triage time, not here:

```sh
gh issue create \
  -t "<problem title>" \
  -F - \
  -l "source:discovered" \
  -l "type:bug" <<'EOF'
## Job
<what the problem is and where it was found>

## Found during
Issue #<n> on branch issue/<n>-<slug>
EOF
```

No out-of-scope code change ships in a PR whose issue didn't ask for it. A discovered problem is either filed or (if blocking) triggers a re-plan — never silently fixed in the current PR, never silently dropped.

## Modes

| Mode | Merge call | Escalation |
|---|---|---|
| **HIP (default)** | Surface PR + head SHA to Antonio; Antonio merges | Surface at 3 rounds; Antonio decides |
| **Autonomous (`--autonomous`)** | Jome merges on unanimous PASS + gate green | Escalate at 3 rounds or hard block; stop; surface |

Enforcement: on repos with `.jome/coverage.json` `enforce:true`, the pre-merge-gate hook is the hard gate. On repos without it, `/ship` still follows the discipline (layer-1 awareness) but without a hook-enforced hard stop.

## Stop Conditions

- **All merged:** every in-scope issue is closed → run complete.
- **Escalated:** one or more issues hit 3 fix rounds without all-PASS → surfaced to Antonio; their transitive dependents are marked `blocked-unresolvable` and included in the escalation report; independent issues continue.
- **Hard block (D2a):** a discovery blocks the current issue and re-planning is needed → stop current issue, surface to Antonio, continue unblocked issues.
- **Builder failure:** if the builder returns a failure or incomplete result, re-delegate to a fresh builder subagent (same branch, same issue) — never absorb the implementation into the main loop. Cap re-delegations at **2** (3 total builder attempts per issue). After the third failure, ESCALATE to Antonio: surface the issue number, branch, and error summary. Transitively mark all issues that have a blocked-by dependency on this one (directly or via chain) as `blocked-unresolvable` and include them in the escalation report. Do not loop further on this issue or its dependents. If other issues are independent, continue the engine on them.
- **Closed-without-merge:** a dep was closed with `stateReason` ≠ `completed` (won't-do / duplicate / not-planned). Do NOT unblock its dependents. Transitively mark all dependents (direct and via chain) as `blocked-needs-attention`, include them in the escalation report, and escalate to Antonio. Stop processing that dependency chain.
- **No-progress terminator:** if a full pass over all remaining in-scope issues yields ZERO newly-READY issues but unresolved in-scope issues remain — all blocked by escalated / out-of-scope / cyclic / closed-without-merge deps — ESCALATE the entire blocked set to Antonio and STOP. Never spin waiting for a condition that cannot resolve itself. An in-scope issue blocked by a still-open out-of-scope dep triggers this rule.

## Output Format

```
SHIP RUN — <scope: milestone / issue #N / label>

Issues in scope:    <N>
  Ready at start:   <n>
  Blocked at start: <n>

--- Issue #<n>: <title> ---
  Branch:   issue/<n>-<slug>
  PR:       #<pr> <url>
  Round 1:  SOCRATES 2 blocking, PLATO 1 blocking → fixed, pushed
  Round 2:  SOCRATES 0, PLATO 0, HOBBES 0 → all PASS @ <sha>
  Coverage: core 96.2%, patch 100%
  Status:   MERGED <sha> (squash)

--- Issue #<m>: <title> ---
  Branch:   issue/<m>-<slug>
  PR:       #<pr> <url>
  Round 1–3: HOBBES blocking (attack surface unresolved)
  Status:   ESCALATED — awaiting Antonio

Discovered issues filed: #<x> (type:bug), #<y> (type:chore)

SUMMARY
  Merged:     <n> PRs
  Escalated:  <n>
  Discovered: <n> issues filed
```
