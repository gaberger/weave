/**
 * Composition root — the ONLY module that imports adapters (hex rule 6). Wires concrete
 * adapters into the PeerLoop use-case and returns a ready-to-start peer.
 */
import { randomUUID } from "node:crypto";

import { PeerLoop, type PeerConfig, type PeerDeps } from "./usecases/peer-loop.js";
import type { Substrate } from "./ports/substrate.js";
import type { Worker } from "./ports/worker.js";
import type { Clock } from "./domain/clock.js";
import type { Timer } from "./ports/timer.js";
import { systemClock } from "./domain/clock.js";
import { SystemTimer } from "./adapters/secondary/system-timer.js";
import { WeaveLeaseGuard } from "./adapters/secondary/weave-lease-guard.js";
import { ToolRegistry } from "./adapters/secondary/in-memory-tool-host.js";

export interface CreatePeerOptions {
  readonly weave: Substrate;
  readonly cfg: PeerConfig;
  readonly newWorker: () => Worker;
  /** Tool registry backing this peer's workers. Defaults to an empty registry. */
  readonly registry?: ToolRegistry;
  /** Overridable for tests. */
  readonly clock?: Clock;
  readonly timer?: Timer;
  readonly newId?: () => string;
}

export function createPeer(opts: CreatePeerOptions): PeerLoop {
  const clock = opts.clock ?? systemClock;
  const timer = opts.timer ?? new SystemTimer();
  const newId = opts.newId ?? (() => randomUUID());
  const registry = opts.registry ?? new ToolRegistry();

  const deps: PeerDeps = {
    weave: opts.weave,
    newWorker: opts.newWorker,
    newToolHost: (grant) => registry.hostFor(grant),
    newLease: (taskId, claimSeq) =>
      new WeaveLeaseGuard(
        opts.weave,
        opts.cfg.agentId,
        taskId,
        claimSeq,
        opts.cfg.leaseMs,
        clock,
        newId,
      ),
    clock,
    timer,
    newId,
  };

  return new PeerLoop(deps, opts.cfg);
}
