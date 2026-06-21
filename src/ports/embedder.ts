/**
 * Embedder port (ADR-0021 §3): turns text into vectors for the semantic half of hybrid search.
 * Optional by design — weave runs BM25-only when no embedder is configured, so the standalone
 * binary stays offline and dependency-free. Adapters call out to a provider (OpenAI-compatible
 * /v1/embeddings, Voyage, …); the domain never depends on this, only the composition layer does.
 */
export interface Embedder {
  /** Model identifier — also the cache key, so changing models invalidates stale vectors. */
  readonly model: string;
  /** Embed texts into equal-length vectors, order-preserving. Throws on provider/transport error. */
  embed(texts: readonly string[]): Promise<number[][]>;
}
