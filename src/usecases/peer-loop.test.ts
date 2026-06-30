import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../domain/clock.js";
import type { Grant } from "../domain/grant.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import { currentHolder, isSettled } from "../domain/claim.js";
import type { Worker } from "../ports/worker.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { FakeWorker } from "../adapters/secondary/fake-worker.js";
import { ManualTimer } from "../adapters/secondary/manual-timer.js";
import { createPeer } from "../composition-root.js";

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

const collect = async (weave: InProcessSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) out.push(e);
  return out;
};

const holderAgent = (events: SealedEvent[], subject: string, now: number): string | null =>
  currentHolder(events, subject, now)?.agentId ?? null;

const recordingWorker = (agentId: string, ran: string[]): Worker => ({
  async run() {
    ran.push(agentId);
    return { status: "completed", summary: `${agentId} done` };
  },
});

test("two peers, one task: exactly one runs it", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;
  const ran: string[] = [];

  const mk = (agentId: string) =>
    createPeer({
      weave,
      cfg: { agentId, grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
      newWorker: () => recordingWorker(agentId, ran),
      clock,
      timer: new ManualTimer(),
      newId,
    });

  const ac = new AbortController();
  const a = mk("agent-a");
  const b = mk("agent-b");
  void a.start(ac.signal);
  void b.start(ac.signal);

  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "do it" } },
  });
  await settle();
  ac.abort();

  assert.equal(ran.length, 1, "exactly one peer should have run the task");
  const events = await collect(weave);
  const completed = events.filter((e) => e.kind === TaskKind.Completed && e.subject === "task-1");
  assert.equal(completed.length, 1, "exactly one task.completed on the weave");
  // The completer is the same peer that ran.
  assert.equal(completed[0]?.actor, ran[0]);
});

test("lease loss mid-task: another peer reclaims and completes", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  let releaseHold!: () => void;
  const hold = new Promise<void>((r) => {
    releaseHold = r;
  });

  // Peer A wins, then "crashes": its worker blocks and it never heartbeats.
  const a = createPeer({
    weave,
    cfg: { agentId: "agent-a", grant: GRANT, leaseMs: 100, maxConcurrent: 1, tickMs: 30 },
    newWorker: () =>
      new FakeWorker({ hold, checkLeaseBeforeResult: true, result: { status: "completed", summary: "a done" } }),
    clock,
    timer: new ManualTimer(), // never fired → A never renews
    newId,
  });

  // Peer B completes immediately once it gets the task.
  let bRan = false;
  const timerB = new ManualTimer();
  const b = createPeer({
    weave,
    cfg: { agentId: "agent-b", grant: GRANT, leaseMs: 100, maxConcurrent: 1, tickMs: 30 },
    newWorker: () => ({
      async run() {
        bRan = true;
        return { status: "completed", summary: "b reclaimed" };
      },
    }),
    clock,
    timer: timerB,
    newId,
  });

  const ac = new AbortController();
  void a.start(ac.signal);
  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "do it" } },
  });
  await settle();
  assert.equal(holderAgent(await collect(weave), "task-1", clock.now()), "agent-a", "A holds the claim");

  void b.start(ac.signal);
  await settle();
  assert.equal(bRan, false, "B stays idle while A's lease is live");

  // A's lease lapses (100ms) and A never renewed; advance the clock and let B sweep.
  clock.set(150);
  timerB.fire();
  await settle();

  assert.equal(bRan, true, "B reclaimed the expired task");
  const afterReclaim = await collect(weave);
  const completedByB = afterReclaim.filter(
    (e) => e.kind === TaskKind.Completed && e.subject === "task-1" && e.actor === "agent-b",
  );
  assert.equal(completedByB.length, 1, "B completed the reclaimed task exactly once");

  // A's worker finally unblocks: its lease is gone, so it must abort (not complete).
  releaseHold();
  await settle();
  const final = await collect(weave);
  const completedByA = final.filter(
    (e) => e.kind === TaskKind.Completed && e.subject === "task-1" && e.actor === "agent-a",
  );
  const releasedByA = final.filter(
    (e) =>
      e.kind === TaskKind.Released &&
      e.subject === "task-1" &&
      e.actor === "agent-a" &&
      (e.payload as { reason?: string }).reason === "lease-lost",
  );
  assert.equal(completedByA.length, 0, "A must not complete after losing its lease");
  assert.equal(releasedByA.length, 1, "A released the task as lease-lost (abortable effects)");

  ac.abort();
});

test("graceful stop drains an in-flight worker: Released lands before stop() resolves", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;
  const ran: string[] = [];

  // A worker that blocks until its abort signal fires, then reports aborted — i.e. a task still
  // running when the peer is asked to shut down.
  const draining = (agentId: string): Worker => ({
    async run(_a, ctx) {
      ran.push(agentId);
      await new Promise<void>((res) => {
        if (ctx.signal.aborted) return res();
        ctx.signal.addEventListener("abort", () => res());
      });
      return { status: "aborted", summary: "drained on shutdown", reason: "cancelled" };
    },
  });

  const peer = createPeer({
    weave,
    cfg: { agentId: "agent-a", grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
    newWorker: () => draining("agent-a"),
    clock,
    timer: new ManualTimer(),
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "long job" } },
  });
  await settle();
  assert.equal(ran.length, 1, "peer started the task");
  assert.equal(
    (await collect(weave)).some((e) => e.subject === "task-1" && e.kind === TaskKind.Released),
    false,
    "no Released yet while the worker is mid-flight",
  );

  // The contract under test: stop() must DRAIN — it resolves only after the aborted worker has
  // appended its Released, so a caller that closes the substrate next won't strand the task as
  // "held by <dead agent>" until lease expiry.
  await peer.stop();

  const events = await collect(weave);
  const released = events.filter(
    (e) => e.kind === TaskKind.Released && e.subject === "task-1" && e.actor === "agent-a",
  );
  assert.equal(released.length, 1, "stop() drained the worker → exactly one Released on the log");
  assert.equal(currentHolder(events, "task-1", clock.now()), null, "task is no longer held after a graceful stop");
});

test("stall watchdog aborts a silent worker, retries via reclaim, then fails terminally", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  // A worker that emits NO progress and blocks until aborted — i.e. a hung subprocess. Counts runs.
  let runs = 0;
  const hung = (): Worker => ({
    async run(_a, ctx) {
      runs++;
      await new Promise<void>((res) => {
        if (ctx.signal.aborted) return res();
        ctx.signal.addEventListener("abort", () => res());
      });
      return { status: "aborted", summary: "stalled", reason: "cancelled" };
    },
  });

  const timer = new ManualTimer();
  const peer = createPeer({
    weave,
    // leaseMs high so the lease never expires — the ONLY thing that can free this task is the
    // stall watchdog. stallMs=50, maxStalls=1 → one retry, then terminal failure.
    cfg: { agentId: "agent-a", grant: GRANT, leaseMs: 10_000, maxConcurrent: 1, tickMs: 10, stallMs: 50, maxStalls: 1 },
    newWorker: () => hung(),
    clock,
    timer,
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "will hang" } },
  });
  await settle();
  assert.equal(runs, 1, "worker started");

  // No progress for > stallMs: the watchdog aborts (attempt 1 ≤ maxStalls) → Released → reclaimed.
  clock.set(60);
  timer.fire();
  await settle();
  assert.equal(runs, 2, "stalled task was aborted and reclaimed for a retry");

  // Still silent: attempt 2 > maxStalls → the peer gives up and fails it terminally.
  clock.set(120);
  timer.fire();
  await settle();

  const events = await collect(weave);
  assert.equal(runs, 2, "no further reclaim after terminal failure");
  assert.equal(isSettled(events, "task-1"), true, "task is terminal after exhausting stall retries");
  assert.equal(currentHolder(events, "task-1", clock.now()), null, "failed task has no holder");
  const failed = events.filter((e) => e.kind === TaskKind.Failed && e.subject === "task-1");
  assert.equal(failed.length, 1, "exactly one terminal Failed from the watchdog");
  assert.match((failed[0]?.payload as { error: string }).error, /no progress/);
  assert.ok(
    events.some((e) => e.kind === TaskKind.Progress && /stall watchdog/.test((e.payload as { note: string }).note)),
    "a stall-watchdog progress note was emitted",
  );

  ac.abort();
});

test("stall watchdog spares a worker that signals liveness but emits no progress notes", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;

  // A worker mid long-tool-call: it streams liveness (onActivity) but no user-facing progress
  // notes, and stays running until released. Without the liveness channel this looks identical to
  // the hung worker above and would be wrongly aborted.
  let captured: import("../ports/worker.js").WorkerContext | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const live = (): Worker => ({
    async run(_a, ctx) {
      captured = ctx;
      ctx.onActivity?.(); // alive at claim
      await gate;
      return { status: "completed", summary: "done" };
    },
  });

  const timer = new ManualTimer();
  const peer = createPeer({
    weave,
    // Same shape as the hung-worker test: lease never expires, so only the stall watchdog could
    // free this task. stallMs=50 — we advance well past it repeatedly while signaling liveness.
    cfg: { agentId: "agent-a", grant: GRANT, leaseMs: 10_000, maxConcurrent: 1, tickMs: 10, stallMs: 50, maxStalls: 1 },
    newWorker: () => live(),
    clock,
    timer,
    newId,
  });

  const ac = new AbortController();
  void peer.start(ac.signal);
  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "long quiet tool call" } },
  });
  await settle();

  // Advance far past stallMs three times; each step signals liveness at the new time just before
  // the watchdog ticks (mirroring a worker that streams output then the peer sweeps).
  for (const t of [60, 120, 180]) {
    clock.set(t);
    captured?.onActivity?.();
    timer.fire();
    await settle();
  }

  let events = await collect(weave);
  assert.equal(events.some((e) => e.kind === TaskKind.Failed && e.subject === "task-1"), false, "live worker not failed");
  assert.equal(
    events.some((e) => e.kind === TaskKind.Progress && /stall watchdog/.test((e.payload as { note: string }).note)),
    false,
    "no stall-watchdog abort note for a live worker",
  );
  assert.equal(isSettled(events, "task-1"), false, "task still running, not aborted");

  // Releasing the worker lets it complete normally.
  release();
  await settle();
  events = await collect(weave);
  assert.equal(isSettled(events, "task-1"), true, "task settles once the worker returns");
  assert.equal(events.some((e) => e.kind === TaskKind.Completed && e.subject === "task-1"), true, "completed cleanly");

  ac.abort();
});

test("task.cancel aborts the running worker and is terminal (no reclaim)", async () => {
  const clock = new FakeClock(0);
  const weave = new InProcessSubstrate(clock);
  let n = 0;
  const newId = () => `id-${++n}`;
  const ran: string[] = [];

  // A worker that blocks until its signal aborts — so a cancel event is what unblocks it.
  const abortable = (agentId: string): Worker => ({
    async run(_a, ctx) {
      ran.push(agentId);
      await new Promise<void>((res) => {
        if (ctx.signal.aborted) return res();
        ctx.signal.addEventListener("abort", () => res());
      });
      return { status: "aborted", summary: "cancelled", reason: "cancelled" };
    },
  });

  const mk = (agentId: string) =>
    createPeer({
      weave,
      cfg: { agentId, grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
      newWorker: () => abortable(agentId),
      clock,
      timer: new ManualTimer(),
      newId,
    });

  const ac = new AbortController();
  const a = mk("agent-a");
  const b = mk("agent-b"); // a second peer must NOT reclaim a cancelled task
  void a.start(ac.signal);
  void b.start(ac.signal);

  await weave.append({
    id: newId(),
    kind: TaskKind.Declared,
    actor: "client",
    subject: "task-1",
    payload: { spec: { goal: "long job" } },
  });
  await settle();
  assert.equal(ran.length, 1, "exactly one peer started the task");

  // Client requests a stop.
  await weave.append({
    id: newId(),
    kind: TaskKind.Cancel,
    actor: "client",
    subject: "task-1",
    payload: { reason: "user-stop" },
  });
  await settle();

  const events = await collect(weave);
  assert.equal(isSettled(events, "task-1"), true, "cancel is terminal — task is settled");
  assert.equal(currentHolder(events, "task-1", clock.now()), null, "cancelled task has no holder");
  assert.equal(ran.length, 1, "the other peer must not reclaim a cancelled task");

  ac.abort();
});
