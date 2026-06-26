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
run "${RUN[@]}" doctor | sed 's/^/   /'
ok "the architecture is verified mechanically — drift can't merge"
