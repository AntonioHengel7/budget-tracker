# Pushback

Challenge your own work before presenting it.

## Rule

Work the five angles below. You must find at least one flaw. If all five come back clean, you weren't pushing hard enough — look again.

## The Five Angles

**1. Simpler?**
Is there a version of this that's meaningfully less complex? Would removing one abstraction, one file, or one step make it better without losing the thing it's for?

**2. Assumptions?**
What are you assuming is true that you haven't verified? What happens if any one of those assumptions is wrong?

**3. Failure modes?**
What breaks under load, at the edges, when a dependency fails, or when the user does something unexpected? Which of these are silent failures (no error, wrong result)?

**4. Alternatives?**
What are the two or three other reasonable approaches? Why did you pick this one? Is the reason still true?

**5. Maintenance cost?**
Who has to understand this in 6 months? Is there a way to make it more obvious to that person without making it worse for the current task?

## Process

1. Work each angle seriously — don't phone it in.
2. List every flaw found (even small ones).
3. For each flaw: decide if it's a blocker (fix before presenting) or a known tradeoff (disclose when presenting).
4. Present findings to Antonio with AskUserQuestion.

## Output

Use AskUserQuestion with your findings:
- What you found at each angle
- Which flaws are blockers vs. tradeoffs
- Your recommendation (proceed / revise / rethink entirely)
