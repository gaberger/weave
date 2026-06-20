import type { Timer, Cancel } from "../../ports/timer.js";

/** Real scheduler over Node's setInterval. Wired only at the composition root. */
export class SystemTimer implements Timer {
  every(ms: number, fn: () => void): Cancel {
    const handle = setInterval(fn, ms);
    // Don't keep the process alive solely for the heartbeat.
    if (typeof handle.unref === "function") handle.unref();
    return () => clearInterval(handle);
  }
}
