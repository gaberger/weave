#!/usr/bin/env bash
# Skill routing: weave is domain-agnostic — what it DOES is skills dropped into .weave/skills/.
# A peer routes each task to the first skill whose match() fires; an unmatched task falls back to
# the offline echo skill. Here two deterministic code skills (greeter, calc) compete with echo.
# (ADR-0012/0016)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

WS="$(make_ws routing)"; export WEAVE_HOME="$WS"
mkdir -p "$WS/.weave/skills"; cp "$HERE"/skills/greeter.mjs "$HERE"/skills/calc.mjs "$WS/.weave/skills/"

say "installed two code skills into .weave/skills/ (plus the built-in echo fallback)"
"${RUN[@]}" skills --fake | sed 's/^/   /'

say "starting a peer, then declaring three tasks with different intents"
"${RUN[@]}" up --fake --agent router --tick-ms 250 >"$WS/peer.log" 2>&1 &
P=$!; trap 'kill $P 2>/dev/null || true' EXIT
sleep 1
"${RUN[@]}" task "hello Ada"        >/dev/null   # → greeter
"${RUN[@]}" task "add 2 and 40"     >/dev/null   # → calc
"${RUN[@]}" task "tell me a secret" >/dev/null   # → no match → echo fallback
sleep 3

printf '\n'; hr "routing decisions (task.progress notes name the chosen skill)"
"${RUN[@]}" log | awk '$3=="task.progress"{ $1=$2=$3=$4=""; print "   "$0 }' | sed 's/—/→/'
printf '\n'; hr "results"
"${RUN[@]}" report | sed 's/^/   /'
ok "each task was dispatched to the matching skill — no core changes, just plugins"
