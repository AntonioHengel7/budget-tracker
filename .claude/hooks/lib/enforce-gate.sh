#!/usr/bin/env bash
# =============================================================================
# enforce-gate.sh — Shared opt-in enforcement check (sourceable library).
#
# Exposes: _effective_dir(), repo_is_enforced()
#
#   _effective_dir <command>
#     Returns the directory the command will actually run in: the last
#     `cd <path>` token in the command string, else $PWD.
#
#   repo_is_enforced <command>
#     Returns 0 (enforced) ONLY when:
#       1. The command's effective dir is inside a git repo
#       2. $root/.jome/coverage.json exists
#       3. jq -e '.enforce == true' succeeds on that file
#     Returns 1 (not enforced) for ANY other condition — fail-open.
#
# Fix for cwd-reset bug (#1):
#   Hooks run with cwd=Jome root between tool calls.  A command like
#   `cd /other/repo && gh pr merge 5` targets a different repo.  The old
#   code keyed enforcement off $PWD, so it was always dormant when Jome
#   itself lacks .jome/coverage.json.
#   The new code extracts the last `cd <path>` from the command string;
#   enforcement is resolved at that LOCAL directory (else cwd).
#   Accepted advisory limitation: `-R owner/repo`-only and `git -C <other>`
#   targets without a preceding `cd` carry no local path to read
#   .jome/coverage.json from and are NOT locally resolvable.
#   Server-side verdicts and GitHub branch protection are the backstop.
#
# Usage:
#   Source:     source "$(dirname "$0")/lib/enforce-gate.sh"
#               repo_is_enforced "$COMMAND" && echo "enforced" || echo "dormant"
#
#   Standalone: bash .claude/hooks/lib/enforce-gate.sh; echo "exit=$?"
#               exit 0 = enforced, exit 1 = not enforced
# =============================================================================
# F6: set -euo pipefail ensures the standalone path can't silently invert
# the fail-open contract.
set -euo pipefail

# _effective_dir <command> — the dir the command runs in: the last `cd <path>`
# token in the command string, else $PWD.
#
# Handles: bare paths, double-quoted paths ("some path"), single-quoted paths
# ('some path'), tilde expansion, and all shell separators (&&, ||, ;, |, &).
_effective_dir() {
  local cmd="${1:-}" p
  p=$(printf '%s' "$cmd" | grep -oE '(^|[;&|])[[:space:]]*cd[[:space:]]+("[^"]+"|'\''[^'\'']+'\''|[^[:space:];&|]+)' | tail -1 | sed -E 's/.*cd[[:space:]]+//; s/^["'\'']//; s/["'\'']$//')
  if [ -n "$p" ]; then p="${p/#\~/$HOME}"; [ -d "$p" ] && { printf '%s' "$p"; return; }; fi
  pwd
}

# repo_is_enforced <command> — true(0) only if the command's effective repo has
# .jome/coverage.json enforce:true. Fail-open (return 1) on any error.
repo_is_enforced() {
  local cmd="${1:-}" dir root
  dir=$(_effective_dir "$cmd") || return 1
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -f "$root/.jome/coverage.json" ] || return 1
  # jq -e exits 1 if the expression is false/null; exits nonzero if JSON is invalid.
  jq -e '.enforce == true' "$root/.jome/coverage.json" >/dev/null 2>&1 || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Standalone invocation: exit 0 = enforced, exit 1 = not enforced.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if repo_is_enforced ""; then
    exit 0
  else
    exit 1
  fi
fi
