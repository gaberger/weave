# ADR-0009: NetworkedSubstrate — replicated log with HLC ordering

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** substrate, distributed, consistency, foundational
- **Depends on:** [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md)
- **Promotes:** ADR-0002 §4 (federated `NetworkedSubstrate`) from future-work to a decision

## Context

ADR-0002 §4 chose, for the federated case, **AP + deterministic conflict resolution**: an
eventually-consistent total order via a **hybrid logical clock (HLC) + nodeId tie-break**,
accepting transient claim duplication under partition (resolved on heal, made safe by the
worker abortability constraint). It deferred the design. This ADR designs it and confronts
the tension ADR-0002 glossed: **the `Substrate` port assumes a single monotonic integer
`seq` that all consumers agree on (C1), but no such global integer exists across nodes** —
that is the entire distributed-systems problem.

The two prior substrates (`InProcess`, `Sqlite`) are single-writer, so `seq` *is* the
global order. A networked, multi-writer log cannot assign a stable global integer at
append time without consensus (which we explicitly rejected as the default).

## Decision

### 1. Two separate concerns: local `seq` (delivery cursor) vs. HLC (conflict order)

We split what `seq` was doing into two:

- **`seq` becomes a node-local append index.** Each `NetworkedSubstrate` node assigns its
  own monotonic `seq` in the order it *applies* events locally (its own appends + events
  received from peers). `seq`/`read`/`head`/`subscribe` are about "what has this node seen
  and in what local order" — a durable cursor, nothing more. The *same logical event has
  different `seq` on different nodes*, which is fine because `seq` is no longer the
  conflict-resolution order.
- **HLC becomes the global conflict-resolution order.** Every event carries an HLC stamp
  `{ p, l, node }` (physical, logical, nodeId), assigned **once by its origin node** and
  preserved verbatim through replication. The total order is `compare(p, l, node)` — a
  deterministic order *all nodes converge on* once they hold the same events.

So C1 is reinterpreted per ADR-0002 C2's spirit: each node delivers in a consistent local
order; the **conflict order is the HLC order**, identical on every node at convergence.

### 2. The claim projection orders by HLC, not `seq`

`currentHolder` (ADR-0002 §3.1) currently sorts by `seq`. It changes to sort by a
**`compareOrder`** that uses the HLC stamp when present and falls back to `seq` when absent.
Single-node substrates set no HLC → behaviour is unchanged (backward compatible; their
existing tests still pass). Networked events all carry HLC → cross-node deterministic
resolution. `Holder.claimSeq` stays node-local and still correctly identifies a peer's own
claim, because a `LeaseGuard` only ever checks the claim it created on its own node.

### 3. Event model addition

`SealedEvent` gains an optional, immutable `hlc?: { p: number; l: number; node: string }`,
set by the substrate at append (like `seq`/`ts`) and carried across the wire. `DraftEvent`
is unchanged — callers (the peer loop) never set it.

### 4. Architecture: replicated log + pluggable transport seam

The hard, testable correctness (HLC algorithm, dedup, merge convergence) lives in the
substrate; the wire is an injected seam so we can test partitions deterministically and
swap real transports later without touching the substrate.

```ts
interface ReplicationTransport {
  broadcast(event: SealedEvent): void;            // gossip a local append to peers
  onReceive(handler: (event: SealedEvent) => void): void;
}
```

- `append(draft)`: stamp HLC (`hlc.tick()`), assign local `seq`, persist, deliver to local
  subscribers, then `transport.broadcast`.
- on receive(remote): **dedup by `event.id`** (C3 — the convergence keystone), `hlc.update`
  with the remote stamp, assign a fresh *local* `seq`, persist, deliver locally. Never
  re-broadcast verbatim (anti-storm); a gossip transport handles fan-out/anti-entropy.
- `read`/`head`/`subscribe`: by local `seq`, exactly like InProcess.

In-memory transports (a shared hub with a partition toggle) drive the tests; a real
WebSocket/libp2p transport is a later adapter implementing the same seam.

### 5. Partition semantics (the AP choice, made concrete)

- During a partition, each side's nodes apply only their own region's events; `currentHolder`
  on each side may name a different winner for the same task → **transient double-claim**.
- On heal, buffered events flush; dedup-by-id means each event applies once; HLC order is
  now identical on all nodes → **`currentHolder` converges to one deterministic winner**.
- The losing peer's next `lease.held()` returns false → its worker aborts `lease-lost`
  (ADR-0003 §2), which is safe **only because** ADR-0002 made effects abortable/idempotent.
  This ADR does not weaken that constraint; it depends on it.

## Consequences

**Positive**
- Implements ADR-0002 §4 without consensus: available under partition, convergent after.
- The `Substrate` port is unchanged; use-cases (peer loop, lease guard) run over it
  untouched — same agent code, now distributed. The only domain change is one optional
  field + an HLC-aware comparator, fully backward compatible.
- Correctness is unit-testable offline via an in-memory partitionable transport.

**Negative / risks**
- **Convergence ≠ instantaneous safety.** Double-work can happen mid-partition; tolerable
  only because effects are abortable. Workloads that cannot tolerate *any* duplication need
  the future CP/Raft substrate (ADR-0002 §4), not this one.
- **Unbounded local log / no compaction yet.** A real deployment needs anti-entropy +
  compaction (ties to the future `Memory` port). Out of scope here.
- **Clock skew** widens the window where physical-time ordering feels surprising; HLC
  bounds but does not erase it. Leases must stay generous (ADR-0002 §4 note).
- **Transport reliability is assumed, not built.** The seam presumes at-least-once delivery
  with eventual reconnection; the real transport must provide anti-entropy so a node that
  missed events while down can catch up.

## Alternatives considered

- **Global integer seq via consensus (Raft).** Rejected as default — blocks under
  partition, contradicting ADR-0001 peer autonomy. Reserved as an optional CP substrate.
- **Order by wall-clock `ts` + nodeId.** Rejected — not monotonic under skew; HLC gives a
  causally-sound, monotonic order that degrades gracefully to physical time.
- **Make `seq` itself the HLC** (encode HLC into one big integer). Rejected — `seq` must
  stay a stable local cursor for `read`/`subscribe`; conflating it with a shifting global
  order breaks cursors on merge.
- **CRDT state (e.g. OR-Set) instead of an event log.** Rejected — the whole system is
  built on a replayable event log (ADR-0001); an HLC-ordered log *is* our CRDT (a grow-only
  set of immutable events, deduped by id, ordered by HLC — convergent by construction).

## Follow-ups

- **Spec:** `docs/specs/networked-substrate.md` — property tests: dedup idempotence;
  post-heal `currentHolder` identical across all nodes; deterministic winner under
  concurrent cross-partition claims; losing peer observes lease loss.
- **Real transport adapter** (WebSocket/libp2p) implementing `ReplicationTransport`, with
  anti-entropy/catch-up for nodes that were offline.
- **Compaction / anti-entropy** (with the future `Memory` port).
