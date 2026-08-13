#!/usr/bin/env bash
# post-compact-context.sh — PostCompact hook
# Re-inject long-term lessons immediately after compaction.
# Belt-and-suspenders: context-inject.sh re-injects on the next UserPromptSubmit;
# this covers the compact turn itself. Skips cleanly when there are no real lessons.
# Always exits 0.

set -euo pipefail

LESSONS_FILE="$(cd "$(dirname "$0")/../.." && pwd)/tasks/lessons-long-term.md"

[ -f "$LESSONS_FILE" ] || exit 0

# Real lesson entries look like "- ...", "* ...", "[2026-..." or a numbered item.
# If none exist, the file is just boilerplate header — nothing to restore.
ENTRIES=$(grep -E '^\s*([-*]|\[|[0-9]+\.)' "$LESSONS_FILE" 2>/dev/null || true)
[ -n "$ENTRIES" ] || exit 0

# Cap at the last WHOLE line within budget — `head -c` chopped entries
# mid-sentence, and 2000 bytes could not hold the 20 entries CLAUDE.md §3 allows.
CONTENT=$(awk -v max=6000 '
  { n += length($0) + 1
    if (n > max) { print "… (truncated at " max " bytes — prune lessons-long-term.md)"; exit }
    print }' "$LESSONS_FILE")
MSG="POST-COMPACT CONTEXT RESTORED

$CONTENT"

jq -n --arg msg "$MSG" '{"systemMessage": $msg}'
exit 0
