import { test } from "node:test";
import assert from "node:assert/strict";

import type { LeaseGuard } from "../../ports/lease.js";
import type { WorkerContext } from "../../ports/worker.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import { createClaudeWorkerFactory } from "./claude-sdk.js";

/**
 * Live end-to-end smoke test against the real Claude Agent SDK. Skipped unless
 * ANTHROPIC_API_KEY is set, so normal runs/CI stay offline and free. With a key, it proves
 * the full real path: ClaudeAgentSdkWorker -> real query() -> completed.
 *
 * Run with:  ANTHROPIC_API_KEY=sk-... npm test
 */
const heldLease: LeaseGuard = {
  held: async () => true,
  assertHeld: async () => {},
  renew: async () => {},
};

test(
  "LIVE: Claude worker completes a trivial task",
  { skip: process.env.ANTHROPIC_API_KEY ? false : "set ANTHROPIC_API_KEY to run", timeout: 90_000 },
  async () => {
    const ctx: WorkerContext = {
      tools: new ToolRegistry().hostFor({ tools: "*", maxEffect: "read" }),
      lease: heldLease,
      onProgress: () => {},
      signal: new AbortController().signal,
    };
    const worker = createClaudeWorkerFactory({ model: "claude-sonnet-4-6", maxTurns: 1 })();
    const res = await worker.run(
      { taskId: "live-1", spec: { goal: "Reply with exactly the word DONE and nothing else." } },
      ctx,
    );
    assert.equal(res.status, "completed");
  },
);
