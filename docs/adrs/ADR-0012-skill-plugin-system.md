# ADR-0012: Skills — the plugin/extension system

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** extensibility, plugins, routing, ports, foundational
- **Depends on:** [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md), [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0005](ADR-0005-peer-loop-usecase.md)

## Context

Today a peer's behaviour is hardcoded: the CLI wires one Worker (Fake / Claude / Probe)
and a fixed tool set. To teach weave a new capability you edit core. We need the
**plugin/skill model** the prior art converged on (Pi's extension API, OpenClaw's
"everything is a plugin", hex skills): drop-in units that declare *what they handle* and
*how*, discovered and loaded at runtime, with a router that dispatches each task to the
right one. That is "how weave knows what to do."

## Decision

### 1. A `Skill` is a named, self-describing, matchable capability

```ts
// src/ports/skill.ts
interface Skill {
  readonly name: string;
  readonly description: string;
  readonly tools?: readonly ToolDefinition[]; // contributed to the shared ToolHost
  match(task: TaskAssignment): boolean;        // "can I handle this?"
  run(task: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult>;
}
```

A skill is essentially a `Worker` (§ADR-0003) plus a `match` predicate and the tools it
needs. `ToolDefinition` (the registerable tool: name/description/effect/schema/execute) is
promoted from the in-memory adapter to `ports/tool-host.ts` so skills depend only on ports.

### 2. A `SkillRouterWorker` dispatches tasks to skills

The peer's worker becomes a **router** (still just a `Worker`): given a task, pick a skill
and run it. Selection order:

1. **Explicit:** `task.spec.skill === skill.name` (set via `weave task --skill <name>`).
2. **Predicate:** the first skill whose `match(task)` is true.
3. **None:** `failed` with `no_skill` — weave says, honestly, it doesn't know how.

Skills are tried in registration order, so specific skills precede catch-all fallbacks.

### 3. Skills are loaded — built-in **and** external plugins

- **Built-in:** `probe` (the interrogation skill, ADR-0011), a `claude` general skill
  (Claude agent; fallback when a key is present), and an offline `echo` fallback.
- **External:** a loader imports skill modules from a directory (default `.weave/skills/`,
  also `~/.weave/skills/`). A plugin module default-exports a `Skill` or `Skill[]`. Loading
  is dynamic `import()`, so `.js`/`.mjs` work in every runtime and `.ts` works under
  node+tsx / Bun. This is the Pi/OpenClaw "drop a file in a folder" model.

The composition: collect skills → register all their tools in one `ToolRegistry` → build
the router → hand it to `createPeer` as `newWorker`. New capability = new skill file; no
core change.

### 4. CLI surface

- `weave up` builds the router from built-in + loaded skills (so a running peer can handle
  any loaded skill, routed per task).
- `weave skills` lists loaded skills (name, description, tools) — discoverability.
- `weave task --skill <name> …` routes explicitly.

## Consequences

**Positive**
- weave becomes extensible without forking: skills are the unit of "what it can do".
- Reuses everything — a skill *is* a Worker behind the port; the router is a Worker; tools
  flow through the existing ToolHost + effect/lease gates (a skill's `irreversible` tools
  are still gated; a skill can't escape ADR-0004).
- Built-ins (probe/claude/echo) are just the first skills, not special cases.

**Negative / risks**
- **Trust:** external skills run arbitrary code with the peer's granted tools. MVP loads
  from a local dir the operator controls; signing/sandboxing/per-skill grants are
  follow-ups. (A skill's tool effects are still gated by the lease, but its own `run` is
  not sandboxed.)
- **Match ambiguity:** predicate routing can mis-route; explicit `--skill` and ordered
  registration are the escape hatches. A future richer matcher (intent/score) can layer on.
- **Compiled-binary loading:** external `.ts` skills rely on the runtime transpiling; ship
  plugins as `.mjs`/`.js` for the Bun binary to be safe.

## Alternatives considered

- **Imperative `register(api)` plugins** (Pi-style ExtensionAPI with a blocking event bus).
  Powerful, but heavier; the declarative `Skill` export is simpler and sufficient now. The
  event-bus/veto hooks can be added later without breaking the `Skill` contract.
- **One big Claude worker that decides everything via tools.** Rejected as the model —
  opaque, costly, and no offline/deterministic path; skills make capability explicit,
  testable, and mixable (deterministic + LLM).
- **Config-file routing (no code).** Too limiting — skills need real logic; a manifest
  alone can't express `run`.

## Follow-ups

- Per-skill grants (a skill declares the capability ceiling it needs).
- Skill signing / sandboxed execution; remote skill registries (OpenClaw-style).
- Imperative extension API + blocking event hooks (Pi-style) for cross-cutting policy.
- `weave task` intent → skill matching beyond simple predicates.
