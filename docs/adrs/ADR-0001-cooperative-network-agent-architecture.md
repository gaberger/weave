# ADR-0001: Cooperative-network agent architecture

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** architecture, coordination, foundational

## Context

We are starting `weave`: a TypeScript framework for **cooperative network agents** —
autonomous AI workers that collaborate on software tasks. It is informed by
[hex](../../../hex) (a microkernel AIOS built on hexagonal / ports-and-adapters
architecture) and by the design of existing agent harnesses, but it deliberately
diverges on one axis: **flexibility of coordination**.

hex centralizes coordination in a single required microkernel (SpacetimeDB). That
buys strong consistency and a single source of truth, but it is heavyweight, is a
single point of failure, and forces *everything* to route through one kernel. For a
framework whose goal is **cooperative, peer-oriented agents that can run solo, in a
local swarm, or federated across a network**, a mandatory central kernel is the wrong
default.

We need to decide the **coordination model** — how agents find work, share state,
and cooperate — because it is the decision every other decision hangs off. The owner
delegated the specific choice ("which works best"); this ADR makes and justifies it.

Two adjacent decisions were already made and are recorded here as constraints:

- **Language:** TypeScript (NodeNext ESM, strict). Settled.
- **Worker runtime:** the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)
  drives each Claude worker — native tool-use, streaming, and lifecycle, rather than
  shelling out to a CLI or hand-rolling the Messages-API agent loop.

## Decision

### 1. Coordination model — shared event-log substrate ("the weave"), agents as autonomous peers

Agents do **not** report to a central coordinator and do **not** message each other
point-to-point as the primary mechanism. Instead they cooperate **indirectly through a
shared, append-only event log** — a blackboard model with peer autonomy:

- Agents **publish** events (claims on work, partial results, requests for help,
  completions) to the log.
- Agents **subscribe** to the slices of the log relevant to them and **react**.
- Work is acquired by **claiming** (optimistic, log-ordered) rather than being
  assigned by a dispatcher. A claim that loses a race is simply superseded by an
  earlier-ordered claim in the log.

This is chosen over the two main alternatives because it dominates them on our
primary goal (flexibility) without losing what matters:

| Model | Flexibility | Resilience (no SPOF) | Observability | Verdict |
|-------|-------------|----------------------|---------------|---------|
| Central kernel (hex-style) | Low — all routes through one kernel | ✗ kernel is SPOF | High | Rejected — the thing we're moving away from |
| Pure P2P mesh / direct messaging | High | ✓ | Low — no single audit trail; hard to debug | Rejected — coordination & debugging too costly |
| **Shared event-log blackboard** | **High** | **✓** | **High — the log *is* the audit trail** | **Chosen** |

The log gives us peer autonomy *and* a single ordered history to reason about,
replay, and debug — without a kernel that must be up for anyone to make progress.

### 2. The substrate is a Port, not a fixed technology

The event log lives behind a `Substrate` port. The P2P-vs-federated-vs-solo question
is therefore **deferred to an adapter choice**, not baked into agent code:

- `InProcessSubstrate` — solo / single-process (ships first).
- `SqliteSubstrate` — local swarm, multiple processes on one host.
- `NetworkedSubstrate` (CRDT / replicated log) — federated across hosts.

The same agent and use-case code runs against all three. This is the concrete payoff
of "more flexible than hex": you scale coordination by wiring a different adapter, not
by rewriting.

### 3. Hexagonal core (inherited from hex, kept)

`domain → ports → usecases → adapters`. Adapters never import adapters; only the
composition root wires them. Relative imports use `.js` extensions (NodeNext).
The three founding ports:

- **`Substrate`** — append/subscribe/claim over the shared event log.
- **`Worker`** — spawn/step/stop a Claude worker (implemented by a Claude-Agent-SDK adapter).
- **`ToolHost`** — the tools/permissions a worker may use (filesystem, shell, git, …).

### 4. Spec-and-ADR-first (inherited from hex, kept)

New ports/adapters/external deps get an ADR. Behavioral specs precede code.

## Consequences

**Positive**
- No mandatory central kernel; any single agent or host can fail without halting the network.
- One codebase scales solo → swarm → federated via adapter selection.
- The event log is a built-in audit/replay trail — strong observability and testability.
- Hexagonal boundaries keep the coordination logic pure and substrate-agnostic.

**Negative / risks**
- **Eventual consistency.** Claim races and ordering must be designed for explicitly
  (resolved by log order); naive code can double-claim. → Spec the claim protocol in ADR-0002.
- **Substrate-port design is load-bearing.** A leaky port abstraction would couple
  agents to a transport. → Treat the `Substrate` port contract as a first-class spec.
- **No global scheduler** means we trade central optimization for autonomy; advanced
  load-balancing becomes its own (optional) concern layered on the log.

## Alternatives considered

- **Adopt hex's SpacetimeDB kernel directly.** Rejected: reintroduces the central
  SPOF and heavyweight runtime we are explicitly trying to shed.
- **Federated hubs.** Reasonable hybrid, but reintroduces a hub as a semi-SPOF and a
  federation protocol to maintain. The event-log-behind-a-port approach can *become*
  federated (via `NetworkedSubstrate`) without committing to it now.
- **Pure P2P direct messaging.** Maximally decoupled but sacrifices the single ordered
  history that makes multi-agent systems debuggable.

## Prior art

A survey of current harnesses (primary sources) **independently converges on the bet in
decision (1): decouple coordination from execution through an immutable, replayable
event/state substrate.** That is reassuring — it is the dominant pattern, not a
contrarian one. Concrete sources and what we take from each:

- **OpenHands** (formerly OpenDevin) — append-only **EventStream** as the *one*
  coordination bus; every event is a typed `Action` (intent) or `Observation` (result);
  all components talk via pub-sub over it and never call each other directly; one JSON
  file per event → deterministic replay/resume. This is almost exactly our `Substrate`,
  and validates events-as-the-only-contract. We also adopt its **security split**
  (analyzer *scores* risk; a separate gate *enforces*; the runtime independently
  *refuses* unconfirmed actions) — see ADR-0004.
- **Pi** (Mario Zechner's coding agent) — **file-based blackboard** for full
  observability; a typed event bus with **blocking interception** (`on(event) →
  {block, reason}`) — the governance hook our gate needs; **provider-agnostic,
  JSON-serializable context** as the unit of cross-agent handoff.
- **OpenClaw** (TS agent gateway, ex-Clawdbot/Moltbot) — **pluggable runtime backends
  with fail-closed selection** (ACP): a peer advertises which runtime it speaks and
  negotiation is explicit — direct support for ADR-0003's Worker-as-plugin-seam;
  **transport-only channel plugins** (a clean hexagonal seam); **shared-vs-per-agent
  state split** in one store.
- **LangGraph / MetaGPT / AutoGen / CrewAI** — CRDT-like **channels with reducers** for
  concurrent merge (LangGraph), **subscribe-by-interest** rather than addressing
  (MetaGPT `_watch`, AutoGen topics) which kills O(N²) peer wiring, and
  **handoff-as-tool-call** (OpenAI Swarm / LangGraph `Command`) so delegation rides the
  existing tool loop with no new control primitive.
- **Claude Agent SDK** — the `PreToolUse → deny/allow/ask → canUseTool → PostToolUse`
  permission eval order is the exact mechanism ADR-0003 §2 wires the lease gate into.

**Reality check from the survey:** *no* surveyed framework ships a literally
peer-to-peer transport — even AutoGen's "distributed" runtime is hub-and-spoke gRPC. The
coordination *abstractions* transfer cleanly, but the gossip/CRDT/libp2p transport for a
true `NetworkedSubstrate` (ADR-0002 §4) is **ours to build** and remains the project's
hardest, least-precedented piece. This sharpens, but does not change, decision (1).

Refinements this surfaces (captured as follow-ups, not changes to this decision):
**subscribe-by-interest** on the `Substrate` port; a possible separate **`Memory` port**
(namespaced, TTL'd, CRDT-mergeable, artifact-by-reference) distinct from the event log;
**handoff-as-tool-call** as the peer-delegation idiom.

## Follow-ups

- **ADR-0002** — `Substrate` port contract + claim/lease protocol (the consistency design). ✅ drafted
- **ADR-0003** — `Worker` port + Claude Agent SDK adapter (model, tools, lifecycle). ✅ drafted
- **ADR-0004** — `ToolHost` capability/permission model. ✅ drafted
- **ADR-0005** (anticipated) — the peer/agent loop use-case (claim → run Worker → publish).
- **ADR-0006** (anticipated) — `Substrate` **subscribe-by-interest** (topic/`cause_by`
  filtering) so peers wire by interest, not addressing.
- **ADR-0007** (anticipated) — a separate **`Memory` port** (namespaced, TTL'd,
  CRDT-mergeable, artifact-by-reference) vs. folding all state into the event log.
- **ADR-0008** (anticipated) — **handoff-as-tool-call** as the peer-delegation idiom.
- **ADR-0009** — `NetworkedSubstrate` (HLC-ordered replicated log; the federated case). ✅ drafted
