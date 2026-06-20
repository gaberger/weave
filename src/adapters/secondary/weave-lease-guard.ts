import { LeaseLostError, type LeaseGuard } from "../../ports/lease.js";
import type { Substrate } from "../../ports/substrate.js";
import type { Clock } from "../../domain/clock.js";
import type { SealedEvent } from "../../domain/event.js";
import type { AgentId, TaskId } from "../../domain/ids.js";
import { currentHolder } from "../../domain/claim.js";
import { TaskKind } from "../../domain/task.js";

/** A LeaseGuard bound to one claim (agent + task + claimSeq). `held()` re-projects the
 *  weave (ADR-0002 §3.1); `renew()` appends a heartbeat. Constructed per claim by the
 *  composition root and handed to the peer loop via the `newLease` factory. */
export class WeaveLeaseGuard implements LeaseGuard {
  constructor(
    private readonly weave: Substrate,
    private readonly agentId: AgentId,
    private readonly taskId: TaskId,
    private readonly claimSeq: number,
    private readonly leaseMs: number,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async held(): Promise<boolean> {
    const events: SealedEvent[] = [];
    for await (const e of this.weave.read(0)) events.push(e);
    const holder = currentHolder(events, this.taskId, this.clock.now());
    return holder !== null && holder.agentId === this.agentId && holder.claimSeq === this.claimSeq;
  }

  async assertHeld(): Promise<void> {
    if (!(await this.held())) throw new LeaseLostError(this.taskId);
  }

  async renew(): Promise<void> {
    await this.weave.append({
      id: this.newId(),
      kind: TaskKind.LeaseRenewed,
      actor: this.agentId,
      subject: this.taskId,
      payload: { leaseMs: this.leaseMs },
    });
  }
}
