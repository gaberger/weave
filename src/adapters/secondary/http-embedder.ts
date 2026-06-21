import type { Embedder } from "../../ports/embedder.js";

/**
 * An Embedder backed by an OpenAI-compatible `/v1/embeddings` endpoint (also works with Voyage and
 * other compatible providers). Configured purely from env so the binary needs no build-time keys:
 *   WEAVE_EMBED_KEY    required — API key (its presence is what enables semantic search)
 *   WEAVE_EMBED_URL    default https://api.openai.com/v1/embeddings
 *   WEAVE_EMBED_MODEL  default text-embedding-3-small
 * Returns null when no key is set, so callers fall back to BM25-only (ADR-0018 §3).
 */
export function httpEmbedderFromEnv(): Embedder | null {
  const key = process.env["WEAVE_EMBED_KEY"];
  if (!key) return null;
  const url = process.env["WEAVE_EMBED_URL"] ?? "https://api.openai.com/v1/embeddings";
  const model = process.env["WEAVE_EMBED_MODEL"] ?? "text-embedding-3-small";
  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const data = json.data ?? [];
      if (data.length !== texts.length) throw new Error(`embeddings: expected ${texts.length} vectors, got ${data.length}`);
      return data.map((d) => d.embedding);
    },
  };
}
