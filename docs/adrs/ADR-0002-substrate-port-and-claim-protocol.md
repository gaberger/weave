# ADR-0002: Substrate port & claim/lease protocol

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** coordination, consistency, ports, foundational
- **Depends on:** [ADR-0001](ADR-0001-cooperative-network-agent-architecture.md)

## Context

ADR-0001 chose a **shared append-only event log ("the weave") behind a `Substrate`
port** as the coordination mechanism, with agents acquiring work by **optimistic
claim resolved by log order**. It deferred two load-bearing details, called out there
as the chief risks:

1. The exact **`Substrate` port contract** — without a tight contract, agents couple
   to a transport and the solo→swarm→federated promise breaks.
2. The **claim/lease protocol** — without it, peers double-claim work or strand work
   held by a crashed agent. ADR-0001's negative-consequences section flagged this
   explicitly.

This ADR specifies both. It is the hardest correctness decision in the project because
the federated (`NetworkedSubstrate`) case is fundamentally a distributed-consensus
problem.

## Decision

### 1. The event model

The weave is a sequence of **immutable, append-only events**. Two identifiers:

- `id` — a client-generated UUID, set by the publisher. Used for **idempotency/dedup**.
- `seq` — a **monotonic ordinal assigned by the substrate at append time**. Defines the
  **total order** all peers agree on. Publishers never set it.

```ts
// src/domain/event.ts
export interface DraftEvent {
  readonly id: string;            // uuid, publisher-set, idempotency key
  readonly kind: string;          // e.g. "task.declared", "task.claimed"
  readonly actor: AgentId;        // who emitted it
  readonly subject: string;       // work/topic this event concerns (e.g. task id)
  readonly causedBy?: string;     // id of the event this reacts to (provenance)
  readonly payload: unknown;      // kind-specific body
}

export interface SealedEvent extends DraftEvent {
  readonly seq: number;           // substrate-assigned total order
  readonly ts: number;            // substrate-assigned wall clock (ms)
}

export type Offset = number;      // a seq cursor; 0 = beginning
```

Events are **never mutated or deleted**. State (who holds what) is a *projection* of
the log, computed by replaying it — not stored separately. This keeps the substrate
dumb and the protocol auditable/replayable.

### 2. The `Substrate` port — deliberately minimal

The port does **four** things. Claiming is **not** a port method — it is a use-case
built from these primitives (§3), so every adapter stays trivial to implement.

```ts
// src/ports/substrate.ts
export interface Substrate {
  /** Append an event; substrate assigns seq + ts. Idempotent on event.id:
   *  re-appending a known id returns the existing SealedEvent, never a duplicate. */
  append(event: DraftEvent): Promise<SealedEvent>;

  /** Replay historical events in seq order, starting at `from` (inclusive). */
  read(from: Offset): AsyncIterable<SealedEvent>;

  /** Live tail: invoke handler for every event with seq >= from, in order,
   *  including ones appended after subscription. Returns an unsubscribe handle. */
  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription;

  /** Current head offset (seq of the latest event, or 0 if empty). */
  head(): Promise<Offset>;
}
```

**Contract every adapter MUST honour:**

- **C1 — Total order.** All consumers observe events in the *same* `seq` order.
- **C2 — Monotonic, gap-tolerant seq.** `seq` strictly increases; consumers must not
  assume it is contiguous (the networked adapter may leave gaps).
- **C3 — Idempotent append.** Appending an event whose `id` was already appended is a
  no-op that returns the original `SealedEvent`. (Enables safe retry.)
- **C4 — Read/subscribe agreement.** An event returned by `read` up to offset N is
  identical to what `subscribe(0, …)` would have delivered for that seq.
- **C5 — Durability is adapter-declared.** Each adapter documents its durability and
  ordering guarantees (see §4); use-cases must not assume more than the contract.

### 3. The claim/lease protocol (a use-case, not the port)

Work moves through the log as events on a single `subject` (the task id):

| kind | meaning |
|------|---------|
| `task.declared` | a unit of work exists (`payload`: spec) |
| `task.claimed`  | actor claims subject; `payload: { leaseMs }` |
| `lease.renewed` | heartbeat; extends the holder's lease |
| `task.completed` / `task.failed` | terminal; releases the claim |
| `task.released` | voluntary release before completion |

**Acquisition (optimistic, lock-free):**

1. Agent replays the log for the subject and computes the **current holder** (§3.1).
2. If unheld (or lease expired), it `append`s a `task.claimed{leaseMs}`.
3. It re-reads up to its own claim's `seq`. The **winner is the valid claim with the
   lowest `seq`**. Because the substrate assigns a total order (C1), *every* peer
   computes the same winner deterministically.
4. If the agent's claim is not the winner, it **backs off** and looks for other work.
   The losing claim event stays in the log (immutable) but is inert.

**3.1 Who holds a subject** — pure projection over the subject's events at wall-clock
time `now`:

- Find terminal events (`completed`/`failed`/`released`): if the latest claim is
  terminated, the subject is **free**.
- Otherwise the holder is the **lowest-seq `task.claimed`** whose lease is live:
  `now <= ts_of_last_renewal_or_claim + leaseMs`.
- If that lease has **expired**, the subject is **reclaimable**: a new
  `task.claimed` (necessarily higher seq) becomes the holder; the stale claim is inert.

**Leases & dead-agent reclamation:** the holder must `lease.renewed` before
`claim.ts + leaseMs` elapses. No central reaper exists — **expiry is derivable by any
peer from the log + its clock**, so reclamation is decentralized. A peer MAY append a
`task.released{reason:"lease-expired"}` purely as an observability marker; correctness
does not depend on it.

**Idempotency of effects:** because a claim can be lost (race) or superseded (partition,
§4), **work side effects MUST be abortable or idempotent**. A worker checks it still
holds the lease before committing irreversible effects (e.g. before `git push`). This is
a hard constraint on everything built on the substrate, recorded here.

### 4. Consistency guarantees per adapter

The port contract (C1–C5) is the floor. Adapters differ in *how* they provide total
order and *what happens under partition*:

| Adapter | seq source | Order | Partition behaviour |
|---------|-----------|-------|---------------------|
| `InProcessSubstrate` | in-memory counter | strong, single writer | n/a |
| `SqliteSubstrate` | `INTEGER PRIMARY KEY AUTOINCREMENT` + txn | strong, multi-process via DB lock | n/a (single host) |
| `NetworkedSubstrate` | **hybrid logical clock + node id** tie-break | **eventually-consistent total order** | **AP**: see below |

For the federated case we choose **AP + deterministic conflict resolution** over CP:

- Order is a **hybrid logical clock (HLC)** value with `nodeId` as the deterministic
  tie-break, so once logs merge, *all* replicas converge on the identical `seq` order
  (satisfying C1 *eventually*; C2's gap-tolerance covers the merge).
- **Under partition, two agents on opposite sides may both believe they won a claim.**
  On heal, the deterministically-earlier claim wins; the loser observes it was
  superseded and must abort/roll back — which §3's idempotency constraint guarantees is
  safe. We accept transiently-duplicated work in exchange for availability (no agent
  blocks waiting for a quorum).

This is the explicit CAP choice. A future ADR may add an optional CP substrate (Raft)
for workloads that cannot tolerate duplicated effects; it would implement the *same*
`Substrate` port, so agent code is unaffected.

## Consequences

**Positive**
- Lock-free, dispatcher-free work acquisition; any peer can reclaim dead work.
- The port is tiny (4 methods) → adapters are cheap and the solo→federated promise holds.
- All coordination state is a replayable projection of one immutable log → strong
  testability (feed a log, assert the holder) and observability.

**Negative / risks**
- **HLC/merge correctness in `NetworkedSubstrate` is genuinely hard** and unimplemented;
  ADR-0001's "substrate-port is load-bearing" risk concentrates here. Mitigation: ship
  InProcess + SQLite first; gate the networked adapter behind its own spec + property
  tests (claim-safety under simulated partitions).
- **The idempotency/abortability constraint leaks into every worker.** It must be a
  first-class part of the `Worker`/`ToolHost` design (ADR-0003/0004), not an afterthought.
- **Clock dependence** for lease expiry. Bounded clock skew is assumed; HLC limits but
  does not eliminate sensitivity. Leases should be generous relative to expected skew.

## Alternatives considered

- **Claim as a `Substrate.claim()` port method** (atomic compare-and-set). Rejected:
  pushes consensus into every adapter and bloats the port; the log-order approach gets
  the same guarantee from `append`+`read` and keeps adapters dumb.
- **Central lease manager / dispatcher.** Rejected: reintroduces the SPOF ADR-0001
  removed.
- **CP-only (Raft) substrate as the default.** Rejected as default: blocks progress
  under partition, contradicting the peer-autonomy goal. Kept as a *future optional*
  adapter behind the same port.
- **Last-writer-wins by wall clock** for claims. Rejected: not deterministic across
  peers under skew; HLC+nodeId gives a stable total order instead.

## Follow-ups

- **Spec:** `docs/specs/substrate-claim.md` — property tests: no two valid holders at
  any seq; reclamation after lease expiry; idempotent append; partition/merge convergence.
- **ADR-0003** — `Worker` port + Claude Agent SDK adapter, incl. the lease-check-before-
  irreversible-effect hook required by §3.
- **ADR-0004** — `ToolHost` capability model (where abortability/idempotency is enforced).
