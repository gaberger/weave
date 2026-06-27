/**
 * General-purpose coordination behaviors of the peer loop, beyond the single-task scenarios in
 * peer-loop.test.ts. These are the properties a user relies on when they "map a prompt over N inputs":
 * concurrent fan-out up to a cap, draining a backlog exactly-once, surfacing worker failures (and
 * carrying on), and publishing progress. All deterministic — FakeWorker + InProcessSubstrate + a
 * settle() pump, no LLM, no wall-clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { Grant } from "../domain/grant.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import type { Worker, WorkerResult } from "../ports/worker.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { ManualTimer } from "../adapters/secondary/manual-timer.js";
import { createPeer } from "../composition-root.js";

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };

const settle = async (rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

const kinds = (events: SealedEvent[], kind: string, subject?: string): SealedEvent[] =>
  events.filter((e) => e.kind === kind && (subject === undefined || e.subject === subject));

const declare = (weave: InProcessSubstrate, newId: () => string, subject: string, goal = subject) =>
  weave.append({ id: newId(), kind: TaskKind.Declared, actor: "client", subject, payload: { spec: { goal } } });

test("concurrency fan-out: one peer with maxConcurrent=3 runs three free tasks at once", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  // Each worker parks on a shared barrier so all three must be in-flight simultaneously before any
  // completes — that's what proves genuine concurrency rather than three sequential runs.
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  let active = 0;
  let peak = 0;
  const worker = (): Worker => ({
    async run() {
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
      return { status: "completed", summary: "done" };
    },
  });

  const peer = createPeer({
    weave,
    cfg: { agentId: "p", grant: GRANT, leaseMs: 1000, maxConcurrent: 3, tickMs: 100 },
    newWorker: worker,
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await declare(weave, newId, "t1");
  await declare(weave, newId, "t2");
  await declare(weave, newId, "t3");
  await settle();

  assert.equal(peak, 3, "all three workers should be in-flight concurrently");
  release();
  await settle();

  const events = await collect(weave);
  for (const t of ["t1", "t2", "t3"]) assert.equal(kinds(events, TaskKind.Completed, t).length, 1, `${t} completed once`);
  ac.abort();
});

test("maxConcurrent caps in-flight work: five tasks, cap 2, never more than two at once", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  let active = 0;
  let peak = 0;
  const worker = (): Worker => ({
    async run() {
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
      return { status: "completed", summary: "done" };
    },
  });

  const peer = createPeer({
    weave,
    cfg: { agentId: "p", grant: GRANT, leaseMs: 1000, maxConcurrent: 2, tickMs: 100 },
    newWorker: worker,
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  for (let i = 1; i <= 5; i++) await declare(weave, newId, `t${i}`);
  await settle();

  assert.equal(peak, 2, "the peer must never exceed its maxConcurrent ceiling");
  release();
  await settle();

  const events = await collect(weave);
  assert.equal(kinds(events, TaskKind.Completed).length, 5, "all five eventually complete");
  ac.abort();
});

test("backlog drain: a single-slot peer completes a queue of tasks exactly once each", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;
  const ran: string[] = [];

  const peer = createPeer({
    weave,
    cfg: { agentId: "solo", grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
    newWorker: (): Worker => ({
      async run(a) {
        ran.push(a.taskId);
        return { status: "completed", summary: `did ${a.taskId}` };
      },
    }),
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  for (const t of ["a", "b", "c", "d"]) await declare(weave, newId, t);
  await settle();

  assert.deepEqual([...ran].sort(), ["a", "b", "c", "d"], "every queued task ran");
  assert.equal(new Set(ran).size, ran.length, "no task ran twice");
  const events = await collect(weave);
  for (const t of ["a", "b", "c", "d"]) {
    assert.equal(kinds(events, TaskKind.Completed, t).length, 1, `${t} completed exactly once`);
    assert.equal(kinds(events, TaskKind.Completed, t)[0]?.actor, "solo");
  }
  ac.abort();
});

test("worker failure publishes task.failed with the error, and the peer keeps draining", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  // "bad" fails with a specific error; "good" completes. A failed task must not stall the queue.
  const worker = (): Worker => ({
    async run(a): Promise<WorkerResult> {
      return a.taskId === "bad"
        ? { status: "failed", summary: "could not do it", error: "Error: kaboom" }
        : { status: "completed", summary: "ok" };
    },
  });

  const peer = createPeer({
    weave,
    cfg: { agentId: "p", grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
    newWorker: worker,
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await declare(weave, newId, "bad");
  await declare(weave, newId, "good");
  await settle();

  const events = await collect(weave);
  const failed = kinds(events, TaskKind.Failed, "bad");
  assert.equal(failed.length, 1, "the failing task emits exactly one task.failed");
  assert.equal((failed[0]?.payload as { error?: string }).error, "Error: kaboom", "the real error is carried");
  assert.equal(kinds(events, TaskKind.Completed, "good").length, 1, "a failure doesn't block later work");
  ac.abort();
});

test("progress notes surface as task.progress events on the weave", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  const peer = createPeer({
    weave,
    cfg: { agentId: "p", grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
    newWorker: (): Worker => ({
      async run(_a, ctx) {
        ctx.onProgress("step one");
        ctx.onProgress("step two");
        return { status: "completed", summary: "done" };
      },
    }),
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await declare(weave, newId, "t1");
  await settle();

  const notes = kinds(await collect(weave), TaskKind.Progress, "t1").map((e) => (e.payload as { note?: string }).note);
  assert.deepEqual(notes, ["step one", "step two"], "both progress notes are published in order");
  ac.abort();
});
