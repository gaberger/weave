#!/usr/bin/env bash
# weave demo — a cooperative swarm: two peers share one substrate, tasks are claimed
# exactly once and split between them. Offline (--fake worker, no API key needed).
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${WEAVE_DEMO_DB:-/tmp/weave-demo/w.db}"
rm -rf "$(dirname "$DB")"
mkdir -p "$(dirname "$DB")"

# Run inside a throwaway project dir, NOT the engine repo: weave refuses to use its own source tree
# as a workspace (the engine-repo guard). Without this, running the demo from source (node+tsx, i.e.
# no pre-built ./weave binary) aborts with "refusing to use the weave engine repo as a workspace".
export WEAVE_HOME="$(dirname "$DB")"

# Prefer the compiled binary; fall back to node+tsx.
if [ -x ./weave ]; then RUN=(./weave); else RUN=(node --import tsx src/cli.ts); fi
echo "▶ using: ${RUN[*]}"

echo "▶ starting two peers (peer-a, peer-b) sharing $DB"
"${RUN[@]}" up --fake --agent peer-a --db "$DB" --tick-ms 250 >/tmp/weave-peer-a.log 2>&1 &
A=$!
"${RUN[@]}" up --fake --agent peer-b --db "$DB" --tick-ms 250 >/tmp/weave-peer-b.log 2>&1 &
B=$!
trap 'kill $A $B 2>/dev/null || true' EXIT
sleep 1

echo "▶ declaring 6 tasks"
for t in "summarize the readme" "write unit tests" "refactor auth module" \
         "fix flaky CI job" "bump dependencies" "draft the changelog"; do
  "${RUN[@]}" task "$t" --db "$DB" >/dev/null
done

sleep 4
echo
echo "── status ───────────────────────────────────"
"${RUN[@]}" status --db "$DB"
echo
echo "── work split (completions per peer) ────────"
"${RUN[@]}" log --db "$DB" | awk '$3=="task.completed"{c[$4]++} END{for(p in c) print "   "p": "c[p]}'
echo "── exactly-once check ───────────────────────"
"${RUN[@]}" log --db "$DB" | awk '$3=="task.completed"{n++} END{print "   "n+0" completions for 6 tasks"}'
echo
echo "✓ done — full event log: ${RUN[*]} log --db $DB"
