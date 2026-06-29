/**
 * End-to-end `fanout` (ADR-0024 §2): a parent task calls the fanout tool, which declares N child
 * tasks and BLOCKS on the substrate until they settle; the SAME peer claims and completes those
 * children on its other concurrency slot, and their results flow back to the parent — the fan-out +
 * JOIN that `spawn_task` (fire-and-forget) does not provide. fanout-tool.test.ts covers the tool in
 * isolation; this proves the whole loop works driven by a real peer (parent blocks → children
 * claimed → join resolves → parent synthesizes from the returned results).
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
import { fanoutTool } from "../adapters/secondary/fanout-tool.js";
import { createPeer } from "../composition-root.js";

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };

const settle = async (rounds = 80): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

test("a parent fans out via the fanout tool and the peer joins the children's results back to it", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  const registry = new ToolRegistry();
  // Manual timer never fires → the join resolves ONLY when all children settle, not on a deadline.
  registry.register(fanoutTool(weave, newId, new ManualTimer()));

  // root calls fanout and folds the joined child summaries into its own result. Children just
  // complete (the skill:"claude"-style pin in production keeps them from recursing; here the same
  // worker handles them and returns a terminal result, so no runaway).
  const worker = (): Worker => ({
    async run(a, ctx) {
      if (a.taskId === "root") {
        const res = await ctx.tools.invoke({ name: "fanout", args: { goals: ["angle A", "angle B"], subjectPrefix: "r" } });
        const out = res.output as { complete: boolean; results: Array<{ summary: string }> };
        return { status: "completed", summary: `joined=${out.complete} [${out.results.map((r) => r.summary).join(", ")}]` };
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

  // Children were declared by fanout, claimed by the peer (on the slot the blocked parent didn't hold), and completed.
  assert.equal(completed("r:0").length, 1, "child r:0 claimed and completed");
  assert.equal(completed("r:1").length, 1, "child r:1 claimed and completed");

  // Lineage: each child records the parent.
  for (const c of ["r:0", "r:1"]) {
    const decl = events.find((e) => e.kind === TaskKind.Declared && e.subject === c);
    assert.ok(decl, `${c} declared`);
    assert.equal((decl!.payload as { parent?: string }).parent, "root", `${c} records root as parent`);
  }

  // The JOIN delivered the children's results back to the parent — the thing fanout adds over spawn_task.
  const root = events.find((e) => e.kind === TaskKind.Completed && e.subject === "root");
  assert.ok(root, "root completed");
  const summary = (root!.payload as { summary: string }).summary;
  assert.match(summary, /joined=true/, "fanout reported all children settled");
  assert.match(summary, /r:0 done/, "root received r:0's result");
  assert.match(summary, /r:1 done/, "root received r:1's result");

  // No runaway: exactly three tasks ever declared (root + 2 children).
  assert.equal(events.filter((e) => e.kind === TaskKind.Declared).length, 3, "no extra tasks spawned");
});
