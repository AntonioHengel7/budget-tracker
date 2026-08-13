#!/usr/bin/env bash
# Detect subagent failure signals and nudge re-delegation instead of absorption.

INPUT=$(cat)

# Extract the stop reason or response from stdin
RESPONSE=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('response', d.get('message', d.get('stop_reason', ''))))
except:
    pass
" 2>/dev/null || echo "")

if [ -z "$RESPONSE" ]; then
  exit 0
fi

RESPONSE_LEN=${#RESPONSE}

# Only flag if the response is short (likely an abort, not real work)
if [ "$RESPONSE_LEN" -gt 400 ]; then
  exit 0
fi

FAILURE_SIGNALS="unable to|failed to|error occurred|couldn't complete|cannot complete|i was unable|i cannot|the agent|subagent"

if echo "$RESPONSE" | grep -qiE "$FAILURE_SIGNALS"; then
  echo "{\"systemMessage\": \"REDISPATCH SIGNAL: A subagent returned a short failure response. Re-delegate to a different agent or approach — don't absorb this work into the main context.\"}"
fi

exit 0
