# TODO

## Phase A — Scaffolding (enforcement OFF) — DONE 2026-08-12

- [x] Install Node, scaffold repo, copy harness config
- [x] Project config files (package.json, vite.config.ts, tsconfig.json, .gitignore)
- [x] npm install and verify toolchain
- [x] Seed money.ts domain module + test (100% real coverage, no padding)
- [x] CI workflow — green on first push (github.com/AntonioHengel7/budget-tracker)
- [x] Phase A done checklist (see plan) — all 7 items verified, including negative cases
- [x] Create GitHub repo, push, create labels (11/11)

## Phase B — Shakedown (enforcement ON)

- [x] B0: flip enforce:true, branch protection, dress-rehearsal PR (issue #1) — DONE 2026-08-12, merged as PR #2
- [x] B1: real domain issue — transaction/budget/period model (issue #3) — DONE 2026-08-13, merged as PR #4 after 4 review rounds
- [ ] File follow-up issues (see review section below for the full accumulated list)

## Review

**B1 (2026-08-13):** Domain layer (date/period/transaction/budget/summary/filter) built by the `builder` subagent, went through 4 real Socrates/Plato/Hobbes review rounds before merging clean:
- Round 1: Socrates PASS, Plato PASS, **Hobbes FAIL — 3 blocking** (`periodsBetween` infinite loop/OOM at year 9999 rollover; `createTransaction` accepted `amountMinor: 1e300`, weaker than `money.ts`'s guard; `budget.ts` had no validating constructor, NaN limit silently reported `state:'under'`, carryover math bypassed overflow protection).
- Round 2 (after fix): **Plato FAIL — 1 blocking** (a `// coverage-skip:` comment invented for an "unreachable" branch didn't match this repo's real enforced skip vocabulary).
- Round 3 (after simplifying carryover per Plato's note): **Socrates FAIL — 2 blocking**, both with concrete reproducers (the "unreachable" cast was actually reachable via a non-zero-padded period literal bypassing `parsePeriod`; a raw `+` at `budgetStatus` could silently exceed `MAX_SAFE_INTEGER`).
- Round 4: **all three PASS**, verified independently (Socrates did mutation testing — reverted the source and confirmed the new regression tests fail on old code, pass on new; Hobbes ran a 3000-case fuzz against a BigInt oracle on the sign-handling arithmetic).

Every blocking finding was real, execution-confirmed, and caught something a "looks right" read wouldn't have. This is the harness's review gate working as designed, not theater.

Also mid-flight: discovered a shared-git-checkout hazard — running multiple Bash-capable review agents against the same working directory (no worktree isolation) let one agent's `git checkout`/cleanup step switch the branch under the others, and later caused a real false-FAIL when one agent's file mutations raced another's test run. Worked around each time (isolated `git archive` exports, explicit `-R owner/repo` on cross-repo `gh` calls); should use `isolation: "worktree"` for this pattern going forward.
