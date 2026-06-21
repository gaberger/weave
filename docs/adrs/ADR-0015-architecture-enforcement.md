# ADR-0015: Enforce hexagonal architecture

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** project owner
- **Tags:** architecture, enforcement, ci, tooling
- **Depends on:** [ADR-0001](ADR-0001-cooperative-network-agent-architecture.md)

## Context

weave inherits hex's hexagonal discipline, but discipline that isn't checked rots (your
memory notes hex-nexus scored an F on its *own* analyzer). We want the boundary rules
enforced automatically — a CI gate, not a code-review hope.

## Decision

### 1. A pure checker + an fs scanner + a gate

- `domain/architecture.ts` — **pure** `checkArchitecture(files, {strict?})` over
  `{path, imports}` records. No I/O, fully unit-testable.
- `adapters/secondary/source-scan.ts` — reads `src/`, extracts relative import specifiers.
- `architecture.test.ts` — runs the checker over `src/` and **fails the build** on any
  violation. This is the enforcement.
- `weave doctor [--strict]` — the human/CI surface.

### 2. The rules (the dependency-inversion cone)

| Layer | May import |
|-------|-----------|
| `domain` | domain |
| `ports` | domain, ports |
| `usecases` | domain, ports, usecases |
| `adapters` | domain, ports (strict: **no other adapters**) |
| `composition/` + `composition-root.ts` + `cli.ts` | anything |

Plus: every relative import ends in `.js` (NodeNext); test files are exempt (they may import
anything). The inviolable core — **inner layers never import outward** (domain/ports/usecases
never reach into adapters; adapters never reach into usecases or composition) — is what makes
the architecture real, and weave satisfies it today.

### 3. Strict (no adapter→adapter) — via a `composition/` layer

Classic hex says "adapters never import other adapters." weave **complies strictly**. The
modules that *wire* adapters into skills/tool-bundles (the skill bundles, the Claude SDK
factory, the notify tool) are not leaf adapters — they are **composition**, so they live in
`src/composition/` (a layer permitted to import adapters), leaving `adapters/secondary/` as
true leaves that import only ports + domain. `weave doctor` and the build gate run **strict by
default**; `--lenient` exists only as an escape hatch. (The pre-1.0 refactor that moved
`builtin-skills`/`arxiv-skills`/`claude-sdk`/`notify-tool` into `composition/` and dropped a
stray convenience import got the strict count to zero.)

## Consequences

**Positive**
- The boundary rules are now a build gate; regressions (a usecase importing an adapter, a
  missing `.js`, domain importing ports) fail CI immediately.
- The checker is pure → trivially testable; weave is **fully textbook-hex-compliant** (strict),
  with a clean three-tier separation: leaf adapters / composition wiring / entry roots.

**Negative / risks**
- Regex import-extraction is approximate (won't see template-string dynamic imports — used
  only in `cli.ts`, which is composition and unrestricted anyway).
- `weave doctor` reads `./src`, so it's a dev/CI tool (the compiled binary has no sources);
  documented as such.
- The `composition/` layer is now where adapter-wiring lives; contributors must put new
  skill/tool bundles there, not in `adapters/secondary/` (the gate enforces this).

## Alternatives considered

- **A third-party boundary linter (dependency-cruiser/eslint-boundaries).** Heavier dep tree;
  a ~60-line pure checker is enough and stays Bun/Node-agnostic with zero deps.
- **Relax rule 5 (allow adapter→adapter).** Simpler short-term, but tolerates erosion. We
  instead introduced a `composition/` *layer* (not the single root), so strict compliance and
  the drop-in plugin model coexist — skills/bundles stay self-contained files, just in the
  composition tier.

## Follow-ups

- Wire `weave doctor` / `npm test` into CI.
- ✅ Strict compliance via a `composition/` layer — done (no adapter→adapter remains).
