#!/usr/bin/env bash
# =============================================================================
# commit-msg-issue-ref.sh — PreToolUse Bash hook
# Blocks git commit commands that lack an issue reference (#N) in the message,
# but only in repos that have explicitly opted in via .jome/coverage.json
# with `"enforce": true`. Dormant (exit 0) in all other repos.
#
# Exit semantics:
#   0 — allow (not a commit, not enforced, has issue ref, or exempt commit)
#   2 — block (enforced repo, missing issue ref)
# =============================================================================
set -euo pipefail

# Source the shared enforcement gate.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/enforce-gate.sh
source "$SCRIPT_DIR/lib/enforce-gate.sh"

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Only act on git commit commands.
if ! printf '%s' "$COMMAND" | grep -qE '\bgit\b.*\bcommit\b'; then
  exit 0
fi

# Fail-open: not enforced → allow.
repo_is_enforced "$COMMAND" || exit 0

# ---------------------------------------------------------------------------
# F3: Extract commit message(s) from the command.
# Handles:
#   -m VALUE          (space-separated, already supported)
#   -m=VALUE          (equals form)
#   --message VALUE   (long form, space-separated)
#   --message=VALUE   (long form, equals)
#   -am / -im / etc.  (combined short flags where m is the last char;
#                      next token is the message value per POSIX convention)
# Strategy: tokenise via xargs (handles quoted strings), then a state-machine
# over tokens looking for all -m / --message variants.
# ---------------------------------------------------------------------------
extract_commit_message() {
  local cmd="$1"
  local msgs=""

  # Use eval-safe tokenisation via bash array.
  local -a tokens=()
  while IFS= read -r token; do
    [ -n "$token" ] && tokens+=("$token")
  done < <(printf '%s' "$cmd" | xargs -n1 printf '%s\n' 2>/dev/null || true)

  local i=0
  local n="${#tokens[@]}"
  while [ "$i" -lt "$n" ]; do
    local tok="${tokens[$i]}"

    # --message=VALUE  (equals form, long)
    if printf '%s' "$tok" | grep -qE '^--message='; then
      msgs+="${tok#--message=}"$'\n'
      i=$(( i + 1 ))
      continue
    fi

    # -m=VALUE  (equals form, short)
    if printf '%s' "$tok" | grep -qE '^-m='; then
      msgs+="${tok#-m=}"$'\n'
      i=$(( i + 1 ))
      continue
    fi

    # --message VALUE  (space-separated, long)
    if [ "$tok" = "--message" ]; then
      local next_i=$(( i + 1 ))
      if [ "$next_i" -lt "$n" ]; then
        msgs+="${tokens[$next_i]}"$'\n'
        i=$(( next_i + 1 ))
        continue
      fi
    fi

    # -m VALUE  (space-separated, short)
    if [ "$tok" = "-m" ]; then
      local next_i=$(( i + 1 ))
      if [ "$next_i" -lt "$n" ]; then
        msgs+="${tokens[$next_i]}"$'\n'
        i=$(( next_i + 1 ))
        continue
      fi
    fi

    # Combined short flags ending in 'm' (e.g. -am, -im):
    # Per POSIX, when 'm' is the last char of a bundled flag, the NEXT token
    # is the message value.
    if printf '%s' "$tok" | grep -qE '^-[a-zA-Z]+m$'; then
      local next_i=$(( i + 1 ))
      if [ "$next_i" -lt "$n" ]; then
        msgs+="${tokens[$next_i]}"$'\n'
        i=$(( next_i + 1 ))
        continue
      fi
    fi

    i=$(( i + 1 ))
  done

  printf '%s' "$msgs"
}

MSG=$(extract_commit_message "$COMMAND")

# ---------------------------------------------------------------------------
# F4: Exempt only genuine git-generated merge/revert commits.
# Narrow exemptions (anchored to git's exact generated prefixes):
#   ^Merge  — git merge, git pull --merge, etc. generate "Merge ..."
#   ^Revert " — git revert generates `Revert "<original subject>"`
# The blanket --no-edit exemption has been removed. The empty-MSG path below
# already handles --no-edit / -F / --amend with no new message (allow).
# ---------------------------------------------------------------------------
if printf '%s' "$MSG" | grep -qE '^(Merge |Revert ")'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Check for issue reference: #<digits>
# If no recognised -m / --message flag was found (e.g. -F file, --amend with
# no new message), we cannot inspect the message — allow to avoid false
# positives (fail-open on unreadable message).
# ---------------------------------------------------------------------------
if [ -z "$MSG" ]; then
  exit 0
fi

if printf '%s' "$MSG" | grep -qE '#[0-9]+'; then
  exit 0
fi

# Block: missing issue reference.
# F8: point to the schema doc, not an opaque code reference.
echo "ERROR: commit message must reference its issue (#N)." >&2
echo "  See .claude/lib/gh-schema.md § Traceability Chain for the required format." >&2
echo "  message: $(printf '%s' "$MSG" | head -1)" >&2
echo "  fix:     git commit -m \"<description> #<issue-number>\"" >&2
exit 2
