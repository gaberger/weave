import type { Effect } from "./effect.js";

/** A per-worker capability grant (ADR-0004 §3). Default-deny: a worker gets exactly
 *  what its peer config grants. `maxEffect` is the ceiling that also implements the
 *  non-interceptable-backend cap from ADR-0003 §6. */
export interface Grant {
  /** Allowlisted tool names, or "*" for every registered tool. */
  readonly tools: readonly string[] | "*";
  /** Tools whose effect outranks this are excluded from `available()`. */
  readonly maxEffect: Effect;
}
