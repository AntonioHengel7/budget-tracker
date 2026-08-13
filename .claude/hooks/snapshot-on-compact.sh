#!/usr/bin/env bash
# snapshot-on-compact.sh — Stop hook
# Saves a memory snapshot when transcript size exceeds 3.5MB.
# Uses transcript file size as a proxy for context usage.
# Always exits 0 (never blocks).

set -euo pipefail

INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# No transcript — nothing to do
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

TRANSCRIPT_SIZE=$(wc -c < "$TRANSCRIPT" 2>/dev/null | tr -d ' ' || echo "0")
THRESHOLD=3670016  # 3.5 MB in bytes — fires before compaction, not at it

if [ "$TRANSCRIPT_SIZE" -lt "$THRESHOLD" ]; then
  exit 0
fi

# Threshold exceeded — save a snapshot
# Derive the Claude project dir from the repo path rather than hardcoding it:
# Claude Code encodes a project directory by replacing "/" with "-".
# Hardcoding tied snapshots to one machine's layout and silently broke as soon
# as .claude/ was copied into another repo.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_SLUG="$(printf '%s' "$REPO_ROOT" | sed 's|/|-|g')"
MEMORY_DIR="$HOME/.claude/projects/$PROJECT_SLUG/memory/snapshots"
mkdir -p "$MEMORY_DIR"

SNAPSHOT_FILE="$MEMORY_DIR/snapshot-$(date +%Y%m%d-%H%M%S).md"
TRANSCRIPT_SIZE_MB=$(echo "scale=1; $TRANSCRIPT_SIZE / 1048576" | bc 2>/dev/null || echo "large")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Extract last 20 assistant messages for context
set +e
RECENT_CONTEXT=$(grep '"role":"assistant"' "$TRANSCRIPT" 2>/dev/null | tail -n 20 | \
  jq -rs 'map(.message.content[]? | select(.type == "text") | .text) | join("\n\n---\n\n")' 2>/dev/null | \
  head -c 4000 || echo "[Could not extract context]")
set -e

{
  printf "# Context Snapshot — %s\n\n" "$(date +"%Y-%m-%d %H:%M:%S")"
  printf "Transcript: %sMB (threshold: 3.5MB)\n" "$TRANSCRIPT_SIZE_MB"
  printf "Session: %s\n\n" "$SESSION_ID"
  printf "## Recent Work\n\n"
  printf "%s\n" "$RECENT_CONTEXT"
} > "$SNAPSHOT_FILE"

MSG="Context at ${TRANSCRIPT_SIZE_MB}MB — compaction likely imminent. Snapshot saved: $SNAPSHOT_FILE. Run /brief after compaction to recover context."
jq -n --arg msg "$MSG" '{"systemMessage": $msg}'
exit 0
