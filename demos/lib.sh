# shellcheck shell=bash
# Shared helpers for the weave capability demos. Source this from each demo script.
#
# Every demo runs OFFLINE (no ANTHROPIC_API_KEY): peers use the --fake echo worker or deterministic
# code skills. State lives in a throwaway workspace under $DEMO_TMP, never the engine repo.

set -euo pipefail

# Resolve the repo root regardless of where the demo was invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_TMP="${WEAVE_DEMO_TMP:-/tmp/weave-demos}"

# --- pretty output ---------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\e[2m'; C_BOLD=$'\e[1m'; C_GREEN=$'\e[92m'; C_CYAN=$'\e[96m'; C_YELLOW=$'\e[93m'; C_RESET=$'\e[0m'
  C_PASS=$'\e[1;30;102m'; C_FAIL=$'\e[1;97;101m'; C_SKIP=$'\e[1;30;107m'   # inverse blocks: green / red / grey
else
  C_DIM=""; C_BOLD=""; C_GREEN=""; C_CYAN=""; C_YELLOW=""; C_RESET=""
  C_PASS=""; C_FAIL=""; C_SKIP=""
fi

hr()   { printf '%s── %s %s%s\n' "$C_CYAN" "$1" "$(printf '─%.0s' $(seq 1 $((50 - ${#1}))))" "$C_RESET"; }
say()  { printf '%s▸%s %s\n' "$C_DIM" "$C_RESET" "$1"; }
run()  { printf '%s$ %s%s\n' "$C_BOLD" "$*" "$C_RESET"; "$@"; }   # echo a command, then run it
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
note() { printf '%s%s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }

# --- verdicts: the scannable line every demo ends on -----------------------
# Each demo ASSERTS its key result and ends in exactly one of these. The launcher reads the exit
# code (0 pass / 1 fail / 2 skip) to build the final results table, so "did it work?" is never a
# guess. Call as the last thing the script does — they exit.
pass() { printf '\n  %s PASS %s %s%s%s\n' "$C_PASS" "$C_RESET" "$C_GREEN" "${1:-}" "$C_RESET"; exit 0; }
fail() { printf '\n  %s FAIL %s %s%s%s\n' "$C_FAIL" "$C_RESET" "$C_YELLOW" "${1:-}" "$C_RESET"; exit 1; }
skip() { printf '\n  %s SKIP %s %s%s%s\n' "$C_SKIP" "$C_RESET" "$C_DIM" "${1:-}" "$C_RESET"; exit 2; }

# --- runner detection ------------------------------------------------------
# Prefer the compiled ./weave binary: it has no tsx loader to resolve, so the pool demo's child
# spawns work and every demo starts fast. Build it once if Bun is available; otherwise fall back to
# node+tsx (fine for everything except the multi-process pool demo, which is gated on POOL_OK).
WEAVE_BIN="$REPO_ROOT/weave"
POOL_OK=1
detect_runner() {
  if [ -x "$WEAVE_BIN" ]; then
    RUN=("$WEAVE_BIN")
  elif command -v bun >/dev/null 2>&1; then
    say "building the single binary (one-time; needs Bun)…"
    ( cd "$REPO_ROOT" && npm run build:bin >/dev/null 2>&1 )
    RUN=("$WEAVE_BIN")
  else
    RUN=(node --import tsx "$REPO_ROOT/src/cli.ts")
    POOL_OK=0  # dev-mode child spawns can't resolve tsx after chdir; pool demo needs the binary
  fi
}

# Make a fresh, isolated workspace and echo its path. Callers must `export WEAVE_HOME="$WS"` after —
# this runs in a command-substitution subshell, so it cannot export into the caller itself. Pointing
# WEAVE_HOME outside the repo satisfies the engine-repo workspace guard and keeps demos isolated.
make_ws() {
  local ws="$DEMO_TMP/$1"
  rm -rf "$ws"; mkdir -p "$ws"
  printf '%s' "$ws"
}

detect_runner
