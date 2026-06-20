import type { TaskId } from "../domain/ids.js";

/** Handle to a worker's claim on a task (ADR-0002 §3 / ADR-0003 §2). The peer loop
 *  constructs one per active claim and drives `renew()` on a heartbeat. */
export interface LeaseGuard {
  /** Project the weave: does this agent still hold the task? */
  held(): Promise<boolean>;
  /** Throw `LeaseLostError` if the lease is gone. Called before irreversible effects. */
  assertHeld(): Promise<void>;
  /** Append a `lease.renewed` heartbeat. */
  renew(): Promise<void>;
}

export class LeaseLostError extends Error {
  constructor(public readonly taskId: TaskId) {
    super(`lease lost for task ${taskId}`);
    this.name = "LeaseLostError";
  }
}
