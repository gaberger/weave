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

## Demo

One command — a cooperative swarm of two peers sharing one substrate, tasks claimed
exactly once and split between them (offline, no API key):

```bash
npm run build:bin   # optional: compile ./weave (else the demo uses node+tsx)
npm run demo
```

```
── status ───────────────────────────────────
task-a026c4c1    [done] summarize the readme
task-c41e978b    [done] write unit tests
...
── work split (completions per peer) ────────
   peer-a: 4
   peer-b: 2
── exactly-once check ───────────────────────
   6 completions for 6 tasks
```

The event log shows the protocol: when both peers race to claim a task, exactly one wins
(lowest `seq`); the other's claim stays inert. The **federated** story (partition → heal →
deterministic convergence) is proven in `npm test` — see the NetworkedSubstrate spec.

## CLI

A hex/pi-style command line (ADR-0010). During dev, run via Node:

```bash
npm run weave -- task "summarize the README"   # declare work (shared SQLite at .weave/weave.db)
npm run weave -- up --fake                      # start a peer; --fake = no API key needed
npm run weave -- status                         # task states: free / held / done
npm run weave -- log --follow                   # tail the event log
```

`up` defaults to the Claude worker (needs `ANTHROPIC_API_KEY`); `--fake` runs an offline
no-LLM worker so the loop is demoable. `up` and `task` coordinate across separate terminals
via the file-backed SQLite substrate.

**Single binary (Bun):** `npm run build:bin` (`bun build src/cli.ts --compile`) produces a
self-contained `./weave` executable — no Node, no node_modules. Verified end-to-end. Under
Bun it uses the built-in `bun:sqlite` substrate (zero native addons); under Node it uses
`better-sqlite3` — selected at runtime behind the `Substrate` port (ADR-0010).

```bash
npm run build:bin && ./weave task "ship it" && ./weave up --fake
```

## Looping research agents

A first-class loop (ADR-0008) re-declares a task routed to any skill each tick. The built-in
**arXiv research agent** discovers recent papers and fans out a detail task per paper:

```bash
weave loop --skill arxiv --interval 6h "large language models"
```

```
researcher  arXiv "llm": 3 papers, 3 detail task(s) declared
researcher  Sparse Attention for Million-Token LLMs — A. Researcher, B. Scientist
researcher  Agentic Tool Use Benchmarks — C. Engineer
```

The `arxiv` skill `http_fetch`es the feed and `spawn_task`s an `arxiv-paper` detail task per
paper (subject `arxiv:<id>`). Because the subject is the paper id, weave's claim-once dedup
means each paper is processed **once ever** — re-runs only pick up *new* papers. `weave loop`
works with any skill; `--feed`/`--max` configure the arXiv source (point it at a local fixture
to test offline).

## Skills (plugins) — how weave knows what to do

A peer doesn't hardcode behaviour: it loads **skills** and routes each task to the one that
matches (ADR-0012). A skill declares what it handles and how; built-ins ship in-tree and
**plugins drop into `.weave/skills/`** with no core change.

```bash
weave skills                      # list loaded skills (built-in + plugins)
weave task --skill shout "shout hello"   # route explicitly...
weave task "probe https://x/health"      # ...or let predicates route it (→ probe skill)
```

A plugin is a module that default-exports a skill (see [`examples/skills/shout.mjs`](examples/skills/shout.mjs)):

```js
export default {
  name: "shout",
  description: "Echo the goal in UPPERCASE",
  match: (task) => task.spec.goal.startsWith("shout "),
  async run(task) { return { status: "completed", summary: task.spec.goal.toUpperCase() }; },
  // optional: tools: [ { name, description, effect, execute } ]  ← contributed to the ToolHost
};
```

Routing: explicit `--skill` → first skill whose `match()` is true → otherwise `failed`
(weave says, honestly, it has no skill for that). Built-ins: `probe` (interrogation),
`claude` (general agent, when `ANTHROPIC_API_KEY` is set), `echo` (offline fallback).

## Interrogate networks on a loop

A peer swarm that repeatedly probes network targets and records findings to the durable log
(ADR-0011). Read-only, so it's safe to fan out:

```bash
weave watch https://api.example.com/health 10.0.0.1 --interval 30s --expect 200
```

```
    netwatch  https://api.example.com/health OK 200 14ms
    netwatch  10.0.0.1 UNREACHABLE 0 2ms
    ...every 30s...
```

- Each tick re-declares one interrogation task per target; peers claim them exactly once,
  so adding more `weave watch`/`up` peers spreads the load. Findings persist across restarts.
- `--expect <status>` turns a probe into an assertion (flags `VIOLATION`); `--once` runs a
  single sweep. Tags: `OK` / `UNHEALTHY(<code>)` / `VIOLATION` / `UNREACHABLE`.
- Today's interrogation tool is `http_probe` (covers the Forward Networks REST API and most
  controller/NOS endpoints). SSH/SNMP/ping are future tool adapters behind the same shape.
- **Drift** is flagged inline when a target's status changes between runs
  (`⚠ DRIFT <target>: OK → UNREACHABLE`).

## Notifications (channels)

Communicate out over email / Slack / Telegram (ADR-0014):

```bash
weave notify "10.0.0.1 is UNREACHABLE" --title "weave alert" --to slack
weave watch <targets...> --notify slack      # alert automatically on drift
```

Each transport is a `Channel` adapter behind a port; configure via flags or env
(`--slack-webhook`, `--telegram-token`+`--telegram-chat`, `EMAIL_*`). Sending is the
`notify` tool, whose effect is **irreversible** — so it's lease-gated (no duplicate alerts
after a worker loses its lease), and skills can call it too.

## Memory & compaction

A loop appends events forever, so the log is compactable (ADR-0007). Compaction folds
**settled** tasks into a single `weave.snapshot` event (condensation-as-an-event — durable,
replayable) and prunes the raw events, keeping one finding per target:

```bash
weave compact                     # one-shot: fold + prune
weave watch <targets...> --compact-every 20   # auto-compact every 20 sweeps
```

```
weave: compacted — folded 5 settled subject(s), retained 1 target finding(s); log 20 → 1 events
```

Projections (`status`, claim resolution) are snapshot-aware, so reads stay correct and cheap
after compaction.

**Reduced context (layer 2, ADR-0013).** `reduceContext` folds the log to one current entry
per target — what a skill or LLM should see instead of raw history (the hex L1/L2/L3 analogue):

```bash
weave summary                     # human view of the reduced state
weave up --compact-secs 300       # long-running peer self-bounds (auto-compaction)
```

```
network: 1/2 healthy, 0 unhealthy, 1 unreachable, 0 violations
  OK            200  https://api.example.com/health
  UNREACHABLE     0  10.0.0.1
```

A read-effect `network_state` tool exposes this to skills, so the built-in `summary` skill —
and the `claude` agent — reason over the reduced view, not megabytes of events. It reads the
same before and after compaction.

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

## Architecture enforcement

The hex boundaries are a **build gate**, not a hope (ADR-0015):

```bash
weave doctor            # strict by default; fails on any boundary violation or missing .js
weave doctor --lenient  # escape hatch (allows adapter→adapter)
```

`checkArchitecture` (pure, in `domain/`) enforces the dependency cone: `domain → ports →
usecases → adapters`, inner layers never import outward, and **adapters import only ports +
domain** (no adapter→adapter). The modules that *wire* adapters into skills/tool-bundles live
in `composition/` (allowed to import adapters), alongside `composition-root.ts`/`cli.ts`. It
runs in `npm test`, so a violation fails CI — weave is fully textbook-hex-compliant.

## Layout

```
docs/adrs/        Architecture Decision Records (start here)
docs/specs/       Behavioral specs (written before code)
src/domain/       Pure types — agents, events, claims, the weave
src/ports/        Interfaces — Substrate, Worker, ToolHost
src/usecases/     Coordination logic — depends only on domain + ports
src/adapters/     Leaf adapters — import only ports + domain (substrates, workers, tools, channels)
src/composition/  Wires adapters into skills/tool-bundles (may import adapters)
src/composition-root.ts, src/cli.ts   Entry roots — wire everything
```
