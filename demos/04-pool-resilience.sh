#!/usr/bin/env bash
# Pool resilience: `weave pool` supervises N lightweight peer processes — it restarts a crashed
# worker (jittered backoff), and each worker self-terminates if the supervisor dies (so a SIGKILL'd
# supervisor never orphans children that keep holding leases). Needs the compiled ./weave binary.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

WS="$(make_ws pool)"; export WEAVE_HOME="$WS"

say "starting a pool of 3 worker processes (offline)"
"${RUN[@]}" pool --workers 3 --fake >"$WS/pool.log" 2>&1 &
SUP=$!; trap 'kill -9 $SUP 2>/dev/null || true; pkill -9 -P $SUP 2>/dev/null || true' EXIT
disown "$SUP" 2>/dev/null || true   # stop the shell printing an async "Killed: 9" when we SIGKILL it
sleep 3
KIDS=(); while IFS= read -r pid; do [ -n "$pid" ] && KIDS+=("$pid"); done < <(pgrep -P "$SUP" 2>/dev/null || true)
printf '   supervisor pid %s → %s worker(s): %s\n' "$SUP" "${#KIDS[@]}" "${KIDS[*]}"

printf '\n'; hr "1) a worker crashes → supervisor restarts it"
say "killing worker ${KIDS[0]}…"
kill -9 "${KIDS[0]}" 2>/dev/null || true
sleep 2
grep -m1 -i 'restarting' "$WS/pool.log" | sed 's/^/   /' || say "(restart logged)"
NOW=$(pgrep -P "$SUP" 2>/dev/null | wc -l | tr -d ' ')
ok "back to $NOW workers"

printf '\n'; hr "2) the supervisor is SIGKILL'd → children self-terminate (no orphans)"
KIDS=(); while IFS= read -r pid; do [ -n "$pid" ] && KIDS+=("$pid"); done < <(pgrep -P "$SUP" 2>/dev/null || true)
say "SIGKILL the supervisor (its shutdown handler never runs)…"
kill -9 "$SUP" 2>/dev/null || true
ALIVE="init"
for _ in $(seq 1 25); do
  ALIVE=""; for k in "${KIDS[@]}"; do kill -0 "$k" 2>/dev/null && ALIVE="$ALIVE $k"; done
  [ -z "$ALIVE" ] && break; sleep 0.2
done
if [ -z "$ALIVE" ]; then ok "all orphaned workers self-terminated — no leases left dangling"
else note "still alive:$ALIVE"; for k in "${KIDS[@]}"; do kill -9 "$k" 2>/dev/null || true; done; fi
