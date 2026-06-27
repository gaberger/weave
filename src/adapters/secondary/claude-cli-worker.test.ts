import { test } from "node:test";
import assert from "node:assert/strict";

import type { WorkerContext, TaskAssignment } from "../../ports/worker.js";
import { ClaudeCliWorker, progressFromEvent, type ClaudeCliRunner } from "./claude-cli-worker.js";

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

test("ClaudeCliWorker wires MCP config: --mcp-config + --strict-mcp-config, before the variadic --allowedTools", async () => {
  let captured: string[] = [];
  const runner: ClaudeCliRunner = async (args) => {
    captured = args;
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  await new ClaudeCliWorker(
    { allowedTools: ["mcp__github", "Read"], mcpConfig: "/ws/mcp.json" },
    runner,
  ).run(task, ctx());

  const mcpAt = captured.indexOf("--mcp-config");
  assert.ok(mcpAt >= 0, "should pass --mcp-config");
  assert.equal(captured[mcpAt + 1], "/ws/mcp.json");
  assert.ok(captured.includes("--strict-mcp-config"), "should pass --strict-mcp-config (only our servers)");
  // --allowedTools is variadic and must stay last so it doesn't swallow the mcp flags.
  assert.ok(mcpAt < captured.indexOf("--allowedTools"), "--mcp-config must precede --allowedTools");
  assert.ok(captured.includes("mcp__github"), "the MCP server grant rides in allowedTools");
});

test("ClaudeCliWorker omits MCP flags when no mcpConfig is set", async () => {
  let captured: string[] = [];
  const runner: ClaudeCliRunner = async (args) => {
    captured = args;
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  await new ClaudeCliWorker({ allowedTools: ["Read"] }, runner).run(task, ctx());
  assert.ok(!captured.includes("--mcp-config") && !captured.includes("--strict-mcp-config"));
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

test("ClaudeCliWorker runs in stream-json mode, surfaces progress, and takes the summary from the result event", async () => {
  const notes: string[] = [];
  const c: WorkerContext = { ...ctx(), onProgress: (n) => notes.push(n) };
  let captured: string[] = [];
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", tools: ["Write"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Let me research this topic." }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "reports/x.md" } }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "done writing", is_error: false }),
  ];
  const runner: ClaudeCliRunner = async (args, _sig, onData) => {
    captured = args;
    // deliver in two chunks split mid-line to exercise the incremental line buffer
    const joined = lines.join("\n") + "\n";
    onData?.(joined.slice(0, 40));
    onData?.(joined.slice(40));
    return { code: 0, stdout: joined, stderr: "" };
  };
  const res = await new ClaudeCliWorker({}, runner).run(task, c);

  assert.equal(res.status, "completed");
  assert.equal(res.summary, "done writing"); // from the result event, not raw JSONL stdout
  assert.ok(captured.includes("--output-format") && captured.includes("stream-json") && captured.includes("--verbose"));
  assert.ok(notes.some((n) => n.includes("session started")), "init surfaced");
  assert.ok(notes.some((n) => n.startsWith("›")), "assistant narration surfaced");
  assert.ok(notes.some((n) => n.startsWith("→ Write reports/x.md")), "tool call surfaced");
});

test("ClaudeCliWorker maps a result event with is_error to failed", async () => {
  const runner: ClaudeCliRunner = async (_a, _s, onData) => {
    const line = JSON.stringify({ type: "result", result: "ran out of turns", is_error: true }) + "\n";
    onData?.(line);
    return { code: 0, stdout: line, stderr: "" };
  };
  const res = await new ClaudeCliWorker({}, runner).run(task, ctx());
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.summary : null, "ran out of turns");
});

test("progressFromEvent picks the salient tool argument and ignores noise", () => {
  assert.equal(
    progressFromEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } }).note,
    "→ Bash ls -la",
  );
  assert.deepEqual(progressFromEvent({ type: "user", message: { content: [] } }), {}); // tool_result etc. ignored
  assert.equal(progressFromEvent({ type: "result", result: "ok", is_error: false }).result, "ok");
});
