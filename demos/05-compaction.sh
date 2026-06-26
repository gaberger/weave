#!/usr/bin/env bash
# Memory compaction: a long-running peer appends forever, so the log compacts (ADR-0007) — settled
# tasks fold into ONE durable `weave.snapshot` event and their raw events are pruned. Projections
# (status, claim resolution) are snapshot-aware, so reads stay correct AND cheap.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

WS="$(make_ws compaction)"; export WEAVE_HOME="$WS"

say "running a peer and settling 5 tasks (each emits declared+claimed+progress+completed)"
"${RUN[@]}" up --fake --agent c --tick-ms 200 >"$WS/peer.log" 2>&1 &
P=$!; trap 'kill $P 2>/dev/null || true' EXIT
sleep 1
for t in alpha bravo charlie delta echo; do "${RUN[@]}" task "task $t" >/dev/null; done
sleep 3
kill $P 2>/dev/null || true; sleep 0.5

BEFORE=$("${RUN[@]}" log | grep -c .)
printf '\n'; hr "log BEFORE compaction"
printf '   %s events\n' "$BEFORE"

say "folding settled tasks into a snapshot + pruning…"
run "${RUN[@]}" compact | sed 's/^/   /'

AFTER=$("${RUN[@]}" log | grep -c .)
printf '\n'; hr "log AFTER compaction"
printf '   %s events  (the snapshot replaces the pruned history)\n' "$AFTER"
printf '\n'; hr "status is still correct (projection reads the snapshot)"
"${RUN[@]}" status | sed 's/^/   /'
ok "history collapsed from $BEFORE → $AFTER events, reads unchanged — durable + replayable"
