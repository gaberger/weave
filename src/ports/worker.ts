import type { TaskId } from "../domain/ids.js";
import type { TaskSpec, Artifact } from "../domain/task.js";
import type { ToolHost } from "./tool-host.js";
import type { LeaseGuard } from "./lease.js";

export interface TaskAssignment {
  readonly taskId: TaskId;
  readonly spec: TaskSpec;
}

export interface WorkerContext {
  readonly tools: ToolHost;
  readonly lease: LeaseGuard;
  /** Emitted progress is turned into `task.progress` events by the peer loop. */
  readonly onProgress: (note: string) => void;
  /** Liveness signal, distinct from progress: "the worker is still producing output" even when
   *  there's no *new* user-facing note (a long tool call streaming tool_use/tool_result events,
   *  repeated/ignored stream events, token deltas). The peer feeds this to the stall watchdog
   *  WITHOUT writing a log event, so a demonstrably-alive worker isn't aborted as "silent" mid
   *  tool call. `onProgress` also implies activity. Optional — a worker that can't stream omits it,
   *  and the watchdog falls back to progress notes alone. */
  readonly onActivity?: () => void;
  readonly signal: AbortSignal;
}

/** A terminal outcome (ADR-0003 §1). `aborted` is distinct from `failed`: it is not the
 *  task's fault and leaves the work reclaimable. */
export type WorkerResult =
  | { readonly status: "completed"; readonly summary: string; readonly artifacts?: readonly Artifact[] }
  | { readonly status: "failed"; readonly summary: string; readonly error: string }
  | { readonly status: "aborted"; readonly summary: string; readonly reason: "lease-lost" | "cancelled" };

/** Executes one claimed task to completion. Single-shot; stateless across tasks. */
export interface Worker {
  run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult>;
}
