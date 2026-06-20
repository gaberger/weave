import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorkerContext, TaskAssignment } from "../../ports/worker.js";
import { ClaudeCliWorker, type ClaudeCliRunner } from "./claude-cli-worker.js";

const ctx = (): WorkerContext => ({
  tools: { available: () => [], invoke: async () => ({ ok: true, output: null }) },
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});
const task: TaskAssignment = { taskId: "t", spec: { goal: "do the thing" } };

test("ClaudeCliWorker builds claude -p args and maps stdout to completed", async () => {
  let captured: string[] = [];
  const runner: ClaudeCliRunner = async (args) => {
    captured = args;
    return { code: 0, stdout: "the answer\n", stderr: "" };
  };
  const res = await new ClaudeCliWorker(
    { model: "claude-sonnet-4-6", systemPrompt: "you are X", allowedTools: ["WebFetch"] },
    runner,
  ).run(task, ctx());

  assert.equal(res.status, "completed");
  assert.equal(res.summary, "the answer");
  assert.deepEqual(captured.slice(0, 2), ["-p", "do the thing"]);
  assert.ok(captured.includes("--append-system-prompt") && captured.includes("you are X"));
  assert.ok(captured.includes("--model") && captured.includes("claude-sonnet-4-6"));
  assert.ok(captured.includes("--allowedTools") && captured.includes("WebFetch"));
});

test("ClaudeCliWorker maps a non-zero exit to failed", async () => {
  const runner: ClaudeCliRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const res = await new ClaudeCliWorker({}, runner).run(task, ctx());
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.error : null, "boom");
});

test("ClaudeCliWorker aborts on a cancelled signal", async () => {
  const ac = new AbortController();
  ac.abort();
  const c: WorkerContext = { ...ctx(), signal: ac.signal };
  const res = await new ClaudeCliWorker({}, async () => ({ code: 0, stdout: "x", stderr: "" })).run(task, c);
  assert.equal(res.status, "aborted");
});
