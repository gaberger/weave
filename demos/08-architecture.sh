#!/usr/bin/env bash
# Architecture gate: weave's hexagonal boundaries are a BUILD GATE, not a hope (ADR-0015). A pure
# checker (in domain/) enforces the dependency cone — domain → ports → usecases → adapters, inner
# layers never import outward, adapters import only ports+domain. It runs in `npm test`, so a
# boundary violation fails CI. `weave doctor` runs the same check on demand.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"

say "the enforced dependency cone:"
cat <<'EOF'
     domain  →  ports  →  usecases  →  adapters
     (inner layers never import outward; adapters import only ports + domain)
EOF
printf '\n'; hr "weave doctor — strict (fails on ANY boundary violation)"
printf '%s$ weave doctor%s\n' "$C_BOLD" "$C_RESET"
DOUT="$DEMO_TMP/doctor.out"; mkdir -p "$DEMO_TMP"
if "${RUN[@]}" doctor >"$DOUT" 2>&1; then DOK=1; else DOK=0; fi
sed 's/^/   /' "$DOUT"
[ "$DOK" = 1 ] \
  && pass "architecture verified mechanically — boundary drift can't merge" \
  || fail "weave doctor reported a boundary violation"
