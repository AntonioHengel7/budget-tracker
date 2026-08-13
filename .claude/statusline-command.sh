#!/bin/sh
# Jome status line
# Row 1: model | [effort] | context bar | dir | branch | session time
# Row 2: tokens | cost | (5h / 7d usage bars for subscribers)
#
# Reads a single JSON object from stdin (Claude Code statusLine command schema).

input=$(cat)

# --- colors ---
GREY='\033[90m'; CYAN='\033[36m'; YELLOW='\033[33m'; BLUE='\033[34m'
GREEN='\033[32m'; MAGENTA='\033[35m'; RED='\033[31m'; RESET='\033[0m'

j() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

# --- helpers ---
# 10-char bar, color by fill: green <50, yellow 50-75, red >=75
bar() {
  pct=$1
  [ -z "$pct" ] && pct=0
  pct=$(printf '%.0f' "$pct" 2>/dev/null || echo 0)
  [ "$pct" -gt 100 ] && pct=100
  [ "$pct" -lt 0 ] && pct=0
  filled=$((pct / 10))
  empty=$((10 - filled))
  if [ "$pct" -ge 75 ]; then c=$RED; elif [ "$pct" -ge 50 ]; then c=$YELLOW; else c=$GREEN; fi
  out="${c}["
  i=0; while [ $i -lt $filled ]; do out="${out}#"; i=$((i+1)); done
  i=0; while [ $i -lt $empty ]; do out="${out}-"; i=$((i+1)); done
  printf '%s]%s' "$out" "$RESET"
}

kfmt() { # human token count: 15500 -> 15k
  n=$1; [ -z "$n" ] && n=0
  if [ "$n" -ge 1000 ]; then printf '%dk' $((n / 1000)); else printf '%d' "$n"; fi
}

countdown() { # epoch -> "2h30m" until reset
  target=$1; now=$(date +%s)
  diff=$((target - now)); [ "$diff" -lt 0 ] && diff=0
  d=$((diff / 86400)); h=$(((diff % 86400) / 3600)); m=$(((diff % 3600) / 60))
  if [ "$d" -gt 0 ]; then printf '%dd%dh' "$d" "$h"; elif [ "$h" -gt 0 ]; then printf '%dh%dm' "$h" "$m"; else printf '%dm' "$m"; fi
}

# --- row 1 ---
model=$(j '.model.display_name // "Claude"')
model=$(printf '%s' "$model" | sed 's/(1M context)/(1M)/')
effort=$(j '.effort.level // empty')
ctx_pct=$(j '.context_window.used_percentage // empty')
ctx_in=$(j '.context_window.total_input_tokens // 0')
ctx_size=$(j '.context_window.context_window_size // 200000')
dir=$(basename "$(j '.workspace.current_dir // .cwd // empty')")

# session duration from cost.total_duration_ms
dur_ms=$(j '.cost.total_duration_ms // 0')
dur_s=$((dur_ms / 1000))
if [ "$dur_s" -ge 3600 ]; then sess="$((dur_s / 3600))h$(((dur_s % 3600) / 60))m"
elif [ "$dur_s" -ge 60 ]; then sess="$((dur_s / 60))m"
else sess="${dur_s}s"; fi

# branch (independent of stdin)
cwd=$(j '.workspace.current_dir // .cwd')
branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)

row1="${CYAN}${model}${RESET}"
[ -n "$effort" ] && row1="${row1} ${YELLOW}[${effort}]${RESET}"
if [ -n "$ctx_pct" ]; then
  ctx_k=$(kfmt "$ctx_in"); size_k=$(kfmt "$ctx_size")
  pct_int=$(printf '%.0f' "$ctx_pct")
  row1="${row1} $(bar "$ctx_pct") ${ctx_k}/${size_k} (${pct_int}%)"
fi
row1="${row1} ${GREEN}${dir}${RESET}"
[ -n "$branch" ] && row1="${row1} ${MAGENTA}${branch}${RESET}"
row1="${row1} ${GREY}${sess}${RESET}"

# --- row 2 ---
in_tok=$(j '.context_window.current_usage.input_tokens // 0')
out_tok=$(j '.context_window.current_usage.output_tokens // 0')
cache_tok=$(j '.context_window.current_usage.cache_read_input_tokens // 0')
cost=$(j '.cost.total_cost_usd // 0')

row2="${GREY}in $(kfmt "$in_tok") out $(kfmt "$out_tok") cache $(kfmt "$cache_tok")${RESET}"
row2="${row2} ${GREEN}\$$(printf '%.2f' "$cost")${RESET}"

# subscription usage bars (absent for non-subscribers)
h5=$(j '.rate_limits.five_hour.used_percentage // empty')
if [ -n "$h5" ]; then
  h5_reset=$(j '.rate_limits.five_hour.resets_at // 0')
  h5_int=$(printf '%.0f' "$h5")
  row2="${row2} ${GREY}|${RESET} 5h $(bar "$h5") ${h5_int}% (${GREY}$(countdown "$h5_reset")${RESET})"
fi
d7=$(j '.rate_limits.seven_day.used_percentage // empty')
if [ -n "$d7" ]; then
  d7_reset=$(j '.rate_limits.seven_day.resets_at // 0')
  d7_int=$(printf '%.0f' "$d7")
  row2="${row2} ${GREY}|${RESET} 7d $(bar "$d7") ${d7_int}% (${GREY}$(countdown "$d7_reset")${RESET})"
fi

printf '%b\n%b\n' "$row1" "$row2"
