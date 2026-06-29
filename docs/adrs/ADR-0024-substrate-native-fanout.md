# ADR-0024: Substrate-native fan-out (deny detached backend orchestration; join over `spawn_task`)

- **Status:** Accepted
- **Implementation:** Complete — §1 (deny `Workflow`/`Task`/`Skill` in both worker backends) + §2 (the `fanout` tool join primitive + built-in `research` skill) shipped
- **Date:** 2026-06-29
- **Deciders:** project owner
- **Tags:** fan-out, join, worker, watchdog, research-agent, orchestration
- **Depends on:** [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md), [ADR-0005](ADR-0005-peer-loop-usecase.md), [ADR-0008](ADR-0008-loops-and-task-fanout.md)

## Context

A `weave chat` "do some research on X" turn hung with `the task went quiet — no progress
for a while`. Root cause: the `claude` worker drives a real Claude Code instance (SDK or
`claude -p`), which exposes Claude Code's own `Skill` and `Workflow` tools. The word
"research" tripped the bundled `deep-research` skill, which calls the **`Workflow`** tool to
fan out a 5-phase background pipeline.

`Workflow` (and `Task`, the subagent spawner) are **detached**: they return immediately and
signal completion *out-of-band* — a `<task-notification>` delivered to the **interactive main
loop**. A weave worker is a **headless, synchronous** invocation (`-p` / a single SDK
`query`): it is never re-invoked on that notification, so it can never receive the result.
Worse, while the detached work runs the worker emits no `onProgress`, so:

- the in-flight keepalive (ADR-0005, added in `fix(worker): in-flight keepalive`) stays silent
  — it ticks only while a tool's `tool_result` is outstanding, and `Workflow` returns its
  `tool_result` in milliseconds (`inflight` drops straight back to 0); and
- the peer stall watchdog (ADR-0005 §4, default 180s) then kills the task.

So the keepalive fix addressed long *synchronous* tools but is structurally blind to detached
background work. The real defect is a **substrate mismatch**: orchestrating fan-out inside a
backend weave can neither observe nor join. weave already *is* a multi-agent task orchestrator
— `spawn_task` (ADR-0008 §3) declares child tasks on the substrate, peers claim them, progress
flows through `onProgress`, results settle in the log with `parent`/`causedBy` lineage. That is
where fan-out belongs.

## Decision

### 1. Deny interactive-harness tools to weave workers _(shipped)_

`Workflow`, `Task`, and `Skill` are denied in **both** worker backends:

- **SDK worker** (`claude-agent-sdk-worker.ts`): added to `SDK_BUILTIN_TOOLS`, which is passed
  as `disallowedTools`. (`Task` was already present; `Workflow` and `Skill` are new.)
- **CLI worker** (`claude-cli-worker.ts`): `--allowedTools` is only an *auto-approve allowlist*
  — in print mode these can still run — so we pass an explicit
  `--disallowedTools Workflow Task Skill` (the `DENIED_TOOLS` constant), ordered before the
  variadic `--allowedTools` so the flag name terminates the deny list.

`Workflow`/`Task` are the detached-orchestration tools (see Context). `Skill` is denied because
it loads Claude Code's *bundled* skills — e.g. `deep-research`, which narrates "I launched the
workflow, I'll present the report once it completes" and then fans out via `Workflow`. With
only `Workflow` denied, the observed result was a **false promise**: the task completed (no
more hang) but the answer claimed a report was still coming that would never arrive (confirmed
in the event log: `using Skill…` → workflow narration → `task.completed`, with no `Workflow`
call). Denying `Skill` removes the trigger. weave routes its OWN skills a layer up (the peer's
`skill: claude` router), so this only removes Claude Code's bundle, not weave capabilities.

With these gone, a "research" ask degrades to **inline** `WebSearch`/`WebFetch` in a single
synchronous turn: it answers, feeds the watchdog normally, and never detaches or over-promises.

### 2. The `fanout` tool — substrate-native fan-out + join _(shipped)_

`spawn_task` gives fan-out + lineage but is **handoff** (fire-and-forget, ADR-0008 §3): the
parent declares children and completes immediately. Research needs a **join** — fan out N
sub-tasks, await their settled results, then synthesize one answer. The `fanout` tool
(`adapters/secondary/fanout-tool.ts`) is that join:

- **Declare** one child weave task per goal (stable `subject = <prefix>:<i>` for `isSettled`
  dedup; `parent`/`causedBy` lineage from the calling task), then **subscribe** to the
  substrate from `head()+1` and resolve when every child emits a terminal `task.completed` /
  `task.failed` (whose `payload.summary`/`error` is the child's result). `reversible` effect —
  it only declares work, like `spawn_task`.
- **Bounded:** a one-shot deadline (built from the `Timer` port; default 4 min, `timeoutMs`
  arg) returns partial results with the unfinished subjects under `pending` — never an
  indefinite hang.
- **Liveness:** the calling worker holds an outstanding `fanout` tool_use for the whole wait,
  so the in-flight keepalive keeps the stall watchdog satisfied. Children run on *other*
  concurrency slots, so a useful fan-out needs peer concurrency ≥ 2 (the `weave up` default)
  or a `weave pool`; with a single slot, children can't be claimed while the parent blocks and
  the call returns `pending` at the deadline.

Built on it: a **built-in `research` skill** (`builtin-skills.ts`) that auto-routes
research-shaped goals — decompose into 3–6 angles → `fanout` (children routed to the `claude`
agent) → synthesize + attribute. Its prompt explicitly forbids the "report coming later"
phrasing that §1's denied `deep-research` produced. Each child is a normal weave task
(claimable, observable in `weave status`, on the watchdog), so §1's `Workflow` failure modes
cannot recur. The primitive generalizes beyond research to any fan-out/gather skill.

## Consequences

- **Good:** chat research turns no longer hang; the failure is impossible by construction once
  detached tools are denied. Fan-out, when reintroduced, is observable (`weave status`),
  resumable, lineage-tracked, and watchdog-friendly — all substrate-native.
- **Good:** no special-casing of `deep-research` by name; the denial is a general capability
  bound on what a headless worker may do.
- **Cost:** until §2 lands, research is single-turn inline only (no parallel multi-source
  fan-out from within a chat turn). Acceptable — a correct synchronous answer beats a hung one.
- **Cost:** §2 adds a substrate subscription/await path; must bound it (deadline + partial
  results) so a stuck child can't wedge the parent — the very failure mode this ADR closes.

## Alternatives considered

- **Bridge the `<task-notification>` into the worker.** Keep a worker alive across the
  detached run and feed it the completion. Rejected: fights the headless `-p`/SDK execution
  model (no re-invocation seam), and still leaves fan-out invisible to weave.
- **Just raise `stallMs` / keep ticking during `Workflow`.** Treats the symptom: even if the
  watchdog spared it, the worker still can't receive the result. The hang is structural.
- **Hide the `deep-research` skill from workers.** Narrower, but name-specific and leaves the
  `Workflow` tool reachable by any other skill. Denying the tool is the general fix.

## Follow-ups

- Implement §2 (fan-out/join primitive + weave-native research skill).
- Audit other bundled Claude Code skills for `Workflow`/`Task`/subagent assumptions that
  silently no-op now that those tools are denied.
