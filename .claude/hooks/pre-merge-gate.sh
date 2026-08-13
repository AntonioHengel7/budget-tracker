#!/usr/bin/env bash
# =============================================================================
# pre-merge-gate.sh — PreToolUse Bash hook
# Guards `gh pr merge` commands. Blocks unless ALL of:
#   (a) SOCRATES + PLATO + HOBBES each have a "PASS @ <head-sha>" verdict
#       posted by the AUTHENTICATED ACCOUNT (gh api user) in PR comments
#       (SHA-bound, structural author filter — body injection cannot forge author)
#   (b) coverage-gate.sh exits 0
#   (c) .jome/verify.sh exits 0 (skipped if absent)
#
# Only active in repos with .jome/coverage.json `"enforce": true`.
#
# ADVISORY layer — catches honest mistakes for the common single-operation case.
# The authoritative guarantee that nothing reaches main is GitHub branch
# protection (see .jome/README.md § Branch Protection). A determined caller
# using compound commands or raw REST is intentionally out of scope for this
# local hook.
#
# CORE PRINCIPLE: the merge gate FAILS CLOSED — any inability to verify
# (gh unavailable, PR not found, no verdicts, stale SHA, wrong author)
# blocks the merge rather than allowing it through. Ambiguity must block.
#
# Commit-msg and push-guard keep the OPPOSITE policy: fail-open (allow on
# ambiguity). The merge gate is the last line of defence.
#
# STRUCTURAL INVARIANT (chaining): this hook counts distinct merge actions in
# the command string. Any count > 1 — regardless of separator (&&, ||, ;, &,
# newline) — is blocked without further parsing. One merge per command is the
# only form this hook can verify. The count-based approach is separator-
# agnostic and cannot be bypassed by choosing a different chaining syntax.
#
# Exit semantics:
#   0 — allow (not a gh pr merge command, or repo not enforced)
#   2 — block (with stderr message naming which check(s) failed)
# =============================================================================
set -euo pipefail

# Source the shared enforcement gate.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/enforce-gate.sh
source "$SCRIPT_DIR/lib/enforce-gate.sh"

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# ---------------------------------------------------------------------------
# STRUCTURAL INVARIANT: count ALL merge actions in the command.
#
# Two forms are counted:
#   Porcelain: \bgh pr merge\b  (the standard path this hook verifies)
#   REST:      \bgh api\b ... pulls/N/merge  (bypasses porcelain — blocked)
#
# If total count == 0 → not a merge command, pass through (exit 0).
# If total count >  1 → chained merges; cannot verify any of them; BLOCK.
#                        This is separator-agnostic: &&, ||, ;, &, newline
#                        all produce count > 1, regardless of form.
# If total count == 1, REST form → raw REST route; BLOCK (can't verify).
# If total count == 1, porcelain → proceed to PR-number + verdict checks.
#
# Fail-open: not enforced → allow regardless of count.
# ---------------------------------------------------------------------------
_PORCELAIN_MERGES=$(printf '%s' "$COMMAND" | \
  { grep -oE '\bgh[[:space:]]+pr[[:space:]]+merge\b' || true; } | wc -l | tr -d ' ')
_REST_MERGES=$(printf '%s' "$COMMAND" | \
  { grep -oE '\bgh[[:space:]]+api\b[^|;&]*\bpulls/[0-9]+/merge\b' || true; } | wc -l | tr -d ' ')
_TOTAL_MERGES=$(( _PORCELAIN_MERGES + _REST_MERGES ))

# Not a merge command — pass through.
[ "$_TOTAL_MERGES" -eq 0 ] && exit 0

# Fail-open: not enforced → allow.
repo_is_enforced "$COMMAND" || exit 0

# BLOCK: more than one merge action — structural kill for all chaining forms.
if [ "$_TOTAL_MERGES" -gt 1 ]; then
  echo "ERROR: PR merge blocked — one merge per command — chained merges can't be verified; run each merge separately." >&2
  exit 2
fi

# BLOCK: raw REST merge route (single, but bypasses the porcelain verification path).
if [ "$_REST_MERGES" -eq 1 ]; then
  echo "ERROR: raw REST merge endpoint is blocked in this enforced repo." >&2
  echo "  Use 'gh pr merge <N>' for the verified merge path." >&2
  echo "  See .claude/lib/gh-schema.md for details." >&2
  exit 2
fi

# Single porcelain merge — proceed with PR-number + verdict verification.

# ---------------------------------------------------------------------------
# F1: Robust PR number extraction (N1: positional-only, skip flag values).
#
# Strategy: extract the part of the command after "gh pr merge", then
# tokenise (respecting shell quoting via xargs), skip flag tokens AND the
# arguments that follow value-taking flags (--body/-b, --match-head-commit,
# --repo/-R), and take the first purely numeric positional token.
# Handles:
#   gh pr merge 7             (plain)
#   gh pr merge --squash 7    (flag before number)
#   gh pr merge -s 7          (short flag before number)
#   gh pr merge --body 42 7   (value-taking flag with numeric value: 42 skipped)
#   gh pr merge "7"           (quoted number — xargs strips quotes)
#   gh pr merge  7            (extra whitespace)
#   gh pr merge               (flag-less: resolves current branch's PR via gh)
#
# If NO PR number can be resolved → FAIL CLOSED (exit 2).
# ---------------------------------------------------------------------------
extract_pr_number() {
  local cmd="$1"

  # Extract the segment after "gh pr merge", collapsing whitespace.
  local after
  after=$(printf '%s' "$cmd" | sed 's/.*gh[[:space:]]\{1,\}pr[[:space:]]\{1,\}merge//')

  # Tokenise (xargs strips shell quoting and splits on whitespace).
  local -a tokens=()
  while IFS= read -r tok; do
    [ -n "$tok" ] && tokens+=("$tok")
  done < <(printf '%s' "$after" | xargs -n1 printf '%s\n' 2>/dev/null || true)

  # Walk tokens: skip flag tokens and the values of value-taking flags.
  local _i=0 _n="${#tokens[@]}" _skip_next=0
  while [ "$_i" -lt "$_n" ]; do
    local tok="${tokens[$_i]}"
    _i=$(( _i + 1 ))

    if [ "$_skip_next" -eq 1 ]; then
      _skip_next=0
      continue
    fi

    # Skip flag tokens (start with -); track value-taking ones.
    if [[ "$tok" == -* ]]; then
      # These flags take a SEPARATE next argument (not embedded via '=').
      # --body-file/-F and --subject/-t also take a value; their numeric
      # arguments must not be mistaken for the PR number.
      case "$tok" in
        --body|-b|--body-file|-F|--subject|-t|--match-head-commit|--repo|-R)
          _skip_next=1 ;;
      esac
      continue
    fi

    # Return the first purely numeric positional token — that is the PR number.
    if printf '%s' "$tok" | grep -qE '^[0-9]+$'; then
      printf '%s' "$tok"
      return 0
    fi
  done
  return 1
}

PR_NUM=$(extract_pr_number "$COMMAND" 2>/dev/null || true)

if [ -z "$PR_NUM" ]; then
  # No inline PR number — flag-less `gh pr merge` form: resolve the current
  # branch's open PR number via gh.
  set +e
  PR_NUM=$(gh pr view --json number --jq '.number' 2>/dev/null)
  set -e
fi

if [ -z "$PR_NUM" ]; then
  echo "ERROR: gh pr merge blocked — unable to resolve a PR number." >&2
  echo "  Specify the PR number explicitly: gh pr merge <N> --squash" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Locate repo root for finding .jome/verify.sh and coverage-gate.sh.
# Use _effective_dir to handle cwd-reset: the hook runs with cwd=Jome root,
# but the command may target a different repo via `cd <path>`.
# Fail CLOSED if not in a git repo (shouldn't happen after repo_is_enforced).
# ---------------------------------------------------------------------------
TARGET_DIR=$(_effective_dir "$COMMAND")
REPO_ROOT=$(git -C "$TARGET_DIR" rev-parse --show-toplevel 2>/dev/null) || {
  echo "ERROR: PR #${PR_NUM} merge blocked — not inside a git repository." >&2
  exit 2
}

# Allow tests to override coverage-gate path via env var for stubbing.
COVERAGE_GATE="${JOME_COVERAGE_GATE_BIN:-$SCRIPT_DIR/lib/coverage-gate.sh}"

# ---------------------------------------------------------------------------
# N2b: Extract --repo/-R value for cross-repo merges.
# When present, all gh pr view calls are directed to that repo.
# ---------------------------------------------------------------------------
CROSS_REPO=""
_EXTRACT_AFTER=$(printf '%s' "$COMMAND" | sed 's/.*gh[[:space:]]\{1,\}pr[[:space:]]\{1,\}merge//')
_SKIP_R=0
while IFS= read -r _RT; do
  [ -z "$_RT" ] && continue
  if [ "$_SKIP_R" -eq 1 ]; then
    CROSS_REPO="$_RT"
    break
  fi
  case "$_RT" in
    --repo|-R) _SKIP_R=1 ;;
    --repo=*)  CROSS_REPO="${_RT#*=}"; break ;;
  esac
done < <(printf '%s' "$_EXTRACT_AFTER" | xargs -n1 printf '%s\n' 2>/dev/null || true)

# Helper: invoke `gh pr view` with optional cross-repo -R flag.
gh_pr_view() {
  if [ -n "$CROSS_REPO" ]; then
    gh pr view -R "$CROSS_REPO" "$@"
  else
    gh pr view "$@"
  fi
}

# ---------------------------------------------------------------------------
# B1: Authenticated-user verdict check (structural author filtering).
#
# Trust anchor: the AUTHENTICATED ACCOUNT (gh api user), NOT the repo owner.
# This is the account that actually posts verdicts and works correctly for
# org-owned repos where the poster is not the org owner.
#
# Injection prevention: author filtering is done STRUCTURALLY inside jq via
# select(.author.login==$me). An attacker whose comment body contains a
# newline followed by a fake author+verdict line cannot forge a verdict —
# jq reads the structured .author.login field, not a substring of a
# concatenated string. We also only consider the FIRST LINE of each comment
# body (split("\n")[0]), so body content after the first newline is ignored.
#
# A verdict counts ONLY when ALL of these hold:
#   1. The comment was authored by the authenticated account (ME).
#   2. The comment body's first line matches exactly:
#        <AGENT>: PASS @ <current-head-SHA>
#      or starts with:
#        <AGENT>: FAIL @ <current-head-SHA>
# For each agent we take the LATEST matching verdict (comments are iterated
# oldest → newest, so later entries overwrite earlier ones).
# Missing, FAIL, or stale (wrong SHA) → block.
# ---------------------------------------------------------------------------

# Get the authenticated user login. Fail CLOSED if unavailable.
set +e
ME=$(gh api user --jq '.login' 2>/dev/null)
ME_EXIT=$?
set -e

if [ "$ME_EXIT" -ne 0 ] || [ -z "$ME" ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — unable to resolve authenticated user (gh api user)." >&2
  echo "  Verify gh is authenticated: gh auth status" >&2
  exit 2
fi

# Get the PR's current head commit SHA. Fail CLOSED if unavailable.
set +e
HEAD_SHA=$(gh_pr_view "$PR_NUM" --json headRefOid --jq '.headRefOid' 2>/dev/null)
HEAD_SHA_EXIT=$?
set -e

if [ "$HEAD_SHA_EXIT" -ne 0 ] || [ -z "$HEAD_SHA" ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — unable to resolve head commit SHA." >&2
  echo "  Verify the PR exists and gh is authenticated." >&2
  exit 2
fi

# Fetch all comments as raw JSON, then structurally filter:
#   - Only comments authored by ME (.author.login == $me)
#   - Only the first line of each comment body (split("\n")[0])
# This yields VERDICTS_RAW: one line per qualifying comment, containing the
# first line of that comment's body. Injection via embedded newlines in body
# text cannot affect the author filter since jq reads the structured field.
set +e
COMMENTS_JSON=$(gh_pr_view "$PR_NUM" --json comments 2>/dev/null)
COMMENTS_EXIT=$?
set -e

if [ "$COMMENTS_EXIT" -ne 0 ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — unable to read PR comments." >&2
  exit 2
fi

VERDICTS_RAW=$(printf '%s' "$COMMENTS_JSON" | \
  jq -r --arg me "$ME" \
  '.comments[] | select(.author.login==$me) | (.body | split("\n")[0])' 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Process VERDICTS_RAW oldest-to-newest, tracking the latest verdict per agent.
# Each line in VERDICTS_RAW is the first line of a ME-authored comment.
# MISSING = no verdict for this SHA; PASS = latest is pass; FAIL = latest is fail.
# ---------------------------------------------------------------------------
VERDICT_SOCRATES="MISSING"
VERDICT_PLATO="MISSING"
VERDICT_HOBBES="MISSING"

if [ -n "$VERDICTS_RAW" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue

    # SOCRATES — PASS requires exact match ($); FAIL allows trailing reason text.
    if printf '%s' "$line" | grep -qE "^SOCRATES: PASS @ ${HEAD_SHA}$"; then
      VERDICT_SOCRATES="PASS"
    elif printf '%s' "$line" | grep -qE "^SOCRATES: FAIL @ ${HEAD_SHA}"; then
      VERDICT_SOCRATES="FAIL"
    fi

    # PLATO
    if printf '%s' "$line" | grep -qE "^PLATO: PASS @ ${HEAD_SHA}$"; then
      VERDICT_PLATO="PASS"
    elif printf '%s' "$line" | grep -qE "^PLATO: FAIL @ ${HEAD_SHA}"; then
      VERDICT_PLATO="FAIL"
    fi

    # HOBBES
    if printf '%s' "$line" | grep -qE "^HOBBES: PASS @ ${HEAD_SHA}$"; then
      VERDICT_HOBBES="PASS"
    elif printf '%s' "$line" | grep -qE "^HOBBES: FAIL @ ${HEAD_SHA}"; then
      VERDICT_HOBBES="FAIL"
    fi
  done <<< "$VERDICTS_RAW"
fi

MISSING_VERDICTS=""
FAIL_VERDICTS=""
[ "$VERDICT_SOCRATES" = "MISSING" ] && MISSING_VERDICTS="${MISSING_VERDICTS} SOCRATES"
[ "$VERDICT_PLATO"    = "MISSING" ] && MISSING_VERDICTS="${MISSING_VERDICTS} PLATO"
[ "$VERDICT_HOBBES"   = "MISSING" ] && MISSING_VERDICTS="${MISSING_VERDICTS} HOBBES"
[ "$VERDICT_SOCRATES" = "FAIL" ]    && FAIL_VERDICTS="${FAIL_VERDICTS} SOCRATES"
[ "$VERDICT_PLATO"    = "FAIL" ]    && FAIL_VERDICTS="${FAIL_VERDICTS} PLATO"
[ "$VERDICT_HOBBES"   = "FAIL" ]    && FAIL_VERDICTS="${FAIL_VERDICTS} HOBBES"

if [ -n "$MISSING_VERDICTS" ] || [ -n "$FAIL_VERDICTS" ]; then
  [ -n "$MISSING_VERDICTS" ] && \
    echo "ERROR: PR #${PR_NUM} merge blocked — missing PASS @ ${HEAD_SHA} verdict(s):${MISSING_VERDICTS}" >&2
  [ -n "$FAIL_VERDICTS" ] && \
    echo "ERROR: PR #${PR_NUM} merge blocked — FAIL verdict(s) for commit ${HEAD_SHA}:${FAIL_VERDICTS}" >&2
  echo "  Post verdicts as: <AGENT>: PASS @ ${HEAD_SHA}" >&2
  echo "  See .claude/lib/gh-schema.md for the verdict format." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# (b) COVERAGE GATE: run coverage-gate.sh using .jome/coverage.json config.
# ---------------------------------------------------------------------------
COVERAGE_FAILED=0
COVERAGE_MSG=""

if [ -f "$COVERAGE_GATE" ]; then
  CONFIG="$REPO_ROOT/.jome/coverage.json"
  if [ -f "$CONFIG" ]; then
    GATE_MODE=$(jq -r '.mode // "bar"' "$CONFIG")
    GATE_THRESHOLD=$(jq -r '.thresholds.core // 95' "$CONFIG")
    GATE_BASELINE=$(jq -r '.baseline // empty' "$CONFIG" 2>/dev/null || true)

    set +e
    if [ "$GATE_MODE" = "ratchet" ] && [ -n "$GATE_BASELINE" ]; then
      COVERAGE_MSG=$(cd "$REPO_ROOT" && bash "$COVERAGE_GATE" --mode ratchet --baseline "$GATE_BASELINE" 2>&1)
    else
      COVERAGE_MSG=$(cd "$REPO_ROOT" && bash "$COVERAGE_GATE" --mode bar --core-threshold "$GATE_THRESHOLD" 2>&1)
    fi
    COVERAGE_EXIT=$?
    set -e

    if [ "$COVERAGE_EXIT" -ne 0 ]; then
      COVERAGE_FAILED=1
    fi
  fi
fi

if [ "$COVERAGE_FAILED" -ne 0 ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — coverage gate failed." >&2
  [ -n "$COVERAGE_MSG" ] && echo "  $COVERAGE_MSG" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# (c) BUILD / TESTS: .jome/verify.sh if present; skip if absent.
# ---------------------------------------------------------------------------
VERIFY_SCRIPT="$REPO_ROOT/.jome/verify.sh"

if [ -f "$VERIFY_SCRIPT" ] && [ -x "$VERIFY_SCRIPT" ]; then
  set +e
  VERIFY_MSG=$(cd "$REPO_ROOT" && bash "$VERIFY_SCRIPT" 2>&1)
  VERIFY_EXIT=$?
  set -e

  if [ "$VERIFY_EXIT" -ne 0 ]; then
    echo "ERROR: PR #${PR_NUM} merge blocked — build/test verification failed." >&2
    [ -n "$VERIFY_MSG" ] && echo "  $VERIFY_MSG" >&2
    exit 2
  fi
fi

# All checks passed.
exit 0
