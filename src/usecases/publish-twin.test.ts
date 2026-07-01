import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { SealedEvent } from "../domain/event.js";
import { TwinKind } from "../domain/twin.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { publishTwin } from "./publish-twin.js";

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

test("publishTwin emits twin.graph keyed by view, carrying the graph as payload", async () => {
  const weave = new InProcessSubstrate(new FakeClock(0));
  let n = 0;
  const graph = { view: "twin", title: "topo", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] };
  await publishTwin(weave, () => `id-${++n}`, "netops", graph);

  const [e] = await collect(weave);
  assert.equal(e?.kind, TwinKind.Graph);
  assert.equal(e?.subject, "twin", "subject is the view so latest-per-view wins on the canvas");
  assert.equal(e?.actor, "netops");
  assert.deepEqual(e?.payload, graph);
});

test("re-publishing the same view appends a newer event the canvas folds as an update", async () => {
  const weave = new InProcessSubstrate(new FakeClock(0));
  let n = 0;
  await publishTwin(weave, () => `id-${++n}`, "netops", { view: "twin", nodes: [{ id: "a" }], edges: [] });
  await publishTwin(weave, () => `id-${++n}`, "netops", { view: "twin", nodes: [{ id: "a" }, { id: "b" }], edges: [] });

  const evs = await collect(weave);
  assert.equal(evs.length, 2);
  assert.equal(evs.every((e) => e.subject === "twin"), true);
  assert.equal((evs[1]!.payload as { nodes: unknown[] }).nodes.length, 2, "latest view has both nodes");
});
