# weave

> A cooperative-network agent framework — autonomous Claude workers that coordinate as **peers** over a shared substrate.

`weave` takes the disciplined parts of [hex](../hex) (hexagonal / ports-and-adapters architecture, ADR-driven design, spec-first development) and trades the rigid central microkernel for a **flexible, peer-oriented coordination model**. Agents are autonomous Claude workers (driven by the [Claude Agent SDK](https://docs.claude.com)) that cooperate by reading from and writing to a shared, replicated event log — the *weave* — rather than reporting to a central kernel.

The same agent code runs three ways without modification:

- **Solo** — one worker, in-process log.
- **Local swarm** — many workers on one host, shared local log.
- **Federated network** — workers across hosts, log replicated peer-to-peer.

How far you scale is an **adapter choice**, not a rewrite. That is the core bet, recorded in [ADR-0001](docs/adrs/ADR-0001-cooperative-network-agent-architecture.md).

## Status

🌱 Day one. Architecture being recorded as ADRs before code. See [`docs/adrs/`](docs/adrs/INDEX.md).

## Principles

1. **Peers, not hierarchy.** No mandatory central coordinator. Agents cooperate through shared state.
2. **Coordination is a port.** Solo / swarm / federated differ only by which substrate adapter is wired in.
3. **Spec & ADR first.** Decisions are recorded before code (inherited from hex).
4. **Hexagonal core.** `domain → ports → usecases → adapters`; adapters never import adapters.

## Running a real Claude worker

The coordination core is LLM-free and fully tested with fakes. To run actual Claude
workers, wire the SDK-backed factory into a peer (the only place the SDK is touched):

```ts
import { createPeer } from "weave/composition-root.js";
import { createClaudeWorkerFactory } from "weave/adapters/secondary/claude-sdk.js";
import { InProcessSubstrate } from "weave/adapters/secondary/in-process-substrate.js";
import { systemClock } from "weave/domain/clock.js";

const weave = new InProcessSubstrate(systemClock);
const peer = createPeer({
  weave,
  cfg: { agentId: "peer-1", grant: { tools: "*", maxEffect: "irreversible" },
         leaseMs: 30_000, maxConcurrent: 2, tickMs: 5_000 },
  newWorker: createClaudeWorkerFactory({ model: "claude-sonnet-4-6" }),
});
peer.start(new AbortController().signal);
```

Needs `ANTHROPIC_API_KEY`. The live smoke test (`claude-sdk.live.test.ts`) exercises this
end-to-end and is skipped automatically when the key is absent.

## Layout

```
docs/adrs/        Architecture Decision Records (start here)
docs/specs/       Behavioral specs (written before code)
src/domain/       Pure types — agents, events, claims, the weave
src/ports/        Interfaces — Substrate, Worker, ToolHost
src/usecases/     Coordination logic — depends only on domain + ports
src/adapters/     Substrate/worker implementations (in-process, SQLite, Claude SDK, …)
```
