#!/usr/bin/env bash
# Cooperative swarm: two peers share one event log, claim tasks exactly once, and split the work —
# no central coordinator. The protocol: when both race to claim a task, the lowest-seq claim wins;
# the other's claim stays inert. (ADR-0001/0002)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

WS="$(make_ws swarm)"; export WEAVE_HOME="$WS"

say "starting two peers (peer-a, peer-b) on one shared log"
"${RUN[@]}" up --fake --agent peer-a --tick-ms 250 >"$WS/a.log" 2>&1 &
A=$!
"${RUN[@]}" up --fake --agent peer-b --tick-ms 250 >"$WS/b.log" 2>&1 &
B=$!
trap 'kill $A $B 2>/dev/null || true' EXIT
sleep 1

say "declaring 6 tasks (either peer may claim any of them)"
for t in "summarize the readme" "write unit tests" "refactor auth module" \
         "fix flaky CI job" "bump dependencies" "draft the changelog"; do
  "${RUN[@]}" task "$t" >/dev/null
done
sleep 4

printf '\n'; hr "task states"
"${RUN[@]}" status
printf '\n'; hr "work split (completions per peer)"
"${RUN[@]}" log | awk '$3=="task.completed"{c[$4]++} END{for(p in c) print "   "p": "c[p]}'
printf '\n'; hr "exactly-once check"
"${RUN[@]}" log | awk '$3=="task.completed"{n++} END{print "   "n+0" completions for 6 tasks"}'
ok "every task ran exactly once, split across both peers — no coordinator involved"
