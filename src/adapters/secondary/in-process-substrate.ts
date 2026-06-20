import type { Substrate, Subscription } from "../../ports/substrate.js";
import type { DraftEvent, SealedEvent, Offset } from "../../domain/event.js";
import type { Clock } from "../../domain/clock.js";

/**
 * In-memory, single-process Substrate (ADR-0002 §4). Strong total order via an in-memory
 * counter; the first adapter to ship. Not durable — for solo runs and tests.
 */
export class InProcessSubstrate implements Substrate {
  private readonly log: SealedEvent[] = [];
  private readonly byId = new Map<string, SealedEvent>();
  private readonly subscribers = new Set<(e: SealedEvent) => void>();
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  async append(event: DraftEvent): Promise<SealedEvent> {
    const existing = this.byId.get(event.id);
    if (existing) return existing; // C3: idempotent on id

    const sealed: SealedEvent = { ...event, seq: ++this.seq, ts: this.clock.now() };
    this.log.push(sealed);
    this.byId.set(sealed.id, sealed);
    // Snapshot subscribers so a handler that (un)subscribes mid-dispatch is well-defined.
    for (const notify of [...this.subscribers]) notify(sealed);
    return sealed;
  }

  async *read(from: Offset): AsyncIterable<SealedEvent> {
    for (const e of this.log) {
      if (e.seq >= from) yield e;
    }
  }

  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription {
    // Replay history at/after `from`, then attach for live events (C4).
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

  /** ADR-0007: drop folded events (seq <= beforeSeq, subject not retained). */
  async prune(beforeSeq: Offset, keepSubjects: ReadonlySet<string>): Promise<number> {
    const before = this.log.length;
    const kept = this.log.filter((e) => e.seq > beforeSeq || keepSubjects.has(e.subject));
    this.log.length = 0;
    this.log.push(...kept);
    this.byId.clear();
    for (const e of kept) this.byId.set(e.id, e);
    return before - kept.length;
  }
}
