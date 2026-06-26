import { test } from "node:test";
import assert from "node:assert/strict";

import { systemClock } from "../domain/clock.js";
import type { Grant } from "../domain/grant.js";
import type { SealedEvent } from "../domain/event.js";
import { TaskKind } from "../domain/task.js";
import { InProcessSubstrate } from "../adapters/secondary/in-process-substrate.js";
import { createPeer } from "../composition-root.js";
import { createClaudeWorkerFactory } from "../composition/claude-sdk.js";

/**
 * Live end-to-end test of the COOPERATIVE path with the real Claude Agent SDK. Where
 * `claude-sdk.live.test.ts` proves the worker in isolation, this proves the whole loop:
 *
 *   declare a task on the substrate
 *     → a real claude-sdk peer claims it (lease, ADR-0002)
 *       → its SDK worker runs the goal
 *         → task.completed lands on the weave, by that peer.
 *
 * Skipped unless ANTHROPIC_API_KEY is set, so normal runs/CI stay offline and free.
 * Run with:  export $(grep ANTHROPIC_API_KEY .env | xargs) && npm test
 *       (or: ANTHROPIC_API_KEY=sk-... node --import tsx --test src/usecases/peer-loop.live.test.ts)
 */
const GRANT: Grant = { tools: "*", maxEffect: "read" };

const completedFor = async (weave: InProcessSubstrate, subject: string): Promise<SealedEvent[]> => {
  const out: SealedEvent[] = [];
  for await (const e of weave.read(0)) if (e.kind === TaskKind.Completed && e.subject === subject) out.push(e);
  return out;
};

test(
  "LIVE: a claude-sdk peer claims a declared task and completes it through the substrate",
  { skip: process.env.ANTHROPIC_API_KEY ? false : "set ANTHROPIC_API_KEY to run", timeout: 120_000 },
  async () => {
    const weave = new InProcessSubstrate(systemClock);
    let n = 0;
    const newId = (): string => `live-${++n}`;

    // A real peer: same composition as `weave up`, but the worker is the live Claude SDK. Real
    // SystemTimer/systemClock (createPeer defaults) so it actually ticks, claims, and renews.
    const peer = createPeer({
      weave,
      cfg: { agentId: "claude-peer", grant: GRANT, leaseMs: 30_000, maxConcurrent: 1, tickMs: 200 },
      newWorker: () => createClaudeWorkerFactory({ model: "claude-sonnet-4-6", maxTurns: 1 })(),
      newId,
    });

    const ac = new AbortController();
    void peer.start(ac.signal);
    try {
      const subject = "live-task";
      await weave.append({
        id: newId(),
        kind: TaskKind.Declared,
        actor: "client",
        subject,
        payload: { spec: { goal: "Reply with exactly the word DONE and nothing else." } },
      });

      // Poll in real time until the peer claims + the SDK completes the task (or we hit the deadline).
      const deadline = Date.now() + 110_000;
      let completed: SealedEvent[] = [];
      while (Date.now() < deadline) {
        completed = await completedFor(weave, subject);
        if (completed.length) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      assert.equal(completed.length, 1, "the task should be completed exactly once on the weave");
      assert.equal(completed[0]?.actor, "claude-peer", "the claude-sdk peer should be the completer");
    } finally {
      ac.abort();
    }
  },
);
