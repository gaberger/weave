import type { Embedder } from "../../ports/embedder.js";
import { tokenize } from "../../domain/search.js";

/**
 * A dependency-free "poor man's" Embedder (ADR-0018 §3): the hashing trick over word tokens plus
 * character trigrams, into a fixed-dim L2-normalised vector. Deterministic, offline, no model — so
 * the standalone binary gets a semantic-ish half for hybrid search with zero dependencies.
 *
 * What it captures: fuzzy/morphological overlap (word forms, typos, shared sub-words via trigrams)
 * weighted by sublinear term frequency. What it does NOT capture: true synonymy ("mpls" ≈ "label
 * switching") — that needs a trained model, available by setting WEAVE_EMBED_KEY (see http-embedder).
 */
const DIM = 512;

/** FNV-1a → unsigned 32-bit. Cheap, well-distributed, no deps. */
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Add a feature to the vector with the signed hashing trick (a second hash picks the sign, which
 *  makes collisions cancel in expectation instead of always inflating). */
function addFeature(vec: Float64Array, token: string, weight: number): void {
  const idx = fnv1a(token) % DIM;
  const sign = fnv1a(`#${token}`) & 1 ? 1 : -1;
  vec[idx] = (vec[idx] ?? 0) + weight * sign;
}

function* trigrams(token: string): Generator<string> {
  const s = `^${token}$`;
  for (let i = 0; i + 3 <= s.length; i++) yield s.slice(i, i + 3);
}

function embedOne(text: string): number[] {
  const vec = new Float64Array(DIM);
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, f] of tf) {
    const w = 1 + Math.log(f); // sublinear term frequency
    addFeature(vec, t, w); // whole-token feature
    for (const g of trigrams(t)) addFeature(vec, `_${g}`, w * 0.5); // char trigrams → fuzzy match
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (x) => x / norm); // L2-normalise so dot product == cosine
}

/** A local, offline Embedder. `model` encodes the algorithm + dim so the vector cache invalidates
 *  if either changes. */
export function localEmbedder(): Embedder {
  return {
    model: `local-hash-v1-d${DIM}`,
    async embed(texts) {
      return texts.map(embedOne);
    },
  };
}
