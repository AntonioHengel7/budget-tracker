#!/usr/bin/env bash
# Save open todos before compaction so in-progress state isn't lost.

TASKS_DIR="$(dirname "$0")/../../tasks"
TODO_FILE="$TASKS_DIR/todo.md"
STATE_FILE="$TASKS_DIR/pre-compact-state.md"

if [ ! -f "$TODO_FILE" ]; then
  exit 0
fi

OPEN_ITEMS=$(grep "^- \[ \]" "$TODO_FILE" 2>/dev/null || echo "")

if [ -z "$OPEN_ITEMS" ]; then
  exit 0
fi

TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
cat > "$STATE_FILE" <<EOF
# Pre-Compact State — $TIMESTAMP

Open items at time of compaction:

$OPEN_ITEMS
EOF

echo "{\"systemMessage\": \"Pre-compact checkpoint saved to tasks/pre-compact-state.md\"}"
exit 0
