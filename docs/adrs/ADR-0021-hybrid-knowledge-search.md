# ADR-0021: Hybrid knowledge search + the recall tool

- **Status:** Accepted
- **Implementation:** Complete — search.ts, search.test.ts, embedder.ts _(self-evaluated 2026-06-26 via weave)_
- **Date:** 2026-06-21
- **Deciders:** project owner
- **Tags:** search, retrieval, embeddings, tools, knowledge
- **Depends on:** [ADR-0004](ADR-0004-toolhost-capability-model.md), [ADR-0016](ADR-0016-domain-agnostic-harness.md), [ADR-0020](ADR-0020-knowledge-bundle-and-graph.md)

## Context

ADR-0020 made accumulated knowledge durable and navigable, but not **findable**. To use prior
knowledge an agent had to already know a filename — `grep --include=*.md` over the bundle was
the only recall path, and it fails the moment a topic spans files or the query is a synonym.
For inference to actually *unlock* the data, the bundle needs search, ideally as a tool a skill
calls **before** re-researching. The constraint: weave is a zero-native-dependency standalone
binary that must work offline, so search cannot hard-require an embedding provider.

## Decision

Hybrid search over the bundle — lexical always, semantic when available — exposed as a CLI
command and a tool.

1. **BM25 lexical core (pure).** `domain/search.ts` builds an in-memory BM25 inverted index and
   ranks; zero deps, fully offline, instant. This is also stage 1 of hybrid.

2. **Hybrid rank.** `hybridRank` min-max-normalises BM25 and (optional) semantic scores and
   blends them; with no semantic scores it degrades to pure BM25, so offline is the graceful
   default, not a separate code path.

3. **Embedder port (optional).** `ports/embedder.ts` is the seam for the semantic half — the
   domain never depends on it. Two adapters: a dependency-free **local "poor man's" embedder**
   (the hashing trick over word tokens + character trigrams → L2-normalised vector; captures
   fuzzy/morphological overlap, *not* true synonymy) used by default, and an **HTTP embedder**
   (OpenAI-compatible / Voyage) activated only when `WEAVE_EMBED_KEY` is set. `pickEmbedder`
   prefers the provider, falls back to local, and `--no-embed` forces BM25-only. Doc vectors are
   cached in `reports/.index/vectors.json` keyed by content + model.

4. **recall tool + commands.** `recall` (effect `read`, ADR-0004-gated) lets skills/inference
   search prior reports and get back hybrid hits **plus graph neighbours** (retrieval-augmented
   navigation: search finds entry points, the ADR-0020 graph expands them). `weave search`
   exposes the same for humans/scripts; `weave index` (re)builds graph + warms the vector cache.

Search/index are mechanical harness code; `recall` is the generic capability skills compose
(ADR-0016) — the policy ("recall before researching") is a skill's, not the harness's.

## Consequences

**Positive**
- Knowledge is findable offline with zero deps (BM25 + local embedder), and upgrades to true
  semantic search by setting one env var — same port, no code change.
- `recall` closes the accumulation loop: a research skill can build on prior reports instead of
  redoing work, which is the dogfooding payoff of ADR-0020's durable bundle.
- Graph-augmented hits give inference the surrounding subgraph, not just a ranked list.

**Negative / risks**
- The local embedder is lexical-fuzzy, not semantic — it will not match "mpls" ≈ "label
  switching". That requires a real model via `WEAVE_EMBED_KEY` (cost/online).
- The HTTP embedder sends report text to a third party; opt-in by design (key absent → never
  called), but worth flagging for sensitive bundles.
- BM25 + whole-bundle scan per query is fine at current scale; large bundles will want a
  persisted index.

## Alternatives considered

- **Lexical only (BM25).** Simplest and offline, but misses morphological/semantic recall; kept
  as the always-on base of hybrid rather than the whole answer.
- **Semantic only (embeddings).** Best recall but breaks the zero-dep/offline property and adds
  provider cost/latency for every search; demoted to the optional half.
- **An external vector DB / search engine.** Violates the standalone-binary constraint
  (ADR-0010) for a corpus this size.

## Follow-ups

- Persist the BM25 index (not just vectors) for large bundles.
- Chunk long reports before embedding for finer-grained semantic hits.
- A local quantized embedding model (WASM) to get true synonymy while staying dependency-light.
