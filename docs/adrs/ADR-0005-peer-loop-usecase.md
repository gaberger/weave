# ADR-0005: The peer loop (agent runtime use-case)

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** usecases, runtime, coordination
- **Depends on:** [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md), [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md), [ADR-0004](ADR-0004-toolhost-capability-model.md)

## Context

ADR-0002/0003/0004 defined the three ports (`Substrate`, `Worker`, `ToolHost`) and the
claim/lease protocol. Nothing yet *runs* them. ADR-0001 named the missing piece: the
**peer / agent loop** — the long-running unit that "is an agent on the network." It is a
**use-case** (depends only on ports + domain; no adapter imports), and it is the only
component that touches all three ports at once, so it is where the protocols compose.

## Decision

### 1. `PeerLoop` is a use-case, constructed from ports

```ts
// src/usecases/peer-loop.ts
export interface PeerConfig {
  readonly agentId: AgentId;
  readonly grant: Grant;                 // ADR-0004 — capability ceiling for its workers
  readonly leaseMs: number;              // ADR-0002 lease duration
  readonly maxConcurrent: number;        // how many tasks this peer runs at once
  readonly interests?: readonly string[];// reserved for ADR-0006 subscribe-by-interest
}

export class PeerLoop {
  constructor(
    private readonly weave: Substrate,
    private readonly newWorker: () => Worker,        // factory: one Worker per task
    private readonly newToolHost: (g: Grant, taskId: string) => ToolHost,
    private readonly cfg: PeerConfig,
    private readonly clock: Clock,                   // injected — testable, no Date.now in logic
  ) {}
  start(signal: AbortSignal): Promise<void> { /* … */ }
}
```

`Clock` is injected (not `Date.now()`), so lease/heartbeat timing is deterministic in
tests — the independent-oracle discipline from the hex lessons.

### 2. Reactive discovery + projection

The loop `subscribe`s to the weave from the current head and maintains an in-memory
**projection of open tasks** by folding events (ADR-0002 §3.1: a task is open if its
latest claim is terminal or its lease expired). On seeing an open task it is permitted to
handle, it attempts a claim — subject to `maxConcurrent`.

**Refinement (added during implementation):** lease *expiry* is time-based and emits **no
event**, so a purely event-reactive peer would never notice work freed by a crashed
holder. The loop therefore also runs a **periodic sweep** on the heartbeat tick
(`cfg.tickMs`) that re-evaluates open tasks against the current clock. So discovery is
event-driven for `task.declared`/`task.released` (immediate) **plus** a timer sweep for
expiries. This is the one place the loop "polls", and only at heartbeat cadence.

### 3. Claim → run → publish (the core cycle)

For each task the peer decides to pursue:

1. **Claim** via the ADR-0002 protocol (append `task.claimed{leaseMs}`, re-read, lowest
   valid `seq` wins). On loss, **jittered backoff** and move on (avoids thundering herd
   when many peers see the same `task.declared`).
2. On win, construct a **`LeaseGuard`** bound to `(weave, agentId, taskId)`, a
   **`ToolHost`** from `cfg.grant`, and a `WorkerContext`; then `newWorker().run(...)`.
3. Map progress and the terminal result back onto the weave:

| Worker outcome | Weave event(s) emitted | Task fate |
|----------------|------------------------|-----------|
| `onProgress(note)` | `task.progress` | — |
| irreversible tool ran | `tool.invoked` (ADR-0004 §5) | — |
| `completed` | `task.completed` | terminal |
| `failed` | `task.failed` | terminal |
| `aborted{lease-lost}` | `task.released{reason:"lease-lost"}` | **reclaimable** |
| `aborted{cancelled}` | `task.released{reason:"cancelled"}` | reclaimable |

This makes the weave the single, replayable account of what every peer did.

### 4. Heartbeat lives in the peer loop, not the worker  *(refines ADR-0003 §2)*

The peer loop owns one **heartbeat timer per active lease**, firing on an interval
`< leaseMs` (default `leaseMs / 3`), calling `LeaseGuard.renew()`. It runs on the
`Clock`, **independent of the worker's tool loop** — this resolves the ADR-0003 risk
that a long synchronous tool call could starve renewal: the worker can block on a tool
and still keep its lease, while the *gate* (`assertHeld`) still fires before the next
irreversible call. The worker no longer needs its own heartbeat; ADR-0003 §2's "runtime
renews" is concretely *the peer loop*.

### 5. Bounded concurrency, graceful stop

- A peer runs at most `maxConcurrent` tasks; excess open tasks are left for other peers
  (that is the point of a cooperative network) or picked up as slots free.
- `start(signal)`: on abort, stop claiming, signal in-flight workers (their
  `ctx.signal`), let them resolve to `aborted{cancelled}` → `task.released`, then return.
  Crash (no graceful stop) is already covered by ADR-0002: leases expire, peers reclaim.

## Consequences

**Positive**
- All three ports compose in exactly one place; adapters and protocols stay isolated.
- Heartbeat/gate separation removes the last sharp edge in the lease design.
- Deterministic via injected `Clock` + `FakeWorker` + `InProcessSubstrate`: the whole
  cooperative cycle is unit-testable with no network and no model calls.
- Crash-safety is free (ADR-0002), so the loop needs no bespoke recovery code.

**Negative / risks**
- **Discovery is O(all events)** until ADR-0006 (subscribe-by-interest) lands; fine for
  early scale, revisit before large fan-out. `interests` is reserved in `PeerConfig` now.
- **Backoff tuning** affects claim-contention efficiency; starts as jittered exponential,
  to be measured.
- The projection is in-memory per peer; very long logs need compaction (a `Memory`-port
  concern, ADR-0007).

## Alternatives considered

- **Central dispatcher assigns tasks to peers.** Rejected — reintroduces the SPOF and
  contradicts ADR-0001 peer autonomy.
- **Polling for open tasks.** Rejected — `subscribe` already gives push; polling adds
  latency and load.
- **Heartbeat inside the worker.** Rejected — §4: couples renewal to the tool loop and
  recreates the starvation risk.

## Follow-ups

- **Code:** `src/usecases/peer-loop.ts` + `src/domain` types + `InProcessSubstrate` +
  `FakeWorker`, behind the specs each ADR named.
- **ADR-0006** — subscribe-by-interest, to bound discovery cost.
- **Spec:** `docs/specs/peer-loop.md` — two peers, one task → exactly one runs it; lease
  loss mid-task → other peer reclaims and completes.
