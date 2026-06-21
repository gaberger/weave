import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBm25, bm25Search, hybridRank, cosine, tokenize, normalise } from "./search.js";

const DOCS = [
  { id: "mpls", text: "Segment Routing MPLS on Arista EOS, TI-LFA reconvergence and SID allocation" },
  { id: "nqe", text: "Forward NQE grammar: foreach, where, select, pattern matching with blockMatches" },
  { id: "bgp", text: "BGP labeled unicast and MPLS forwarding behavior on the provider edge" },
];

test("tokenize drops stopwords and single chars", () => {
  assert.deepEqual(tokenize("the MPLS on a P router"), ["mpls", "router"]);
});

test("bm25Search ranks the on-topic doc first", () => {
  const idx = buildBm25(DOCS);
  const r = bm25Search(idx, "TI-LFA reconvergence", 5);
  assert.equal(r[0]?.id, "mpls");
});

test("bm25Search returns nothing for out-of-vocabulary queries", () => {
  const idx = buildBm25(DOCS);
  assert.equal(bm25Search(idx, "kubernetes helm chart").length, 0);
});

test("bm25Search matches a shared term across multiple docs", () => {
  const idx = buildBm25(DOCS);
  const ids = bm25Search(idx, "mpls", 5).map((s) => s.id).sort();
  assert.deepEqual(ids, ["bgp", "mpls"]);
});

test("hybridRank falls back to pure BM25 when no semantic scores", () => {
  const lex = [{ id: "a", score: 8 }, { id: "b", score: 2 }];
  const r = hybridRank(lex, [], 0.5, 5);
  assert.equal(r[0]?.id, "a");
});

test("hybridRank lets semantic scores reorder lexical ties", () => {
  const lex = [{ id: "a", score: 5 }, { id: "b", score: 5 }];
  const sem = [{ id: "b", score: 9 }, { id: "a", score: 1 }];
  const r = hybridRank(lex, sem, 0.5, 5);
  assert.equal(r[0]?.id, "b");
});

test("cosine of identical vectors is ~1, orthogonal is 0", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test("normalise maps to [0,1]", () => {
  const m = normalise([{ id: "a", score: 10 }, { id: "b", score: 0 }, { id: "c", score: 5 }]);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 0);
  assert.equal(m.get("c"), 0.5);
});
