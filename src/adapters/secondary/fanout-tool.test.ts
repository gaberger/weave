import { test } from "node:test";
import assert from "node:assert/strict";

import { InProcessSubstrate } from "./in-process-substrate.js";
import { ManualTimer } from "./manual-timer.js";
import { FakeClock } from "../../domain/clock.js";
import { TaskKind } from "../../domain/task.js";
import { fanoutTool } from "./fanout-tool.js";

let n = 0;
const ids = () => `id-${++n}`;

/** Append a terminal event for a child subject, as the peer loop would on settle. */
async function settleChild(weave: InProcessSubstrate, subject: string, status: "completed" | "failed", body: string) {
  await weave.append({
    id: ids(),
    kind: status === "completed" ? TaskKind.Completed : TaskKind.Failed,
    actor: "peer-x",
    subject,
    payload: status === "completed" ? { summary: body } : { summary: body, error: body },
  });
}

test("fanout declares one child per goal with parent lineage, then joins their results", async () => {
  const weave = new InProcessSubstrate(new FakeClock());
  const tool = fanoutTool(weave, ids, new ManualTimer());

  const run = tool.execute(
    { goals: ["search angle A", "search angle B"], subjectPrefix: "r", skill: "claude" },
    { taskId: "parent-1" },
  );

  // Let the children get declared, then settle them out of order.
  await Promise.resolve();
  await settleChild(weave, "r:1", "completed", "answer B");
  await settleChild(weave, "r:0", "completed", "answer A");

  const res = await run;
  assert.equal(res.ok, true);
  const out = res.output as { complete: boolean; results: Array<{ subject: string; goal: string; status: string; summary: string }> };
  assert.equal(out.complete, true);
  assert.deepEqual(
    out.results,
    [
      { subject: "r:0", goal: "search angle A", status: "completed", summary: "answer A" },
      { subject: "r:1", goal: "search angle B", status: "completed", summary: "answer B" },
    ],
  );

  // Lineage: each declared child records the parent (payload.parent + top-level causedBy).
  const declared = [];
  for await (const e of weave.read(1)) if (e.kind === TaskKind.Declared) declared.push(e);
  assert.equal(declared.length, 2);
  for (const d of declared) {
    assert.equal((d.payload as { parent?: string }).parent, "parent-1");
    assert.equal((d as { causedBy?: string }).causedBy, "parent-1");
    assert.equal((d.payload as { spec: { skill?: string } }).spec.skill, "claude");
  }
});

test("fanout surfaces a failed child without blocking the join", async () => {
  const weave = new InProcessSubstrate(new FakeClock());
  const tool = fanoutTool(weave, ids, new ManualTimer());

  const run = tool.execute({ goals: ["g0", "g1"], subjectPrefix: "f" }, { taskId: "p" });
  await Promise.resolve();
  await settleChild(weave, "f:0", "completed", "ok");
  await settleChild(weave, "f:1", "failed", "boom");

  const out = (await run).output as { complete: boolean; results: Array<{ status: string; summary: string }> };
  assert.equal(out.complete, true);
  assert.equal(out.results[0]!.status, "completed");
  assert.equal(out.results[1]!.status, "failed");
  assert.equal(out.results[1]!.summary, "boom");
});

test("fanout returns partial results with `pending` when the deadline fires before all settle", async () => {
  const weave = new InProcessSubstrate(new FakeClock());
  const timer = new ManualTimer();
  const tool = fanoutTool(weave, ids, timer);

  const run = tool.execute({ goals: ["g0", "g1", "g2"], subjectPrefix: "t" }, { taskId: "p" });
  await Promise.resolve();
  await settleChild(weave, "t:0", "completed", "done0");
  // t:1 and t:2 never settle — fire the deadline.
  timer.fire();

  const out = (await run).output as { complete: boolean; pending: string[]; results: Array<{ status: string }> };
  assert.equal(out.complete, false);
  assert.deepEqual(out.pending.sort(), ["t:1", "t:2"]);
  assert.equal(out.results[0]!.status, "completed");
  assert.equal(out.results[1]!.status, "pending");
  assert.equal(out.results[2]!.status, "pending");
});

test("fanout coerces stringified args from the MCP bridge (JSON-array goals, numeric-string timeout)", async () => {
  const weave = new InProcessSubstrate(new FakeClock());
  const tool = fanoutTool(weave, ids, new ManualTimer());

  // Exactly the shape smaller models send through the z.unknown() bridge: goals as a JSON string,
  // inputs as a "{}" string, timeoutMs as a numeric string.
  const run = tool.execute(
    { goals: '["angle one", "angle two"]', inputs: "{}", timeoutMs: "120000", subjectPrefix: "c" },
    { taskId: "p" },
  );
  await Promise.resolve();
  await settleChild(weave, "c:0", "completed", "one");
  await settleChild(weave, "c:1", "completed", "two");

  const out = (await run).output as { complete: boolean; results: Array<{ goal: string; summary: string }> };
  assert.equal(out.complete, true);
  assert.deepEqual(out.results.map((r) => r.goal), ["angle one", "angle two"]);
  assert.deepEqual(out.results.map((r) => r.summary), ["one", "two"]);
});

test("fanout rejects an empty goals list", async () => {
  const weave = new InProcessSubstrate(new FakeClock());
  const res = await fanoutTool(weave, ids, new ManualTimer()).execute({ goals: [] }, { taskId: "p" });
  assert.equal(res.ok, false);
  assert.match((res.output as { error: string }).error, /non-empty/);
});
