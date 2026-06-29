# ADR-0024: Substrate-native fan-out (deny detached backend orchestration; join over `spawn_task`)

- **Status:** Accepted
- **Implementation:** Partial — §1 (deny `Workflow`/`Task` in both worker backends) shipped; §2 (the fan-out/join primitive) proposed
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

### 1. Deny detached-work tools to weave workers _(shipped)_

`Workflow` and `Task` are denied in **both** worker backends:

- **SDK worker** (`claude-agent-sdk-worker.ts`): added to `SDK_BUILTIN_TOOLS`, which is passed
  as `disallowedTools`. (`Task` was already present; `Workflow` is new.)
- **CLI worker** (`claude-cli-worker.ts`): `--allowedTools` is only an *auto-approve allowlist*
  — in print mode `Workflow`/`Task` can still run — so we pass an explicit
  `--disallowedTools Workflow Task` (the `DENIED_TOOLS` constant), ordered before the variadic
  `--allowedTools` so the flag name terminates the deny list.

With these gone, a "research" ask degrades to **inline** `WebSearch`/`WebFetch` in a single
synchronous turn: it answers, feeds the watchdog normally, and never detaches. `Skill` itself
is left enabled — only the detached-orchestration tools are removed.

### 2. Substrate-native fan-out + join _(proposed)_

`spawn_task` gives fan-out + lineage but is **handoff** (fire-and-forget, ADR-0008 §3): the
parent declares children and completes immediately. Research needs a **join** — fan out N
sub-tasks, await their settled results, then synthesize one answer. Proposed shape:

- A `usecases/` join primitive: declare children via `spawn_task` (stable `subject`s for
  `isSettled` dedup), then **subscribe to the substrate** for those children's settled events
  (the data is already there — children settle with results + `causedBy=parent`), resolving
  when all are in or a deadline elapses. Partial results on timeout, never an indefinite hang.
- A weave-native research skill built on it: decompose → `spawn_task` per search angle →
  join → synthesize + cite. Each child is a normal weave task (claimable, observable, on the
  watchdog), so the failure modes that killed §1's `Workflow` path cannot recur.
- The parent's progress is the join's progress (children settling), keeping the keepalive fed
  for the whole fan-out.

This generalizes beyond research to any fan-out/gather skill.

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
