#!/usr/bin/env bash
# weave capability demos — interactive launcher.
#
#   npm run demos            # menu
#   npm run demos -- 1       # run demo 1 directly
#   npm run demos -- all     # run them all in sequence
#
# Everything is OFFLINE (no API key). See demos/README.md.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

# id | title | script | needs-binary-pool
DEMOS=(
  "1|Cooperative swarm — exactly-once claiming|01-swarm.sh|0"
  "2|Skill routing — match a task to the right skill|02-skill-routing.sh|0"
  "3|Loops — re-declare work each tick|03-loops.sh|0"
  "4|Pool resilience — restart + orphan recovery|04-pool-resilience.sh|1"
  "5|Memory compaction — fold a long log into a snapshot|05-compaction.sh|0"
  "6|Federated — partition → heal → deterministic convergence|06-federated.sh|0"
  "7|Knowledge graph + hybrid search|07-knowledge.sh|0"
  "8|Architecture gate — hex boundaries as a build gate|08-architecture.sh|0"
  "9|Container sandbox — Docker isolation (needs Docker)|09-sandbox.sh|0"
)

RESULTS=()   # collected as "id|STATUS|title"; STATUS ∈ PASS/FAIL/SKIP

# Run one demo and record its verdict from the exit code (0 pass / 2 skip / other fail). Each demo
# ends in pass()/fail()/skip() (see lib.sh), so the launcher never has to guess whether it worked.
run_one() {
  local n="$1" entry id title script needs_pool status rc=0
  for entry in "${DEMOS[@]}"; do
    IFS='|' read -r id title script needs_pool <<<"$entry"
    [ "$id" = "$n" ] || continue
    printf '\n'; hr "demo $id — $title"; printf '\n'
    if [ "$needs_pool" = "1" ] && [ "$POOL_OK" != "1" ]; then
      printf '  %s SKIP %s %sneeds the compiled ./weave binary (Bun not found to build it)%s\n' \
        "$C_SKIP" "$C_RESET" "$C_DIM" "$C_RESET"
      status="SKIP"
    else
      bash "$HERE/$script" || rc=$?
      case "$rc" in 0) status="PASS";; 2) status="SKIP";; *) status="FAIL";; esac
    fi
    RESULTS+=("$id|$status|$title")
    return 0
  done
  note "no demo '$n'"
}

summary() {
  printf '\n'; hr "scorecard"
  local r id status title npass=0 nfail=0 nskip=0 badge
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r id status title <<<"$r"
    case "$status" in
      PASS) badge="$C_PASS PASS $C_RESET"; npass=$((npass+1));;
      FAIL) badge="$C_FAIL FAIL $C_RESET"; nfail=$((nfail+1));;
      *)    badge="$C_SKIP SKIP $C_RESET"; nskip=$((nskip+1));;
    esac
    printf '   %s  %s%s)%s %s\n' "$badge" "$C_CYAN" "$id" "$C_RESET" "$title"
  done
  printf '\n   %s%s passed%s · %s failed · %s%s skipped%s\n' \
    "$C_GREEN" "$npass" "$C_RESET" "$nfail" "$C_DIM" "$nskip" "$C_RESET"
}

# Did anything fail? (drives the exit code for scripting/CI)
overall() { local r; for r in "${RESULTS[@]}"; do case "$r" in *'|FAIL|'*) return 1;; esac; done; return 0; }

run_all() { RESULTS=(); local entry id; for entry in "${DEMOS[@]}"; do IFS='|' read -r id _ _ _ <<<"$entry"; run_one "$id"; done; summary; }

menu() {
  printf '\n%sweave — capability demos%s  %s(offline, no API key)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  local entry id title
  for entry in "${DEMOS[@]}"; do
    IFS='|' read -r id title _ _ <<<"$entry"
    printf '  %s%s)%s %s\n' "$C_CYAN" "$id" "$C_RESET" "$title"
  done
  printf '  %sa)%s run all    %sq)%s quit\n\n' "$C_CYAN" "$C_RESET" "$C_CYAN" "$C_RESET"
}

# Non-interactive: `run.sh 1` / `run.sh all`. Exit non-zero if any demo FAILED (CI-friendly).
if [ "$#" -ge 1 ]; then
  case "$1" in all|a) run_all ;; *) run_one "$1" ;; esac
  overall; exit $?
fi

# Interactive menu loop.
while true; do
  menu
  printf 'select> '
  if ! read -r choice; then printf '\n'; break; fi   # EOF (piped/non-tty)
  case "${choice:-}" in
    q|quit|exit) break ;;
    a|all)       run_all ;;
    "")          continue ;;
    *)           run_one "$choice" ;;
  esac
  printf '\n'
done
