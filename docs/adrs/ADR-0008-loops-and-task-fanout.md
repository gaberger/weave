# ADR-0008: First-class loops + task fan-out (handoff-as-tool-call)

- **Status:** Proposed
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** loop, scheduler, fan-out, handoff, skills, research-agent
- **Depends on:** [ADR-0005](ADR-0005-peer-loop-usecase.md), [ADR-0012](ADR-0012-skill-plugin-system.md), [ADR-0011](ADR-0011-network-interrogation-loop.md)

## Context

We want autonomous research agents — e.g. one that loops over arXiv finding new LLM papers,
then fetches each paper's page for details. That needs three things weave lacks as
first-class pieces: (1) a **reusable loop** (the `watch` scheduler was ad-hoc and
interrogation-specific), (2) the ability to **fetch content** (not just `http_probe`'s
status), and (3) **task fan-out** so a "discover" step can spawn a "detail" task per item —
the handoff-as-tool-call idiom this ADR slot was reserved for.

## Decision

### 1. `LoopRunner` — a first-class loop construct

`usecases/loop.ts`: `LoopRunner(timer, tick, intervalMs, once)` runs `tick` immediately then
every `intervalMs` (or just once), `stop()`-able. It takes the `Timer` port, so it's
deterministic under test (ManualTimer) and real under `SystemTimer`. `weave loop --skill
<name> --interval <dur> [goal…]` re-declares a task routed to **any** skill each tick — the
general construct; `watch` is just the interrogation-flavoured special case.

### 2. `http_fetch` tool — content, not just status

A `read`-effect tool returning the response **body** (size-capped) + status. `http_probe`
answers "is it up?"; `http_fetch` answers "what does it say?" — needed to read an arXiv feed
or a paper page.

### 3. `spawn_task` tool — fan-out / handoff-as-tool-call

A substrate-bound tool (`reversible` effect — it only declares work, no external effect) that
appends a `task.declared` for a follow-up task `{subject, skill, goal, inputs}`. A skill can
now hand off: the arXiv discover skill spawns one `arxiv-paper` detail task per paper. Each
detail task uses **`subject = arxiv:<id>`**, so weave's `isSettled` dedup means a paper is
processed **once ever** — "new papers only" falls out of the existing claim-once model, no
bespoke seen-set.

### 4. The arXiv research agent (two skills)

- **`arxiv`** (discover): `http_fetch` the arXiv API feed for a query, `parseArxivAtom` →
  papers, `spawn_task` an `arxiv-paper` task per paper (subject `arxiv:<id>`). "I found titles
  in the digest."
- **`arxiv-paper`** (detail): `http_fetch` the paper's abs page, record its details as a
  finding artifact. "Let me get the actual paper page." Routed only explicitly (by the spawn).

On a loop, this continuously discovers and details new LLM papers; details accumulate in the
durable log (and compact/reduce like any findings). The arXiv feed URL is configurable
(`inputs.feedUrl`) so it's testable/demoable against a local fixture without external network.

## Consequences

**Positive**
- Loops, content fetch, and fan-out are reusable primitives — not arXiv-specific. Any
  multi-stage agent (discover → detail → analyze) is now expressible as skills + spawn_task.
- "New items only" for free via `subject`-based `isSettled` dedup.
- Realizes handoff-as-tool-call within the grant/effect model (spawn is `reversible`, gated
  like any tool).

**Negative / risks**
- `spawn_task` lets a skill enqueue work → loops could fan out unboundedly; bounded here by
  feed `max_results` and dedup, but a per-loop spawn budget is a follow-up.
- `http_fetch` is general network egress (SSRF surface), like `http_probe`; same mitigation
  (granted, read-only, future per-target allowlist).
- Regex Atom parsing is pragmatic, not a full XML parser; fine for arXiv's regular feed,
  revisit if feeds vary.

## Alternatives considered

- **Discover + detail in one skill run.** Simpler but loses per-paper dedup and the
  durable, reclaimable, swarm-distributable detail tasks; fan-out is the weave-native shape.
- **A bespoke cron/persisted-schedule subsystem.** Heavier; the foreground `LoopRunner` +
  re-declare is first-class enough now. Persisted distributed schedules are a later ADR.
- **Reuse `http_probe` for fetching.** It intentionally returns no body; conflating probe and
  fetch muddies the effect/finding model.

## Follow-ups

- Per-loop spawn budget / rate-limit; dedup-aware discover (skip already-settled before spawn).
- A `claude` `arxiv-analyze` skill ranking/summarizing the detailed papers (LLM over the
  reduced research findings — composes with ADR-0013).
- Persisted, distributed loop definitions (survive restart, claimed by the swarm).
