// Bun-only test (uses bun:sqlite). Named *.bun-test.ts so the Node runner
// (`find src -name '*.test.ts'`) skips it. Run with: bun test (see scripts.test:bun).
import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { FakeClock } from "../../domain/clock.js";
import type { SealedEvent } from "../../domain/event.js";
import { BunSqliteSubstrate } from "./bun-sqlite-substrate.js";

const tmp = () => join(tmpdir(), `weave-bun-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
const rm = (f: string) => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(f + ext);
    } catch {
      /* best effort */
    }
  }
};

test("BunSqliteSubstrate: monotonic seq, idempotent append, durable reopen", async () => {
  const f = tmp();
  const clock = new FakeClock(1000);
  const sub = new BunSqliteSubstrate({ filename: f, clock });

  const a = await sub.append({ id: "e1", kind: "k", actor: "a", subject: "s", payload: { v: 1 } });
  clock.advance(5);
  const b = await sub.append({ id: "e2", kind: "k", actor: "a", subject: "s", payload: { v: 2 } });
  const dup = await sub.append({ id: "e1", kind: "k", actor: "a", subject: "s", payload: { v: 99 } });

  expect(a.seq).toBe(1);
  expect(a.ts).toBe(1000);
  expect(b.seq).toBe(2);
  expect(b.ts).toBe(1005);
  expect(dup.seq).toBe(1); // idempotent on id
  expect((dup.payload as { v: number }).v).toBe(1); // original wins
  expect(await sub.head()).toBe(2);
  sub.close();

  // Durable across reopen.
  const s2 = new BunSqliteSubstrate({ filename: f, clock });
  const seen: SealedEvent[] = [];
  for await (const e of s2.read(0)) seen.push(e);
  expect(seen.map((e) => e.id)).toEqual(["e1", "e2"]);
  s2.close();
  rm(f);
});

test("BunSqliteSubstrate: a second connection sees writes via poll", async () => {
  const f = tmp();
  const clock = new FakeClock(0);
  const writer = new BunSqliteSubstrate({ filename: f, clock });
  const reader = new BunSqliteSubstrate({ filename: f, clock, pollMs: 0 });
  try {
    const seen: string[] = [];
    reader.subscribe(0, (e) => seen.push(e.id));
    await writer.append({ id: "x1", kind: "k", actor: "a", subject: "s", payload: 0 });
    reader.poll();
    await writer.append({ id: "x2", kind: "k", actor: "a", subject: "s", payload: 0 });
    reader.poll();
    expect(seen).toEqual(["x1", "x2"]);
  } finally {
    writer.close();
    reader.close();
    rm(f);
  }
});
