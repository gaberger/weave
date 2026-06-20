import type { Substrate, Subscription } from "../../ports/substrate.js";
import type { ReplicationTransport } from "../../ports/replication-transport.js";
import type { DraftEvent, SealedEvent, Offset } from "../../domain/event.js";
import type { Clock } from "../../domain/clock.js";
import { HybridClock } from "../../domain/hlc.js";

/**
 * Multi-writer, eventually-consistent Substrate over a replicated log (ADR-0009).
 *
 * `seq` is a node-LOCAL append index (delivery cursor) — the same logical event has
 * different `seq` on different nodes. The global conflict-resolution order is the HLC
 * stamp each event carries, assigned once by its origin node and preserved across the
 * wire. `currentHolder` orders by HLC, so all nodes converge once they hold the same
 * events. Convergence rests on **dedup by `event.id`** (C3).
 */
export class NetworkedSubstrate implements Substrate {
  private readonly log: SealedEvent[] = [];
  private readonly byId = new Map<string, SealedEvent>();
  private readonly subscribers = new Set<(e: SealedEvent) => void>();
  private readonly hlc: HybridClock;
  private seq = 0;

  constructor(
    private readonly nodeId: string,
    private readonly clock: Clock,
    private readonly transport: ReplicationTransport,
  ) {
    this.hlc = new HybridClock(clock, nodeId);
    this.transport.onReceive((e) => this.receive(e));
  }

  async append(event: DraftEvent): Promise<SealedEvent> {
    const existing = this.byId.get(event.id);
    if (existing) return existing; // C3 idempotent

    const sealed: SealedEvent = {
      ...event,
      seq: ++this.seq,
      ts: this.clock.now(),
      hlc: this.hlc.tick(),
    };
    this.apply(sealed);
    this.transport.broadcast(sealed);
    return sealed;
  }

  /** Apply an event received from a peer. Dedup-by-id, advance the local HLC, then assign
   *  a fresh LOCAL seq while preserving the event's origin HLC/ts. */
  private receive(remote: SealedEvent): void {
    if (this.byId.has(remote.id)) return; // dedup — the convergence keystone (C3)
    if (remote.hlc !== undefined) this.hlc.update(remote.hlc);
    const local: SealedEvent = { ...remote, seq: ++this.seq };
    this.apply(local);
    // No re-broadcast: the transport owns fan-out / anti-entropy.
  }

  private apply(e: SealedEvent): void {
    this.log.push(e);
    this.byId.set(e.id, e);
    for (const notify of [...this.subscribers]) notify(e);
  }

  async *read(from: Offset): AsyncIterable<SealedEvent> {
    for (const e of this.log) {
      if (e.seq >= from) yield e;
    }
  }

  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription {
    for (const e of this.log) {
      if (e.seq >= from) handler(e);
    }
    this.subscribers.add(handler);
    return {
      unsubscribe: () => {
        this.subscribers.delete(handler);
      },
    };
  }

  async head(): Promise<Offset> {
    return this.seq;
  }
}
