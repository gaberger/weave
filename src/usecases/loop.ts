import type { Timer, Cancel } from "../ports/timer.js";

/**
 * A first-class loop construct (ADR-0008 §1): run `tick` immediately, then every
 * `intervalMs` (unless `once`). Uses the Timer port so it's deterministic under test
 * (ManualTimer) and real under SystemTimer. Generic — drives any per-tick work.
 */
export class LoopRunner {
  private cancel: Cancel | undefined;

  constructor(
    private readonly timer: Timer,
    private readonly tick: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly once: boolean,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    if (!this.once) {
      this.cancel = this.timer.every(this.intervalMs, () => {
        void this.tick();
      });
    }
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
