# ADR-0003: Worker port & Claude Agent SDK adapter

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** workers, claude, lifecycle, ports
- **Depends on:** [ADR-0001](ADR-0001-cooperative-network-agent-architecture.md), [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md)

## Context

ADR-0001 settled that workers are **Claude agents driven by the Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`). ADR-0002 imposed a hard constraint on whatever runs
the work: because a claim can be lost to a race or superseded after a partition heal,
**a worker must verify it still holds its lease before any irreversible effect**, and
its effects must otherwise be abortable/idempotent.

This ADR defines the `Worker` port — the thing that executes *one* claimed task — and
its canonical Claude-SDK adapter, and it wires in the lease guard so the ADR-0002
constraint is enforced by construction rather than left to each task's author.

A naming split that the rest of the system depends on:

- **Peer / agent loop** — the long-running process that subscribes to the weave, claims
  work (ADR-0002 §3), and is the unit of "an agent on the network." This is a *use-case*,
  not this ADR's subject.
- **Worker** — runs a single claimed task to completion, then returns. Stateless across
  tasks. *This ADR.* Keeping the Worker single-shot (not a long-lived REPL) matches
  claim-per-task and keeps the SDK adapter simple.

## Decision

### 1. The `Worker` port

```ts
// src/ports/worker.ts
export interface Worker {
  /** Execute one claimed task to completion. Resolves with a terminal result;
   *  never throws for ordinary task failure (that is `status: "failed"`). */
  run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult>;
}

export interface TaskAssignment {
  readonly taskId: string;     // the weave subject this worker holds
  readonly spec: TaskSpec;     // domain: what to do (prompt/goal + inputs)
}

export interface WorkerContext {
  readonly tools: ToolHost;                       // ADR-0004 — capabilities
  readonly lease: LeaseGuard;                      // ADR-0002 lease, this run holds it
  readonly onProgress: (note: string) => void;     // peer loop → task.progress events
  readonly signal: AbortSignal;                    // cooperative cancellation
}

export type WorkerResult =
  | { readonly status: "completed"; readonly summary: string; readonly artifacts?: readonly Artifact[] }
  | { readonly status: "failed";    readonly summary: string; readonly error: string }
  | { readonly status: "aborted";   readonly summary: string; readonly reason: "lease-lost" | "cancelled" };
```

`aborted` is **distinct from `failed`**: an abort (lease lost / cancelled) is not the
task's fault and the peer loop emits `task.released`, leaving the work reclaimable;
`failed` emits `task.failed` (terminal). The Worker reports outcomes faithfully — it
never reports `completed` if an irreversible step was blocked.

### 2. Lease integration — the guard is in the adapter, not in task code

The ADR-0002 constraint is enforced in **two** places inside the worker runtime so no
individual task has to remember it:

- **Pre-effect gate.** Every tool the worker invokes carries an effect class from its
  `ToolHost` descriptor (ADR-0004): `read` | `reversible` | `irreversible`. Before an
  `irreversible` tool runs, the runtime calls `lease.assertHeld()`. If the lease is
  gone, the tool is **denied** and the run ends `aborted{reason:"lease-lost"}`.
- **Heartbeat.** While `run()` is in flight the runtime renews the lease
  (`lease.renew()`) on an interval comfortably shorter than `leaseMs`, so a healthy
  worker never loses its claim mid-task to expiry.

```ts
// src/ports/lease.ts  (the handle ADR-0002 §3 referred to)
export interface LeaseGuard {
  held(): Promise<boolean>;     // project the weave: do I still hold taskId?
  assertHeld(): Promise<void>;  // throws LeaseLostError if not
  renew(): Promise<void>;       // append lease.renewed
}
```

This makes "check the lease before `git push`" a property of the framework, satisfying
ADR-0002 by construction.

### 3. Canonical adapter — `ClaudeAgentSdkWorker`

`src/adapters/secondary/claude-sdk-worker.ts` implements `Worker` over the Claude Agent
SDK's streaming `query()` loop:

- **Tools** come from the injected `ToolHost`, surfaced to the SDK as its tool set
  (in-process MCP / tool definitions). The Worker does not define tools itself.
- **The pre-effect gate is wired via the SDK's per-tool-use permission callback**
  (`canUseTool`): for an `irreversible` tool it consults `lease.assertHeld()` and
  returns allow/deny; reversible/read tools pass straight through. This is the single
  enforcement point for §2's gate.
- **Streaming → progress.** Assistant/tool-result messages are mapped to
  `ctx.onProgress(note)`; the peer loop turns those into `task.progress` events on the
  weave (ADR-0002 §3), so progress is observable to all peers, not just locally.
- **Cancellation.** `ctx.signal` aborts the SDK query; the run resolves
  `aborted{reason:"cancelled"}`.

### 4. Model-agnostic, latest-Claude default

The port is model-free; the adapter takes model config (no hardcoding). Default to the
**latest, most capable Claude** — `claude-opus-4-8` for deep work, `claude-sonnet-4-6`
for high-throughput tasks — overridable per peer via config, mirroring hex's
model-agnostic tiering. The exact SDK option names are bound at implementation time
against the version pinned in `package.json`; this ADR fixes the *contract*, not the
call signatures.

### 5. Test double — `FakeWorker`

`src/adapters/secondary/fake-worker.ts` implements `Worker` deterministically (scripted
results, scriptable lease-loss) so the peer loop and claim protocol can be tested with
**no network and no model calls** — the independent oracle the hex lessons demand
("tests can mirror bugs"; property/behavioral specs over LLM-written tests).

### 6. The `Worker` port *is* the plugin seam (Copilot, other backends)

Making `Worker` a port is exactly what lets a non-Claude backend — GitHub Copilot, a
raw-API loop, a local model, another harness — drop in as **just another adapter**
(`CopilotWorker`, `OpenAiWorker`, …) with the peer loop and substrate untouched. That
is the payoff of ports-and-adapters here and the reason not to call the SDK directly
from use-cases.

One requirement this imposes, decided here: **the lease guard (§2) must remain
enforceable across *every* backend, not just Claude.** The Claude SDK gives us a native
per-tool permission callback (`canUseTool`); other backends may not. Therefore:

- **Tool execution is owned by `weave`, not delegated wholesale to the backend.** Tools
  come from our `ToolHost`; the backend proposes a tool call, but the *runtime* runs it,
  and the runtime applies the pre-effect gate. Adapters wrap their backend's tool loop
  to route through `ToolHost`.
- A backend that cannot surface tool-call interception **may only be granted `read` /
  `reversible` tools** (no `irreversible` effects), so the ADR-0002 guarantee holds even
  without a native hook. This is a capability ceiling, declared per adapter.

So: yes, use ports-and-adapters — but the port owns tool execution and effect-gating;
backends contribute the *reasoning loop*, not the *authority to act*.

## Consequences

**Positive**
- A new agent backend (Copilot, raw API, local model) is an adapter, not a fork — the
  peer loop, substrate, and lease guard are reused unchanged.
- The ADR-0002 idempotency/abortability constraint is enforced once, in the runtime, not
  re-implemented (or forgotten) per task.
- Worker is swappable: Claude SDK in prod, `FakeWorker` in tests, other models later —
  the peer loop and substrate never change.
- `aborted` vs `failed` keeps the weave's task lifecycle honest under lease loss.

**Negative / risks**
- **Effect classification is trust-critical.** A tool mis-tagged `reversible` bypasses
  the gate. → ADR-0004 must make `irreversible` the *safe default* for unknown tools.
- **Heartbeat vs. long synchronous tool calls.** A tool that blocks longer than the
  renewal interval could let the lease lapse. → renew from a timer independent of the
  tool loop, and keep `leaseMs` generous (ties to ADR-0002 clock-skew note).
- **SDK coupling in one adapter** is intentional and contained; the port keeps it from
  leaking. Pinned at `^0.1.0` — pre-1.0, so the adapter is expected to track breaking
  changes.

## Alternatives considered

- **Long-lived worker REPL** (one Claude session servicing many tasks). Rejected:
  complicates lease scoping (which task does an effect belong to?) and crash recovery;
  single-shot per claim is cleaner and matches ADR-0002.
- **Lease check as task-author responsibility.** Rejected: exactly the "leaks into every
  worker" failure ADR-0002 warned about; enforce in the runtime instead.
- **Shell out to the `claude` CLI** (hex's approach). Rejected per ADR-0001: the SDK
  gives native tool-use, streaming, and the per-tool permission callback we need for §2.
- **Hardcode a single model.** Rejected: contradicts model-agnostic goal; config-driven.

## Follow-ups

- **ADR-0004** — `ToolHost`: capability/permission model and the `read|reversible|
  irreversible` effect taxonomy (with irreversible-by-default for unknowns).
- **ADR-0005** (anticipated) — the peer/agent loop use-case: claim → run Worker →
  publish, including `onProgress`→`task.progress` and `aborted`→`task.released` mapping.
- **Spec:** `docs/specs/worker-lease-guard.md` — property test: no `irreversible` tool
  executes after lease loss; `aborted` never reports `completed`.
