# ADR-0010: Bun as compile target + the `weave` CLI

- **Status:** Accepted
- **Implementation:** Complete — cli.ts, bun-sqlite-substrate.ts, bun-sqlite-substrate.bun-test.ts _(self-evaluated 2026-06-26 via weave)_
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

- A **`bun:sqlite` substrate** (Bun's built-in SQLite, zero native addon) is the native-free
  path; the CLI selects it at runtime when `typeof Bun !== "undefined"`, else the
  better-sqlite3 `SqliteSubstrate` under Node. Same `Substrate` contract. **Implemented &
  verified** (`BunSqliteSubstrate`).
- For the SDK, the compiled binary may need the SDK present at runtime (or marked
  `--external`); documented until verified. The Claude worker is one adapter behind the
  `Worker` port, so a binary can ship with only `InProcess`/`--fake` if needed.

## Consequences

**Positive**
- Single-file distribution; operator UX comparable to hex/pi.
- The CLI reuses the entire tested core unchanged — it's just another primary adapter.
- Runtime differences (Node vs Bun, better-sqlite3 vs bun:sqlite) stay adapter choices.

**Verified (2026-06-19):** Bun 1.3.14 installed; `bun build --compile` produces a ~92 MB
self-contained ELF `weave` binary that runs standalone (no Node, no Bun, no node_modules)
through the full `task → up --fake → status → log` lifecycle, using `bun:sqlite` with zero
native addon. The native-free design avoided the better-sqlite3 single-binary trap: the
Node-only substrate import is non-analyzable so Bun's bundler never pulls it in.

**Negative / risks**
- **Two runtimes** (Node for the main test suite, Bun for the binary + `BunSqliteSubstrate`)
  is mild divergence risk. Mitigated: `test:bun` covers the bun:sqlite adapter; the rest of
  the code is shared and runtime-agnostic. Full `bun test` migration remains optional.
- **Claude SDK in the compiled binary** is bundled (works for `--fake`); a real-Claude
  binary run is not yet smoke-tested under `--compile` (needs a key) — distinct from the
  substrate, which is verified.

## Alternatives considered

- **`pkg`/Node SEA (single executable apps).** Rejected: clunkier with ESM + native deps
  than Bun; Bun was the explicit request.
- **Ship as an npm package (`npx weave`).** Fine for Node users but not a single binary;
  kept as a secondary distribution, not the primary.
- **Deno compile.** Viable but not requested; Bun's npm compatibility (SDK, better-sqlite3)
  is closer to our existing deps.

## Follow-ups

- Wire Bun into CI (install + `build:bin` + run the binary smoke + `test:bun`).
- Smoke-test a real-Claude binary run under `--compile` (needs `ANTHROPIC_API_KEY`).
- Decide whether to migrate the whole suite to `bun test` (single runtime).
- ✅ `build:bin` script + `bun:sqlite` substrate + runtime selection — done.
