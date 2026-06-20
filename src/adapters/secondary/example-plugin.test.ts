import { test } from "node:test";
import assert from "node:assert/strict";

import type { ToolHost } from "../../ports/tool-host.js";
import type { WorkerContext, TaskAssignment } from "../../ports/worker.js";
import { loadSkills } from "./skill-loader.js";

const hostStatusByUrl = (statusOf: (url: string) => number): ToolHost => ({
  available: () => [],
  invoke: async (call) => ({ ok: true, output: { status: statusOf(String(call.args["target"] ?? "")) } }),
});

const ctx = (tools: ToolHost): WorkerContext => ({
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});

const run = (skill: { run: (t: TaskAssignment, c: WorkerContext) => Promise<{ status: string }> }, goal: string, tools: ToolHost) =>
  skill.run({ taskId: "t", spec: { goal } }, ctx(tools));

test("examples/plugins/http-check.mjs loads as a code skill and runs deterministically", async () => {
  const { skills, errors } = await loadSkills("examples/plugins");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const httpCheck = skills.find((s) => s.name === "http-check");
  assert.ok(httpCheck, "http-check code skill should load from examples/plugins");

  // all up -> completed
  const up = await run(httpCheck, "check http://a/ http://b/", hostStatusByUrl(() => 200));
  assert.equal(up.status, "completed");

  // one down -> failed
  const mixed = await run(
    httpCheck,
    "check http://ok/ http://bad/",
    hostStatusByUrl((u) => (u.includes("bad") ? 500 : 200)),
  );
  assert.equal(mixed.status, "failed");

  // routing keyword
  assert.equal(httpCheck.match({ taskId: "t", spec: { goal: "check http://x/" } }), true);
});
