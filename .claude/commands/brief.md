# Brief

Read memory and return a focused briefing for the current task.

## When to use

- After context compaction (memory was reset, you need to reconstruct what was happening)
- Switching domains mid-session (e.g., moving from DM's Hand to observability platform)
- Starting a new session and the context-inject didn't capture enough
- Antonio asks "what were we doing?"

## Process

1. Read `tasks/todo.md` — what's open?
2. Read `tasks/lessons-short-term.md` — what patterns are actively being tracked?
3. Read `tasks/lessons-long-term.md` — what principles apply to this task?
4. Read the relevant project memory file from `~/.claude/projects/-Users-antonio-Documents-Projects-Jome/memory/` if the current task is project-specific
5. Filter everything to what's relevant to the current task or conversation context

## Output Format

```
BRIEF — <date>

**Continuing:** <what was in progress, if anything>

**Open commitments:** <anything promised but not delivered>

**Relevant patterns:** <short-term lessons that apply to this task>

**Watch out for:** <known pitfalls or traps from memory>

**Last time:** <last meaningful thing that happened in this domain, if known>
```

Keep it tight. If a section is empty, omit it. The goal is a 10-second read that gets you back up to speed.
