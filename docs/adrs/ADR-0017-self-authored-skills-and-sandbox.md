# ADR-0017: Self-authored skills + the execution sandbox (the learning loop)

- **Status:** Accepted
- **Implementation:** Complete — write-skill-tool.ts, reloadable-skill-set.ts, skill.ts; wired into the `up` peer's reload poller (cli.ts) so a running peer hot-reloads `.weave/skills/` without a restart _(reload wiring added 2026-06-27; self-evaluated 2026-06-26 via weave)_
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** self-improvement, skills, sandbox, capability, learning, foundational
- **Depends on:** [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0008](ADR-0008-loops-and-task-fanout.md), [ADR-0012](ADR-0012-skill-plugin-system.md), [ADR-0016](ADR-0016-domain-agnostic-harness.md)

## Context

weave already has every primitive for a self-learning loop *except the ability to extend
itself*: a continuous loop (`LoopRunner`, ADR-0008), a durable+condensable memory of outcomes
(the event log + compaction, ADR-0007), drop-in skills (ADR-0012/0016), and fan-out
(`spawn_task`, ADR-0008). The missing capability is letting an agent **author a new skill or
tool at runtime** and have a running peer pick it up — "creating necessary skills and
generating tools to extend its own capabilities."

That capability is also the most dangerous thing weave could do: a code skill is loaded with
`import()` and runs as a module, so its `run()` is arbitrary code that **never passes through
the grant/effect gate** (ADR-0004) that protects every other action. An LLM, on a timer,
writing and executing code unsupervised is the threat model. The owner's explicit choice was
"full autonomous code-gen" — so the decision is not *whether* to allow it but *how to bound the
blast radius* while keeping it a composition choice (hex: rewiring must stay easy).

## Decision

### 1. `write_skill` — authoring as a gated tool

A `ToolDefinition` (`write-skill-tool.ts`) that writes `{ filename, content }` into the skills
dir. Its effect is **`irreversible`** — the written file later runs as code or steers an LLM.
That single classification *is* the safety switch: under ADR-0004 a peer reaches `write_skill`
only if its grant allowlists it **and** `maxEffect: "irreversible"`. A peer that must not
self-extend is simply not granted it (or is capped at `read`/`reversible`). Filenames are
validated to a bare, allowlisted-extension name (no path traversal); the write is pinned inside
the dir. Self-modification thus stays *auditable* (a tool call on the weave) and *gated* (one
capability flag), not a hidden side effect.

### 2. Hot-reload behind a `SkillSet` port

The router reads a **`SkillSet`** (ports/skill.ts) live on every dispatch rather than holding a
frozen array. `ReloadableSkillSet` re-scans the skills dir on `refresh()` and swaps in the
freshly-loaded code-skill slice (keeping the LLM-bound tail fixed), so a running peer picks up a
dropped/edited/self-authored skill **without a restart**. The `up` peer drives `refresh()` on a
`--reload-secs` poller; a cheap dir signature (mtime+size) gates the actual re-import so an
unchanged dir costs nothing. `loadSkills(dir, {version})` takes a cache-bust token because
`import()` caches by URL — a *new* filename reloads for free, but a *rewritten* file needs the
version bump. The router neither knows nor cares that the set changed: mutability lives behind the
port; composition injects both the impl and its disk-scanning seam (so the adapter imports only
ports — no adapter→adapter edge, ADR-0015).

### 3. The reflection skill is itself a (declarative) skill

The "brain" of the loop ships as an example declarative plugin
(`examples/plugins/reflect.md`) — prompt + a grant of `write_skill, spawn_task, notify`, no
harness code. It reads a digest of recent outcomes, identifies a recurring *unmet* need,
authors **one** skill to fill it (declarative by default — a subset of its own grant), and
`spawn_task`s a validation task so the next iteration proves the new skill. Put it on a
`LoopRunner` and weave discovers gaps, writes skills, and exercises them continuously. Learning
is a plugin, consistent with ADR-0016.

### 4. The sandbox is a `Worker`-port adapter

Self-authored **code** skills run in `SandboxedSkillRunner` — a `worker_threads` thread that
implements the existing `Worker` port. Choosing sandboxed vs. in-process execution is therefore
a composition wiring (`newWorker`), not a use-case change. The thread reaches tools **only** by
RPC to the parent, which invokes them on the caller's grant-filtered `ToolHost` — so the
ADR-0004 ceiling holds across the thread boundary. A timeout terminates a runaway skill; a V8
old-space cap bounds memory; a thread crash fails the one task, not the peer.

## Consequences

**Positive**
- weave can extend its own capabilities at runtime; "create a skill" is a gated, audited tool
  call, and a live peer adopts it via a port swap — no restart, no core change.
- Self-modification is bounded by exactly one capability flag (`maxEffect: irreversible` +
  allowlist), reusing ADR-0004 rather than inventing a parallel trust model.
- The sandbox/learning brain are both swap-in: in-process ↔ threaded ↔ (future) child-process
  is a wiring choice; the reflection policy is a prompt, not a fork.

**Negative / risks**
- **worker_threads is NOT a security boundary.** A thread shares process privileges and can
  `require('fs')`/open sockets directly; the sandbox confines *tool access* (via RPC), gives
  fault isolation, and enforces time/memory — it does **not** stop authored code from touching
  the filesystem or network on its own. True OS-level confinement (child process +
  seccomp/container, or a restricted realm) is the follow-up — and, by §4, a drop-in adapter
  behind the same `Worker` port.
- **Autonomous code-gen remains genuinely risky.** `write_skill` + reload + a loop is
  sufficient for an unsupervised agent to write and run code. Mitigations available today:
  cap the loop peer's grant (declarative-only by withholding code execution / running every
  code skill through the sandbox), keep the reflection prompt conservative (one skill/run), and
  gate adoption behind `notify` + human approval if desired. The owner has opted into the
  ungated decision layer; the execution layer stays bounded.
- **No persisted/distributed reflection yet** — the loop is foreground, like ADR-0008's.

## Alternatives considered

- **Declarative-only self-extension.** Safest (new skills only recombine already-granted
  tools), but can't author genuinely new capabilities. Rejected as the *default ceiling*, kept
  as the recommended grant for untrusted loops.
- **No sandbox; run authored code in-process.** Simpler, but an authored skill could crash or
  hang the peer and has zero isolation. Rejected — the `Worker`-port adapter costs little and
  buys fault/resource isolation and the tool boundary now, with OS confinement as a later swap.
- **A bespoke plugin compiler / signing scheme.** Heavier than warranted at this stage; the
  grant flag + sandbox is enough to make the capability real and bounded. Signed-skill adoption
  is a future ADR.

## Follow-ups

- Child-process / container sandbox adapter (real capability confinement) behind the `Worker`
  port; per-skill resource policy.
- A `read_memory`/snapshot tool so `reflect` reasons over the compacted log (ADR-0007) directly
  instead of a goal-supplied digest.
- Per-loop spawn/author budget; human-approval gate on adoption; persisted/distributed loops.
- `weave reflect` / `weave loop --skill reflect` CLI wiring + a curated grant preset for the
  learning peer.
