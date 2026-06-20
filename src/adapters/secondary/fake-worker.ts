import type { Worker, TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";

/** Scripted behaviour for a deterministic Worker test double (ADR-0003 §5). */
export interface FakeScript {
  /** Progress notes emitted before completing. */
  readonly progress?: readonly string[];
  /** If set, the worker awaits this before the lease check — lets a test hold a worker
   *  mid-task (e.g. to expire its lease and prove another peer reclaims). */
  readonly hold?: Promise<unknown>;
  /** Simulate an irreversible step: check the lease before returning `result`. If the
   *  lease is gone, the worker aborts with `lease-lost` instead. */
  readonly checkLeaseBeforeResult?: boolean;
  /** The terminal result when not cancelled / lease-lost. */
  readonly result: WorkerResult;
}

/** A Worker that runs no model and makes no network calls — the independent oracle for
 *  testing the peer loop and claim protocol. */
export class FakeWorker implements Worker {
  constructor(private readonly script: FakeScript) {}

  async run(assignment: TaskAssignment, ctx: WorkerContext): Promise<WorkerResult> {
    for (const note of this.script.progress ?? []) {
      if (ctx.signal.aborted) {
        return { status: "aborted", summary: "cancelled mid-progress", reason: "cancelled" };
      }
      ctx.onProgress(note);
    }

    if (this.script.hold) await this.script.hold;

    if (this.script.checkLeaseBeforeResult && !(await ctx.lease.held())) {
      return {
        status: "aborted",
        summary: `lease lost before irreversible step on ${assignment.taskId}`,
        reason: "lease-lost",
      };
    }

    if (ctx.signal.aborted) {
      return { status: "aborted", summary: "cancelled", reason: "cancelled" };
    }
    return this.script.result;
  }
}
