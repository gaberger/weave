/** Injected time source (ADR-0005 §1) — logic never calls Date.now() directly, so
 *  lease/heartbeat timing is deterministic under test. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** The real clock, wired only at the composition root. */
export const systemClock: Clock = { now: () => Date.now() };

/** A controllable clock for tests. */
export class FakeClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
