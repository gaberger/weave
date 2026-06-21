# ADR-0022: Per-task model tiering

- **Status:** Proposed
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** models, routing, cost, latency, worker, tasks
- **Depends on:** [ADR-0002](ADR-0002-substrate-port-and-claim-protocol.md), [ADR-0003](ADR-0003-worker-port-and-claude-sdk-adapter.md), [ADR-0012](ADR-0012-skill-plugin-system.md), [ADR-0016](ADR-0016-domain-agnostic-harness.md)

## Context

Every peer picks **one** LLM at startup (`pickLlm`, default `claude-sonnet-4-6`) and builds a single
Worker (ADR-0003). `TaskSpec` is `{goal, skill, inputs}` with **no model field**, so every task a
peer claims runs on that one model. A one-word chat turn and a multi-hour SR/MPLS research task are
answered by the same Sonnet — overpaying and over-waiting on the easy work, and capped at Sonnet's
ceiling on the hard work.

`SkillRouterWorker` already routes a goal → the right *skill* (ADR-0012). The model is the other axis
of the same routing problem: a goal should also reach the right *model*. The 3-tier pattern
(cheap → mid → frontier) is well-established; this ADR adapts it to weave's event-sourced, shared-lease
substrate without breaking the domain-agnostic harness boundary (ADR-0016).

Current Claude tiers and list prices (input · output per 1M tokens), for grounding the map:

| Tier | Model | ID | $/1M in · out | Intended for |
|------|-------|----|---------------|--------------|
| 0 | none (heuristic) | — | $0 | trivial/mechanical, canned replies |
| 1 | Haiku 4.5 | `claude-haiku-4-5` | 1 · 5 | chat turns, simple lookups, classification |
| 2 | Sonnet 4.6 | `claude-sonnet-4-6` | 3 · 15 | default work (today's behaviour) |
| 3 | Opus 4.8 | `claude-opus-4-8` | 5 · 25 | architecture, security, deep reasoning |
| 3+ | Fable 5 | `claude-fable-5` | 10 · 50 | premium long-horizon (opt-in only) |

## Decision

Carry the model **per task**, choose it at **declare time** by policy, and have the Worker honour it.

1. **`TaskSpec.model?` is the mechanism (per-task, not per-peer).** Add an optional concrete model id
   to `TaskSpec` (ADR-0002). It is the *only* harness-level change to the data model: when present, the
   Worker uses it for that task; when absent, the Worker falls back to its startup default — so the
   change is **backward-compatible** and the default behaviour (everything on Sonnet) is unchanged until
   a model is set. Per-task beats per-peer because any peer can claim any task under the shared-lease
   protocol; a "haiku peer / opus peer" split would force claim-filtering by tier and fight that model.

2. **The Worker honours a per-call model override.** `ClaudeCliWorker` passes `task.spec.model` as
   `--model` (falling back to its constructed default); the Claude-SDK worker overrides the model on the
   request the same way. This stays behind the Worker port (ADR-0003) — the domain never names a model.

3. **Tier selection is a declare-time policy, not harness code (ADR-0016).** The harness ships the
   *mechanism* (a model field the Worker honours); *which* tier a goal gets is a policy that lives where
   the task is declared:
   - **Phase 1 — heuristic classifier.** A pure function over the goal: short/conversational → tier 1;
     keywords like `architecture`, `design`, `audit`, `security`, `migrate`, `prove` → tier 3; else
     tier 2. Zero-cost, offline, deterministic — the weave-native analogue of the "agent-booster" tier 0.
   - **Phase 2 (optional) — Haiku classifier.** A cheap tier-1 call that returns a tier, for goals the
     heuristic can't confidently bucket. Itself a skill, so it's swappable and opt-in.

4. **A configurable tier → model map in composition.** The ladder above is a default table in the
   composition layer (env/flag-overridable, e.g. `--tier1-model`), not hardcoded in the domain — the
   harness stays domain-agnostic and the map can track new model ids without touching `src/domain`.

5. **`weave chat` declares conversational turns at tier 1 (Haiku).** This is the immediate payoff: chat
   becomes snappy and cheap instead of running every "hi" through Sonnet. `--skill`/`--route` and an
   explicit `--model` still override.

6. **Tier is observable.** The chosen model rides on the existing `task.progress` / `tool.invoked`
   events, so the log shows which tier ran each task — making cost and routing auditable from
   `weave log` with no new event kind.

## Consequences

**Positive**
- Cheap/latency-sensitive work (chat, lookups, classification) drops to Haiku — directly fixing the
  chat-latency complaint that motivated this ADR — while hard work can escalate to Opus, all on one
  shared substrate.
- Backward-compatible: no `model` on a task → today's behaviour exactly. Adoption is incremental
  (chat first, then loops, then declares).
- The model axis reuses the skill-routing shape (ADR-0012): goal → policy → {skill, model}. Selection
  policy stays a skill (ADR-0016); the harness only carries and honours the field.
- Per-task granularity means a single peer/pool serves all tiers — no fleet partitioning.

**Negative / risks**
- A wrong tier under-serves (Haiku on a task that needed Opus) or overspends. Mitigation: conservative
  heuristic defaults (unknown → tier 2 Sonnet, the current model), and an explicit override always wins.
- Switching models mid-conversation invalidates prompt cache (per Anthropic guidance); within a single
  task the model is fixed, so this only matters across the multi-turn chat context-carry — acceptable,
  and Haiku's price makes the cold-cache hit cheap.
- A second classifier call (Phase 2) adds latency/cost to declare; keep it opt-in and only for the
  goals the heuristic abstains on.
- Capability ceiling (ADR-0004) is orthogonal: a cheap tier must not implicitly gain trust for
  irreversible effects. Tier governs *which model*, never the effect grant.

## Alternatives considered

- **Per-peer tiering (haiku peer + opus peer on the shared db).** Natural-looking, but any peer can
  claim any task under ADR-0002 leases, so it requires a `tier` field tasks are claim-filtered on and
  peers that refuse off-tier work — more moving parts than a per-task model the one Worker reads.
- **Keep one model, tune `effort` instead.** `output_config.effort` modulates depth within a model but
  can't make Sonnet as cheap/fast as Haiku for trivial turns nor as capable as Opus for hard ones;
  complementary, not a substitute.
- **Hardcode the tier map in the domain.** Violates ADR-0016 and couples `src/domain` to specific model
  ids; the map belongs in composition.
- **Always Opus (the frontier-by-default stance).** Maximises quality but is the opposite of the
  cost/latency goal; the tier ladder lets the easy majority run cheap.

## Follow-ups

- Define `TaskSpec.model?` + thread it through `declareTask` and `SkillRouterWorker` → Worker.
- Implement the Phase-1 heuristic classifier (pure, in a skill/composition seam) + the tier→model map.
- Wire `weave chat` to declare tier 1; add `--tier{1,2,3}-model` overrides.
- Optionally: a Haiku classifier skill (Phase 2); a `weave report`/`status` column showing per-task
  model + a rough cost rollup from the log.
