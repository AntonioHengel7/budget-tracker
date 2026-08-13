# Team

Coordinate work across multiple repos by spawning a headless Claude session in a target repo and relaying turns.

## When to use

When you need to work on a different repo (AgentForge, DM's Hand, observability-platform, etc.) without switching your current context. Jome acts as meta-lead; Claude in the target repo does the work.

## Usage

```
/team <absolute-path-to-repo>
```

Or use a known short name (Jome resolves these):
- `agentforge` → `/Users/antonio/Documents/Projects/AgentForge`
- `dms-hand` → `/Users/antonio/Documents/Projects/AgentForge/output/the-dms-hand`
- `observability` → `/Users/antonio/Documents/Projects/observability-platform`

## How it works

1. Jome receives the relay request and the target repo path
2. For each message you want to send to the target repo, Jome runs:
   `claude --print "<your message>" --cwd <target-repo-path>`
3. The output is returned to you through Jome
4. Jome can interpret, filter, or act on the output before relaying it back

## Modes

**Relay (default):** Every turn goes through Jome. Good when you want Jome to interpret or act on results.

**Direct:** Jome gives you the exact command to run yourself so you can interact with the target repo's Claude session directly. Use this when you want unfiltered access.

## Notes

- The target repo doesn't need a special config — it just runs whatever Claude Code setup it has
- Each relay is stateless (no persistent session between turns unless you chain messages)
- For long-running tasks in the target repo, consider using the Agent tool with a builder subagent pointed at the target path instead
