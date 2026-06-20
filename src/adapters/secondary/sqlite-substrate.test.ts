import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { FakeClock } from "../../domain/clock.js";
import type { Grant } from "../../domain/grant.js";
import type { SealedEvent } from "../../domain/event.js";
import type { Worker } from "../../ports/worker.js";
import { TaskKind } from "../../domain/task.js";
import { ManualTimer } from "./manual-timer.js";
import { SqliteSubstrate } from "./sqlite-substrate.js";
import { createPeer } from "../../composition-root.js";

let fileCounter = 0;
const tmpFile = (): string => join(tmpdir(), `weave-sqlite-${process.pid}-${++fileCounter}.db`);
const cleanup = (f: string): void => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(f + ext);
    } catch {
      /* best effort */
    }
  }
};
const ev = (id: string, over: Partial<SealedEvent> = {}) => ({
  id,
  kind: "k",
  actor: "a",
  subject: "s",
  payload: 0 as unknown,
  ...over,
});

test("SqliteSubstrate: monotonic seq, clock ts, idempotent on id (C2/C3)", async () => {
  const f = tmpFile();
  const clock = new FakeClock(1000);
  const sub = new SqliteSubstrate({ filename: f, clock });
  try {
    const a = await sub.append(ev("e1", { payload: { v: 1 } }));
    clock.advance(5);
    const b = await sub.append(ev("e2", { payload: { v: 2 } }));
    const dup = await sub.append(ev("e1", { payload: { v: 99 } })); // same id

    assert.equal(a.seq, 1);
    assert.equal(a.ts, 1000);
    assert.equal(b.seq, 2);
    assert.equal(b.ts, 1005);
    assert.equal(dup.seq, 1);
    assert.deepEqual(dup.payload, { v: 1 }); // original wins
    assert.equal(await sub.head(), 2);
  } finally {
    sub.close();
    cleanup(f);
  }
});

test("SqliteSubstrate: durable across reopen", async () => {
  const f = tmpFile();
  const clock = new FakeClock(0);
  const s1 = new SqliteSubstrate({ filename: f, clock });
  await s1.append(ev("x", { causedBy: "root" }));
  s1.close();

  const s2 = new SqliteSubstrate({ filename: f, clock });
  try {
    const seen: SealedEvent[] = [];
    for await (const e of s2.read(0)) seen.push(e);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, "x");
    assert.equal(seen[0]?.causedBy, "root");
    assert.equal(await s2.head(), 1);
  } finally {
    s2.close();
    cleanup(f);
  }
});

test("SqliteSubstrate: a second connection sees the first's writes (cross-process proxy)", async () => {
  const f = tmpFile();
  const clock = new FakeClock(0);
  const writer = new SqliteSubstrate({ filename: f, clock });
  const reader = new SqliteSubstrate({ filename: f, clock, pollMs: 0 }); // manual poll
  try {
    const seen: string[] = [];
    reader.subscribe(0, (e) => seen.push(e.id));

    await writer.append(ev("live-1"));
    reader.poll();
    assert.deepEqual(seen, ["live-1"]);

    await writer.append(ev("live-2"));
    reader.poll();
    assert.deepEqual(seen, ["live-1", "live-2"]);
  } finally {
    writer.close();
    reader.close();
    cleanup(f);
  }
});

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };
const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

test("PeerLoop runs unchanged over SqliteSubstrate: two peers, one task, one runs", async () => {
  const f = tmpFile();
  const clock = new FakeClock(0);
  const weave = new SqliteSubstrate({ filename: f, clock, pollMs: 0 }); // drive delivery manually
  let n = 0;
  const newId = () => `id-${++n}`;
  const ran: string[] = [];

  const recordingWorker = (agentId: string): Worker => ({
    async run() {
      ran.push(agentId);
      return { status: "completed", summary: `${agentId} done` };
    },
  });
  const mk = (agentId: string) =>
    createPeer({
      weave,
      cfg: { agentId, grant: GRANT, leaseMs: 1000, maxConcurrent: 1, tickMs: 100 },
      newWorker: () => recordingWorker(agentId),
      clock,
      timer: new ManualTimer(),
      newId,
    });

  const ac = new AbortController();
  try {
    void mk("agent-a").start(ac.signal);
    void mk("agent-b").start(ac.signal);

    await weave.append({
      id: newId(),
      kind: TaskKind.Declared,
      actor: "client",
      subject: "task-1",
      payload: { spec: { goal: "do it" } },
    });
    weave.poll(); // deliver task.declared to both peers
    await settle();

    assert.equal(ran.length, 1, "exactly one peer ran the task (over SQLite)");
    const completed: SealedEvent[] = [];
    for await (const e of weave.read(0)) {
      if (e.kind === TaskKind.Completed && e.subject === "task-1") completed.push(e);
    }
    assert.equal(completed.length, 1, "exactly one task.completed persisted in SQLite");
    assert.equal(completed[0]?.actor, ran[0]);
  } finally {
    ac.abort();
    weave.close();
    cleanup(f);
  }
});
