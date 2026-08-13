# One-Shot

End-to-end pipeline for taking an app/service concept from idea to a close-as-possible first execution. Front-loads all thinking into design + plan so the build has nowhere to wander.

## Core principle

**The closeness of the first effort is set in Phase 2 (the plan), not Phase 4 (the build).** A one-shot fails not because of bad coding but because the plan left a decision open, forcing improvisation mid-build — and improvisation compounds. Frozen tests + pinned interfaces convert "build me an app" (infinite freedom) into "make these tests pass against these exact interfaces" (one target). Spend the real time in Phases 0–3; execution should feel almost mechanical.

## The pipeline

### Phase 0 — Lock the concept (`/grill-me`)
Depth-first interview, one decision at a time, each with a proposed answer: platform (iOS / web / service), the core job, scope boundaries, must-haves vs. nice-to-haves.
**Output:** unambiguous concept, zero open forks.
**Gate:** Antonio signs off on what we're building.

### Phase 1 — Design doc (`/writing-jtbd-design` → `docs/dev-notes/`)
The durable "what and why." Load-bearing artifact: the Decisions & Tradeoffs table with a *Don't-lose-this* invariant per decision. Architecture is decided here, once.
**Gate:** Antonio approves the decisions.

### Phase 2 — The plan (`/writing-jtbd-plan` → `docs/plans/`)  ← most important
- Locks decisions from the design (never re-decides mid-build)
- Completeness map: every file, NEW/MODIFY/DELETE
- Pinned interfaces: every external symbol verified against real source (`file:line`), never from memory
- Frozen tests written NOW — complete test code as a deliverable, before any implementation
- **Emit Issues:** after `/writing-jtbd-plan` runs, the completeness map and frozen tests are emitted as GitHub issues — this is the "Emit Issues" step baked into `/writing-jtbd-plan`. The plan becomes the issue backlog; every item that will be built has a corresponding issue before Phase 4 begins.
**Gate:** Antonio approves the plan. Once approved, execution is mechanical.

### Phase 3 — Pre-flight (`/pushback` + `/rethink`)
Attack the plan from five angles. Verify every pinned interface actually exists (real API/library signature), not assumed. Catches the "planned against a function that doesn't exist" failure that wrecks one-shots. Use an `explorer` subagent to verify external API/library assumptions.
**Gate:** plan survives its own critique.

### Phase 4 — Execution (`/freeze` + `/ship`)
`/freeze` scope, then hand off to **`/ship`** — the issue-driven engine that walks the issue DAG (branch → builder → PR → review → gated merge) for each issue emitted in Phase 2. The builder's only job: make the frozen tests green. No decisions to make — they were all made in Phase 2.

N=1 (a single-issue plan, e.g. a probe) is just `/ship --issue <n>` — the same loop, no special path (D5). `/ship` chooses inline vs Workflow-fanout based on how many independent issues the milestone has: ≤3 independent issues run inline and sequenced; a large milestone fans out builders in parallel (ultracode). Ultracode requires Antonio to opt in.

### Phase 5 — Review (inside `/ship`)
Review happens **per-PR** inside `/ship`'s loop — SOCRATES, PLATO, and HOBBES each post SHA-bound verdicts on every PR before it can merge. Fix loops (max 3 rounds), escalation, and coverage gating are all handled by `/ship`. The old standalone `/review-cycle` call is fully subsumed; there is no separate end-of-build review step.

## What Jome needs from Antonio

- A real review at each gate — the gates only work if Antonio actually pushes back, especially on the design decisions (Phase 1) and the plan (Phase 2). Garbage approved at a gate becomes garbage in the build.
- A decision on **ultracode** for Phase 4 if it's a full app.

## Autonomous mode (`--autonomous`)

Opt-in, off by default. One prompt in, one report out — Jome drives all six phases in a single run and surfaces nothing until it's done or genuinely blocked. The gated mode above stays the default; autonomous is chosen per run, not permanently.

**Kickoff is the whole interface:**
```
/one-shot --autonomous
PRD: /path/to/prd.pdf            # ingested in Phase 0; .pdf or .md
Build mode: /ship --autonomous   # /ship drives the issue DAG; ultracode only if Antonio opts in
```

### The trade being made
The human gates (concept, design, plan, merge) are load-bearing — they're where Antonio's pushback keeps drift down. Autonomous mode removes them, which makes Jome both author *and* approver of the architecture. That violates separation of powers unless **every human gate is replaced by an autonomous adversarial gate.** No gate may simply be skipped.

| Gated mode | Autonomous replacement |
|---|---|
| Antonio signs off on concept | PRD ambiguity → **documented assumption**, logged, continue |
| Antonio approves design decisions | `/pushback` + `/rethink` run as real self-critique; design must survive them |
| Antonio approves the plan | `explorer` subagent **verifies every pinned interface** against real source (`file:line`) before any code |
| Antonio makes the merge call | `/ship` merges per-PR on unanimous PASS + coverage gate (max 3 fix rounds per PR, then escalates) |

### The Decisions & Assumptions log — mandatory
This is what replaces Antonio's at-gate eyes. Every call made without him — every PRD gap filled, every open fork resolved — is recorded with its rationale. In `--autonomous` mode this log is **per-issue**: each issue's PR comment thread carries its own assumptions, and they are aggregated into the final report. Antonio reviews **once, at the end**, against the full log. A run with no log is not a valid autonomous run.

Auto-merge-on-unanimous-PASS happens **per-PR inside `/ship`** (D8) — not as a single end-of-run gate. Each PR is merged as soon as all three reviewers post `PASS @ <sha>` and the coverage gate clears; later issues can build on already-merged work without waiting for the entire run to complete.

### Stop conditions — only two
Autonomous mode reports back **only** when:
1. **Done** — frozen suite green + all PRs merged by `/ship`. Final report = what was built, the assumptions log, deferred NOTEs.
2. **Hard block** — an ambiguity load-bearing enough that assuming past it would be irresponsible (e.g. the PRD contradicts itself on the core data model, or a pinned interface doesn't exist and has no substitute). Everything else: assume, log, continue.

Routine gates are NOT stop conditions. "The design needs a decision" is not a reason to come back — make it, log it, move on.

### Where autonomous mode fits
Best for **small/medium apps inline**. A full app means sequential builders (slow, long single run) or ultracode (parallel, but burns subscription usage limits and needs explicit opt-in). Don't run a large app autonomously-inline and expect speed — that's the wrong tool. Scope to what one inline run can carry.

## Honest ceiling

A literal flawless one-shot of a whole app is rare. This pipeline optimizes for "close as possible, fix later" — the tighter the plan, the smaller the fix list. Don't promise perfection; promise minimal drift. Autonomous mode does not raise this ceiling — it trades Antonio's mid-flight gates for a single end-of-run review, so the assumptions log is the safety net. The bigger the PRD's ambiguity, the longer that log, the more there is to correct at the end.
