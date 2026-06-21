# ADR-0007: Memory — log compaction via snapshot events

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** memory, compaction, context-reduction, scalability
- **Depends on:** [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md), [ADR-0011](ADR-0011-network-interrogation-loop.md)

## Context

weave's projections (`currentHolder`, `isSettled`, status, the peer loop's `snapshot()`)
replay the **whole** event log (`read(0)`) every pass, and the log grows without bound. A
recurring interrogation loop (ADR-0011) appends declared/claimed/completed events forever,
so replay cost and storage grow linearly with time. This is the missing **context-reduction
/ memory** layer (hex's `hex-summarize` + the OpenHands "condensation-as-an-event" pattern
from ADR-0001's prior art). It is the `Memory` port anticipated in ADR-0001's follow-ups.

## Decision

### 1. Compaction folds settled subjects into a snapshot **event**

A subject that reached a terminal state (`task.completed` / `task.failed`) never reactivates
(ADR-0002 §3.1 / the `isSettled` rule). So its raw events (`declared/claimed/lease.renewed/
progress/completed`) can be collapsed to a single fact: "this subject is settled". Compaction:

1. reads the log, computes the **settled** subject set and the still-**active** subjects;
2. appends a single `weave.snapshot` event carrying `{ upTo, settled[], findings }` — this is
   **condensation-as-an-event**: the snapshot lives *in* the log, so it's durable and
   replicates like everything else;
3. **prunes** folded events: delete `seq <= upTo` whose subject is not active (this also drops
   superseded older snapshots; the new snapshot has `seq > upTo` and survives).

After compaction, `read(0)` returns `latest snapshot + active subjects' events + tail` —
bounded by the number of *active* tasks, not total history.

### 2. Projections become snapshot-aware (no signature changes)

`isSettled` / `currentHolder` already treat a subject with a terminal event as settled. They
gain one rule: a subject listed in a `weave.snapshot` event's `settled` set is also settled
(its raw terminal event may have been pruned). So existing callers — peer loop, status — keep
working unchanged and automatically get cheap reads once the log is compacted.

### 3. The snapshot retains a bounded **finding-per-target** map (enables drift)

For interrogation, compaction extracts the latest `ProbeFinding` per *target* into
`snapshot.findings` (one entry per target, not per tick). This is the context-reduction win
for the loop — unbounded raw findings → one current value per target — and the data drift
needs. Real-time **drift** (status changed since last run) is computed in `weave watch` by
diffing each new finding against the last seen per target (`diffFinding`); compaction keeps
the durable side bounded.

### 4. Pruning is an optional substrate capability

`PrunableSubstrate extends Substrate` with `prune(beforeSeq, keepSubjects)`. SQLite/bun-sqlite
delete rows; InProcess filters. NetworkedSubstrate doesn't implement it yet (compaction there
needs anti-entropy-safe pruning — a follow-up). Compaction degrades gracefully: it always
emits the snapshot event; it prunes only if the substrate supports it.

## Consequences

**Positive**
- Bounded log + bounded replay → the interrogation loop scales over time.
- Durable & replayable: the snapshot is just another event (audit trail preserved as a
  condensed record, not destroyed).
- Foundation for the LLM-context reducer (ADR-future): a snapshot *is* a reduced context;
  an analysis skill can be fed `snapshot.findings` instead of raw history.
- Drift falls out of the retained finding-per-target map.

**Negative / risks**
- **Pruning is destructive.** Mitigated: only settled subjects are pruned, their settled
  status is preserved in the snapshot, and the snapshot is written before pruning. Raw
  intermediate history (individual claim/renew events of finished tasks) is intentionally
  discarded — if full forensic history is ever required, archive before prune.
- **NetworkedSubstrate can't prune yet** — compaction there only adds the snapshot event
  (still helps reads, doesn't shrink storage). Follow-up.
- **Finding extraction couples compaction to the probe artifact shape** — contained to the
  compaction use-case + the `ProbeFinding` domain type.

## Alternatives considered

- **Prune by time/TTL only.** Simpler but unsafe — could drop an active task's events.
  Settled-subject folding is correctness-preserving; TTL can layer on top later.
- **External snapshot store (separate file/table).** Rejected — a snapshot event reuses the
  substrate's durability/replication/idempotency for free and keeps one source of truth.
- **Never prune, only cache projections in memory.** Helps replay cost, not storage; and a
  fresh peer still cold-reads everything. The snapshot event fixes both.

## Follow-ups

- The **LLM `ContextReducer`** (layer 2): feed skills a reduced view (snapshot + relevance)
  instead of raw context — the hex L1/L2/L3 analogue.
- Networked compaction (anti-entropy-safe pruning).
- TTL / keep-last-N retention for `snapshot.findings` and archival-before-prune.
- Auto-compaction cadence tuning in `watch`/`up`.
