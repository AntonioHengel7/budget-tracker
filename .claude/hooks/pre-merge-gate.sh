#!/usr/bin/env bash
# =============================================================================
# pre-merge-gate.sh — PreToolUse Bash hook
# Guards `gh pr merge` commands. Blocks unless ALL of:
#   (a)  SOCRATES + PLATO + HOBBES each have a "PASS @ <head-sha>" verdict
#        posted by the AUTHENTICATED ACCOUNT (gh api user) in PR comments
#        (SHA-bound, structural author filter — body injection cannot forge author)
#   (a2) GitHub's actual CI status (statusCheckRollup) at the head SHA is
#        green — no pending/failed checks. Posted verdicts are not proof CI
#        passed; a reviewer can post PASS after CI already failed, or before
#        it finishes. No CI configured on the repo is not a failure.
#   (b)  coverage-gate.sh exits 0
#   (c)  .jome/verify.sh exits 0 (skipped if absent)
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
# _text_after_merge_match <cmd> — return the command text AFTER the one
# real, word-boundary-anchored "gh pr merge" match (the same \b-anchored
# pattern the STRUCTURAL INVARIANT counter below uses). Both extraction call
# sites rely on _TOTAL_MERGES == 1 having already been verified by the time
# they run, so exactly one such match exists.
#
# Must NOT use a plain (unanchored) `sed 's/.*gh...merge//'` strip here:
# that pattern matches "gh pr merge" as a raw substring anywhere, including
# inside an unrelated word like "ugh pr merge" (e.g. hidden in a trailing
# shell comment after a real merge command) — and greedy `.*` extends
# through the LAST such occurrence, silently returning text from the FAKE
# occurrence instead of the real one. That let a single crafted command
# (e.g. `gh pr merge 103 --squash # ugh pr merge 99`) point the PR-number/
# --repo extraction at an attacker-chosen PR/repo while the real, earlier
# `gh pr merge` in the same string still executed against its own,
# unverified target — a verified gate bypass (Hobbes, budget-tracker PR
# #103, 2026-08-27).
#
# grep -boE (with \b) is used instead of sed because BSD sed (macOS) does
# not support \b at all — it silently fails to match, verified empirically
# — while grep -E's \b works correctly on both GNU and BSD.
#
# `local LC_ALL=C` is load-bearing, not cosmetic: `grep -bo` reports a BYTE
# offset, but bash's `${cmd:offset}` slices by CHARACTER under any UTF-8
# locale (the default) — every multibyte char before the match shifts the
# tail's start rightward, silently chopping leading digits off the real PR
# number (e.g. a stray non-ASCII char earlier in the command turned PR 1200
# into extracted "200"). Forcing the whole function into the C locale makes
# "byte" and "character" the same unit throughout, so the offset arithmetic
# is internally consistent regardless of what the rest of the command
# contains. `local` scopes the override to just this function call.
# (Socrates + Hobbes, budget-tracker PR #103, 2026-08-27 — both indepen-
# dently found this exact mismatch in the first fix attempt, which computed
# the offset without any locale control.)
#
# This function does NOT bound the returned text to end at a shell
# separator/comment character — callers must do that themselves by
# stopping their own token walk at a separator TOKEN (see
# _is_command_separator below), not by truncating raw characters here.
# Character-level truncation before tokenizing was tried first and had to
# be reverted: it truncates INSIDE a legitimately quoted flag value too
# (e.g. `--subject "Sync gate (#98)"` or `-R other/repo` following a body
# containing `&`), silently dropping real arguments — including, ironically,
# `#98`-style issue references, which this repo's own commit-msg convention
# requires. Tokenizing first (via xargs, which already respects quoting)
# and stopping at a separator TOKEN preserves quoted content correctly.
# ---------------------------------------------------------------------------
_text_after_merge_match() {
  local LC_ALL=C
  local cmd="$1"
  local match_info match_offset match_text match_len
  match_info=$(printf '%s' "$cmd" | grep -boE '\bgh[[:space:]]+pr[[:space:]]+merge\b' | head -1)
  match_offset="${match_info%%:*}"
  match_text="${match_info#*:}"
  match_len=${#match_text}
  printf '%s' "${cmd:$((match_offset + match_len))}"
}

# ---------------------------------------------------------------------------
# _is_command_separator <token> — true if a token produced by `xargs -n1`
# tokenizing (which already respects shell quoting) is itself an unquoted
# shell separator/comment marker: `;`, `&`, `&&`, `|`, `||`, or starts with
# `#`. Callers walking tokens from _text_after_merge_match's output must
# stop (not process) at the first such token — everything after it belongs
# to a different clause than the real `gh pr merge` invocation, whether
# that's a chained command or an inert trailing comment.
#
# Because xargs groups quoted content into a single token, a separator
# character that appeared INSIDE quotes in the original command (e.g. the
# `#` in `--subject "Sync gate (#98)"`) is never seen here as its own
# token — it stays embedded in the quoted token, correctly NOT treated as a
# boundary. A bare, unquoted separator with no surrounding whitespace
# (e.g. `7;echo`) is not detected as a boundary either, since xargs's
# whitespace-based splitting won't isolate it as its own token — that
# obfuscated-compound-command shape is accepted as out of scope, per this
# file's own documented carve-out for "a determined caller using compound
# commands."
# ---------------------------------------------------------------------------
_is_command_separator() {
  case "$1" in
    ';'|'&'|'&&'|'|'|'||') return 0 ;;
    '#'*) return 0 ;;
    *) return 1 ;;
  esac
}

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
# Resolve the target repo ONCE, early — every `gh pr ...` call below must be
# bound to the repo the intercepted command actually targets (via `cd <path>`
# in the command string), not the hook's own process cwd. Hooks run with
# cwd=Jome root between tool calls (see enforce-gate.sh's header comment); a
# bare `cd <repo> && gh pr merge <n> ...` from a different session's cwd
# previously left every unqualified `gh pr view` call below resolving
# against the wrong repo (or failing outright), producing "unable to
# resolve head commit SHA" even when every real gate condition (verdicts,
# CI, coverage) was actually satisfied. Fixes Jome issue #6.
#
# TARGET_DIR/REPO_ROOT are also reused later for coverage-gate.sh/verify.sh.
# ---------------------------------------------------------------------------
TARGET_DIR=$(_effective_dir "$COMMAND")
REPO_ROOT=$(git -C "$TARGET_DIR" rev-parse --show-toplevel 2>/dev/null) || {
  echo "ERROR: gh pr merge blocked — not inside a git repository." >&2
  exit 2
}

# N2b: Extract --repo/-R value for cross-repo merges. An explicit flag on
# the command always wins; otherwise derive the default below from
# REPO_ROOT's own git remote.
CROSS_REPO=""
_EXTRACT_AFTER=$(_text_after_merge_match "$COMMAND")
_SKIP_R=0
while IFS= read -r _RT; do
  [ -z "$_RT" ] && continue
  _is_command_separator "$_RT" && break
  if [ "$_SKIP_R" -eq 1 ]; then
    CROSS_REPO="$_RT"
    break
  fi
  case "$_RT" in
    --repo|-R) _SKIP_R=1 ;;
    --repo=*)  CROSS_REPO="${_RT#*=}"; break ;;
  esac
done < <(printf '%s' "$_EXTRACT_AFTER" | xargs -n1 printf '%s\n' 2>/dev/null || true)

# No explicit flag — derive the default repo from REPO_ROOT's own git
# remote, resolved IN that directory (a subshell cd, not the hook's cwd).
if [ -z "$CROSS_REPO" ]; then
  set +e
  CROSS_REPO=$(cd "$REPO_ROOT" && gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)
  set -e
fi

if [ -z "$CROSS_REPO" ]; then
  echo "ERROR: gh pr merge blocked — unable to resolve the target repo (no --repo/-R given and 'gh repo view' failed in ${REPO_ROOT})." >&2
  exit 2
fi

# Helper: invoke `gh pr view` bound to the resolved repo — used for every
# PR lookup below (flagless PR-number resolution, head-SHA fetch, comments).
gh_pr_view() {
  gh pr view -R "$CROSS_REPO" "$@"
}

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
  after=$(_text_after_merge_match "$cmd")

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

    _is_command_separator "$tok" && break

    # Skip flag tokens (start with -); track value-taking ones.
    if [[ "$tok" == -* ]]; then
      # These flags take a SEPARATE next argument (not embedded via '=').
      # Full value-taking set per `gh pr merge --help`: -A/--author-email,
      # -b/--body, -F/--body-file, -t/--subject, --match-head-commit,
      # -R/--repo. (Hobbes, budget-tracker PR #103, 2026-08-27: -A was
      # missing here, so `gh pr merge -A 200 1200` read 200 as the PR
      # number when gh itself treats 1200 as the real target.)
      case "$tok" in
        --body|-b|--body-file|-F|--subject|-t|--match-head-commit|--repo|-R|--author-email|-A)
          _skip_next=1 ; continue ;;
      esac
      # Long flags (--foo) with no recognized value are safe to skip
      # outright — they're a fixed, closed vocabulary in `gh pr merge`.
      # A SHORT flag CLUSTER (-xyz, 2+ letters after a single dash) is not
      # safe to skip blindly: gh/pflag lets the last letter in a cluster
      # take a value (e.g. `-sb 200` means -s, then -b consumes "200"),
      # and this parser has no general decomposition logic for that.
      # Rather than guess which reading is right, this is AMBIGUOUS — return
      # 2, a distinct exit code from "return 1: no PR number token at all."
      # Collapsing both into one signal (both previously returned 1) was
      # itself a bypass: the caller treated an ambiguous cluster exactly
      # like the legitimate flag-less form and fell through to resolving
      # the CURRENT BRANCH's PR — verifying an entirely different PR's
      # verdicts/CI while `gh pr merge -sd 999` (an utterly ordinary
      # `--squash --delete-branch` command) actually merged #999 (Hobbes +
      # Socrates, budget-tracker PR #103, 2026-08-27, independently
      # reproduced end-to-end with `gh pr merge -sd 999` / `-sb x 999`).
      if [[ "$tok" =~ ^-[A-Za-z][A-Za-z]+$ ]]; then
        return 2
      fi
      continue
    fi

    # Return the first purely numeric positional token — that is the PR number.
    if printf '%s' "$tok" | grep -qE '^[0-9]+$'; then
      printf '%s' "$tok"
      return 0
    fi

    # A non-flag, non-numeric positional token here is a PR URL or branch
    # name — `gh pr merge`'s selector is documented as
    # `[<number> | <url> | <branch>]`, and both of those forms are ordinary,
    # ungimmicked usage, not an obfuscation trick. This parser has no way to
    # resolve either to a definite PR number, so it's AMBIGUOUS (return 2),
    # not "no PR given" (return 1) — the same conflation already fixed for
    # flag clusters applies here too: falling through to the flag-less
    # fallback would verify the CURRENT BRANCH's PR while `gh` merges
    # whatever the URL/branch actually points at (Socrates, budget-tracker
    # PR #103, 2026-08-27 — reproduced with `gh pr merge <url-for-999>`).
    return 2
  done
  return 1
}

set +e
PR_NUM=$(extract_pr_number "$COMMAND" 2>/dev/null)
_EXTRACT_STATUS=$?
set -e

# Ambiguous (exit 2) is NOT the same as "no PR number given" (exit 1) — an
# ambiguous parse must fail closed immediately. Falling through to the
# flag-less branch-resolution fallback here would verify whatever PR is
# open on the CURRENT branch, not the PR the real command actually merges.
if [ "$_EXTRACT_STATUS" -eq 2 ]; then
  echo "ERROR: gh pr merge blocked — command contains an unrecognized flag shape (e.g. a clustered short flag like -sd) that cannot be safely parsed for a PR number." >&2
  echo "  Use explicit long flags instead: gh pr merge <N> --squash --delete-branch" >&2
  exit 2
fi

if [ -z "$PR_NUM" ]; then
  # No inline PR number — flag-less `gh pr merge` form: resolve the current
  # branch's open PR number via gh.
  set +e
  PR_NUM=$(gh_pr_view --json number --jq '.number' 2>/dev/null)
  set -e
fi

if [ -z "$PR_NUM" ]; then
  echo "ERROR: gh pr merge blocked — unable to resolve a PR number." >&2
  echo "  Specify the PR number explicitly: gh pr merge <N> --squash" >&2
  exit 2
fi

# Allow tests to override coverage-gate path via env var for stubbing.
COVERAGE_GATE="${JOME_COVERAGE_GATE_BIN:-$SCRIPT_DIR/lib/coverage-gate.sh}"

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
# (a2) CI STATUS: verify GitHub's actual CI status at HEAD_SHA, not just
# posted verdict comments. A reviewer PASS proves the reviewer looked; it
# does not prove CI passed — a PASS can be posted after CI already failed,
# or before it has finished. This queries the same statusCheckRollup field
# gh-schema.md documents as a Pinned Interface, structurally rather than by
# trusting any comment.
#
# GitHub's rollup returns a mix of two GraphQL union types:
#   CheckRun      (GitHub Actions etc.)  — fields: status, conclusion
#   StatusContext (legacy commit status) — fields: state
#
# Empty/null rollup (no CI configured on the repo) is NOT a failure — pass
# through, same policy as .jome/verify.sh's "skipped if absent" below.
# Fail CLOSED if the rollup itself can't be fetched.
# ---------------------------------------------------------------------------
set +e
ROLLUP_JSON=$(gh_pr_view "$PR_NUM" --json statusCheckRollup 2>/dev/null)
ROLLUP_EXIT=$?
set -e

if [ "$ROLLUP_EXIT" -ne 0 ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — unable to resolve CI status (statusCheckRollup)." >&2
  exit 2
fi

CI_PROBLEMS=$(printf '%s' "$ROLLUP_JSON" | jq -r '
  [.statusCheckRollup[]? |
    if .__typename == "CheckRun" then
      if .status != "COMPLETED" then
        "PENDING: \(.name // .workflowName // "unknown") (still running)"
      elif (.conclusion // "") as $c | ($c == "SUCCESS" or $c == "NEUTRAL" or $c == "SKIPPED") then
        empty
      else
        "FAILED: \(.name // .workflowName // "unknown") (\(.conclusion // "unknown"))"
      end
    elif .__typename == "StatusContext" then
      if .state == "SUCCESS" then
        empty
      elif .state == "PENDING" then
        "PENDING: \(.context // "unknown") (still running)"
      else
        "FAILED: \(.context // "unknown") (\(.state))"
      end
    else
      empty
    end
  ] | .[]' 2>/dev/null || true)

if [ -n "$CI_PROBLEMS" ]; then
  echo "ERROR: PR #${PR_NUM} merge blocked — CI is not green at ${HEAD_SHA}:" >&2
  printf '%s\n' "$CI_PROBLEMS" | while IFS= read -r _problem; do
    echo "  $_problem" >&2
  done
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
