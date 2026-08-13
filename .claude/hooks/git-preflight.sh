#!/usr/bin/env bash
# git-preflight.sh — PreToolUse Bash hook
# Injects a pre-flight checklist for git commit and git push commands.
# In repos with enforce:true, also BLOCKS direct pushes to main/master (exit 2).
# No-ops for all other Bash commands.
#
# ADVISORY layer — catches honest mistakes for the common single-operation case.
# The authoritative guarantee that nothing reaches main is GitHub branch
# protection (see .jome/README.md § Branch Protection). A determined caller
# using compound commands or raw REST is intentionally out of scope for this
# local hook.

set -euo pipefail

# Source the shared enforcement gate.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/enforce-gate.sh
source "$SCRIPT_DIR/lib/enforce-gate.sh"

INPUT=$(cat)
# F8: use printf, not echo, to avoid interpretation of escape sequences in INPUT.
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Only act on git commit or git push
if ! printf '%s' "$COMMAND" | grep -qE 'git (commit|push)'; then
  exit 0
fi

OP_TYPE="git operation"
if printf '%s' "$COMMAND" | grep -q 'git commit'; then
  OP_TYPE="git commit"
elif printf '%s' "$COMMAND" | grep -q 'git push'; then
  OP_TYPE="git push"
fi

# Branch detection uses cwd — Claude Code hooks inherit the project working
# directory between tool calls.  Enforcement decisions (blocked pushes /
# enforced-repo check) use _effective_dir "$COMMAND" instead; see enforce-gate.sh.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# ---------------------------------------------------------------------------
# B2: parse_all_push_targets — resolve ALL branches being pushed TO,
# using POSITIONAL args only. Prints each resolved target on its own line.
#
# Algorithm:
#   1. Build a positional-only argument list by discarding:
#      - Any token starting with '-' (flag)
#      - The NEXT token after a value-taking push flag (-o/--push-option,
#        --receive-pack, --exec) in separated (non-'=') form.
#      Note: --force-with-lease, --repo, etc. with embedded '=' are already
#      skipped by the flag rule; --force-with-lease without '=' is boolean
#      (no value) and does NOT consume a next arg.
#   2. positional[0] = remote (skipped). positional[1..] = targets.
#   3. For each target: if it contains ':', the push target is the DST side
#      (after ':'). Otherwise the token itself is the target.
#   4. Resolve HEAD or @ to the actual symbolic branch name.
#   5. If no explicit targets, return current branch (bare `git push`).
#
# All targets are emitted; the caller checks if ANY resolves to main/master.
#
# Handles:
#   git push origin main                  → main
#   git push origin HEAD:main             → main (refspec dst)
#   git push origin HEAD                  → <current branch> (HEAD resolved)
#   git push origin feat:main             → main (refspec dst)
#   git push origin develop main          → develop, main (two targets)
#   git push origin feat:dev master:main  → dev, main (two refspec dsts)
#   git push --force-with-lease=x:y o m  → m (flag with embedded ':' skipped)
#   git push -o ci.var=a:b origin main    → main (-o value with ':' skipped)
#   git push -u origin main               → main (-u is boolean, no skip)
#   git push origin issue/42             → issue/42 (feature branch)
# ---------------------------------------------------------------------------
parse_all_push_targets() {
  local cmd="$1"
  local current_branch="$2"

  # Extract the part after "git push" (last occurrence, sed greedily).
  # Only called for non-compound commands so there is exactly one git push.
  local after
  after=$(printf '%s' "$cmd" | sed 's/.*git[[:space:]]\{1,\}push//')

  # Tokenise, respecting quotes.
  local -a tokens=()
  while IFS= read -r tok; do
    [ -n "$tok" ] && tokens+=("$tok")
  done < <(printf '%s' "$after" | xargs -n1 printf '%s\n' 2>/dev/null || true)

  # Build positional-only list, skipping flags and their value-args.
  local -a positional=()
  local _pi=0 _pn="${#tokens[@]}" _skip_next=0
  while [ "$_pi" -lt "$_pn" ]; do
    local _tok="${tokens[$_pi]}"
    _pi=$(( _pi + 1 ))

    if [ "$_skip_next" -eq 1 ]; then
      _skip_next=0
      continue
    fi

    if [[ "$_tok" == -* ]]; then
      # Flags that take a SEPARATE next argument (value not embedded via '=').
      # -o / --push-option: always takes a separate key=value argument.
      # --receive-pack / --exec: take a separate path argument.
      # --force-with-lease without '=': boolean flag, does NOT take a value.
      # -u / --set-upstream: boolean flag, does NOT take a value.
      case "$_tok" in
        -o|--push-option|--receive-pack|--exec)
          _skip_next=1 ;;
      esac
      continue
    fi

    positional+=("$_tok")
  done

  # positional[0] = remote (skip). positional[1..] = target specs.
  if [ "${#positional[@]}" -lt 2 ]; then
    # Bare `git push` or `git push <remote>` — target is current branch.
    local _bare="$current_branch"
    if [ "$_bare" = "HEAD" ] || [ "$_bare" = "@" ]; then
      _bare=$(git symbolic-ref --short HEAD 2>/dev/null || printf '%s' "$_bare")
    fi
    printf '%s\n' "$_bare"
    return
  fi

  # Iterate every target spec after the remote.
  local _i=1 _n="${#positional[@]}"
  while [ "$_i" -lt "$_n" ]; do
    local _ptok="${positional[$_i]}"
    _i=$(( _i + 1 ))

    local _target
    if printf '%s' "$_ptok" | grep -q ':'; then
      # Refspec — push target is the DST side (after ':').
      _target=$(printf '%s' "$_ptok" | cut -d: -f2)
    else
      _target="$_ptok"
    fi

    # Resolve HEAD or @ to the actual symbolic branch name.
    if [ "$_target" = "HEAD" ] || [ "$_target" = "@" ]; then
      _target=$(git symbolic-ref --short HEAD 2>/dev/null || printf '%s' "$_target")
    fi

    printf '%s\n' "$_target"
  done
}

# ---------------------------------------------------------------------------
# Is the given branch name main or master (including refs/heads/ variants)?
# ---------------------------------------------------------------------------
is_main_or_master() {
  local target="$1"
  # Strip the force-push '+' shorthand FIRST so that "+refs/heads/main" becomes
  # "refs/heads/main" before the refs/heads/ strip reduces it to "main".
  # Order matters: strip '+' → strip "refs/heads/" → compare.
  #
  # Wrong order (old): "${target#refs/heads/}" on "+refs/heads/main" → no match
  #   → base stays "+refs/heads/main" → "${base#+}" → "refs/heads/main" ≠ main → BYPASS.
  # Correct order (new): "${target#+}" → "refs/heads/main" → "${base#refs/heads/}" → "main" → BLOCKED.
  #
  # "release/main" has no leading '+' and no refs/heads/ prefix
  #   → base stays "release/main" → not blocked. ✓
  local base="${target#+}"
  base="${base#refs/heads/}"
  [ "$base" = "main" ] || [ "$base" = "master" ]
}

# ---------------------------------------------------------------------------
# Push guard: structural COUNT rule (issue #2 fix).
#
# Count git push occurrences in the command:
#   0 → not a push, skip.
#   1 → single push: parse ALL push targets with parse_all_push_targets and
#       block if ANY resolves to main/master in enforced repos.  A leading
#       `cd <repo> &&` or `git add && git commit &&` prefix is fine — the
#       greedy sed in parse_all_push_targets extracts only the push's args.
#   >1 → BLOCK in enforced repos: multiple pushes in one command cannot be
#       individually verified (catches `git push … && git push …` evasion
#       using the literal "git push" token form; `git -C <dir> push` without
#       the "git push" token is an accepted advisory limitation of this layer).
#
# B1: the count is computed on a STRIPPED command — quoted substrings (single-
# or double-quoted) are removed before counting so that commit messages
# containing the literal text "git push" cannot inflate the count.
#
# B2 (socrates): the single-push target parse ALSO uses `_stripped`, not the
# original COMMAND.  If the original were used, `git push origin main && echo
# "git push done"` would have the greedy sed in parse_all_push_targets latch on
# the LAST "git push" (inside the quoted echo arg), yielding `after=" done"` and
# no visible remote/target → parse falls back to current branch → bypass.
# Using `_stripped` removes the quoted echo arg so the greedy sed lands on the
# real `git push origin main` → after=" origin main" → correctly blocked.
#
# Replaces the old blanket compound-[;&|]-with-push block that over-blocked
# the benign `cd <repo> && git push origin feature` idiom (issue #2).
# ---------------------------------------------------------------------------
BRANCH_WARNING=""

if printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+push'; then
  # B1: strip single- and double-quoted strings so commit-message content
  # containing "git push" cannot be counted as a real push invocation.
  _stripped=$(printf '%s' "$COMMAND" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g")
  # B1: `|| true` prevents set -euo pipefail from aborting when grep finds zero
  # matches (e.g. `git commit -m "mention git push"` whose quoted text is stripped
  # away — _stripped contains no "git push", grep exits 1 without the guard).
  _PUSH_COUNT=$(printf '%s' "$_stripped" | { grep -oE 'git[[:space:]]+push' || true; } | wc -l | tr -d ' ')

  if [ "$_PUSH_COUNT" -gt 1 ]; then
    if repo_is_enforced "$COMMAND"; then
      echo "ERROR: multiple pushes in one command can't be verified — push once per command." >&2
      exit 2
    fi
    # Non-enforced: fall through to checklist.
  elif [ "$_PUSH_COUNT" -eq 1 ]; then
    # Single push — iterate ALL push targets; block if ANY resolves to main/master.
    _BLOCK_TARGET=""
    while IFS= read -r _tgt; do
      if is_main_or_master "$_tgt"; then
        _BLOCK_TARGET="$_tgt"
        break
      fi
    done < <(parse_all_push_targets "$_stripped" "$CURRENT_BRANCH")

    if [ -n "$_BLOCK_TARGET" ]; then
      if repo_is_enforced "$COMMAND"; then
        # BLOCK in enforced repos — the push target (not current branch) is what matters.
        echo "ERROR: direct push to $_BLOCK_TARGET is blocked under enforcement — open a PR." >&2
        exit 2
      else
        # WARN only (original behavior) in non-enforced repos.
        BRANCH_WARNING="
WARNING: Pushing directly to $_BLOCK_TARGET."
      fi
    fi
  fi
fi

PR_STATUS=""
if [ "$OP_TYPE" = "git push" ] && command -v gh >/dev/null 2>&1; then
  set +e
  PR_INFO=$(gh pr list --head "$CURRENT_BRANCH" --state merged --json number,title 2>/dev/null | \
    jq -r '.[0] | "PR #\(.number): \(.title)"' 2>/dev/null || true)
  set -e
  if [ -n "$PR_INFO" ] && [ "$PR_INFO" != "null" ]; then
    PR_STATUS="
ALERT: PR for this branch is already merged: $PR_INFO"
  fi
fi

CHECKLIST="Git pre-flight ($OP_TYPE) — branch: $CURRENT_BRANCH$BRANCH_WARNING$PR_STATUS

Before proceeding:
- [ ] Correct branch?
- [ ] Only intended changes in scope?
- [ ] Commit message accurate?
- [ ] No sensitive files staged?"

jq -n --arg msg "$CHECKLIST" '{"systemMessage": $msg}'
exit 0
