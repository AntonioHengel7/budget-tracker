# Writing JTBD Design Doc

Create a durable record of what we decided and why. This is the upstream document that all plans derive from.

## When to use

Any non-trivial feature, system, or architectural decision (3+ files touched, or a decision with long-term consequences). Run this before `/writing-jtbd-plan`.

## Output

File: `docs/dev-notes/YYYY-MM-DD-<topic>.md`

## The JTBD Spine

Three rules to hold while writing:
1. **State the job, not the feature.** "Users need to authenticate" is a job. "Add a login page" is a feature. The job persists; the feature is disposable.
2. **Separate the disposable solution from the durable job.** The current implementation is a short-term bet. The job it serves is the long-term commitment.
3. **Protect each job with a named invariant and a seam.** An invariant is a condition that must always be true. A seam is the boundary where this job can be swapped out later without breaking everything else.

## Template

```markdown
# Design: <Topic> — YYYY-MM-DD

## §1 Job Statement

What is the user trying to accomplish? (One sentence, verb-object form. Not a feature.)

## §2 Context and Constraints

What shaped the decisions below? Deadlines, existing architecture, team size, etc.

## §3 Decisions & Tradeoffs (READ FIRST)

| Decision | Short-term (now) | Long-term target | Don't-lose-this |
|---|---|---|---|
| <decision name> | <what we're doing now> | <where we want to get to> | **Invariant:** <condition that must always hold> / **Seam:** <where we can swap this out later> |

## §4 Alternatives Considered

What else was on the table and why it was rejected.

## §5 Open Questions

Unresolved items that the plan will need to address or that need a decision before implementation.

## §6 Checklist

- [ ] Every decision names a short-term choice AND a long-term target
- [ ] Every Don't-lose-this has a named invariant
- [ ] Every invariant is testable (can become a frozen test)
- [ ] Every seam is explicit (there is a boundary, interface, or abstraction that makes future replacement possible)
- [ ] No feature language in the job statement
- [ ] Sections are numbered (§N) so the derived plan can reference them
- [ ] Alternatives considered are listed with rejection reasons
- [ ] Open questions are listed, not buried
- [ ] A reader unfamiliar with the project could understand the decisions
- [ ] This doc could be handed to a new engineer and they'd know what not to break
```

## Process

1. Start with §1. Get the job statement right before touching anything else.
2. Fill §3 last — decisions crystallize after you've written out the context.
3. For each row in §3, ask: "If we rip this out in 18 months, what must remain true?" That's your invariant.
4. Run the §6 checklist before calling it done.
5. Once complete, derive the plan with `/writing-jtbd-plan`.
