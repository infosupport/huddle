#!/usr/bin/env bash
# Claude Code status line — truecolor RGB gradient, no jq, pure bash+sed+awk

# Ensure common tool locations are on PATH (Git Bash on Windows, macOS, Linux)
export PATH="/usr/local/bin:/usr/bin:/bin:/mingw64/bin:/mingw32/bin:$PATH"

input=$(cat)

# Flatten JSON to a single line for reliable sed extraction
flat=$(printf '%s' "$input" | tr -d '\n\r' | sed 's/[[:space:]]\+/ /g')

# Extract a scalar value for a given "key": (string or number) from a flat JSON string.
# Usage: scalar_get <flat_json> <key>
scalar_get() {
local src="$1" key="$2" after val
after=$(printf '%s' "$src" | sed "s/.*\"${key}\" *: *//")
[ "$after" = "$src" ] && echo "" && return
case "$after" in
'"'*) val=$(printf '%s' "$after" | sed 's/^"//; s/".*//')  ;;
*)    val=$(printf '%s' "$after" | sed 's/[,}{] .*//' | sed 's/[,}{ \t].*//')  ;;
esac
case "$val" in
""|null) echo "" ;;
*) echo "$val" ;;
esac
}

# --- Data extraction (all from confirmed JSON fields) ---

# Repo name: last path component of cwd (works for both / and \ separators)
raw_cwd=$(scalar_get "$flat" "cwd")
repo_name=$(printf '%s' "$raw_cwd" | sed 's|\\|/|g; s|/$||; s|.*/||')

# Model display name
model=$(scalar_get "$flat" "display_name")

# Context window used percentage
# Extract the context_window object substring first, then pull used_percentage
# from that — avoids the greedy-sed ambiguity with rate_limits.*.used_percentage.
ctx_window=$(printf '%s' "$flat" | sed 's/.*"context_window" *: *{//' | sed 's/"current_usage" *: *{[^}]*}//' | sed 's/}.*//')
used_pct=$(scalar_get "$ctx_window" "used_percentage")

# Session cost: extract total_cost_usd, format as "$X.XX"
raw_cost=$(scalar_get "$flat" "total_cost_usd")

# Lines added/removed from cost object
lines_added=$(scalar_get "$flat" "total_lines_added")
lines_removed=$(scalar_get "$flat" "total_lines_removed")

# Session duration: total_duration_ms → human-readable
total_duration_ms=$(scalar_get "$flat" "total_duration_ms")

# Cache hit rate: cache_read_input_tokens / total_input_tokens
# Isolate current_usage object to avoid key collisions, then extract from it
current_usage_block=$(printf '%s' "$flat" | sed 's/.*"current_usage" *: *{//' | sed 's/}.*//')
cache_read=$(scalar_get "$current_usage_block" "cache_read_input_tokens")
total_input=$(scalar_get "$flat" "total_input_tokens")

# Thinking and fast_mode flags — both are unique scalar keys in the JSON
thinking_enabled=$(scalar_get "$flat" "enabled")
fast_mode=$(scalar_get "$flat" "fast_mode")

# Git branch — use raw_cwd converted to forward slashes
cwd_fwd=$(printf '%s' "$raw_cwd" | sed 's|\\|/|g')
if [ -n "$cwd_fwd" ]; then
branch=$(git -C "$cwd_fwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
else
branch=$(git --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
fi

# --- ANSI helpers ---
rgb()  { printf '\033[38;2;%d;%d;%dm' "$1" "$2" "$3"; }
bold() { printf '\033[1m'; }
dim()  { printf '\033[2m'; }
reset(){ printf '\033[0m'; }

PIPE=" $(dim)$(rgb 80 80 80)|$(reset) "

# --- 1. Repo name: bold yellow ---
repo_part=""
if [ -n "$repo_name" ]; then
repo_part="$(bold)$(rgb 220 180 0)${repo_name}$(reset)"
fi

# --- 2. Branch: 🌿 + bold cyan in parentheses ---
branch_part=""
if [ -n "$branch" ]; then
branch_part="🌿 $(bold)$(rgb 0 200 220)(${branch})$(reset)"
fi

# --- 3. 20-block gradient context bar + emoji + percentage ---
bar_part=""
if [ -n "$used_pct" ]; then
pct_int=$(printf '%.0f' "$used_pct")

filled=$(( pct_int * 20 / 100 ))
[ "$filled" -gt 20 ] && filled=20

bar=""
for i in $(seq 0 19); do
if [ "$i" -lt "$filled" ]; then
# Gradient: green(0,200,80) → yellow(220,200,0) at midpoint → red(220,40,20)
frac=$(awk "BEGIN{printf \"%.4f\", $i / 19.0}")
if awk "BEGIN{exit !($frac <= 0.5)}"; then
t=$(awk "BEGIN{printf \"%.4f\", $frac * 2.0}")
r=$(awk "BEGIN{printf \"%d\", 0   + (220 - 0)   * $t + 0.5}")
g=$(awk "BEGIN{printf \"%d\", 200 + (200 - 200) * $t + 0.5}")
b=$(awk "BEGIN{printf \"%d\", 80  + (0   - 80)  * $t + 0.5}")
else
t=$(awk "BEGIN{printf \"%.4f\", ($frac - 0.5) * 2.0}")
r=$(awk "BEGIN{printf \"%d\", 220 + (220 - 220) * $t + 0.5}")
g=$(awk "BEGIN{printf \"%d\", 200 + (40  - 200) * $t + 0.5}")
b=$(awk "BEGIN{printf \"%d\", 0   + (20  - 0)   * $t + 0.5}")
fi
bar="${bar}$(rgb $r $g $b)█$(reset)"
else
bar="${bar}$(dim)$(rgb 60 60 60)█$(reset)"
fi
done

# Emoji by usage level
if   [ "$pct_int" -lt 20 ]; then emoji="🟢"
elif [ "$pct_int" -lt 70 ]; then emoji="⚡"
elif [ "$pct_int" -lt 90 ]; then emoji="🔥"
else                              emoji="🚨"
fi

# Percentage color by usage level
if   [ "$pct_int" -lt 20 ]; then pct_color="$(rgb 0 200 80)"
elif [ "$pct_int" -lt 70 ]; then pct_color="$(rgb 220 200 0)"
elif [ "$pct_int" -lt 90 ]; then pct_color="$(rgb 220 130 0)"
else                              pct_color="$(rgb 220 40 20)"
fi

bar_part="${bar} ${emoji} ${pct_color}${pct_int}%$(reset)"
fi

# --- 4. Session duration: ⏱ + dim white ---
duration_part=""
if [ -n "$total_duration_ms" ] && [ "$total_duration_ms" != "0" ]; then
total_s=$(awk "BEGIN{printf \"%d\", $total_duration_ms / 1000}")
if [ "$total_s" -lt 60 ]; then
dur_str="${total_s}s"
else
mins=$(( total_s / 60 ))
secs=$(( total_s % 60 ))
dur_str="${mins}m${secs}s"
fi
duration_part="⏱ $(dim)$(rgb 200 200 200)${dur_str}$(reset)"
fi

# --- 5. Cache hit rate: ⚡cache XX% with traffic-light color ---
cache_part=""
if [ -n "$cache_read" ] && [ -n "$total_input" ] && [ "$total_input" != "0" ]; then
cache_pct=$(awk "BEGIN{printf \"%d\", ($cache_read / $total_input) * 100 + 0.5}")
if [ "$cache_pct" -ge 80 ]; then
cache_color="$(rgb 0 200 80)"
elif [ "$cache_pct" -ge 50 ]; then
cache_color="$(rgb 220 200 0)"
else
cache_color="$(dim)$(rgb 140 140 140)"
fi
cache_part="⚡cache ${cache_color}${cache_pct}%$(reset)"
fi

# --- 6. Thinking / fast mode status icons ---
think_part=""
icons=""
[ "$thinking_enabled" = "true" ] && icons="${icons}🧠"
[ "$fast_mode"        = "true" ] && icons="${icons}⚡"
[ -n "$icons" ] && think_part="$icons"

# --- 7. Session cost: yellow, formatted as $X.XX ---
cost_part=""
if [ -n "$raw_cost" ]; then
formatted_cost=$(awk "BEGIN{printf \"\$%.2f\", $raw_cost}")
cost_part="$(rgb 220 180 0)${formatted_cost}$(reset)"
fi

# --- 8. Code velocity: +added in green, -removed in red (from cost object) ---
velocity_part=""
if [ -n "$lines_added" ] || [ -n "$lines_removed" ]; then
vel=""
[ -n "$lines_added" ]   && vel="${vel}$(rgb 0 200 80)+${lines_added}$(reset)"
[ -n "$lines_added" ] && [ -n "$lines_removed" ] && vel="${vel} "
[ -n "$lines_removed" ] && vel="${vel}$(rgb 220 40 20)-${lines_removed}$(reset)"
velocity_part="$vel"
fi

# --- 9. Model: 🤖 + magenta ---
model_part=""
if [ -n "$model" ]; then
model_part="🤖 $(rgb 200 80 220)${model}$(reset)"
fi

# --- Assemble with dim gray pipe separators ---
out=""
add() {
if [ -n "$1" ]; then
if [ -n "$out" ]; then
out="${out}${PIPE}$1"
else
out="$1"
fi
fi
}

add "$repo_part"
add "$branch_part"
add "$bar_part"
add "$duration_part"
add "$cache_part"
add "$think_part"
add "$cost_part"
add "$velocity_part"
add "$model_part"

printf "%s" "$out"
