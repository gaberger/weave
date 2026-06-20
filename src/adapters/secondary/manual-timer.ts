import type { Timer, Cancel } from "../../ports/timer.js";

/** Test double: a Timer whose registered callbacks fire only when the test calls
 *  `fire()`. Lets a spec drive heartbeats/sweeps deterministically alongside FakeClock. */
export class ManualTimer implements Timer {
  private fns: Array<() => void> = [];

  every(_ms: number, fn: () => void): Cancel {
    this.fns.push(fn);
    return () => {
      this.fns = this.fns.filter((f) => f !== fn);
    };
  }

  /** Fire every registered callback once. */
  fire(): void {
    for (const fn of [...this.fns]) fn();
  }
}
