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
)

run_one() {
  local n="$1" entry
  for entry in "${DEMOS[@]}"; do
    IFS='|' read -r id title script needs_pool <<<"$entry"
    if [ "$id" = "$n" ]; then
      if [ "$needs_pool" = "1" ] && [ "$POOL_OK" != "1" ]; then
        note "demo $id needs the compiled ./weave binary (Bun not found to build it) — skipping."
        return 0
      fi
      printf '\n'; hr "demo $id — $title"; printf '\n'
      bash "$HERE/$script"
      printf '\n'; ok "demo $id complete"
      return 0
    fi
  done
  note "no demo '$n'"
}

run_all() { local entry id; for entry in "${DEMOS[@]}"; do IFS='|' read -r id _ _ _ <<<"$entry"; run_one "$id"; done; }

menu() {
  printf '\n%sweave — capability demos%s  %s(offline, no API key)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  local entry id title
  for entry in "${DEMOS[@]}"; do
    IFS='|' read -r id title _ _ <<<"$entry"
    printf '  %s%s)%s %s\n' "$C_CYAN" "$id" "$C_RESET" "$title"
  done
  printf '  %sa)%s run all    %sq)%s quit\n\n' "$C_CYAN" "$C_RESET" "$C_CYAN" "$C_RESET"
}

# Non-interactive: `run.sh 1` / `run.sh all`
if [ "$#" -ge 1 ]; then
  case "$1" in all|a) run_all ;; *) run_one "$1" ;; esac
  exit 0
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
