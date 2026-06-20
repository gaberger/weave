import type { DraftEvent, SealedEvent, Offset } from "../domain/event.js";

export interface Subscription {
  unsubscribe(): void;
}

/**
 * The shared append-only event log ("the weave"). ADR-0002 §2.
 *
 * Contract every adapter MUST honour:
 *  - C1 total order: all consumers observe events in the same `seq` order.
 *  - C2 monotonic, gap-tolerant `seq`.
 *  - C3 idempotent append on `event.id`.
 *  - C4 read/subscribe agreement.
 *  - C5 adapter-declared durability.
 */
export interface Substrate {
  /** Append an event; substrate assigns seq + ts. Re-appending a known id returns the
   *  existing SealedEvent (C3). */
  append(event: DraftEvent): Promise<SealedEvent>;

  /** Replay historical events with seq >= `from`, in order. */
  read(from: Offset): AsyncIterable<SealedEvent>;

  /** Deliver every event with seq >= `from` in order, including future ones. */
  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription;

  /** seq of the latest event, or 0 if empty. */
  head(): Promise<Offset>;
}
