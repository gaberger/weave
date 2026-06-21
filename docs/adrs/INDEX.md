# Architecture Decision Records

Append-only log of architectural decisions for `weave`. Newest at top.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0022](ADR-0022-model-tiering.md) | Per-task model tiering (Haiku/Sonnet/Opus by task) | Accepted | 2026-06-21 |
| [0021](ADR-0021-hybrid-knowledge-search.md) | Hybrid knowledge search (BM25 + optional embeddings) + the recall tool | Accepted | 2026-06-21 |
| [0020](ADR-0020-knowledge-bundle-and-graph.md) | Durable knowledge bundle (OKF) + knowledge graph | Accepted | 2026-06-21 |
| [0019](ADR-0019-file-io-tools.md) | File-I/O tools (read_file / edit_file) — the missing self-maintenance primitive | Accepted | 2026-06-21 |
| [0018](ADR-0018-container-sandbox.md) | Container sandbox — OS-level confinement behind the Worker port | Accepted | 2026-06-21 |
| [0017](ADR-0017-self-authored-skills-and-sandbox.md) | Self-authored skills + the execution sandbox (the learning loop) | Accepted | 2026-06-21 |
| [0016](ADR-0016-domain-agnostic-harness.md) | weave is a domain-agnostic harness; use-cases are skills | Accepted | 2026-06-20 |
| [0015](ADR-0015-architecture-enforcement.md) | Enforce hexagonal architecture | Accepted | 2026-06-20 |
| [0014](ADR-0014-notification-channels.md) | Communication channels (email / Slack / Telegram) | Accepted | 2026-06-20 |
| [0013](ADR-0013-context-reducer.md) | ContextReducer — reduced context for skills/LLMs | Superseded by 0016 | 2026-06-20 |
| [0012](ADR-0012-skill-plugin-system.md) | Skills — the plugin/extension system | Accepted | 2026-06-20 |
| [0011](ADR-0011-network-interrogation-loop.md) | Recurring network interrogation | Superseded by 0016 | 2026-06-20 |
| [0010](ADR-0010-bun-compile-and-cli.md) | Bun compile target + the weave CLI | Accepted | 2026-06-19 |
| [0009](ADR-0009-networked-substrate.md) | NetworkedSubstrate — replicated log with HLC ordering | Accepted | 2026-06-19 |
| [0008](ADR-0008-loops-and-task-fanout.md) | First-class loops + task fan-out (handoff-as-tool-call) | Accepted | 2026-06-20 |
| [0007](ADR-0007-memory-compaction.md) | Memory — log compaction via snapshot events | Accepted | 2026-06-20 |
| [0005](ADR-0005-peer-loop-usecase.md) | The peer loop (agent runtime use-case) | Accepted | 2026-06-19 |
| [0004](ADR-0004-toolhost-capability-model.md) | ToolHost capability & effect model | Accepted | 2026-06-19 |
| [0003](ADR-0003-worker-port-and-claude-sdk-adapter.md) | Worker port & Claude Agent SDK adapter | Accepted | 2026-06-19 |
| [0002](ADR-0002-substrate-port-and-claim-protocol.md) | Substrate port & claim/lease protocol | Accepted | 2026-06-19 |
| [0001](ADR-0001-cooperative-network-agent-architecture.md) | Cooperative-network agent architecture | Proposed | 2026-06-19 |

## Statuses

`Proposed` → `Accepted` → (`Superseded by NNNN` \| `Deprecated`)
