#!/usr/bin/env bash
# Loops: a first-class scheduler (ADR-0008) re-declares a task routed to a skill each tick — the
# building block for monitors and recurring jobs. --once runs a single pass and exits when the task
# settles (handy for demos/CI); drop it for `--interval 30s/6h` to run forever.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

WS="$(make_ws loops)"; export WEAVE_HOME="$WS"
mkdir -p "$WS/.weave/skills"; cp "$HERE/skills/calc.mjs" "$WS/.weave/skills/"

say "one pass of a loop bound to the 'calc' skill (--once exits when it settles):"
run "${RUN[@]}" loop --skill calc --once "sum 10 20 30 40" 2>&1 | grep -vE '^\s*#|claimed|progress' | sed 's/^/   /'

printf '\n'; hr "result"
REPORT="$("${RUN[@]}" report)"
printf '%s\n' "$REPORT" | sed 's/^/   /'
say "for a real monitor you'd write e.g.:  weave loop --skill monitor --interval 30s \"https://api…\""
# calc sums the numbers in the goal: 10 + 20 + 30 + 40 = 100. Its presence proves declare→route→run→settle.
printf '%s' "$REPORT" | grep -q '= 100' \
  && pass "the loop declared → routed → ran → settled in one command (calc returned 100)" \
  || fail "expected the loop's calc result (= 100) in the report"
