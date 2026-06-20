/** Effect taxonomy (ADR-0004 §1). Unknown/untagged tools are treated as `irreversible`
 *  so the lease gate fails closed. */
export type Effect = "read" | "reversible" | "irreversible";

/** Total order for capability-ceiling comparisons: read < reversible < irreversible. */
export const EFFECT_RANK: Record<Effect, number> = {
  read: 0,
  reversible: 1,
  irreversible: 2,
};

/** Normalize a possibly-absent effect to the fail-closed default. */
export function normalizeEffect(e: Effect | undefined): Effect {
  return e ?? "irreversible";
}

/** True if `effect` is allowed under a `maxEffect` ceiling (ADR-0004 §3). */
export function withinCeiling(effect: Effect, ceiling: Effect): boolean {
  return EFFECT_RANK[effect] <= EFFECT_RANK[ceiling];
}
