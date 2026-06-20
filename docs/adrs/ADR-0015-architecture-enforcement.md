# ADR-0015: Enforce hexagonal architecture

- **Status:** Proposed
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
| `adapters` | domain, ports, adapters |
| composition (`composition-root.ts`, `cli.ts`) | anything |

Plus: every relative import ends in `.js` (NodeNext); test files are exempt (they may import
anything). The inviolable core — **inner layers never import outward** (domain/ports/usecases
never reach into adapters; adapters never reach into usecases or composition) — is what makes
the architecture real, and weave satisfies it today.

### 3. Adapter→adapter is allowed (deliberate deviation from textbook rule 5)

Classic hex says "adapters never import other adapters." weave **relaxes this on purpose**:
its plugin model (ADR-0012) makes the adapter layer *composable* — a skill bundles a worker +
tools, `notify` bundles channels — so a capability can ship as one self-contained file. The
default checker permits adapter→adapter. `--strict` flags it too, so the deviation is
*visible and measurable*, not hidden; tightening to strict (pushing all composition into the
root) remains a future option if the tradeoff changes.

## Consequences

**Positive**
- The boundary rules are now a build gate; regressions (a usecase importing an adapter, a
  missing `.js`, domain importing ports) fail CI immediately.
- The checker is pure → trivially testable; the deviation (adapter→adapter) is explicit and
  quantified via `--strict` rather than silently tolerated.

**Negative / risks**
- Regex import-extraction is approximate (won't see template-string dynamic imports — used
  only in `cli.ts`, which is composition and unrestricted anyway).
- `weave doctor` reads `./src`, so it's a dev/CI tool (the compiled binary has no sources);
  documented as such.
- Relaxed rule 5 is a real divergence from textbook hex — owned and recorded here, not
  accidental.

## Alternatives considered

- **A third-party boundary linter (dependency-cruiser/eslint-boundaries).** Heavier dep tree;
  a ~60-line pure checker is enough and stays Bun/Node-agnostic with zero deps.
- **Enforce strict rule 5 now.** Would force all skill/tool wiring into the composition root,
  destroying the drop-in plugin model. Rejected; kept as `--strict` for visibility.

## Follow-ups

- Wire `weave doctor` / `npm test` into CI.
- Optionally graduate to `--strict` by introducing a dedicated composition layer for skill/tool
  bundles.
