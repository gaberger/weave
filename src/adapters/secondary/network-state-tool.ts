import type { ToolDefinition } from "../../ports/tool-host.js";
import type { Substrate } from "../../ports/substrate.js";
import type { SealedEvent } from "../../domain/event.js";
import { reduceContext } from "../../domain/context.js";

/** A read-effect tool exposing the reduced network state (ADR-0013 §2). Substrate-bound at
 *  composition, since a skill can't hold the substrate itself. Lets any skill — including the
 *  Claude agent — get the compacted view (one entry per target) instead of raw history. */
export function networkStateTool(weave: Substrate): ToolDefinition {
  return {
    name: "network_state",
    description: "Return the current reduced network state: one finding per target + rollup totals.",
    effect: "read",
    inputSchema: {},
    execute: async () => {
      const events: SealedEvent[] = [];
      for await (const e of weave.read(0)) events.push(e);
      return { ok: true, output: reduceContext(events) };
    },
  };
}
