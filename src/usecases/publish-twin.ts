import type { Substrate } from "../ports/substrate.js";
import type { AgentId } from "../domain/ids.js";
import { TwinKind, type TwinGraph } from "../domain/twin.js";

/**
 * Publish a network view onto the weave (emits `twin.graph`, ADR-0025). The event's subject is the
 * graph's `view`, so the blackboard keeps the latest graph per view (re-publishing a view is a live
 * update, not an append that piles up). Read-only observers (the SSE surface) push it to the canvas;
 * it declares no work and holds no authority.
 */
export async function publishTwin(
  weave: Substrate,
  newId: () => string,
  actor: AgentId,
  graph: TwinGraph,
): Promise<void> {
  await weave.append({
    id: newId(),
    kind: TwinKind.Graph,
    actor,
    subject: graph.view,
    payload: graph,
  });
}
