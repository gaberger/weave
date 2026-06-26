// Federated convergence demo (run via tsx). The CLI always wires a local SQLite substrate, so this
// shows the federated story at the substrate level: two hosts replicate one log; a partition lets
// each claim the same task; on heal the logs converge on ONE deterministic winner (ADR-0009).
import { FakeClock } from "../src/domain/clock.js";
import { TaskKind } from "../src/domain/task.js";
import { currentHolder } from "../src/domain/claim.js";
import type { SealedEvent } from "../src/domain/event.js";
import { NetworkedSubstrate } from "../src/adapters/secondary/networked-substrate.js";
import { InMemoryNetwork } from "../src/adapters/secondary/in-memory-network.js";

const collect = async (s: NetworkedSubstrate): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of s.read(0)) out.push(e);
  return out;
};
const who = async (s: NetworkedSubstrate): Promise<string> =>
  currentHolder(await collect(s), "task-1", 1000)?.agentId ?? "(none)";

const net = new InMemoryNetwork();
const clock = new FakeClock(1000);
const n1 = new NetworkedSubstrate("n1", clock, net.endpoint("n1"));
const n2 = new NetworkedSubstrate("n2", clock, net.endpoint("n2"));

console.log("   two hosts (n1, n2) share one peer-to-peer replicated log\n");

await n1.append({ id: "d1", kind: TaskKind.Declared, actor: "client", subject: "task-1", payload: { spec: { goal: "do it" } } });
console.log(`   • task-1 declared on n1 → replicated to n2 (n2 now sees ${(await collect(n2)).length} event)\n`);

console.log("   ✂  PARTITION — n1 and n2 can no longer reach each other");
net.partition({ n1: "A", n2: "B" });
await n1.append({ id: "c1", kind: TaskKind.Claimed, actor: "agent-1", subject: "task-1", payload: { leaseMs: 100_000 } });
await n2.append({ id: "c2", kind: TaskKind.Claimed, actor: "agent-2", subject: "task-1", payload: { leaseMs: 100_000 } });
console.log("      each side claims task-1 independently (a transient double-claim):");
console.log(`        n1 says holder = ${await who(n1)}`);
console.log(`        n2 says holder = ${await who(n2)}   ←  they DISAGREE\n`);

console.log("   🔗 HEAL — buffered events cross, dedup by id applies");
net.heal();
const l1 = await collect(n1), l2 = await collect(n2);
const h1 = await who(n1), h2 = await who(n2);
console.log(`      both logs now hold all events  (n1: ${l1.length}, n2: ${l2.length})`);
console.log(`        n1 says holder = ${h1}`);
console.log(`        n2 says holder = ${h2}   ←  they CONVERGE`);

const okConverged = h1 === h2 && l1.length === 3 && l2.length === 3 && h1 === "agent-1";
console.log(
  okConverged
    ? "\n   ✓ both nodes pick the lowest-HLC claim (agent-1) — deterministic, no coordinator."
    : "\n   ✗ unexpected divergence",
);
console.log("     the loser (agent-2) sees from its own converged log that it no longer holds the");
console.log("     task → its worker aborts lease-lost, which is safe because effects are abortable.");
process.exit(okConverged ? 0 : 1);
