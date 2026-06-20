import type { ReplicationTransport } from "../../ports/replication-transport.js";
import type { SealedEvent } from "../../domain/event.js";

interface Node {
  handler: (e: SealedEvent) => void;
  group: string;
}

/**
 * A partitionable in-memory replication network for tests (ADR-0009 §4). Nodes in the same
 * group receive each other's broadcasts synchronously; cross-group broadcasts are buffered
 * and flushed on `heal()` — modelling a network partition and its recovery. Deterministic:
 * delivery is synchronous, so no real timers/clocks are involved.
 */
export class InMemoryNetwork {
  private readonly nodes = new Map<string, Node>();
  private buffer: Array<{ to: string; event: SealedEvent }> = [];

  /** Register a node and get its transport endpoint. */
  endpoint(nodeId: string, group = "main"): ReplicationTransport {
    this.nodes.set(nodeId, { handler: () => {}, group });
    return {
      broadcast: (event) => this.dispatch(nodeId, event),
      onReceive: (handler) => {
        const n = this.nodes.get(nodeId);
        if (n) n.handler = handler;
      },
    };
  }

  /** Reassign nodes to partition groups, e.g. `{ n1: "A", n2: "B" }`. */
  partition(groups: Record<string, string>): void {
    for (const [id, g] of Object.entries(groups)) {
      const n = this.nodes.get(id);
      if (n) n.group = g;
    }
  }

  /** Reunite all nodes into one group and flush everything buffered during the split. */
  heal(group = "main"): void {
    for (const n of this.nodes.values()) n.group = group;
    const pending = this.buffer;
    this.buffer = [];
    for (const { to, event } of pending) this.nodes.get(to)?.handler(event);
  }

  private dispatch(from: string, event: SealedEvent): void {
    const fromGroup = this.nodes.get(from)?.group;
    for (const [id, n] of this.nodes) {
      if (id === from) continue;
      if (n.group === fromGroup) n.handler(event);
      else this.buffer.push({ to: id, event });
    }
  }
}
