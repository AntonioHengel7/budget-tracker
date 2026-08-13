# Review Cycle

Orchestrate the full build → review → fix → recheck loop with separation of powers. This is the default pre-merge discipline for any non-trivial change.

## When to use

- Before committing or merging a non-trivial change
- After a builder subagent returns an implementation
- Whenever Antonio says "review this" or "is this ready?"

## The Iron Rule: Separation of Powers

- **The reviewer never fixes.** socrates, plato, and hobbes report findings only.
- **The builder never self-approves.** The agent that wrote the code does not decide it's done.
- **Jome is the switchboard.** All handoffs route through the main loop — there is no peer-to-peer agent chat.

## The Loop

1. **Establish scope.** Identify exactly what's under review — a diff, a set of files, or a feature. If unclear, get the diff: `git diff` or name the files. Never review "the whole codebase" vaguely.

2. **Dispatch reviewers in parallel.** In a single message, spawn all three:
   - `socrates` — logic, correctness, edge cases
   - `plato` — conventions, quality, naming, maintainability
   - `hobbes` — security, attack surface, dependency/supply-chain risk (adversarial lane)
   Give each the exact scope. They return BLOCKING / NOTE findings with `file:line` citations. `hobbes` calibrates depth to the app's real surface — light for a read-only client, full pass when auth/PII/payments/backend are involved.

3. **Triage findings.** Collect both reports. Separate BLOCKING (must fix) from NOTE (optional). De-dupe overlaps. If zero BLOCKING findings → go to step 6.

4. **Route fixes to the builder.** Send the BLOCKING findings to the `builder` agent (use SendMessage to continue the *same* builder if it's still alive, so it keeps context). The builder fixes — and only fixes the cited issues. No scope creep.

5. **Recheck — changed lines only.** Re-dispatch only the reviewers that had BLOCKING findings (`socrates` / `plato` / `hobbes`), against *only the lines the builder changed in this round*, not the whole scope again. Cheaper, sharper, avoids re-litigating settled code. Return to step 3.

6. **Verdict.** When a full review round produces zero BLOCKING findings, report:
   - What was reviewed (scope)
   - What was found and fixed across the rounds
   - Remaining NOTEs (deferred, with reasons)
   - Final status: **APPROVED** or **ESCALATE**

## Stop Conditions

- **Clean:** a review round returns zero BLOCKING → APPROVED.
- **Max 3 rounds:** if BLOCKING findings persist after 3 fix→recheck rounds, STOP and escalate to Antonio. Persistent findings mean either a hard design problem or a reviewer/builder disagreement that needs human judgment — don't loop forever.
- **Builder failure:** if the builder returns a failure or incomplete result, re-delegate to a different approach (per the redispatch rule) — never absorb the fix into the main loop.

## Modes

- **Default (HIP — human in the picture):** pause and surface the verdict to Antonio before committing/merging. Antonio makes the merge call.
- **Multi-vote (high-stakes):** when Antonio flags a change as high-risk, replace single-pass review with 3 independent skeptics per BLOCKING finding, each prompted to *refute* it. Keep the finding only if a majority can't refute it. Use sparingly — it's expensive.

## For large multi-file jobs

If the scope is big enough that the loop above would be slow or token-heavy (many files, many independent changes), this is a Workflow-tool job — tell Antonio it's a candidate for `ultracode` / a deterministic workflow (fan-out builders + adversarial verify + loop-until-clean) rather than running it inline.

## Output Format

```
REVIEW CYCLE — <scope>

Round 1: socrates <N blocking>, plato <M blocking> → fixed <X>
Round 2: socrates <N blocking> → fixed <X>
...

Deferred NOTEs:
- [file:line] <note> — <why deferred>

STATUS: APPROVED / ESCALATE
```
