import { test } from "node:test";
import assert from "node:assert/strict";

import { ManualTimer } from "../adapters/secondary/manual-timer.js";
import { LoopRunner } from "./loop.js";

test("LoopRunner: immediate tick, then one per timer fire, until stopped", async () => {
  const timer = new ManualTimer();
  let n = 0;
  const loop = new LoopRunner(timer, async () => {
    n += 1;
  }, 1000, false);

  await loop.start();
  assert.equal(n, 1); // immediate
  timer.fire();
  assert.equal(n, 2);
  timer.fire();
  assert.equal(n, 3);
  loop.stop();
  timer.fire();
  assert.equal(n, 3); // no more after stop
});

test("LoopRunner once: ticks exactly once, never repeats", async () => {
  const timer = new ManualTimer();
  let n = 0;
  await new LoopRunner(timer, async () => {
    n += 1;
  }, 1000, true).start();
  assert.equal(n, 1);
  timer.fire();
  assert.equal(n, 1);
});
