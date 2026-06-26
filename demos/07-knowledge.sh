#!/usr/bin/env bash
# Knowledge graph + search: completed results are mirrored to a durable report bundle (ADR-0020).
# `weave index` builds a knowledge graph (graph.json/graph.md + forward/backlinks); `weave search`
# runs hybrid BM25 (+ optional embeddings) over it (ADR-0021) so later work builds on prior results.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

WS="$(make_ws knowledge)"; export WEAVE_HOME="$WS"

say "running a peer and completing a few tasks (each mirrors a report to disk)"
"${RUN[@]}" up --fake --agent k --tick-ms 200 >"$WS/peer.log" 2>&1 &
P=$!; trap 'kill $P 2>/dev/null || true' EXIT
sleep 1
"${RUN[@]}" task "investigate the BGP route leak on us-border-1" >/dev/null
"${RUN[@]}" task "audit firewall rules for the payments VLAN"    >/dev/null
"${RUN[@]}" task "summarize the BGP incident postmortem"         >/dev/null
sleep 3
kill $P 2>/dev/null || true; sleep 0.5

printf '\n'; hr "build the knowledge graph + search index (offline, --no-embed)"
run "${RUN[@]}" index --no-embed | sed 's/^/   /'

printf '\n'; hr 'search: "BGP"'
"${RUN[@]}" search "BGP route leak" --no-embed | sed 's/^/   /'
ok "results are indexed + searchable — accumulated knowledge, not just an event log"
