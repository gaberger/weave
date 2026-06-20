import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { ToolHost } from "../ports/tool-host.js";
import type { WorkerContext, TaskAssignment } from "../ports/worker.js";
import { TaskKind } from "../domain/task.js";
import { reduceContext, type ReducedContext } from "../domain/context.js";
import type { ProbeFinding } from "../domain/interrogation.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { networkStateTool } from "../adapters/secondary/network-state-tool.js";
import { summarySkill } from "../adapters/secondary/builtin-skills.js";

const finding = (target: string, status: number): ProbeFinding => ({
  target,
  status,
  ms: 1,
  healthy: status >= 200 && status < 400,
  violated: false,
  ok: status >= 200 && status < 400,
});

async function recordProbe(sub: InProcessSubstrate, ids: () => string, subject: string, f: ProbeFinding): Promise<void> {
  await sub.append({ id: ids(), kind: TaskKind.Declared, actor: "cli", subject, payload: { spec: { goal: "g" } } });
  await sub.append({
    id: ids(),
    kind: TaskKind.Completed,
    actor: "p",
    subject,
    payload: { summary: "done", artifacts: [{ kind: "probe", ref: JSON.stringify(f) }] },
  });
}

test("reduceContext: one entry per target + correct rollup", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await recordProbe(sub, () => `e${++n}`, "p1", finding("a", 200));
  await recordProbe(sub, () => `e${++n}`, "p2", finding("a", 500)); // newer for same target wins
  await recordProbe(sub, () => `e${++n}`, "p3", finding("b", 0)); // unreachable

  const events = [];
  for await (const e of sub.read(0)) events.push(e);
  const r = reduceContext(events);

  assert.equal(r.totals.targets, 2); // a and b
  const a = r.targets.find((t) => t.target === "a");
  assert.equal(a?.status, 500); // latest wins
  assert.equal(r.totals.unreachable, 1);
  assert.equal(r.totals.healthy, 0);
});

test("network_state tool returns the reduced context", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await recordProbe(sub, () => `e${++n}`, "p1", finding("a", 200));
  const tool = networkStateTool(sub);
  const res = await tool.execute({});
  const r = res.output as ReducedContext;
  assert.equal(r.totals.targets, 1);
  assert.equal(r.targets[0]?.target, "a");
});

test("summary skill formats the reduced view from the tool", async () => {
  const reduced: ReducedContext = {
    targets: [{ target: "a", status: 200, ok: true, tag: "OK", ms: 1 }],
    totals: { targets: 1, healthy: 1, unhealthy: 0, unreachable: 0, violations: 0 },
  };
  const tools: ToolHost = {
    available: () => [],
    invoke: async () => ({ ok: true, output: reduced }),
  };
  const ctx: WorkerContext = {
    tools,
    lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
    onProgress: () => {},
    signal: new AbortController().signal,
  };
  const task: TaskAssignment = { taskId: "t", spec: { goal: "summary" } };
  const res = await summarySkill.run(task, ctx);
  assert.equal(res.status, "completed");
  assert.match(res.summary, /1\/1 healthy/);
  assert.match(res.summary, /a OK/);
});
