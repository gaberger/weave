import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTwinGraph, DEFAULT_TWIN_VIEW } from "./twin.js";

test("parses a forward-report-graph-shaped path and keeps known optional fields", () => {
  const g = parseTwinGraph({
    title: "Path: A → B",
    nodes: [
      { id: "a", label: "A", class: "endpoint", color: "#444" },
      { id: "r1", label: "core-1", status: "up" },
      { id: "b", label: "B", shape: "stadium" }, // unknown field (shape) is dropped
    ],
    edges: [{ from: "a", to: "r1", label: "eth0", dashed: false }, { from: "r1", to: "b" }],
  });
  assert.equal(g.view, DEFAULT_TWIN_VIEW, "omitted view defaults to the primary topology");
  assert.equal(g.title, "Path: A → B");
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes[0], { id: "a", label: "A", class: "endpoint", color: "#444" });
  assert.equal((g.nodes[2] as unknown as Record<string, unknown>)["shape"], undefined, "unknown fields dropped");
  assert.equal(g.edges[0]!.label, "eth0");
  assert.equal(g.edges[0]!.dashed, false);
});

test("an explicit view name is preserved (named views coexist on the canvas)", () => {
  assert.equal(parseTwinGraph({ view: "path-42", nodes: [], edges: [] }).view, "path-42");
});

test("fails closed on malformed input (a half-graph must never reach the canvas)", () => {
  assert.throws(() => parseTwinGraph(null), /must be a JSON object/);
  assert.throws(() => parseTwinGraph([]), /must be a JSON object/);
  assert.throws(() => parseTwinGraph({ edges: [] }), /`nodes` must be an array/);
  assert.throws(() => parseTwinGraph({ nodes: [] }), /`edges` must be an array/);
  assert.throws(() => parseTwinGraph({ nodes: [{}], edges: [] }), /nodes\[0\]\.id/);
  assert.throws(() => parseTwinGraph({ nodes: [{ id: 7 }], edges: [] }), /nodes\[0\]\.id/);
  assert.throws(() => parseTwinGraph({ nodes: [{ id: "a" }], edges: [{ from: "a" }] }), /edges\[0\]/);
});

test("non-string dashed is ignored, not coerced (only a real boolean styles the edge)", () => {
  const g = parseTwinGraph({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b", dashed: "yes" }] });
  assert.equal((g.edges[0] as unknown as Record<string, unknown>)["dashed"], undefined);
});
