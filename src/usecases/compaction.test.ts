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
import { compact, SNAPSHOT_KIND, type SnapshotPayload } from "../domain/snapshot.js";
import { diffFinding, type ProbeFinding } from "../domain/interrogation.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { SqliteSubstrate } from "../adapters/secondary/sqlite-substrate.js";
import { compactWeave } from "./compaction.js";

const finding = (target: string, status: number): ProbeFinding => ({
  target,
  status,
  ms: 1,
  healthy: status >= 200 && status < 400,
  violated: false,
  ok: status >= 200 && status < 400,
});

async function settledTask(sub: Substrate, ids: () => string, subject: string, f?: ProbeFinding): Promise<void> {
  await sub.append({ id: ids(), kind: TaskKind.Declared, actor: "cli", subject, payload: { spec: { goal: "g" } } });
  await sub.append({ id: ids(), kind: TaskKind.Claimed, actor: "p", subject, payload: { leaseMs: 1000 } });
  await sub.append({
    id: ids(),
    kind: TaskKind.Completed,
    actor: "p",
    subject,
    payload: { summary: "done", artifacts: f ? [{ kind: "probe", ref: JSON.stringify(f) }] : [] },
  });
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

test("compact: folds settled subjects, keeps active, retains finding per target", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1", finding("t1", 200));
  await activeTask(sub, () => `e${++n}`, "live-1");

  const { payload, activeSubjects } = compact(await readAll(sub));
  assert.deepEqual([...payload.settled].sort(), ["done-1"]);
  assert.ok(activeSubjects.has("live-1"));
  assert.equal(payload.findings["t1"]?.status, 200);
});

test("compactWeave: shrinks the log but preserves settled state (snapshot-aware)", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1", finding("t1", 200));
  await settledTask(sub, () => `e${++n}`, "done-2");
  await activeTask(sub, () => `e${++n}`, "live-1");

  const before = (await readAll(sub)).length;
  const r = await compactWeave(sub, () => `s${++n}`, "compactor");
  const after = await readAll(sub);

  assert.equal(r.settled, 2);
  assert.equal(r.targets, 1);
  assert.ok(after.length < before, "log shrank");

  // settled subjects: raw events pruned, but still settled via the snapshot event
  assert.equal(after.some((e) => e.subject === "done-1" && e.kind !== SNAPSHOT_KIND), false);
  assert.equal(isSettled(after, "done-1"), true);
  assert.equal(currentHolder(after, "done-1", 0), null);

  // active subject retained and still projects as held
  assert.equal(after.some((e) => e.subject === "live-1"), true);
  assert.equal(isSettled(after, "live-1"), false);
  assert.equal(currentHolder(after, "live-1", 0)?.agentId, "p");

  // snapshot carries the finding
  const snap = after.find((e) => e.kind === SNAPSHOT_KIND)?.payload as SnapshotPayload;
  assert.equal(snap.findings["t1"]?.status, 200);
});

test("compactWeave is idempotent-ish: a second pass keeps settled folded", async () => {
  let n = 0;
  const sub = new InProcessSubstrate(new FakeClock(0));
  await settledTask(sub, () => `e${++n}`, "done-1", finding("t1", 200));
  await compactWeave(sub, () => `s${++n}`, "c");
  await compactWeave(sub, () => `s${++n}`, "c");
  const after = await readAll(sub);
  assert.equal(isSettled(after, "done-1"), true);
  // only one snapshot retained (old one pruned)
  assert.equal(after.filter((e) => e.kind === SNAPSHOT_KIND).length, 1);
});

test("SqliteSubstrate.prune deletes folded events on disk", async () => {
  const f = join(tmpdir(), `weave-compact-${process.pid}-${Date.now()}.db`);
  let n = 0;
  const sub = new SqliteSubstrate({ filename: f, clock: new FakeClock(0) });
  try {
    await settledTask(sub, () => `e${++n}`, "done-1", finding("t1", 200));
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

test("diffFinding: new vs stable vs changed", () => {
  assert.equal(diffFinding(undefined, finding("t", 200)).changed, true);
  assert.equal(diffFinding(undefined, finding("t", 200)).from, undefined);
  assert.equal(diffFinding(finding("t", 200), finding("t", 200)).changed, false);
  const d = diffFinding(finding("t", 200), finding("t", 503));
  assert.equal(d.changed, true);
  assert.equal(d.from, 200);
  assert.equal(d.to, 503);
});
