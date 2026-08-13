#!/usr/bin/env bash
# context-inject.sh — UserPromptSubmit hook
# Injects today's date, open todo items, and long-term lessons before every turn.
# Raises a promotion nudge when short-term memory has grown past the threshold —
# CLAUDE.md §3 specifies promotion but nothing triggered it, so it never fired.
# Short-term lessons are deliberately NOT injected: per CLAUDE.md §3, long-term
# is the injected identity, short-term is working memory read on demand.
# Always exits 0. Outputs {"systemMessage": "..."} to stdout.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TODAY=$(date +"%Y-%m-%d")
TODO_FILE="$REPO_ROOT/tasks/todo.md"
LESSONS_LONG="$REPO_ROOT/tasks/lessons-long-term.md"
LESSONS_SHORT="$REPO_ROOT/tasks/lessons-short-term.md"

# Byte budget for injected long-term lessons. CLAUDE.md §3 allows 20 entries;
# at ~200 bytes each the old 2000-byte cap silently chopped the file in half.
LONG_TERM_BUDGET=6000
# Short-term entry count at which a promotion pass is due.
PROMOTION_THRESHOLD=8

# _cap <max_bytes> — pass stdin through, stopping at the last WHOLE line that
# fits the budget, so an entry is never cut mid-sentence.
_cap() {
  awk -v max="$1" '
    { n += length($0) + 1
      if (n > max) { print "… (truncated at " max " bytes — prune lessons-long-term.md)"; exit }
      print }'
}

# Collect open todo items (lines starting with "- [ ]")
OPEN_ITEMS=""
if [ -f "$TODO_FILE" ]; then
  OPEN_ITEMS=$(grep -E '^\- \[ \]' "$TODO_FILE" 2>/dev/null | head -10 || true)
fi

# Long-term lessons — the identity file, injected whole within budget
LESSONS=""
if [ -f "$LESSONS_LONG" ]; then
  LESSONS=$(_cap "$LONG_TERM_BUDGET" < "$LESSONS_LONG" 2>/dev/null || true)
fi

# Count short-term entries. Entries are dated: "[2026-08-11] PATTERN: … RULE: …"
SHORT_COUNT=0
if [ -f "$LESSONS_SHORT" ]; then
  SHORT_COUNT=$(grep -cE '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}\]' "$LESSONS_SHORT" 2>/dev/null || true)
  [ -n "$SHORT_COUNT" ] || SHORT_COUNT=0
fi

# Build context block
CONTEXT="=== SESSION CONTEXT ===
Today: $TODAY"

if [ -n "$OPEN_ITEMS" ]; then
  CONTEXT="$CONTEXT

Open tasks (tasks/todo.md):
$OPEN_ITEMS"
fi

if [ -n "$LESSONS" ]; then
  CONTEXT="$CONTEXT

Long-term lessons:
$LESSONS"
fi

if [ "$SHORT_COUNT" -ge "$PROMOTION_THRESHOLD" ]; then
  CONTEXT="$CONTEXT

PROMOTION DUE — tasks/lessons-short-term.md holds $SHORT_COUNT entries (threshold $PROMOTION_THRESHOLD).
Before this session ends, run the promotion pass (CLAUDE.md §3):
  1. Read tasks/lessons-short-term.md and cluster entries by underlying cause,
     not surface symptom — three bugs in one subsystem are usually one principle.
  2. Any cluster with 2+ independent occurrences: write the condensed principle
     to tasks/lessons-long-term.md, then delete the short-term entries it absorbed.
  3. Per §3b, if the principle could be a hook, a CLAUDE.md rule, or a skill,
     build that instead of writing prose.
  4. Keep long-term under 20 entries — merge before adding."
fi

CONTEXT="$CONTEXT
========================"

jq -n --arg msg "$CONTEXT" '{"systemMessage": $msg}'
exit 0
