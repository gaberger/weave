import type { SealedEvent } from "./event.js";
import { TaskKind, type LeasePayload } from "./task.js";

/** Who currently holds a subject's claim. */
export interface Holder {
  readonly agentId: string;
  readonly claimSeq: number;
  readonly leaseUntil: number;
}

/**
 * Pure projection of the claim protocol (ADR-0002 §3.1): given the log and a wall-clock
 * `now`, return the holder of `subject`, or `null` if it is free/reclaimable.
 *
 * Rules:
 *  - The earliest valid `task.claimed` (lowest seq) holds, until a terminal event by the
 *    holder or until the lease expires.
 *  - `lease.renewed` by the holder extends the window.
 *  - On expiry, a later claim may take over — so expiry is evaluated against each
 *    subsequent event's `ts`, not only against `now`.
 *
 * Because the substrate gives a total order, every peer computes the same holder.
 */
export function currentHolder(
  events: readonly SealedEvent[],
  subject: string,
  now: number,
): Holder | null {
  const ev = events
    .filter((e) => e.subject === subject)
    .sort((a, b) => a.seq - b.seq);

  let holder: Holder | null = null;

  for (const e of ev) {
    // Free the holder if its lease lapsed before this event happened.
    if (holder !== null && holder.leaseUntil < e.ts) holder = null;

    switch (e.kind) {
      case TaskKind.Claimed: {
        if (holder === null) {
          const { leaseMs } = e.payload as LeasePayload;
          holder = { agentId: e.actor, claimSeq: e.seq, leaseUntil: e.ts + leaseMs };
        }
        // A later claim while held is a lost race: inert (stays in the log).
        break;
      }
      case TaskKind.LeaseRenewed: {
        if (holder !== null && e.actor === holder.agentId) {
          const { leaseMs } = e.payload as LeasePayload;
          holder = {
            agentId: holder.agentId,
            claimSeq: holder.claimSeq,
            leaseUntil: e.ts + leaseMs,
          };
        }
        break;
      }
      case TaskKind.Completed:
      case TaskKind.Failed:
      case TaskKind.Released: {
        if (holder !== null && e.actor === holder.agentId) holder = null;
        break;
      }
      default:
        break;
    }
  }

  if (holder !== null && holder.leaseUntil < now) return null;
  return holder;
}
