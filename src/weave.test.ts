import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "./domain/clock.js";
import type { DraftEvent, SealedEvent } from "./domain/event.js";
import { TaskKind } from "./domain/task.js";
import { currentHolder } from "./domain/claim.js";
import { InProcessSubstrate } from "./adapters/secondary/in-process-substrate.js";

const draft = (over: Partial<DraftEvent> & Pick<DraftEvent, "id">): DraftEvent => ({
  kind: "test.event",
  actor: "agent-a",
  subject: "task-1",
  payload: {},
  ...over,
});

test("InProcessSubstrate: append assigns monotonic seq + clock ts", async () => {
  const clock = new FakeClock(1000);
  const sub = new InProcessSubstrate(clock);

  const a = await sub.append(draft({ id: "e1" }));
  clock.advance(5);
  const b = await sub.append(draft({ id: "e2" }));

  assert.equal(a.seq, 1);
  assert.equal(a.ts, 1000);
  assert.equal(b.seq, 2);
  assert.equal(b.ts, 1005);
  assert.equal(await sub.head(), 2);
});

test("InProcessSubstrate: append is idempotent on id (C3)", async () => {
  const sub = new InProcessSubstrate(new FakeClock(0));
  const first = await sub.append(draft({ id: "dup", payload: { v: 1 } }));
  const second = await sub.append(draft({ id: "dup", payload: { v: 2 } }));

  assert.equal(second.seq, first.seq);
  assert.deepEqual(second.payload, { v: 1 }); // original wins
  assert.equal(await sub.head(), 1);
});

test("InProcessSubstrate: read(from) yields seq >= from in order (C4)", async () => {
  const sub = new InProcessSubstrate(new FakeClock(0));
  for (const id of ["e1", "e2", "e3"]) await sub.append(draft({ id }));

  const seen: number[] = [];
  for await (const e of sub.read(2)) seen.push(e.seq);
  assert.deepEqual(seen, [2, 3]);
});

test("InProcessSubstrate: subscribe replays history then delivers live events", async () => {
  const sub = new InProcessSubstrate(new FakeClock(0));
  await sub.append(draft({ id: "past" }));

  const seen: string[] = [];
  const subscription = sub.subscribe(0, (e) => seen.push(e.id));
  await sub.append(draft({ id: "live" }));

  assert.deepEqual(seen, ["past", "live"]);
  subscription.unsubscribe();
  await sub.append(draft({ id: "after-unsub" }));
  assert.deepEqual(seen, ["past", "live"]);
});

// ---- claim projection (ADR-0002 §3.1) -------------------------------------

const claim = (
  seq: number,
  ts: number,
  actor: string,
  kind: string,
  leaseMs = 100,
): SealedEvent => ({
  id: `${kind}-${seq}`,
  kind,
  actor,
  subject: "task-1",
  payload: { leaseMs },
  seq,
  ts,
});

test("currentHolder: earliest valid claim wins a race (lowest seq)", () => {
  const log = [
    claim(1, 0, "agent-a", TaskKind.Claimed),
    claim(2, 0, "agent-b", TaskKind.Claimed),
  ];
  const h = currentHolder(log, "task-1", 10);
  assert.equal(h?.agentId, "agent-a");
  assert.equal(h?.claimSeq, 1);
});

test("currentHolder: expired lease frees the task (reclaimable)", () => {
  const log = [claim(1, 0, "agent-a", TaskKind.Claimed, 100)];
  assert.equal(currentHolder(log, "task-1", 50)?.agentId, "agent-a"); // within lease
  assert.equal(currentHolder(log, "task-1", 150), null); // lease lapsed
});

test("currentHolder: a later claim takes over after the prior lease expires", () => {
  const log = [
    claim(1, 0, "agent-a", TaskKind.Claimed, 100),
    claim(2, 200, "agent-b", TaskKind.Claimed, 100), // after A's lease lapsed at 100
  ];
  const h = currentHolder(log, "task-1", 250);
  assert.equal(h?.agentId, "agent-b");
});

test("currentHolder: renewal extends the holder's lease", () => {
  const log = [
    claim(1, 0, "agent-a", TaskKind.Claimed, 100),
    claim(2, 80, "agent-a", TaskKind.LeaseRenewed, 100), // extends to 180
  ];
  assert.equal(currentHolder(log, "task-1", 150)?.agentId, "agent-a");
});

test("currentHolder: terminal event by holder frees the task", () => {
  const log = [
    claim(1, 0, "agent-a", TaskKind.Claimed, 100),
    claim(2, 10, "agent-a", TaskKind.Completed),
  ];
  assert.equal(currentHolder(log, "task-1", 20), null);
});

test("currentHolder: a non-holder's release is ignored", () => {
  const log = [
    claim(1, 0, "agent-a", TaskKind.Claimed, 100),
    claim(2, 10, "agent-b", TaskKind.Released),
  ];
  assert.equal(currentHolder(log, "task-1", 20)?.agentId, "agent-a");
});

test("currentHolder: free when no events", () => {
  assert.equal(currentHolder([], "task-1", 0), null);
});
