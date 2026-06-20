import type { Clock } from "./clock.js";

/** A hybrid logical clock stamp (ADR-0009 §1): physical ms, logical counter, origin node.
 *  Assigned once by the event's origin node and carried verbatim across replication. */
export interface HlcStamp {
  readonly p: number;
  readonly l: number;
  readonly node: string;
}

/** Deterministic total order over HLC stamps: physical, then logical, then nodeId.
 *  Every node converges on this order once it holds the same events. */
export function compareHlc(a: HlcStamp, b: HlcStamp): number {
  if (a.p !== b.p) return a.p - b.p;
  if (a.l !== b.l) return a.l - b.l;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/**
 * A hybrid logical clock. `tick()` stamps a locally-originated event (send event);
 * `update()` advances the clock on receiving a remote stamp (receive event). Standard
 * HLC algorithm — keeps causal monotonicity while staying close to physical time.
 */
export class HybridClock {
  private p = 0;
  private l = 0;

  constructor(
    private readonly clock: Clock,
    private readonly node: string,
  ) {}

  tick(): HlcStamp {
    const wall = this.clock.now();
    if (wall > this.p) {
      this.p = wall;
      this.l = 0;
    } else {
      this.l += 1;
    }
    return { p: this.p, l: this.l, node: this.node };
  }

  update(remote: HlcStamp): void {
    const wall = this.clock.now();
    const newP = Math.max(this.p, remote.p, wall);
    if (newP === this.p && newP === remote.p) {
      this.l = Math.max(this.l, remote.l) + 1;
    } else if (newP === this.p) {
      this.l += 1;
    } else if (newP === remote.p) {
      this.l = remote.l + 1;
    } else {
      this.l = 0;
    }
    this.p = newP;
  }
}
