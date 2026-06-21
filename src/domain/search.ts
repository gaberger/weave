/**
 * Lexical search over the knowledge bundle (ADR-0021). Pure: BM25 ranking + a hybrid combiner that
 * folds in optional semantic (vector) scores. No I/O and no embedding calls live here — the
 * composition layer reads concept files, optionally calls the Embedder port, and feeds the numbers
 * in. BM25 alone is fully offline and dependency-free; semantic re-rank is layered on when present.
 */

export interface SearchDoc {
  readonly id: string;
  readonly text: string;
}

export interface Scored {
  readonly id: string;
  readonly score: number;
}

const STOP = new Set(
  "a an the of on in at to for and or is are be was were it its this that these those as by with from into over under not no but if then else do does did has have had will would can could should i we you they he she them our your their".split(
    " ",
  ),
);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens. Shared by index + query
 *  so the vocabularies line up. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (t.length > 1 && !STOP.has(t)) out.push(t);
  }
  return out;
}

export interface Bm25Index {
  readonly postings: Map<string, Map<string, number>>; // term → (docId → term frequency)
  readonly df: Map<string, number>; // term → document frequency
  readonly len: Map<string, number>; // docId → token count
  readonly ids: readonly string[];
  readonly avgdl: number;
  readonly n: number;
}

/** Build an in-memory BM25 inverted index from documents. */
export function buildBm25(docs: readonly SearchDoc[]): Bm25Index {
  const postings = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  const len = new Map<string, number>();
  let total = 0;
  for (const doc of docs) {
    const toks = tokenize(doc.text);
    len.set(doc.id, toks.length);
    total += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, f] of tf) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = new Map()));
      p.set(doc.id, f);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = docs.length;
  return { postings, df, len, ids: docs.map((d) => d.id), avgdl: n ? total / n : 0, n };
}

const K1 = 1.2;
const B = 0.75;

/** Rank documents against a query with Okapi BM25. Returns matches sorted by score, descending. */
export function bm25Search(index: Bm25Index, query: string, limit = 20): Scored[] {
  const terms = tokenize(query);
  const scores = new Map<string, number>();
  for (const t of terms) {
    const posting = index.postings.get(t);
    if (!posting) continue;
    const df = index.df.get(t) ?? 0;
    // BM25 idf with the +1 guard so it never goes negative for common terms.
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    for (const [id, tf] of posting) {
      const dl = index.len.get(id) ?? 0;
      const denom = tf + K1 * (1 - B + (B * dl) / (index.avgdl || 1));
      scores.set(id, (scores.get(id) ?? 0) + idf * ((tf * (K1 + 1)) / (denom || 1)));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Min-max normalise scores to [0,1] so heterogeneous scales (BM25 vs cosine) can be blended. */
export function normalise(scored: readonly Scored[]): Map<string, number> {
  const out = new Map<string, number>();
  if (scored.length === 0) return out;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of scored) {
    if (s.score < lo) lo = s.score;
    if (s.score > hi) hi = s.score;
  }
  const span = hi - lo;
  for (const s of scored) out.set(s.id, span > 0 ? (s.score - lo) / span : 1);
  return out;
}

/** Cosine similarity of two equal-length vectors (0 if either is degenerate). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Hybrid rank: blend normalised BM25 and (optional) semantic scores with `alpha` toward lexical.
 * With no semantic scores this is just normalised BM25, so callers get graceful offline fallback.
 */
export function hybridRank(
  lexical: readonly Scored[],
  semantic: readonly Scored[],
  alpha = 0.5,
  limit = 20,
): Scored[] {
  const lex = normalise(lexical);
  const sem = normalise(semantic);
  const ids = new Set<string>([...lex.keys(), ...sem.keys()]);
  const blended: Scored[] = [];
  const useSem = sem.size > 0;
  for (const id of ids) {
    const l = lex.get(id) ?? 0;
    const s = sem.get(id) ?? 0;
    blended.push({ id, score: useSem ? alpha * l + (1 - alpha) * s : l });
  }
  return blended.sort((a, b) => b.score - a.score).slice(0, limit);
}
