import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { FakeClock } from "../domain/clock.js";
import type { Substrate } from "../ports/substrate.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import { currentHolder, isSettled } from "../domain/claim.js";
import { compact, SNAPSHOT_KIND } from "../domain/snapshot.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { SqliteSubstrate } from "../adapters/secondary/sqlite-substrate.js";
import { compactWeave } from "./compaction.js";

async function settledTask(sub: Substrate, ids: () => string, subject: string): Promise<void> {
  await sub.append({ id: ids(), kind: TaskKind.Declared, actor: "cli", subject, payload: { spec: { goal: "g" } } });
  await sub.append({ id: ids(), kind: TaskKind.Claimed, actor: "p", subject, payload: { leaseMs: 1000 } });
  await sub.append({ id: ids(), kind: TaskKind.Completed, actor: "p", subject, payload: { summary: "done" } });
}

async function activeTask(sub: Substrate, ids: () => string, subject: string): Promise<void> {
  await sub.append({ id: ids(), kind: TaskKind.Declared, actor: "cli", subject, payload: { spec: { goal: "g" } } });
  await sub.append({ id: ids(), kind: TaskKind.Claimed, actor: "p", subject, payload: { leaseMs: 1000 } });
}

const readAll = async (sub: Substrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of sub.read(0)) out.push(e);
  return out;
};

test("compact: folds settled subjects, keeps active", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1");
  await activeTask(sub, () => `e${++n}`, "live-1");

  const { payload, activeSubjects } = compact(await readAll(sub));
  assert.deepEqual([...payload.settled].sort(), ["done-1"]);
  assert.ok(activeSubjects.has("live-1"));
});

test("compactWeave: shrinks the log but preserves settled state (snapshot-aware)", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1");
  await settledTask(sub, () => `e${++n}`, "done-2");
  await activeTask(sub, () => `e${++n}`, "live-1");

  const before = (await readAll(sub)).length;
  const r = await compactWeave(sub, () => `s${++n}`, "compactor");
  const after = await readAll(sub);

  assert.equal(r.settled, 2);
  assert.ok(after.length < before, "log shrank");
  assert.equal(after.some((e) => e.subject === "done-1" && e.kind !== SNAPSHOT_KIND), false);
  assert.equal(isSettled(after, "done-1"), true);
  assert.equal(currentHolder(after, "done-1", 0), null);
  assert.equal(after.some((e) => e.subject === "live-1"), true);
  assert.equal(currentHolder(after, "live-1", 0)?.agentId, "p");
});

test("compactWeave: a second pass keeps settled folded (one snapshot)", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1");
  await compactWeave(sub, () => `s${++n}`, "c");
  await compactWeave(sub, () => `s${++n}`, "c");
  const after = await readAll(sub);
  assert.equal(isSettled(after, "done-1"), true);
  assert.equal(after.filter((e) => e.kind === SNAPSHOT_KIND).length, 1);
});

test("SqliteSubstrate.prune deletes folded events on disk", async () => {
  const f = join(tmpdir(), `weave-compact-${process.pid}-${Date.now()}.db`);
  let n = 0;
  const sub = new SqliteSubstrate({ filename: f, clock: new FakeClock(0) });
  try {
    await settledTask(sub, () => `e${++n}`, "done-1");
    await activeTask(sub, () => `e${++n}`, "live-1");
    const before = (await readAll(sub)).length;
    const r = await compactWeave(sub, () => `s${++n}`, "c");
    const after = await readAll(sub);
    assert.ok(r.pruned > 0);
    assert.ok(after.length < before);
    assert.equal(isSettled(after, "done-1"), true);
    assert.equal(currentHolder(after, "live-1", 0)?.agentId, "p");
  } finally {
    sub.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(f + ext);
      } catch {
        /* ignore */
      }
    }
  }
});
