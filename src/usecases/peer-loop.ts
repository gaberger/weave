import type { Substrate, Subscription } from "../ports/substrate.js";
import type { Worker, WorkerResult } from "../ports/worker.js";
import type { ToolHost } from "../ports/tool-host.js";
import type { LeaseGuard } from "../ports/lease.js";
import type { Timer, Cancel } from "../ports/timer.js";
import type { Clock } from "../domain/clock.js";
import type { Grant } from "../domain/grant.js";
import type { AgentId, TaskId } from "../domain/ids.js";
import type { SealedEvent } from "../domain/event.js";
import { currentHolder, isSettled } from "../domain/claim.js";
import {
  TaskKind,
  type TaskSpec,
  type DeclaredPayload,
} from "../domain/task.js";

export interface PeerConfig {
  readonly agentId: AgentId;
  readonly grant: Grant; // ADR-0004 capability ceiling for this peer's workers
  readonly leaseMs: number; // ADR-0002 lease duration
  readonly maxConcurrent: number; // tasks this peer runs at once
  /** Heartbeat + sweep cadence (ADR-0005 §4). Should be < leaseMs (e.g. leaseMs/3). The
   *  sweep is what lets a peer notice work freed by *lease expiry*, which emits no event. */
  readonly tickMs: number;
  readonly interests?: readonly string[]; // reserved for ADR-0006
}

/** Factories the composition root injects so this use-case never imports adapters. */
export interface PeerDeps {
  readonly weave: Substrate;
  readonly newWorker: () => Worker;
  readonly newToolHost: (grant: Grant, taskId: TaskId) => ToolHost;
  readonly newLease: (taskId: TaskId, claimSeq: number) => LeaseGuard;
  readonly clock: Clock;
  readonly timer: Timer;
  readonly newId: () => string;
}

interface ActiveTask {
  readonly lease: LeaseGuard;
  readonly abort: AbortController;
  /** The in-flight run() promise. stop() awaits these so a graceful shutdown drains active work —
   *  each aborted worker appends its terminal/Released event before the caller closes the substrate. */
  run?: Promise<void>;
}

/**
 * The peer loop (ADR-0005): subscribe to the weave, claim free work by log order, run a
 * Worker per claim, and publish progress/results back onto the weave. Crash-safety is
 * free — leases expire and peers reclaim (ADR-0002).
 */
export class PeerLoop {
  private readonly events: SealedEvent[] = [];
  private readonly declared = new Map<TaskId, TaskSpec>();
  private readonly done = new Set<TaskId>(); // terminal (completed/failed) — never re-run
  private readonly active = new Map<TaskId, ActiveTask>();

  private subscription?: Subscription;
  private cancelTick?: Cancel;
  private stopping = false;
  private stopPromise?: Promise<void>; // shared so every stop() caller awaits the SAME drain
  private scheduling = false;
  private pending = false;
  private onStopped?: () => void;

  constructor(
    private readonly deps: PeerDeps,
    private readonly cfg: PeerConfig,
  ) {}

  /** Begin participating. Resolves when stopped (via `stop()` or the abort signal). */
  start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    this.subscription = this.deps.weave.subscribe(0, (e) => this.onEvent(e));
    this.cancelTick = this.deps.timer.every(this.cfg.tickMs, () => {
      void this.tick();
    });
    signal.addEventListener("abort", () => {
      void this.stop();
    });
    return new Promise<void>((resolve) => {
      this.onStopped = resolve;
    });
  }

  /** Idempotent: every caller (the abort-signal listener AND an explicit cmdUp shutdown) awaits the
   *  SAME drain promise, so the substrate isn't closed until in-flight work has released. */
  stop(): Promise<void> {
    return (this.stopPromise ??= this.doStop());
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    this.cancelTick?.();
    this.subscription?.unsubscribe();
    // Abort in-flight workers, then WAIT for each run() to append its terminal/Released event before
    // resolving. Otherwise a Ctrl-C'd task reads "held by <dead agent>" until its lease expires
    // (ADR-0002) — the abort raced the publishResult append. Workers honor the abort signal; the CLI
    // wraps this in a wall-clock bound so a misbehaving worker can't hang shutdown (this use-case
    // stays timer-pure per ADR-0005 §4).
    const inflight = [...this.active.values()].map((t) => t.run).filter((p): p is Promise<void> => !!p);
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled(inflight);
    this.onStopped?.();
  }

  // --- internals -----------------------------------------------------------

  private onEvent(e: SealedEvent): void {
    this.events.push(e);
    if (e.kind === TaskKind.Declared) {
      this.declared.set(e.subject, (e.payload as DeclaredPayload).spec);
    } else if (e.kind === TaskKind.Completed || e.kind === TaskKind.Failed || e.kind === TaskKind.Cancel) {
      this.done.add(e.subject); // terminal — never (re-)claim
      // A client's stop request: abort the worker if we're the one running it. The task is already
      // terminal in the log (settled), so the worker's resulting Released is inert (won't re-run).
      if (e.kind === TaskKind.Cancel) this.active.get(e.subject)?.abort.abort();
    }
    void this.schedule();
  }

  /** Heartbeat active leases, then sweep for newly-free work (incl. expired leases). */
  private async tick(): Promise<void> {
    if (this.stopping) return;
    for (const { lease } of this.active.values()) {
      try {
        await lease.renew();
      } catch {
        // Renewal failed; the worker's pre-effect gate will catch the lost lease.
      }
    }
    await this.schedule();
  }

  private async snapshot(): Promise<SealedEvent[]> {
    const out: SealedEvent[] = [];
    for await (const e of this.deps.weave.read(0)) out.push(e);
    return out;
  }

  /** Claim and run any free, permitted, not-already-handled tasks up to maxConcurrent. */
  private async schedule(): Promise<void> {
    if (this.stopping || this.scheduling) {
      if (this.scheduling) this.pending = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.pending = false;
        for (const [taskId, spec] of this.declared) {
          if (this.stopping) break;
          if (this.active.size >= this.cfg.maxConcurrent) break;
          if (this.active.has(taskId) || this.done.has(taskId)) continue;
          // Decide from the authoritative log, not the subscribe stream — a substrate may
          // deliver subscriptions lazily (e.g. SqliteSubstrate polls), so the in-memory
          // `done` set can lag. `isSettled` prevents re-running a completed task.
          const snap = await this.snapshot();
          if (isSettled(snap, taskId)) continue; // terminal — never re-run
          const holder = currentHolder(snap, taskId, this.deps.clock.now());
          if (holder !== null) continue; // someone holds it
          await this.tryClaim(taskId, spec);
        }
      } while (this.pending && !this.stopping);
    } finally {
      this.scheduling = false;
    }
  }

  /** Optimistic claim (ADR-0002 §3): append, then win iff our claim is the lowest-seq
   *  valid one. On win, launch the worker (fire-and-forget so one task can't stall others). */
  private async tryClaim(taskId: TaskId, spec: TaskSpec): Promise<void> {
    const claim = await this.deps.weave.append({
      id: this.deps.newId(),
      kind: TaskKind.Claimed,
      actor: this.cfg.agentId,
      subject: taskId,
      payload: { leaseMs: this.cfg.leaseMs },
    });

    const snap = await this.snapshot();
    const holder = currentHolder(snap, taskId, this.deps.clock.now());
    const won =
      !isSettled(snap, taskId) &&
      holder !== null &&
      holder.agentId === this.cfg.agentId &&
      holder.claimSeq === claim.seq;
    if (!won) return; // lost the race or already settled; our claim event is inert

    const lease = this.deps.newLease(taskId, claim.seq);
    const abort = new AbortController();
    const entry: ActiveTask = { lease, abort };
    this.active.set(taskId, entry);
    // Keep the run() handle so stop() can drain it. run() suspends at its first await before deleting
    // itself from `active`, so the assignment lands before the entry can be removed.
    entry.run = this.run(taskId, spec, lease, abort);
  }

  private async run(
    taskId: TaskId,
    spec: TaskSpec,
    lease: LeaseGuard,
    abort: AbortController,
  ): Promise<void> {
    const tools = this.deps.newToolHost(this.cfg.grant, taskId);
    const worker = this.deps.newWorker();
    let result: WorkerResult;
    try {
      result = await worker.run(
        { taskId, spec },
        {
          tools,
          lease,
          onProgress: (note) => {
            void this.emit(TaskKind.Progress, taskId, { note });
          },
          signal: abort.signal,
        },
      );
    } catch (err) {
      result = {
        status: "failed",
        summary: "worker threw",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.active.delete(taskId);
    }
    await this.publishResult(taskId, result);
    void this.schedule();
  }

  /** Map a worker outcome onto the weave (ADR-0005 §3). */
  private async publishResult(taskId: TaskId, result: WorkerResult): Promise<void> {
    switch (result.status) {
      case "completed":
        await this.emit(TaskKind.Completed, taskId, {
          summary: result.summary,
          artifacts: result.artifacts ?? [],
        });
        break;
      case "failed":
        await this.emit(TaskKind.Failed, taskId, { summary: result.summary, error: result.error });
        break;
      case "aborted":
        await this.emit(TaskKind.Released, taskId, { reason: result.reason });
        break;
    }
  }

  private async emit(kind: string, subject: string, payload: unknown): Promise<void> {
    await this.deps.weave.append({
      id: this.deps.newId(),
      kind,
      actor: this.cfg.agentId,
      subject,
      payload,
    });
  }
}
