# ADR-0013: ContextReducer — reduced context for skills/LLMs

- **Status:** Superseded by 0016
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** context-reduction, skills, tools, llm
- **Depends on:** [ADR-0007](ADR-0007-memory-compaction.md), [ADR-0012](ADR-0012-skill-plugin-system.md)

## Context

ADR-0007 (compaction) bounded the durable log — context reduction **layer 1**. Layer 2 is
giving a *skill/LLM* a token-efficient view instead of raw history: hex's L1/L2/L3 context
levels, the OpenHands "context-as-projection" idea. A skill that reasons about "the state of
the network" should receive *one current value per target* (+ rollup), not thousands of raw
events.

A constraint from ADR-0003/0012: skills get `tools/lease/onProgress/signal`, **not** the
substrate. So the reduced view must reach a skill the same way any data does — through a tool.

## Decision

### 1. `reduceContext(events) → ReducedContext` — a pure reducer

A pure domain function folds the log into a compact view (reusing `compact()` from ADR-0007,
which already merges snapshot findings + tail):

```ts
interface TargetState { target: string; status: number; ok: boolean; tag: string; ms: number }
interface ReducedContext {
  targets: TargetState[];                 // one per target (current state)
  totals: { targets; healthy; unhealthy; unreachable; violations };
}
```

This is the reduction: unbounded history → O(targets) current state. It's pure and unit-tested.

### 2. A substrate-bound `network_state` tool exposes it (read effect)

`networkStateTool(weave)` is a `read`-effect `ToolDefinition` whose `execute` reads the weave
and returns `reduceContext(...)`. It's wired into the ToolRegistry at composition (where the
substrate exists), since a skill can't bind the substrate itself. Any skill granted it — and
the Claude agent — gets the reduced view by calling one tool, so the **LLM sees the snapshot,
not the raw log** (the token win).

### 3. A `summary` skill consumes it (deterministic, offline)

A built-in `summary` skill calls `network_state` and formats a health summary — proving the
"skill consumes reduced context" path with no LLM/key. The same tool lets the `claude` skill
do richer natural-language analysis over the *reduced* view.

### 4. CLI: `weave summary`, and auto-compaction in `up`

- `weave summary` prints the reduced view directly (human-facing).
- `weave up --compact-secs N` periodically compacts so a long-running peer self-bounds without
  manual `weave compact`. Safe: compaction only folds/prunes *settled* subjects; active
  (in-flight) subjects are retained.

## Consequences

**Positive**
- LLM/skill context is O(targets), not O(history) — the layer-2 token win, fully reusing the
  layer-1 snapshot.
- Reduction is a pure function (testable) surfaced via the existing tool/grant/effect model;
  `network_state` is read-only, so no lease-gate concerns.
- `weave up` can run indefinitely and stay bounded.

**Negative / risks**
- The reducer is interrogation-shaped (targets/findings) today; a general reducer (arbitrary
  task results, relevance ranking) is a follow-up. Kept narrow on purpose.
- A substrate-bound tool reads the whole log on each call; cheap after compaction, but a
  cached/incremental reducer is a later optimization.
- Auto-compaction cadence is a tradeoff (prune churn vs log size); exposed as a flag, off by
  default.

## Alternatives considered

- **Give skills the substrate directly.** Rejected — breaks the ADR-0003/0012 decoupling and
  lets any skill read/write the log unmediated. A read-effect tool keeps it within the grant
  model.
- **Precompute the reduced view into the snapshot only.** The snapshot already holds findings;
  the reducer formats them for consumption — keeping formatting out of the durable record.
- **LLM summarizes raw events.** The thing we're avoiding — expensive and unbounded.

## Follow-ups

- A general `ContextReducer` port (pluggable strategies; relevance/recency ranking) — the full
  hex L1/L2/L3 analogue for arbitrary task context, not just interrogation.
- Incremental/cached reduction; `network_state` filters (by target glob, only-unhealthy).
- A `claude`-backed `analyze` skill that narrates drift over the reduced view.
