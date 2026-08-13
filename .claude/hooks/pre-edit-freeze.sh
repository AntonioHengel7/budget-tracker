#!/usr/bin/env bash
# Enforce .claude/freeze.lock scope. Blocks Edit/Write outside locked paths.

LOCK_FILE="$(dirname "$0")/../freeze.lock"

# No lock file = no freeze active
if [ ! -f "$LOCK_FILE" ]; then
  exit 0
fi

# Read the target file path from tool input
INPUT=$(cat)
TARGET=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file_path', d.get('path', '')))" 2>/dev/null || echo "")

if [ -z "$TARGET" ]; then
  exit 0
fi

# Resolve to absolute path
TARGET=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$TARGET" 2>/dev/null || echo "$TARGET")

# The freeze.lock itself is always off-limits to agent edits
LOCK_REAL=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$LOCK_FILE")
if [ "$TARGET" = "$LOCK_REAL" ]; then
  echo "{\"decision\": \"block\", \"reason\": \"freeze.lock is operator-only. Delete it yourself to unfreeze.\"}"
  exit 2
fi

# Read allowed paths and check if target is within any of them
ALLOWED_PATHS=$(grep -v '^#' "$LOCK_FILE" | grep -v '^[[:space:]]*$')

while IFS= read -r ALLOWED; do
  ALLOWED_REAL=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$ALLOWED" 2>/dev/null || echo "$ALLOWED")
  if [[ "$TARGET" == "$ALLOWED_REAL"* ]]; then
    exit 0
  fi
done <<< "$ALLOWED_PATHS"

# Target is outside all allowed paths — block
LOCKED_LIST=$(echo "$ALLOWED_PATHS" | tr '\n' ', ' | sed 's/, $//')
echo "{\"decision\": \"block\", \"reason\": \"Freeze active. '$TARGET' is outside locked paths: $LOCKED_LIST. Delete .claude/freeze.lock to unfreeze.\"}"
exit 2
