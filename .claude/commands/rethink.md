# Rethink

Stop generating. Start verifying.

## Rule

**Every claim needs a `file:line` citation or an explicit retraction.**

A claim without a code reference is not a finding. It's a guess dressed up as confidence.

## Process

Go through your last response or the current analysis. For each claim:

1. **Can you cite it?** Find the file, read it this session, get the line number. Format: `path/to/file.ext:42`
2. **If you can't cite it:** Retract it. Say: "I said X but I haven't verified this — retracting until I read the source."
3. **If you cited it and it checks out:** It stands.

## Gotcha List

Things that commonly get stated as facts without verification — never say these without having read the file this session:

- "The code does X" or "X is implemented in Y"
- "This function calls Z"
- "The config is set to..."
- "There are N occurrences of..."
- "This was added in commit..."
- "The test covers..."
- "X is not implemented" (absence claims require a search, not just a lack of memory)

## Proactive Triggers

Run `/rethink` before:
- Presenting an architecture summary
- Presenting a gap analysis
- Making cross-repo claims
- Sharing anything with decision-makers
- Saying "the codebase does X" in any form

## Output Format

```
RETHINK AUDIT

Claim: "<original claim>"
Status: VERIFIED / RETRACTED
Citation: path/to/file.ext:42 (if verified) | "Haven't read this yet" (if retracting)

...repeat for each claim...

VERDICT: N verified, M retracted.
```
