import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeClock } from "../../domain/clock.js";
import type { SealedEvent } from "../../domain/event.js";
import { TaskKind } from "../../domain/task.js";
import { currentHolder } from "../../domain/claim.js";
import { NetworkedSubstrate } from "./networked-substrate.js";
import { InMemoryNetwork } from "./in-memory-network.js";

const collect = async (sub: NetworkedSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of sub.read(0)) out.push(e);
  return out;
};

const declared = (id: string, actor: string, subject: string) => ({
  id,
  kind: TaskKind.Declared,
  actor,
  subject,
  payload: { spec: { goal: "do it" } },
});

const claimed = (id: string, actor: string, subject: string) => ({
  id,
  kind: TaskKind.Claimed,
  actor,
  subject,
  payload: { leaseMs: 100_000 },
});

test("NetworkedSubstrate: a local append replicates to peers in the same group", async () => {
  const net = new InMemoryNetwork();
  const clock = new FakeClock(1000);
  const n1 = new NetworkedSubstrate("n1", clock, net.endpoint("n1"));
  const n2 = new NetworkedSubstrate("n2", clock, net.endpoint("n2"));

  await n1.append(declared("e1", "client", "task-1"));
  const onN2 = await collect(n2);
  assert.equal(onN2.length, 1);
  assert.equal(onN2[0]?.id, "e1");
  assert.equal(onN2[0]?.hlc?.node, "n1"); // origin HLC preserved across the wire
});

test("NetworkedSubstrate: dedup by id — a re-delivered event applies once (C3)", async () => {
  const net = new InMemoryNetwork();
  const clock = new FakeClock(0);
  const n1 = new NetworkedSubstrate("n1", clock, net.endpoint("n1"));
  const n2 = new NetworkedSubstrate("n2", clock, net.endpoint("n2"));

  const e = await n1.append(declared("dup", "client", "task-1"));
  // Re-deliver the same event straight into n2's transport handler.
  net.partition({ n1: "A", n2: "A" }); // same group
  // Force a second delivery by re-broadcasting from n1's endpoint.
  net.endpoint("n1").broadcast(e);

  const onN2 = await collect(n2);
  assert.equal(onN2.filter((x) => x.id === "dup").length, 1);
});

test("NetworkedSubstrate: partition → concurrent claims → heal → deterministic convergence", async () => {
  const net = new InMemoryNetwork();
  const clock = new FakeClock(1000); // shared clock → HLC ties broken by logical+nodeId
  const n1 = new NetworkedSubstrate("n1", clock, net.endpoint("n1"));
  const n2 = new NetworkedSubstrate("n2", clock, net.endpoint("n2"));

  // Task declared and replicated to both before the split.
  await n1.append(declared("d1", "client", "task-1"));

  // Split the network.
  net.partition({ n1: "A", n2: "B" });

  // Each side claims the same task independently — the transient double-claim (ADR-0009 §5).
  await n1.append(claimed("c1", "agent-1", "task-1"));
  await n2.append(claimed("c2", "agent-2", "task-1"));

  // Mid-partition the two sides disagree on the holder.
  const h1Before = currentHolder(await collect(n1), "task-1", 1000);
  const h2Before = currentHolder(await collect(n2), "task-1", 1000);
  assert.equal(h1Before?.agentId, "agent-1");
  assert.equal(h2Before?.agentId, "agent-2");
  assert.notEqual(h1Before?.agentId, h2Before?.agentId);

  // Heal: buffered claims cross, dedup applies, both logs hold all 3 events.
  net.heal();
  const log1 = await collect(n1);
  const log2 = await collect(n2);
  assert.equal(log1.length, 3);
  assert.equal(log2.length, 3);

  // Both nodes now compute the SAME deterministic winner (HLC order).
  const h1After = currentHolder(log1, "task-1", 1000);
  const h2After = currentHolder(log2, "task-1", 1000);
  assert.equal(h1After?.agentId, h2After?.agentId, "nodes converge on one holder");
  assert.equal(h1After?.agentId, "agent-1", "lowest HLC (node n1) wins deterministically");

  // The loser (agent-2) can see, from n2's own converged log, that it no longer holds it
  // → its worker would abort lease-lost (ADR-0003 §2), safe per ADR-0002 abortability.
  assert.notEqual(h2After?.agentId, "agent-2");
});
