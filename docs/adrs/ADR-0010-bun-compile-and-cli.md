# ADR-0010: Bun as compile target + the `weave` CLI

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** project owner
- **Tags:** tooling, cli, distribution, primary-adapter
- **Depends on:** [ADR-0001](ADR-0001-cooperative-network-agent-architecture.md), [ADR-0005](ADR-0005-peer-loop-usecase.md)

## Context

`weave` needs to ship as a single executable with a command-line interface, like hex's
Rust binary and pi's CLI — so an operator can `weave up` a peer, declare tasks, and
inspect the weave without a Node toolchain. Two decisions: **how we compile/distribute**
and **the CLI shape**.

## Decision

### 1. Bun `--compile` for the distributed binary; Node+tsx stays for dev/test (for now)

`bun build src/cli.ts --compile --outfile weave` produces a self-contained `weave`
executable (Bun bundles the runtime). The codebase is already runtime-agnostic ESM/TS, so
Bun runs it directly; tests continue on `node --import tsx` until/unless we migrate to
`bun test`. This keeps the proven Node test path while adding Bun purely as the
build/distribution target.

### 2. The CLI is a primary adapter / composition entry

`src/cli.ts` is the entry: it parses argv and wires concrete adapters into the use-cases —
i.e. it is a composition root for the CLI (the one place, alongside `composition-root.ts`,
allowed to import adapters). Commands (hex/pi-flavoured, minimal, no arg-parser dep):

| Command | Action |
|---|---|
| `weave up` | Start a peer: subscribe → claim → run workers until SIGINT; streams events |
| `weave task <goal>` | Declare a unit of work on the weave |
| `weave status` | Show each task's state (free/held/done) from the log |
| `weave log` | Print the event log (`--follow` to tail) |
| `weave help` | Usage |

### 3. Default substrate = SQLite (shared); worker = Claude (or `--fake`)

`up` and `task` typically run in **separate processes**, so the CLI defaults to the
**file-backed `SqliteSubstrate`** (multi-process via WAL) at `.weave/weave.db` — InProcess
would isolate each process. Default worker is the Claude SDK backend (needs
`ANTHROPIC_API_KEY`); `--fake` swaps in a no-LLM worker so the loop is demoable offline.
Substrate/worker are chosen behind their ports, so this is configuration, not new code.

### 4. Native deps under a compiled binary — the known risk, handled behind ports

`better-sqlite3` (SqliteSubstrate) is a native addon and the Claude Agent SDK has runtime
needs; both can complicate `--compile`. Because substrate selection is a `Substrate`-port
choice (ADR-0001/0009), the mitigation is an **adapter swap, not a rewrite**:

- Add a **`bun:sqlite` substrate** (Bun's built-in SQLite, zero native addon) as a
  follow-up; the CLI picks it when running under Bun. Same `Substrate` contract.
- For the SDK, the compiled binary may need the SDK present at runtime (or marked
  `--external`); documented until verified. The Claude worker is one adapter behind the
  `Worker` port, so a binary can ship with only `InProcess`/`--fake` if needed.

## Consequences

**Positive**
- Single-file distribution; operator UX comparable to hex/pi.
- The CLI reuses the entire tested core unchanged — it's just another primary adapter.
- Runtime differences (Node vs Bun, better-sqlite3 vs bun:sqlite) stay adapter choices.

**Negative / risks**
- **Unverified in this environment:** Bun is not installed here, so `--compile` and the
  resulting binary are **not yet validated**. The CLI is verified under `node --import tsx`;
  the Bun binary step is a documented TODO, not a tested claim.
- Native-addon-in-single-binary is the real unknown; the bun:sqlite follow-up exists
  precisely to sidestep it.
- Two runtimes (Node for tests, Bun for the binary) is mild divergence risk until tests
  also move to Bun.

## Alternatives considered

- **`pkg`/Node SEA (single executable apps).** Rejected: clunkier with ESM + native deps
  than Bun; Bun was the explicit request.
- **Ship as an npm package (`npx weave`).** Fine for Node users but not a single binary;
  kept as a secondary distribution, not the primary.
- **Deno compile.** Viable but not requested; Bun's npm compatibility (SDK, better-sqlite3)
  is closer to our existing deps.

## Follow-ups

- Install Bun in CI; verify `bun build --compile` and smoke-test the binary; wire a
  `build:bin` script (added now, unverified).
- `bun:sqlite` substrate adapter for native-free compiled builds.
- Decide whether to migrate tests to `bun test` (single runtime).
