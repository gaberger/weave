# weave

> A cooperative-network agent framework — autonomous agent workers that coordinate as **peers** over a shared substrate.

`weave` takes the disciplined parts of [hex](../hex) (hexagonal / ports-and-adapters architecture, ADR-driven design, spec-first development) and trades the rigid central microkernel for a **flexible, peer-oriented coordination model**. Agents are autonomous workers behind a single `Worker` port — today Claude-backed (the [Claude Agent SDK](https://docs.claude.com) or the `claude -p` CLI) — that cooperate by reading from and writing to a shared, replicated event log — the *weave* — rather than reporting to a central kernel. *Where* each task runs (in-process, a sandboxed thread, or a container) is a wiring choice behind that same port; see [Execution tiers](#execution-tiers-where-a-task-runs).

The same agent code runs three ways without modification:

- **Solo** — one worker, in-process log.
- **Local swarm** — many workers on one host, shared local log.
- **Federated network** — workers across hosts, log replicated peer-to-peer.

How far you scale is an **adapter choice**, not a rewrite. That is the core bet, recorded in [ADR-0001](docs/adrs/ADR-0001-cooperative-network-agent-architecture.md).

## Status

🌿 Working. The coordination core (solo / swarm / federated), the CLI, skills, loops,
compaction, notifications, and the architecture gate are implemented and tested — `npm test`
plus the [capability demos](#capability-demos). Decisions are recorded as ADRs first; see
[`docs/adrs/`](docs/adrs/INDEX.md). Real Claude workers run end-to-end on both backends (SDK and
`claude -p`), proven by the [field-validation campaign](#field-validation--real-projects-end-to-end).

## Quickstart

Requires **Node ≥ 18.17** (or [Bun](https://bun.sh) for the single-binary build). From a fresh clone:

```bash
npm install                          # install deps (better-sqlite3, tsx) — do this first
npm run demo                         # offline two-peer swarm, no API key needed

# or drive the CLI yourself (offline, no key):
npm run weave -- up --fake           # start a peer; leave it running
npm run weave -- task "summarize the README"   # in another terminal: declare work
npm run weave -- status              # watch it go free → held → done
npm run weave -- report              # see the actual result
```

`up --fake` runs an offline echo worker (no LLM). To run real Claude workers, set
`ANTHROPIC_API_KEY` or have the `claude` CLI on your PATH, then drop `--fake`. See
[LLM backends](#llm-backends-api-key-optional).

### Capability demos

Nine demos of the headline capabilities — swarm exactly-once, skill routing, loops, pool resilience,
compaction, federated convergence, knowledge search, the architecture gate, and Docker sandbox
isolation. The first eight are offline (no API key); the last needs Docker and skips cleanly without
it. Each one **asserts its result** and ends in a `PASS` / `FAIL` / `SKIP` verdict, and `run.sh all`
prints a scorecard (and exits non-zero on any failure):

```bash
npm run demos            # interactive menu
npm run demos -- all     # run them all, then print a scorecard
npm run demos -- 9       # Docker sandbox: --network none isolation, granted tool still works
```

See [`demos/`](demos/README.md).

## Principles

1. **Peers, not hierarchy.** No mandatory central coordinator. Agents cooperate through shared state.
2. **Coordination is a port.** Solo / swarm / federated differ only by which substrate adapter is wired in.
3. **Spec & ADR first.** Decisions are recorded before code (inherited from hex).
4. **Hexagonal core.** `domain → ports → usecases → adapters`; adapters never import adapters.

## Demo

One command — a cooperative swarm of two peers sharing one substrate, tasks claimed
exactly once and split between them (offline, no API key):

```bash
npm install   # if you haven't already
npm run demo
```

> Optional — single binary: `npm run build:bin` compiles a self-contained `./weave`
> (requires [Bun](https://bun.sh)). The demo itself needs only Node + `npm install`.

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

The exactly-once check is invariant; the **work split is timing-dependent** — whichever peer wins
each race claims the task, so a run may split 4/2, 5/1, or even 6/0 on a fast machine. What's
guaranteed is that all 6 tasks complete and each is claimed exactly once.

The event log shows the protocol: when both peers race to claim a task, exactly one wins
(lowest `seq`); the other's claim stays inert. The **federated** story (partition → heal →
deterministic convergence) is proven in `npm test` — see the NetworkedSubstrate spec.

## CLI

A hex/pi-style command line (ADR-0010).

> **Invocation:** examples below are written as `weave …` for brevity. If you haven't built the
> binary, run them as `npm run weave -- …` (shown here), or build once with `npm run build:bin`
> and use `./weave …`. Nothing puts a bare `weave` on your PATH unless you install it globally.

During dev, run via Node:

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

## Skills — how you add use-cases (ADR-0012 / ADR-0016)

**weave is domain-agnostic.** What it *does* is skills, dropped into `.weave/skills/` — no
core changes. A peer routes each task to the matching skill. Two kinds:

**Declarative agent skill** (`.md` / `.json`) — a use-case as a *prompt + tool grant*; the LLM
reasons over the granted tools. This is the "loosely-defined business logic" path. Example
([`examples/plugins/researcher.md`](examples/plugins/researcher.md)):

```md
---
name: researcher
description: Research recent arXiv papers on a topic
match: research, arxiv, papers
tools: http_fetch, spawn_task, notify
---
You are a research agent. Fetch the arXiv API feed for the topic with http_fetch, identify
recent papers, fetch each paper's page, and write a concise digest. Notify if configured.
```

**Code skill** (`.js` / `.ts` / `.mjs`) — when you want determinism (no LLM, no key);
default-export a `Skill` (`{ name, description, match, run, tools? }`). Example
([`examples/plugins/http-check.mjs`](examples/plugins/http-check.mjs)): GETs each URL via the
`http_fetch` tool and returns `completed`/`failed` based on status — full control, deterministic.

```bash
weave skills --workspace <dir>            # list the skills a peer in <dir> loads (code + declarative)
weave task --skill researcher "LLM agents"   # route explicitly (rejected up-front if no such skill)
weave task "research recent LLM papers"      # or let match keywords route it
```

> **Adding a skill to a running peer:** a peer assembles its skill set **once at startup**, so after
> you drop a new file into `.weave/skills/` you must **restart the peer** for it to pick the skill up
> (an already-running peer will keep using the fallback). Verify discovery first with `weave skills
> --workspace <dir>` — it lists exactly what a peer in that workspace would load.

Generic tools the harness ships for skills to use: `http_fetch` (GET a URL), `spawn_task`
(fan out a follow-up task — used for "discover → detail per item", deduped by subject),
`notify` (channels). Per-skill `tools` allowlists restrict what each skill can touch.

## Loops

A first-class loop (ADR-0008) re-declares a task routed to **any** skill each tick:

```bash
weave loop --skill researcher --interval 6h "large language models"
weave loop --skill monitor --interval 30s --notify slack "https://api.example.com 10.0.0.1"
```

`--notify` alerts on completed results; `--once` runs a single pass. The researcher/monitor
are example *plugins* (`examples/plugins/`), not harness code.

## Notifications (channels, ADR-0014)

```bash
weave notify "deploy finished" --title "weave" --to slack
```

Each transport is a `Channel` adapter behind a port; configure via flags or env
(`--slack-webhook`, `--telegram-token`+`--telegram-chat`, `EMAIL_*`). The `notify` tool's
effect is **irreversible** — lease-gated (no duplicate alerts after a worker loses its lease).

## Memory & compaction (ADR-0007)

A long-running loop appends forever, so the log compacts: settled tasks fold into one
`weave.snapshot` event (condensation-as-an-event — durable, replayable) and their raw events
are pruned. Projections (`status`, claim resolution) are snapshot-aware, so reads stay correct
and cheap.

```bash
weave compact                # one-shot fold + prune
weave up --compact-secs 300  # long-running peer self-bounds
```

## LLM backends (API key optional)

Agent skills run on whichever backend the CLI detects:

| backend | when | auth |
|---|---|---|
| **Claude SDK** | `ANTHROPIC_API_KEY` is set | API key |
| **`claude -p` CLI** | no key, but `claude` is on PATH | your Claude Code login — **no key** |
| **echo** | `--fake`, or neither available | none (offline) |

So you can run real agents on a Claude Code subscription with no API key:

```bash
weave loop --skill researcher "mixture of experts language models" --once   # uses claude -p
```

`up`/`skills` print the chosen backend (`[llm: claude-cli]`). The `claude -p` worker uses
Claude Code's own (read-only) tools; the SDK worker uses weave's gated ToolHost.

## Execution tiers (where a task runs)

The backend above decides *what reasons* over a task; this decides *where the task runs*. Both sit
behind the **same `Worker` port**, so either is a composition wiring (`newWorker`), not a use-case
change. Three tiers ship:

| tier | mechanism | runs | isolation |
|---|---|---|---|
| **in-process** | the peer's event loop | the LLM workers (Claude SDK / `claude -p`) and trusted code skills | none — trusted |
| **threaded** | `node:worker_threads` (`SandboxedSkillRunner`, [ADR-0017](docs/adrs/ADR-0017-self-authored-skills-and-sandbox.md)) | self-authored **code skills** | fault + resource isolation (wall-clock timeout, V8 old-space cap); tools reachable **only** by RPC back to the parent's grant-filtered ToolHost |
| **container** | `docker run --network none` (`DockerSkillRunner`, [ADR-0018](docs/adrs/ADR-0018-container-sandbox.md)) | code skills needing real confinement | OS-level — the boundary a thread can't give |

A peer runs up to `maxConcurrent` tasks at once via **cooperative async** on its single event loop;
scaling past one peer means more **processes** (local swarm / `pool`) or hosts (federated), not
threads. The threaded and container tiers are the **self-authored-skill sandbox** — implemented and
tested, with the Docker tier exercised in [demo 9](#capability-demos); the default `weave up` runs
the in-process worker. A `worker_threads` thread gives fault isolation, resource caps, and the tool
boundary — but it is explicitly **not** a security boundary (it shares process privileges and can
touch fs/net directly), which is exactly why the container tier exists (ADR-0018).

## Running a real Claude worker (SDK)

The coordination core is LLM-free and fully tested with fakes. To run actual Claude
workers via the SDK, wire the SDK-backed factory into a peer (the only place the SDK is touched):

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

## Field validation — real projects, end to end

Beyond the unit suite (`npm test`) and the [capability demos](#capability-demos), weave is
**dogfooded** by driving complete software projects through it and fixing the engine wherever a
real workload broke it. Five project types, each chosen to stress a different coordination mode:

| project | mode exercised | independent verification | result |
|---|---|---|---|
| Diffusion-models research report | independent fan-out (many parallel tasks, no deps) | rendered to PDF via the `publish` skill | digests + PDF |
| Chord DHT (Python) | sequential coding | project's own test suite | 24 / 24 |
| Language interpreter (TypeScript) | parallel multi-agent coding (spec-first → integrate) | project's own test suite | 148 / 148 |
| BigInt arbitrary precision (Python) | iterative repair | differential oracle vs Python `int` | 0 disagreements |
| Regex engine — Thompson NFA (Python) | iterative repair | differential oracle vs Python `re.fullmatch` | 0 disagreements / ~6k cases |

Each run surfaced a real engine gap; all are merged:

- **[#14](https://github.com/gaberger/weave/pull/14)** — build portability (TMPDIR-safe runner,
  builds anywhere), agent-task **progress streaming** (`--output-format stream-json` surfaces each
  tool call as a `task.progress` event), the `weave` Claude skill, and the `publish` code-skill
  (markdown → PDF).
- **[#15](https://github.com/gaberger/weave/pull/15)** — `write_file` tool (create / overwrite) on
  the ToolHost.
- **[#16](https://github.com/gaberger/weave/pull/16)** — no-progress **stall watchdog**: a worker
  silent past `--stall-ms` is aborted and its task reclaimed; after `--max-stalls` it fails
  terminally (crash-safe — the lease releases cleanly).
- **[#17](https://github.com/gaberger/weave/pull/17)** — detach stdin from the `claude -p`
  subprocess (an inherited but silent stdin pipe hung the whole turn at init).

**Differential oracles.** For the numeric / string engines, correctness is checked against an
independent ground truth the agent never sees — Python's own `int` and `re` — across thousands of
randomized inputs plus targeted edge cases. Any single disagreement is a real bug: the regex oracle
caught an escaped-dot (`\.`) that wrongly matched any character (a transition-label collision
between the wildcard `.` and a literal dot). The fix was driven back through weave as a fix-task,
and the re-run is clean across ~6,000 cases. The watchdog (#16) and stdin fix (#17) were both
exercised live during these builds.

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
