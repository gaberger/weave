# Architecture Decision Records

Append-only log of architectural decisions for `weave`. Newest at top.

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0016](ADR-0016-domain-agnostic-harness.md) | weave is a domain-agnostic harness; use-cases are skills | Proposed | 2026-06-20 |
| [0015](ADR-0015-architecture-enforcement.md) | Enforce hexagonal architecture | Proposed | 2026-06-20 |
| [0014](ADR-0014-notification-channels.md) | Communication channels (email / Slack / Telegram) | Proposed | 2026-06-20 |
| [0013](ADR-0013-context-reducer.md) | ContextReducer — reduced context for skills/LLMs | Superseded by 0016 | 2026-06-20 |
| [0012](ADR-0012-skill-plugin-system.md) | Skills — the plugin/extension system | Proposed | 2026-06-20 |
| [0011](ADR-0011-network-interrogation-loop.md) | Recurring network interrogation | Superseded by 0016 | 2026-06-20 |
| [0010](ADR-0010-bun-compile-and-cli.md) | Bun compile target + the weave CLI | Proposed | 2026-06-19 |
| [0009](ADR-0009-networked-substrate.md) | NetworkedSubstrate — replicated log with HLC ordering | Proposed | 2026-06-19 |
| [0008](ADR-0008-loops-and-task-fanout.md) | First-class loops + task fan-out (handoff-as-tool-call) | Proposed | 2026-06-20 |
| [0007](ADR-0007-memory-compaction.md) | Memory — log compaction via snapshot events | Proposed | 2026-06-20 |
| [0005](ADR-0005-peer-loop-usecase.md) | The peer loop (agent runtime use-case) | Proposed | 2026-06-19 |
| [0004](ADR-0004-toolhost-capability-model.md) | ToolHost capability & effect model | Proposed | 2026-06-19 |
| [0003](ADR-0003-worker-port-and-claude-sdk-adapter.md) | Worker port & Claude Agent SDK adapter | Proposed | 2026-06-19 |
| [0002](ADR-0002-substrate-port-and-claim-protocol.md) | Substrate port & claim/lease protocol | Proposed | 2026-06-19 |
| [0001](ADR-0001-cooperative-network-agent-architecture.md) | Cooperative-network agent architecture | Proposed | 2026-06-19 |

## Statuses

`Proposed` → `Accepted` → (`Superseded by NNNN` \| `Deprecated`)
