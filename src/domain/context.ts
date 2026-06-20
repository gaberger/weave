import type { SealedEvent } from "./event.js";
import { compact } from "./snapshot.js";
import { findingTag } from "./interrogation.js";

/** Current state of one interrogated target. */
export interface TargetState {
  readonly target: string;
  readonly status: number;
  readonly ok: boolean;
  readonly tag: string;
  readonly ms: number;
}

/** A token-efficient view of the weave (ADR-0013): O(targets), not O(history). */
export interface ReducedContext {
  readonly targets: readonly TargetState[];
  readonly totals: {
    readonly targets: number;
    readonly healthy: number;
    readonly unhealthy: number;
    readonly unreachable: number;
    readonly violations: number;
  };
}

/** Fold the log into the reduced view. Pure — reuses compaction's finding-per-target map. */
export function reduceContext(events: readonly SealedEvent[]): ReducedContext {
  const { payload } = compact(events);
  const targets: TargetState[] = Object.values(payload.findings).map((f) => ({
    target: f.target,
    status: f.status,
    ok: f.ok,
    tag: findingTag(f),
    ms: f.ms,
  }));

  let healthy = 0;
  let unhealthy = 0;
  let unreachable = 0;
  let violations = 0;
  for (const f of Object.values(payload.findings)) {
    if (f.status === 0) unreachable += 1;
    else if (f.violated) violations += 1;
    else if (!f.healthy) unhealthy += 1;
    if (f.ok) healthy += 1;
  }

  return {
    targets,
    totals: { targets: targets.length, healthy, unhealthy, unreachable, violations },
  };
}
