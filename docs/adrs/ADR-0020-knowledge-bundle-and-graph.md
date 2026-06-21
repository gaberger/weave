# ADR-0020: Durable knowledge bundle (OKF) + knowledge graph

- **Status:** Accepted
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** memory, knowledge, persistence, graph, okf
- **Depends on:** [ADR-0007](ADR-0007-memory-compaction.md), [ADR-0008](ADR-0008-loops-and-task-fanout.md), [ADR-0016](ADR-0016-domain-agnostic-harness.md)

## Context

Task results lived only in the event log as the `summary` payload of `task.completed`
events. `weave report` re-derived its output from those events — but compaction (ADR-0007)
folds settled subjects into a snapshot that keeps **only their ids**, then prunes the events.
So every completed result was silently lost on compaction, and a long-running daemon
auto-compacts. For loops whose entire purpose is to **accumulate knowledge**, that is fatal:
the knowledge evaporates. Results were also unnavigable — a flat set of opaque task ids with
no relationships, so neither a human nor an agent could see that two reports cover the same
topic or that one task spawned another.

## Decision

Mirror every settled result to a durable, navigable, agent-consumable **bundle on disk**, and
index it as a graph.

1. **Durable persistence.** A peer subscribes from seq 0 (backfills history + captures live
   completions) and writes each settled task to `<db-dir>/reports/`. Because every path is a
   pure function of the event, writes are idempotent and multi-peer-safe. `weave report` now
   falls back to the bundle for results whose events were pruned, so it survives compaction.

2. **OKF v0.1 layout.** The bundle is a Google Open Knowledge Format bundle: per-skill subdirs
   of concept files `<skill>/<topic-slug>--<shortid>.md`, each with YAML frontmatter
   (`type`/`title`/`description`/`resource`/`tags`/`timestamp` + custom `task_id`/`skill`/
   `status`/`actor`/`parent`), plus the reserved `index.md` (progressive-disclosure listing)
   and `log.md` (date-grouped history). OKF was chosen over an ad-hoc format because it is a
   vendor-neutral standard meant exactly for giving agents curated context.

3. **Knowledge graph.** `weave index` parses the bundle and builds a typed graph
   (`graph.json` + human `graph.md` + inline `## Forward links`/`## Backlinks`/`## Related`
   sections regenerated after a `<!-- weave:graph -->` sentinel). The graph model is a pure
   domain module (`domain/knowledge-graph.ts`); all file I/O stays in the composition layer.
   Edge types: `task-ref` (explicit/weave://task), `lineage` (parent→child, from `spawn_task`
   provenance per ADR-0008 §3), `co-citation` and `tag-cluster` (derived, undirected),
   `artifact-ref` and `cites` (to local files / external sources). Indexing runs on demand and
   debounced after completions in a peer.

This is harness code, not a skill: it is deterministic and mechanical (ADR-0016 keeps *domain
logic* out of the core, not generic capabilities). The payoff for skills/inference is the
search + `recall` tool layered on top (ADR-0021).

## Consequences

**Positive**
- Accumulated knowledge is durable — it outlives compaction, the event log's reason to exist.
- The bundle is browsable by humans (index/log/graph.md) and by agents (frontmatter + links +
  `graph.json`), turning a flat result set into a navigable knowledge graph.
- Backfill-from-seq-0 retroactively rescues results created before this feature existed.
- Lineage and co-citation make implicit relationships explicit without any manual linking.

**Negative / risks**
- Two stores now hold results (transactional event log + durable bundle); the bundle is the
  source of truth for *settled* knowledge, the log for *live* state. Drift is avoided by
  deriving the bundle purely from events.
- Whole-bundle reindex is O(n) per pass; fine at current scale, debounced, but not free.
- `description` is a heuristic (lead line of the body); good enough for navigation, not a
  curated abstract.

## Alternatives considered

- **Keep result text in the compaction snapshot.** Bloats the snapshot and stays db-locked /
  not browsable; rejected — a file bundle is durable *and* agent-readable.
- **An ad-hoc markdown/JSON format.** OKF is a published standard with the same goal (curated
  agent context); adopting it gets interop for free.
- **A graph database.** Violates weave's zero-native-dep standalone-binary property; a pure
  in-memory graph serialized to `graph.json` is enough at this scale.

## Follow-ups

- Cheaper incremental indexing (only re-touch changed files).
- Richer `type`/`tags` once skills emit topic tags (today `tag-cluster` excludes skill/status).
- Curated `description`/abstract from the agent instead of the body lead line.
