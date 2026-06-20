import type { Substrate } from "../ports/substrate.js";
import { isPrunable } from "../ports/substrate.js";
import type { SealedEvent } from "../domain/event.js";
import { compact, SNAPSHOT_KIND } from "../domain/snapshot.js";

export interface CompactionResult {
  readonly settled: number; // settled subjects folded
  readonly targets: number; // findings retained (one per target)
  readonly pruned: number; // events deleted (0 if substrate can't prune)
  readonly upTo: number;
}

/**
 * Compact the weave (ADR-0007): fold settled subjects into a single `weave.snapshot` event
 * (condensation-as-an-event), then prune the folded events if the substrate supports it.
 * The snapshot is written BEFORE pruning, so settled status + latest findings survive.
 */
export async function compactWeave(
  weave: Substrate,
  newId: () => string,
  actor: string,
): Promise<CompactionResult> {
  const events: SealedEvent[] = [];
  for await (const e of weave.read(0)) events.push(e);

  const { payload, activeSubjects } = compact(events);

  await weave.append({ id: newId(), kind: SNAPSHOT_KIND, actor, subject: "*", payload });

  let pruned = 0;
  if (isPrunable(weave)) {
    // The new snapshot has seq > upTo, so it is never pruned. Active subjects are retained.
    pruned = await weave.prune(payload.upTo, activeSubjects);
  }

  return {
    settled: payload.settled.length,
    targets: Object.keys(payload.findings).length,
    pruned,
    upTo: payload.upTo,
  };
}
