# Grill Me

Resolve unresolved branches in a plan or design through a depth-first interview.

## When to use

- A plan has two or more unresolved branches ("we could do X or Y")
- A design has open questions that are blocking progress
- You have a proposal but aren't confident in the assumptions behind it
- Antonio asks you to probe a decision more deeply

## Rule

**One question at a time.** Each question comes with your proposed answer. Don't dump a list of questions — resolve the tree one node at a time.

## Process

1. Identify all unresolved branches or open questions.
2. Pick the most load-bearing one (the one whose answer would collapse the most other branches).
3. Ask it via AskUserQuestion with your proposed answer as the default option.
4. Based on the answer, either: (a) resolve the next branch, or (b) update your understanding and re-examine.
5. Continue until the decision tree is fully resolved.

## Format

Each question should be:
- One sentence
- Paired with your proposed answer (and why)
- Specific enough that a yes/no or a single choice resolves it

## Proactive Trigger

If you're writing a plan and notice two or more unresolved branches, stop and run `/grill-me` before continuing. A plan with unresolved branches is not a plan — it's a list of possibilities.
