#!/usr/bin/env bash
# Container sandbox isolation (ADR-0018): a code skill runs in a locked-down Docker container —
# --network none --read-only --cap-drop ALL --pids-limit 64 --memory 256m. It CANNOT touch the
# network, yet a granted tool still round-trips to the parent over stdio RPC. OS-level isolation and
# the capability boundary, proven together. Needs Docker (skips cleanly without it).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
  skip "Docker isn't available — this is the one demo that needs it (everything else is offline)"
fi

say "a skill inside a --network none container tries the net, then calls a granted parent tool:"
printf '\n'
# sandbox.mts exits non-zero unless the net was blocked AND the granted tool still worked.
if node --import tsx "$HERE/sandbox.mts"; then
  pass "network blocked by the kernel, granted tool still worked — isolation + capability boundary hold"
else
  fail "container was not properly isolated (or the granted tool failed to round-trip)"
fi
