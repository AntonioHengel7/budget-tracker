# Freeze

Lock the edit scope to a specific set of paths. Useful for focused build sprints where you want to prevent accidental changes outside the target area.

## How it works

Creating `.claude/freeze.lock` activates the freeze. The `pre-edit-freeze.sh` hook reads this file and blocks any Edit or Write outside the listed paths.

## Usage

To freeze:

```
Create .claude/freeze.lock with the allowed paths (one per line):
path/to/allowed/dir/
path/to/specific/file.ext
```

To unfreeze:

```
Delete .claude/freeze.lock
```

## Notes

- Paths are prefix-matched — `src/auth/` allows edits to any file under `src/auth/`
- The freeze.lock file itself is always locked (only you, not Jome, can delete it)
- If you need to edit something outside the locked paths and it's intentional, delete the lock first, then edit, then re-create it
- Freeze does not affect Bash commands — only Edit and Write tool calls

## When to use

- Before a focused implementation sprint on a specific module
- When you want to ensure a "read-only" review session stays read-only
- When multiple things are in flight and you want to prevent cross-contamination
