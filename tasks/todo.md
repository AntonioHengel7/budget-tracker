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
- [ ] B1: real domain issue — transaction/budget/period model (issue #3 — #2 was consumed by the B0 PR, GitHub shares one number sequence for issues and PRs)
- [ ] File follow-up issues (see review section below for the full accumulated list from B0)

## Paused 2026-08-13 (mid B1 review round 2 — resume here)

PR #4 (`issue/3-domain-layer` @ `66e35e2`) not merged. Round 2 verdicts:
- PLATO: FAIL — 1 blocking: the round-1 fix's `// coverage-skip: ...` comment on the "unreachable" branch in `budget.ts` doesn't match this repo's actual enforced skip vocabulary (`v8 ignore` / `istanbul ignore` / `c8 ignore` / `pragma: no cover`, each needing an adjacent `justification:` comment — see `coverage-gate.sh`'s scan logic). It's cosmetic, doesn't really exclude the branch from coverage. Also NOTE (non-blocking): the carryover rewrite (array + telescoping sum) is more machinery than the fix needed — a plain per-iteration `addMinor`/`subMinor` swap would avoid the unreachable-branch problem entirely.
- HOBBES / SOCRATES: stopped mid-recheck (user cost concern), no usable verdict — Hobbes had confirmed the carryover math is mathematically correct before being stopped.

Next step: fix the coverage-skip comment (real `v8 ignore` + `justification:`, or just remove the array/telescoping approach per Plato's simplification note and go back to a plain loop with addMinor/subMinor — probably the better fix, avoids the unreachable branch entirely), then re-dispatch fresh Socrates/Plato/Hobbes review at the new SHA.

## Review
(filled at completion)
