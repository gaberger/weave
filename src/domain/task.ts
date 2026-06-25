/** Task domain types and the event kinds of the claim protocol (ADR-0002 §3). */

export interface TaskSpec {
  /** What the worker should accomplish. */
  readonly goal: string;
  /** Optional explicit routing to a named skill (ADR-0012); else skills match by predicate. */
  readonly skill?: string;
  /** Optional model override for this task (ADR-0022 per-task tiering). When set, the Worker uses
   *  it for this task; when absent, the Worker uses its own startup default. */
  readonly model?: string;
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
  /** A client's request to stop a task for good. Terminal (like completed/failed) so the task is
   *  never re-claimed, and observed by the holding peer to abort its running worker (ADR-0002 §3). */
  Cancel: "task.cancel",
  ToolInvoked: "tool.invoked",
  /** Learning: a user question was asked (for self-learning analytics). */
  QuestionAsked: "learning.question.asked",
  /** Learning: a user question was resolved (for self-learning analytics). */
  QuestionResolved: "learning.question.resolved",
} as const;

export type TaskKindValue = (typeof TaskKind)[keyof typeof TaskKind];

export interface DeclaredPayload {
  readonly spec: TaskSpec;
  /** Parent task id, if this task was spawned by another (ADR-0008 §3 lineage). */
  readonly parent?: string;
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

export interface CancelPayload {
  /** Why it was cancelled (e.g. "user-stop") — for logs/audit; doesn't affect the protocol. */
  readonly reason?: string;
}

/** Learning analytics: track user questions and outcomes. */
export interface QuestionAskedPayload {
  readonly utterance: string;
  readonly intent: string;
  readonly networkId: string;
  readonly persona: string;
}

export interface QuestionResolvedPayload {
  readonly questionId: string;
  readonly durationMs: number;
  readonly followUps: number;
  readonly resolved: boolean;
  readonly skill: string;
}
