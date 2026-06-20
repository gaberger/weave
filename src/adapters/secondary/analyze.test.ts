import { test } from "node:test";
import assert from "node:assert/strict";

import type { ToolHost } from "../../ports/tool-host.js";
import type { Worker, TaskAssignment, WorkerContext } from "../../ports/worker.js";
import type { ReducedContext } from "../../domain/context.js";
import { makeAnalyzeSkill } from "../../composition/builtin-skills.js";

test("analyze skill: feeds the reduced context to the worker and returns its report", async () => {
  const reduced: ReducedContext = {
    targets: [{ target: "10.0.0.1", status: 0, ok: false, tag: "UNREACHABLE", ms: 0 }],
    totals: { targets: 1, healthy: 0, unhealthy: 0, unreachable: 1, violations: 0 },
  };
  const tools: ToolHost = { available: () => [], invoke: async () => ({ ok: true, output: reduced }) };

  let captured: TaskAssignment | undefined;
  const worker: Worker = {
    async run(a) {
      captured = a;
      return { status: "completed", summary: "REPORT" };
    },
  };
  const ctx: WorkerContext = {
    tools,
    lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
    onProgress: () => {},
    signal: new AbortController().signal,
  };

  const res = await makeAnalyzeSkill(worker).run({ taskId: "t", spec: { goal: "analyze" } }, ctx);

  assert.equal(res.status, "completed");
  assert.equal(res.summary, "REPORT");
  // The worker got the REDUCED state in its prompt, not raw events.
  assert.match(captured?.spec.goal ?? "", /10\.0\.0\.1/);
  assert.match(captured?.spec.goal ?? "", /UNREACHABLE/);
});
