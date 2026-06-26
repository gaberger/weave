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
"${RUN[@]}" report | sed 's/^/   /'
say "for a real monitor you'd write e.g.:  weave loop --skill monitor --interval 30s \"https://api…\""
ok "the loop declared → routed → ran → settled, all in one command"
