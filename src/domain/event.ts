import type { AgentId, EventId } from "./ids.js";

/** An event before the substrate seals it (ADR-0002 §1). `id` is the publisher-set
 *  idempotency key; `seq`/`ts` are assigned on append. */
export interface DraftEvent {
  readonly id: EventId;
  readonly kind: string;
  readonly actor: AgentId;
  /** The work/topic this event concerns (e.g. a task id). */
  readonly subject: string;
  /** id of the event this reacts to (provenance), if any. */
  readonly causedBy?: string;
  readonly payload: unknown;
}

/** An event after the substrate assigns total order + wall clock. Immutable. */
export interface SealedEvent extends DraftEvent {
  /** Substrate-assigned total order. Strictly increasing, may have gaps (C2). */
  readonly seq: number;
  /** Substrate-assigned wall clock (epoch ms). */
  readonly ts: number;
}

/** A seq cursor. 0 means "from the beginning"; the first real event has seq 1. */
export type Offset = number;
