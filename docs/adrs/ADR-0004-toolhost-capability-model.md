# ADR-0004: ToolHost capability & effect model

- **Status:** Accepted
- **Implementation:** Partial — capability/effect model + grant gate in place; §5 audit (`tool.invoked`) emission deferred to ADR-0005, spec doc absent _(self-evaluated 2026-06-26 via weave)_
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** tools, permissions, security, ports
- **Depends on:** [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md), [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md)

## Context

ADR-0003 decided that **`weave` owns tool execution**, not the backend, and that the
**lease guard gates `irreversible` tools** before they run — the mechanism that makes
ADR-0002's "abort before an irreversible effect" guarantee hold across every worker
backend (Claude SDK, Copilot, …). Two things were forward-referenced to here and are
load-bearing:

1. The **effect taxonomy** `read | reversible | irreversible`, and the rule that an
   unknown/untagged tool is treated as **`irreversible`** (the safe default the gate
   depends on).
2. The **capability ceiling** per worker — how a backend that can't intercept tool
   calls is confined to `read`/`reversible` tools (ADR-0003 §6).

This ADR defines the `ToolHost` port that provides both, plus the sandboxing inherited
from the hex security lessons (path confinement, least privilege).

## Decision

### 1. Effect taxonomy — three classes, irreversible is the safe default

```ts
// src/domain/effect.ts
export type Effect = "read" | "reversible" | "irreversible";

// total order for ceiling comparisons: read < reversible < irreversible
export const EFFECT_RANK: Record<Effect, number> = { read: 0, reversible: 1, irreversible: 2 };
```

- **`read`** — observes only; no state change (read file, list dir, query).
- **`reversible`** — changes state the worker can undo within the workspace (write/edit a
  file in the sandbox, create a scratch branch).
- **`irreversible`** — effects that escape the workspace or cannot be undone (`git push`,
  network POST, package publish, deploy, deleting outside the sandbox).

**A tool with no declared effect is `irreversible`.** Safety must not depend on every
tool author remembering to tag correctly; the gate fails *closed*. Down-classifying a
tool is a deliberate, reviewable act.

### 2. The `ToolHost` port

```ts
// src/ports/tool-host.ts
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly effect: Effect;          // normalized; missing -> "irreversible"
  readonly inputSchema: JsonSchema;
}

export interface ToolHost {
  /** Tools this worker may use — the registry already filtered by its Grant (§3). */
  available(): readonly ToolDescriptor[];

  /** Execute a permitted tool. Throws NotPermittedError if name is outside the grant.
   *  Applies sandboxing (§4). Does NOT itself check the lease — the worker runtime
   *  does that (ADR-0003 §2) using `available()` effect classes, keeping the gate in
   *  one place. */
  invoke(call: ToolCall): Promise<ToolResult>;
}
```

`ToolHost` is **per-worker**: it is constructed for a single `run()` from the global
tool registry plus that worker's `Grant`. It deliberately does **not** import the
substrate (adapters don't import adapters); the worker runtime observes invocations and
is responsible for any audit events on the weave (§5).

### 3. Grants — least privilege + the capability ceiling

```ts
// src/domain/grant.ts
export interface Grant {
  readonly tools: readonly string[] | "*";   // allowlisted names (or all)
  readonly maxEffect: Effect;                 // ceiling: tools ranked above are excluded
}
```

`available()` = `registry ∩ grant.tools`, then **drop any tool whose `effect` outranks
`grant.maxEffect`**. This single rule delivers ADR-0003 §6's requirement:

- A full Claude worker: `{ tools: [...], maxEffect: "irreversible" }`.
- A backend that **cannot** intercept tool calls (e.g. a `CopilotWorker` lacking a
  `canUseTool` hook): `{ tools: [...], maxEffect: "reversible" }` — irreversible tools
  are simply never presented to it, so the ADR-0002 guarantee holds even with no gate
  hook in that backend.

Grants are **default-deny**: a worker gets exactly what its peer config grants, nothing
more (least privilege, per the hex security lessons).

### 4. Sandboxing (carried over from hex security lessons)

`ToolHost.invoke` enforces, before dispatch:

- **Path confinement** for filesystem tools — every path resolved and asserted inside
  the worker's workspace root (the `safePath()` lesson). Escapes (`../`, symlinks,
  absolute paths outside root) are rejected as `NotPermittedError`.
- **Shell/exec** tools are `irreversible` by default and additionally subject to an
  allow/deny command policy in the grant.
- **Secrets** are never passed through tool args; injected at the adapter boundary only
  (hex: keys loaded only at the composition root).

### 5. Auditability via the weave

Because the worker runtime (not `ToolHost`) touches the substrate, **the runtime
publishes a `tool.invoked` event for every `irreversible` invocation** (name, args
digest, result status) onto the weave, so irreversible actions are part of the shared,
replayable audit trail (ADR-0002). `read`/`reversible` calls stay local to the run to
avoid log spam; this threshold is configurable per peer.

## Consequences

**Positive**
- The gate ADR-0003 relies on has a well-defined, fail-closed input: unknown ⇒
  irreversible ⇒ gated.
- One mechanism (`maxEffect` ceiling) covers both least-privilege grants and the
  non-interceptable-backend cap — no special-casing per backend.
- Irreversible actions are auditable on the weave for free; sandboxing reuses hardened
  hex patterns rather than reinventing them.

**Negative / risks**
- **Effect tagging is a trust boundary.** Mis-tagging an irreversible tool as
  `reversible` bypasses the gate. Mitigation: fail-closed default + tagging is reviewed;
  consider a registry lint that flags down-classifications.
- **Coarse taxonomy.** Three classes won't capture every nuance (e.g. "reversible but
  expensive"). Accepted for now; a richer policy can layer on without changing the port.
- **Audit granularity.** Digesting args (not logging them raw) is required to avoid
  leaking secrets into the weave — an implementation constraint for §5.

## Alternatives considered

- **Boolean `readOnly` flag.** Rejected: can't express "writes inside sandbox are fine
  but escaping it is not" — the reversible/irreversible split is what the lease gate
  needs.
- **Per-call interactive approval** (hex/Claude Code permission prompts). Rejected as
  the default: stalls autonomous peers (the hex "no per-item prompts" lesson). Grants +
  effect ceiling are the autonomous equivalent; interactive approval can be an optional
  policy adapter later.
- **Trust the backend's own permission system.** Rejected: ADR-0003 §6 — backends differ
  and some can't gate at all; `weave` owns the authority to act.

## Follow-ups

- **ADR-0005** (anticipated) — the peer/agent loop use-case, which consumes `Worker`,
  `Substrate`, and `ToolHost` together and emits the `tool.invoked` audit events.
- **Spec:** `docs/specs/toolhost-grants.md` — property tests: untagged tool is
  irreversible; tool above `maxEffect` never appears in `available()`; path escape is
  rejected.
