/**
 * End-to-end `spawn_task` fan-out: a worker declares follow-up tasks through the spawn_task tool, and
 * the SAME peer then claims and completes those children — the "one task expands into N" pattern that
 * underpins map/reduce-style work on the weave. spawn-task-tool.test.ts covers the tool's lineage
 * fields in isolation; this exercises the whole loop (parent runs → children declared with lineage →
 * children claimed → all settled), with a guard against runaway recursion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { Grant } from "../domain/grant.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import type { Worker } from "../ports/worker.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { ManualTimer } from "../adapters/secondary/manual-timer.js";
import { ToolRegistry } from "../adapters/secondary/in-memory-tool-host.js";
import { spawnTaskTool } from "../adapters/secondary/spawn-task-tool.js";
import { createPeer } from "../composition-root.js";

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };

const settle = async (rounds = 40): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

test("a worker fans out via spawn_task and the peer drains the children with lineage intact", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  const registry = new ToolRegistry();
  registry.register(spawnTaskTool(weave, newId));

  // The "root" task spawns two children then completes. Children just complete — without this guard a
  // child that also spawned would fan out forever.
  const worker = (): Worker => ({
    async run(a, ctx) {
      if (a.taskId === "root") {
        await ctx.tools.invoke({ name: "spawn_task", args: { subject: "child-1", goal: "do child 1" } });
        await ctx.tools.invoke({ name: "spawn_task", args: { subject: "child-2", goal: "do child 2" } });
        return { status: "completed", summary: "spawned 2" };
      }
      return { status: "completed", summary: `${a.taskId} done` };
    },
  });

  const peer = createPeer({
    weave,
    cfg: { agentId: "p", grant: GRANT, leaseMs: 1000, maxConcurrent: 2, tickMs: 100 },
    newWorker: worker,
    registry,
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await weave.append({ id: newId(), kind: TaskKind.Declared, actor: "client", subject: "root", payload: { spec: { goal: "fan out" } } });
  await settle();
  ac.abort();

  const events = await collect(weave);
  const completed = (s: string) => events.filter((e) => e.kind === TaskKind.Completed && e.subject === s);
  assert.equal(completed("root").length, 1, "root completed once");
  assert.equal(completed("child-1").length, 1, "child-1 was claimed and completed");
  assert.equal(completed("child-2").length, 1, "child-2 was claimed and completed");

  // Lineage: each child's declared event records its parent (payload.parent + top-level causedBy).
  for (const c of ["child-1", "child-2"]) {
    const decl = events.find((e) => e.kind === TaskKind.Declared && e.subject === c);
    assert.ok(decl, `${c} was declared`);
    assert.equal((decl!.payload as { parent?: string }).parent, "root", `${c} records root as parent`);
    assert.equal((decl as { causedBy?: string }).causedBy, "root", `${c} carries causedBy=root`);
  }

  // No runaway: exactly three tasks ever declared (root + 2 children).
  assert.equal(events.filter((e) => e.kind === TaskKind.Declared).length, 3, "no extra tasks spawned");
});
