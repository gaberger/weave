import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, neighbours, type ReportInput } from "./knowledge-graph.js";

const r = (over: Partial<ReportInput> & Pick<ReportInput, "id">): ReportInput => ({
  relPath: `researcher/${over.id}.md`,
  skill: "researcher",
  status: "completed",
  timestamp: "2026-06-21T00:00:00.000Z",
  title: over.id,
  tags: ["researcher", "completed"],
  links: [],
  sources: [],
  artifacts: [],
  ...over,
});

test("buildGraph: report nodes + directed task-ref edges only to known targets", () => {
  const g = buildGraph([r({ id: "a", links: ["b", "ghost"] }), r({ id: "b" })]);
  assert.equal(g.nodes.filter((n) => n.type === "report").length, 2);
  const refs = g.edges.filter((e) => e.type === "task-ref");
  assert.deepEqual(refs, [{ from: "a", to: "b", type: "task-ref", directed: true }]); // ghost dropped
});

test("buildGraph: lineage edge goes parent → child", () => {
  const g = buildGraph([r({ id: "parent" }), r({ id: "child", parent: "parent" })]);
  const lineage = g.edges.find((e) => e.type === "lineage");
  assert.deepEqual(lineage, { from: "parent", to: "child", type: "lineage", directed: true });
});

test("buildGraph: co-citation is undirected and weighted by shared sources", () => {
  const g = buildGraph([
    r({ id: "a", sources: ["http://x", "http://y"] }),
    r({ id: "b", sources: ["http://y"] }),
  ]);
  const co = g.edges.find((e) => e.type === "co-citation");
  assert.deepEqual(co, { from: "a", to: "b", type: "co-citation", directed: false, weight: 1 });
  assert.ok(g.nodes.some((n) => n.type === "source" && n.id === "source:http://y"));
});

test("buildGraph: trivial skill/status tags never form a tag-cluster", () => {
  const g = buildGraph([r({ id: "a" }), r({ id: "b" })]); // tags are the default [researcher, completed]
  assert.equal(g.edges.filter((e) => e.type === "tag-cluster").length, 0);
});

test("buildGraph: a shared non-trivial topic tag clusters", () => {
  const g = buildGraph([
    r({ id: "a", tags: ["researcher", "completed", "mpls"] }),
    r({ id: "b", tags: ["researcher", "completed", "mpls"] }),
  ]);
  assert.equal(g.edges.filter((e) => e.type === "tag-cluster").length, 1);
});

test("buildGraph: artifact reference creates an artifact node + directed edge", () => {
  const g = buildGraph([r({ id: "a", artifacts: ["nqe/nqe.g4"] })]);
  assert.ok(g.nodes.some((n) => n.type === "artifact" && n.id === "artifact:nqe/nqe.g4"));
  assert.ok(g.edges.some((e) => e.type === "artifact-ref" && e.from === "a" && e.to === "artifact:nqe/nqe.g4"));
});

test("neighbours: splits forward / back / related for a node", () => {
  const g = buildGraph([
    r({ id: "a", links: ["b"], sources: ["http://y"] }),
    r({ id: "b", sources: ["http://y"] }),
  ]);
  const nb = neighbours(g, "b");
  assert.equal(nb.back.length, 1); // a → b (task-ref)
  assert.equal(nb.back[0]?.from, "a");
  assert.equal(nb.forward.length, 1); // b → source:http://y (cites)
  assert.equal(nb.forward[0]?.type, "cites");
  assert.equal(nb.related.length, 1); // co-citation a — b
});
