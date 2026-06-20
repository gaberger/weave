/** Task domain types and the event kinds of the claim protocol (ADR-0002 §3). */

export interface TaskSpec {
  /** What the worker should accomplish. */
  readonly goal: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/** Large outputs are referenced, not inlined (artifact-by-reference; ADR-0001 prior art). */
export interface Artifact {
  readonly kind: string;
  readonly ref: string;
}

/** Event `kind` constants emitted onto the weave. */
export const TaskKind = {
  Declared: "task.declared",
  Claimed: "task.claimed",
  LeaseRenewed: "lease.renewed",
  Progress: "task.progress",
  Completed: "task.completed",
  Failed: "task.failed",
  Released: "task.released",
  ToolInvoked: "tool.invoked",
} as const;

export type TaskKindValue = (typeof TaskKind)[keyof typeof TaskKind];

export interface DeclaredPayload {
  readonly spec: TaskSpec;
}

/** Carried by both `task.claimed` and `lease.renewed` so a renewal can re-derive the
 *  lease window (ADR-0002 §3.1). */
export interface LeasePayload {
  readonly leaseMs: number;
}

export interface ProgressPayload {
  readonly note: string;
}

export interface ReleasePayload {
  readonly reason: "lease-lost" | "cancelled" | "lease-expired";
}
