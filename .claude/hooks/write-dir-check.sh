#!/usr/bin/env bash
# write-dir-check.sh — PreToolUse Write hook
# Lists the target directory contents before any file write.
# Prevents duplicate files and wrong-directory writes.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# No path — nothing to check
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

TARGET_DIR=$(dirname "$FILE_PATH")

if [ ! -d "$TARGET_DIR" ]; then
  MSG="Write check: $TARGET_DIR does not exist yet (will be created)."
  jq -n --arg msg "$MSG" '{"systemMessage": $msg}'
  exit 0
fi

DIR_LISTING=$(ls -1 "$TARGET_DIR" 2>/dev/null | head -30 || true)
FILE_COUNT=$(ls -1 "$TARGET_DIR" 2>/dev/null | wc -l | tr -d ' ' || echo "0")

if [ -z "$DIR_LISTING" ]; then
  MSG="Write check: $TARGET_DIR is empty."
else
  MSG="Write check — $TARGET_DIR ($FILE_COUNT files):
$DIR_LISTING"
fi

jq -n --arg msg "$MSG" '{"systemMessage": $msg}'
exit 0
