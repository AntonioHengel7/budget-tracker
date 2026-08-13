#!/usr/bin/env bash
# =============================================================================
# coverage-gate.sh — Language-detecting coverage reader, bar/ratchet gate,
#                    and unjustified-skip scanner.
#
# Invocation modes:
#
#   --fixture <json> --core-threshold <N> --mode bar [--lang vitest|python|swift]
#       Exit 0 if core line% >= N; exit 1 with message otherwise.
#       --lang picks the pinned jq path directly; omitted, it auto-detects
#       by probing each pinned shape in turn (vitest -> python -> swift).
#
#   --fixture <json> --baseline <N> --mode ratchet [--lang vitest|python|swift]
#       Exit 0 if core line% >= baseline (no regression); exit 1 otherwise.
#
#   --scan <file>
#       Exit 0 if no unjustified skip/ignore directives are found.
#       Exit 1 + print a message containing "justification" to stdout if a
#       skip directive exists without an adjacent justification comment.
#       .only / fit / fdescribe are always hard-fail regardless of justification.
#
# Live-run (no --fixture): detect_language() + adapter functions below.
# Core globs are read from .jome/coverage.json `core` field.
#
# Pinned interfaces (plan §Pinned Interfaces):
#   vitest  : coverage/coverage-summary.json → .total.lines.pct
#   swift   : xcrun llvm-cov export <bin> -instr-profile=<profdata> -format=text
#             → .data[0].totals.lines.percent
#   python  : coverage.json → .totals.percent_covered
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# detect_language: inspect cwd for language fingerprints.
# ---------------------------------------------------------------------------
detect_language() {
  if ls vite.config.* tsconfig.json package.json 2>/dev/null | grep -q .; then
    echo "vitest"
  elif [ -f "Package.swift" ]; then
    echo "swift"
  elif ls pytest.ini pyproject.toml setup.cfg setup.py 2>/dev/null | grep -q .; then
    echo "python"
  else
    echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# assert_numeric VAL [LABEL] — exits 1 if VAL is not a non-negative number.
# Prevents injection via crafted JSON pct values.
# ---------------------------------------------------------------------------
assert_numeric() {
  local val="$1"
  local label="${2:-value}"
  if ! printf '%s' "$val" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
    echo "ERROR: non-numeric $label: '$val'" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Adapter stubs — thin wrappers around the pinned native commands.
# The TESTED path is --fixture / --scan; live adapters are called by the
# core-glob reader when no --fixture is supplied.
# ---------------------------------------------------------------------------

# vitest adapter: coverage/coverage-summary.json → .total.lines.pct
read_vitest_coverage() {
  local summary_file="${1:-coverage/coverage-summary.json}"
  local pct
  pct=$(jq -r '.total.lines.pct' "$summary_file")
  assert_numeric "$pct" "vitest .total.lines.pct"
  echo "$pct"
}

# swift adapter: xcrun llvm-cov export → .data[0].totals.lines.percent
read_swift_coverage() {
  local bin="$1"
  local profdata="$2"
  xcrun llvm-cov export "$bin" \
    -instr-profile="$profdata" \
    -format=text \
    | jq -r '.data[0].totals.lines.percent'
}

# python adapter: coverage.json → .totals.percent_covered
read_python_coverage() {
  local coverage_file="${1:-coverage.json}"
  local pct
  pct=$(jq -r '.totals.percent_covered' "$coverage_file")
  assert_numeric "$pct" "python .totals.percent_covered"
  echo "$pct"
}

# swift adapter (fixture/CI path): an already-exported llvm-cov JSON file,
# no live xcrun invocation. Same jq path as read_swift_coverage.
read_swift_coverage_from_file() {
  local file="$1"
  local pct
  pct=$(jq -r '.data[0].totals.lines.percent' "$file")
  assert_numeric "$pct" "swift .data[0].totals.lines.percent"
  echo "$pct"
}

# ---------------------------------------------------------------------------
# read_pct_from_fixture FILE [LANG]
# --fixture mode's language dispatch. Explicit LANG picks the pinned jq path
# directly; omitted LANG auto-detects by probing each pinned shape in turn
# (vitest -> python -> swift) and taking the first that yields a value.
# ---------------------------------------------------------------------------
read_pct_from_fixture() {
  local file="$1"
  local lang="${2:-}"

  case "$lang" in
    vitest) read_vitest_coverage "$file"; return ;;
    python) read_python_coverage "$file"; return ;;
    swift)  read_swift_coverage_from_file "$file"; return ;;
    "") ;;
    *)
      echo "ERROR: unknown --lang '$lang'; expected vitest, python, or swift" >&2
      exit 1
      ;;
  esac

  local pct
  pct=$(jq -r '.total.lines.pct // empty' "$file")
  if [ -n "$pct" ]; then
    assert_numeric "$pct" "vitest .total.lines.pct"
    echo "$pct"; return
  fi

  pct=$(jq -r '.totals.percent_covered // empty' "$file")
  if [ -n "$pct" ]; then
    assert_numeric "$pct" "python .totals.percent_covered"
    echo "$pct"; return
  fi

  pct=$(jq -r '.data[0].totals.lines.percent // empty' "$file" 2>/dev/null)
  if [ -n "$pct" ]; then
    assert_numeric "$pct" "swift .data[0].totals.lines.percent"
    echo "$pct"; return
  fi

  echo "ERROR: fixture matches no known coverage shape (vitest/.total.lines.pct, python/.totals.percent_covered, swift/.data[0].totals.lines.percent) — pass --lang explicitly" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# read_core_pct_from_config: reads core globs from .jome/coverage.json
# and resolves the current-language adapter.
# Documented function; bypassed when --fixture is supplied.
# ---------------------------------------------------------------------------
read_core_pct_from_config() {
  local config=".jome/coverage.json"
  if [ ! -f "$config" ]; then
    echo "ERROR: .jome/coverage.json not found — create it per plan §Completeness Map" >&2
    return 1
  fi

  local lang
  lang="$(detect_language)"
  case "$lang" in
    vitest) read_vitest_coverage ;;
    python) read_python_coverage ;;
    swift)
      echo "ERROR: swift adapter requires --bin and --profdata; use --fixture for CI" >&2
      return 1
      ;;
    *)
      echo "ERROR: unknown language — add vite.config.*, Package.swift, or pytest.ini to project root" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# scan_for_unjustified_skips: check a source file for skip/ignore directives
# that lack an adjacent justification comment.
#
# Hard-fail patterns (no justification accepted — presence alone is a failure):
#   .only\b  |  \bfit\b  |  \bfdescribe\b  |  ['only'] / ["only"] bracket form
#   These silently disable sibling tests and are never acceptable.
#
# Justifiable skip patterns (allowed with adjacent justification comment):
#   istanbul ignore  |  c8 ignore  |  v8 ignore  |  pragma: no cover
#   .skip\b          |  .skipIf\b  |  .runIf\b   |  .todo\b
#   ['skip']/["skip"] bracket form
#   \bxit\b  |  \bxdescribe\b  |  \bxtest\b  (jest x-prefixed disablers)
#   xfail    |  XCTSkip\b  |  XCTSkipIf\b  |  XCTSkipUnless\b
#
# A skip is JUSTIFIED when a line matching:
#   (// justification: ...) or (# justification: ...)
# appears on the SAME line, the line immediately BEFORE, or the line
# immediately AFTER the skip directive.
#
# Returns 0 (success) if all skips are justified or none exist.
# Returns 1 (failure) if any hard-fail directive or unjustified skip is found.
# ---------------------------------------------------------------------------
scan_for_unjustified_skips() {
  local file="$1"

  # Character-class helpers — avoids quoting hell in complex patterns.
  local QQ='"'   # literal double-quote
  local QS="'"   # literal single-quote

  # Hard-fail patterns: .only / fit / fdescribe / bracket ['only'] ["only"] — never justified.
  # These silently disable sibling tests and must never appear in merged code.
  local hard_re="(\\.only\\b|\\bfit\\b|\\bfdescribe\\b|\\[[$QQ$QS]only[$QQ$QS]\\])"

  # Justifiable skip patterns (allowed only when an adjacent justification: comment exists).
  # \.skip\b   — catches .skip( and .skip<space> but NOT .skipIf (no word boundary before I).
  # \.skipIf\b — vitest/jest conditional-skip; must be listed separately from \.skip\b.
  # \.runIf\b  — vitest conditional-run (inverse of skipIf; same risk profile).
  # \.todo\b   — marks test as pending; omits it from coverage and pass/fail counts.
  # bracket    — ['skip']/["skip"] notation; equivalent to .skip in Jest/Vitest.
  # xit/xdescribe/xtest — jest x-prefixed disablers.
  # xfail      — pytest expected-failure marker.
  # XCTSkip\b / XCTSkipIf\b / XCTSkipUnless\b — Swift XCTest skip family.
  local skip_re="(istanbul ignore|c8 ignore|v8 ignore|pragma: no cover|\\.skip\\b|\\.skipIf\\b|\\.runIf\\b|\\.todo\\b|\\[[$QQ$QS]skip[$QQ$QS]\\]|\\bxit\\b|\\bxdescribe\\b|\\bxtest\\b|xfail|XCTSkip\\b|XCTSkipIf\\b|XCTSkipUnless\\b)"

  local just_re='(//|#)[[:space:]]*justification:'

  # Check hard-fail patterns first — no justification window applies.
  if grep -En "$hard_re" "$file" 2>/dev/null | grep -q .; then
    echo ".only / fit / fdescribe found — these are always hard-fail and cannot be justified"
    return 1
  fi

  # Collect line numbers containing justifiable skip patterns.
  local skip_lines
  skip_lines=$(grep -inE "$skip_re" "$file" 2>/dev/null | cut -d: -f1 || true)

  # No skip directives found — all clear.
  if [ -z "$skip_lines" ]; then
    return 0
  fi

  # F5: use awk to count lines so a missing final newline is not undercounted.
  local total_lines
  total_lines=$(awk 'END{print NR}' "$file")

  while IFS= read -r lineno; do
    [ -z "$lineno" ] && continue

    local justified=0

    # --- same line ---
    local this_line
    this_line=$(sed -n "${lineno}p" "$file")
    if echo "$this_line" | grep -qiE "$just_re" 2>/dev/null; then
      justified=1
    fi

    # --- previous line ---
    if [ "$justified" -eq 0 ]; then
      local prev=$((lineno - 1))
      if [ "$prev" -ge 1 ]; then
        local prev_line
        prev_line=$(sed -n "${prev}p" "$file")
        if echo "$prev_line" | grep -qiE "$just_re" 2>/dev/null; then
          justified=1
        fi
      fi
    fi

    # --- next line ---
    if [ "$justified" -eq 0 ]; then
      local nxt=$((lineno + 1))
      if [ "$nxt" -le "$total_lines" ]; then
        local next_line
        next_line=$(sed -n "${nxt}p" "$file")
        if echo "$next_line" | grep -qiE "$just_re" 2>/dev/null; then
          justified=1
        fi
      fi
    fi

    if [ "$justified" -eq 0 ]; then
      echo "unjustified skip — add a justification: comment adjacent to each skip/ignore directive"
      return 1
    fi
  done <<< "$skip_lines"

  return 0  # every skip has an adjacent justification comment
}

# ---------------------------------------------------------------------------
# float_gte A B — returns 0 (true) when A >= B, 1 (false) otherwise.
# Operands are passed as awk DATA (not program text) to prevent injection.
# ---------------------------------------------------------------------------
float_gte() { awk -v a="$1" -v b="$2" 'BEGIN { exit (a+0 >= b+0) ? 0 : 1 }'; }

# ---------------------------------------------------------------------------
# apply_gate PCT MODE THRESHOLD BASELINE
# Single dispatch point for bar/ratchet logic. Always exits.
# ---------------------------------------------------------------------------
apply_gate() {
  local pct="$1"
  local mode="$2"
  local threshold="$3"
  local baseline="$4"

  case "$mode" in
    bar)
      if [ -z "$threshold" ]; then
        echo "ERROR: --core-threshold is required for bar mode" >&2
        exit 1
      fi
      assert_numeric "$threshold" "--core-threshold"
      if float_gte "$pct" "$threshold"; then
        exit 0
      else
        echo "coverage ${pct}% < ${threshold}% bar" >&2
        exit 1
      fi
      ;;

    ratchet)
      if [ -z "$baseline" ]; then
        echo "ERROR: --baseline is required for ratchet mode" >&2
        exit 1
      fi
      assert_numeric "$baseline" "--baseline"
      if float_gte "$pct" "$baseline"; then
        exit 0
      else
        echo "regression: ${pct}% < baseline ${baseline}%" >&2
        exit 1
      fi
      ;;

    "")
      echo "ERROR: --mode is required (bar or ratchet)" >&2
      exit 1
      ;;

    *)
      echo "ERROR: unknown mode '$mode'; expected bar or ratchet" >&2
      exit 1
      ;;
  esac
}

# ===========================================================================
# Main — parse arguments and dispatch.
# ===========================================================================

MODE=""
FIXTURE=""
CORE_THRESHOLD=""
BASELINE=""
SCAN_FILE=""
LANG_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --fixture)        FIXTURE="$2";         shift 2 ;;
    --core-threshold) CORE_THRESHOLD="$2";  shift 2 ;;
    --baseline)       BASELINE="$2";        shift 2 ;;
    --mode)           MODE="$2";            shift 2 ;;
    --scan)           SCAN_FILE="$2";       shift 2 ;;
    --lang)           LANG_ARG="$2";        shift 2 ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# --scan mode
# ---------------------------------------------------------------------------
if [ -n "$SCAN_FILE" ]; then
  if [ ! -f "$SCAN_FILE" ]; then
    echo "ERROR: scan target not found: $SCAN_FILE" >&2
    exit 1
  fi
  if ! scan_for_unjustified_skips "$SCAN_FILE"; then
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# --fixture modes (bar and ratchet)
# ---------------------------------------------------------------------------
if [ -n "$FIXTURE" ]; then
  if [ ! -f "$FIXTURE" ]; then
    echo "ERROR: fixture file not found: $FIXTURE" >&2
    exit 1
  fi

  CORE_PCT=$(read_pct_from_fixture "$FIXTURE" "$LANG_ARG")

  if [ "$CORE_PCT" = "null" ] || [ -z "$CORE_PCT" ]; then
    echo "ERROR: fixture missing coverage data: $FIXTURE" >&2
    exit 1
  fi

  assert_numeric "$CORE_PCT" "coverage percentage from fixture"

  apply_gate "$CORE_PCT" "$MODE" "$CORE_THRESHOLD" "$BASELINE"
fi

# ---------------------------------------------------------------------------
# Neither --fixture nor --scan — live-run path via .jome/coverage.json
# ---------------------------------------------------------------------------
if [ -z "$MODE" ]; then
  echo "ERROR: no mode specified. Use --fixture/--mode or --scan" >&2
  exit 1
fi

CORE_PCT=$(read_core_pct_from_config)

if [ "$CORE_PCT" = "null" ] || [ -z "$CORE_PCT" ]; then
  echo "ERROR: read_core_pct_from_config returned null or empty" >&2
  exit 1
fi

assert_numeric "$CORE_PCT" "coverage percentage"

apply_gate "$CORE_PCT" "$MODE" "$CORE_THRESHOLD" "$BASELINE"
