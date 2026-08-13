#!/usr/bin/env bash
# reflect-stop.sh — Stop hook
# Forces a reflection turn after non-trivial responses (>1000 chars).
# Skips if response starts with "REFLECTION:" to prevent infinite loops.
# Outputs {"decision": "block", "reason": "..."} or {"decision": "approve"}.

set -euo pipefail

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# No transcript available — approve stop silently
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  echo '{"decision": "approve"}'
  exit 0
fi

# Extract last assistant text block from JSONL transcript
set +e
LAST_OUTPUT=$(grep '"role":"assistant"' "$TRANSCRIPT" 2>/dev/null | tail -n 50 | \
  jq -rs 'map(.message.content[]? | select(.type == "text") | .text) | last // ""' 2>/dev/null)
JQ_EXIT=$?
set -e

if [ $JQ_EXIT -ne 0 ] || [ -z "$LAST_OUTPUT" ]; then
  echo '{"decision": "approve"}'
  exit 0
fi

# Trivial response — skip reflection
CHAR_COUNT=${#LAST_OUTPUT}
if [ "$CHAR_COUNT" -lt 1000 ]; then
  echo '{"decision": "approve"}'
  exit 0
fi

# Already a reflection turn — prevent infinite loop
if echo "$LAST_OUTPUT" | head -c 15 | grep -q '^REFLECTION:'; then
  echo '{"decision": "approve"}'
  exit 0
fi

REFLECTION='REFLECTION: Before stopping, quickly check (keep it brief):
1. Anything novel learned this turn? If yes, add 1-2 lines to tasks/lessons-short-term.md.
   Format: [date] PATTERN: what went wrong. RULE: what to do instead.
2. Does tasks/todo.md need updating? (new items, completed items)
3. Could the lesson be a hook, CLAUDE.md rule, or skill instead of prose? If yes, encode it structurally instead.
Only write if there is something genuinely worth capturing. Skip if this was routine.
Start your response with exactly "REFLECTION:".'

jq -n --arg reason "$REFLECTION" '{"decision": "block", "reason": $reason}'
exit 0
