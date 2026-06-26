#!/usr/bin/env bash
# Federated: the same agent code runs solo / local-swarm / federated — it's an adapter choice, not a
# rewrite (the core bet, ADR-0001). This shows the federated substrate converging after a partition.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "$HERE/lib.sh"
REPO="$(cd "$HERE/.." && pwd)"

say "two replicated hosts, a network partition, concurrent claims, then a heal:"
printf '\n'
# federated.mts exits non-zero if the two replicas don't converge to identical state after the heal.
if node --import tsx "$HERE/federated.mts"; then
  pass "partition-tolerant: same code, replicated log, deterministic convergence after heal"
else
  fail "replicas did not converge after the partition healed"
fi
