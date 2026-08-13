#!/usr/bin/env bash
# Inject planning card when design/plan keywords detected.
# Nudge delegation to builder when implementation keywords detected.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('prompt',''))" 2>/dev/null || echo "")

if [ -z "$PROMPT" ]; then
  exit 0
fi

PLANNING_KEYWORDS="design|plan|architect|approach|strategy|structure|how should we|how do we|what's the best way|should we"
IMPL_KEYWORDS="implement|build|write|code|create|add feature|add the"

PLANNING_CARD_PATH="$(dirname "$0")/../docs/planning-card.md"

INJECT=""

# Check for planning/design intent
if echo "$PROMPT" | grep -qiE "$PLANNING_KEYWORDS"; then
  if [ -f "$PLANNING_CARD_PATH" ]; then
    CARD=$(cat "$PLANNING_CARD_PATH")
    INJECT="$INJECT\n\n--- PLANNING REMINDER ---\n$CARD"
  fi
fi

# Check for implementation intent (only nudge, don't inject if planning card already shown)
if echo "$PROMPT" | grep -qiE "$IMPL_KEYWORDS" && ! echo "$PROMPT" | grep -qiE "$PLANNING_KEYWORDS"; then
  INJECT="$INJECT\n\nIMPLEMENTATION NOTE: Consider delegating this to the builder subagent to keep the main context clean."
fi

if [ -n "$INJECT" ]; then
  MSG=$(printf '%s' "$INJECT" | sed 's/^\\n//')
  echo "{\"systemMessage\": \"$MSG\"}"
fi

exit 0
