import { test } from "node:test";
import assert from "node:assert/strict";

import type { LeaseGuard } from "../../ports/lease.js";
import { LeaseLostError } from "../../ports/lease.js";
import type { WorkerContext, TaskAssignment } from "../../ports/worker.js";
import type { Grant } from "../../domain/grant.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import {
  ClaudeAgentSdkWorker,
  type ClaudeQuery,
  type SdkMessage,
  type ToolBridge,
} from "./claude-agent-sdk-worker.js";

const GRANT: Grant = { tools: "*", maxEffect: "irreversible" };
const NOOP_BRIDGE: ToolBridge = { build: () => ({}) };
const ASSIGNMENT: TaskAssignment = { taskId: "task-1", spec: { goal: "do the thing" } };

const lease = (held: boolean): LeaseGuard => ({
  held: async () => held,
  assertHeld: async () => {
    if (!held) throw new LeaseLostError("task-1");
  },
  renew: async () => {},
});

const hostWith = (name: string, effect: "read" | "reversible" | "irreversible") =>
  new ToolRegistry()
    .register({ name, description: name, effect, execute: async () => ({ ok: true, output: null }) })
    .hostFor(GRANT);

const ctxOf = (opts: {
  held: boolean;
  toolName?: string;
  toolEffect?: "read" | "reversible" | "irreversible";
  signal?: AbortSignal;
  progress?: string[];
  activity?: () => void;
}): WorkerContext => ({
  tools: opts.toolName ? hostWith(opts.toolName, opts.toolEffect ?? "irreversible") : new ToolRegistry().hostFor(GRANT),
  lease: lease(opts.held),
  onProgress: (n) => opts.progress?.push(n),
  ...(opts.activity ? { onActivity: opts.activity } : {}),
  signal: opts.signal ?? new AbortController().signal,
});

/** A fake `query` that optionally drives the gate via canUseTool, then emits text + a result. */
const fakeQuery = (script: {
  toolCall?: string;
  assistantText?: string[];
  toolUses?: string[];
  resultSubtype?: string;
}): ClaudeQuery =>
  async function* ({ options }): AsyncIterable<SdkMessage> {
    if (script.toolCall && options.canUseTool) {
      const res = await options.canUseTool(
        script.toolCall,
        {},
        { signal: options.abortController?.signal ?? new AbortController().signal, toolUseID: "t1" },
      );
      if (res.behavior === "deny") {
        yield { type: "result", subtype: "error_denied" };
        return;
      }
    }
    for (const name of script.toolUses ?? []) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", name }] } };
    }
    for (const text of script.assistantText ?? []) {
      yield { type: "assistant", message: { content: [{ type: "text", text }] } };
    }
    if (script.resultSubtype) yield { type: "result", subtype: script.resultSubtype };
  };

test("gate denies irreversible tool when lease lost -> aborted lease-lost", async () => {
  const worker = new ClaudeAgentSdkWorker({ query: fakeQuery({ toolCall: "deploy", resultSubtype: "success" }), bridge: NOOP_BRIDGE });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: false, toolName: "deploy", toolEffect: "irreversible" }));
  assert.equal(res.status, "aborted");
  assert.equal(res.status === "aborted" ? res.reason : null, "lease-lost");
});

test("gate allows irreversible tool when lease held -> completed", async () => {
  const progress: string[] = [];
  const worker = new ClaudeAgentSdkWorker({
    query: fakeQuery({ toolCall: "deploy", assistantText: ["working", "done"], resultSubtype: "success" }),
    bridge: NOOP_BRIDGE,
  });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true, toolName: "deploy", toolEffect: "irreversible", progress }));
  assert.equal(res.status, "completed");
  assert.match(res.summary, /done/);
  assert.deepEqual(progress, ["working", "done"]);
});

test("tool_use blocks emit a progress heartbeat (feeds idle/stall watchdogs) without polluting the summary", async () => {
  const progress: string[] = [];
  const worker = new ClaudeAgentSdkWorker({
    query: fakeQuery({ toolUses: ["Bash", "WebFetch"], assistantText: ["done"], resultSubtype: "success" }),
    bridge: NOOP_BRIDGE,
  });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true, progress }));
  assert.equal(res.status, "completed");
  assert.deepEqual(progress, ["using Bash…", "using WebFetch…", "done"]);
  assert.match(res.summary, /^done$/); // heartbeats are progress-only, never part of the summary
});

test("in-flight keepalive pulses SILENT onActivity (no progress spam) while a tool is awaiting its result", async () => {
  const progress: string[] = [];
  let activity = 0;
  const fired: Array<() => void> = []; // captured ticker callbacks; we fire them by hand (no real time)
  // tool_use (inflight=1) → fire ticker ×2 (pulses onActivity) → tool_result (inflight=0) → fire ×1 (no-op).
  const query: ClaudeQuery = async function* (): AsyncIterable<SdkMessage> {
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } };
    fired.forEach((fn) => fn());
    fired.forEach((fn) => fn());
    yield { type: "user", message: { content: [{ type: "tool_result" }] } };
    fired.forEach((fn) => fn());
    yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
    yield { type: "result", subtype: "success" };
  };
  const worker = new ClaudeAgentSdkWorker({
    query,
    bridge: NOOP_BRIDGE,
    setInterval: (fn) => { fired.push(fn); return fired.length; },
    clearInterval: () => {},
  });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true, progress, activity: () => activity++ }));
  assert.equal(res.status, "completed");
  // The ticker no longer adds "still using…" notes — progress is just the real tool note + final text.
  assert.deepEqual(progress, ["using Bash…", "done"]);
  // Liveness is signalled SILENTLY instead: per-message onActivity (4 msgs) + 2 ticker pulses while a
  // tool is in flight (the 3rd ticker fire is a no-op, inflight back to 0). So strictly more than the
  // message count — proving the ticker contributes silent liveness during the tool gap.
  assert.ok(activity >= 6, `expected silent liveness pulses (msgs + 2 ticker), got ${activity}`);
  assert.match(res.summary, /^done$/);
});

test("reversible tool is NOT gated even when lease lost (ADR-0004 effect split)", async () => {
  const worker = new ClaudeAgentSdkWorker({
    query: fakeQuery({ toolCall: "write", resultSubtype: "success" }),
    bridge: NOOP_BRIDGE,
  });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: false, toolName: "write", toolEffect: "reversible" }));
  assert.equal(res.status, "completed");
});

test("result error subtype -> failed", async () => {
  const worker = new ClaudeAgentSdkWorker({ query: fakeQuery({ resultSubtype: "error_timeout" }), bridge: NOOP_BRIDGE });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true }));
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.error : null, "error_timeout");
});

test("no result message -> failed no_result", async () => {
  const worker = new ClaudeAgentSdkWorker({ query: fakeQuery({ assistantText: ["hmm"] }), bridge: NOOP_BRIDGE });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true }));
  assert.equal(res.status, "failed");
  assert.equal(res.status === "failed" ? res.error : null, "no_result");
});

test("cancelled signal -> aborted cancelled", async () => {
  const ac = new AbortController();
  ac.abort();
  const worker = new ClaudeAgentSdkWorker({
    query: fakeQuery({ assistantText: ["x"], resultSubtype: "success" }),
    bridge: NOOP_BRIDGE,
  });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true, signal: ac.signal }));
  assert.equal(res.status, "aborted");
  assert.equal(res.status === "aborted" ? res.reason : null, "cancelled");
});

test("query throwing -> failed (not completed)", async () => {
  const boom: ClaudeQuery = async function* () {
    throw new Error("network down");
  };
  const worker = new ClaudeAgentSdkWorker({ query: boom, bridge: NOOP_BRIDGE });
  const res = await worker.run(ASSIGNMENT, ctxOf({ held: true }));
  assert.equal(res.status, "failed");
  assert.match(res.status === "failed" ? res.error : "", /network down/);
});

test("interactive-harness tools (Workflow/Task/Skill) are disallowed (ADR-0024)", async () => {
  let captured: string[] | undefined;
  const capture: ClaudeQuery = async function* ({ options }) {
    captured = options.disallowedTools;
    yield { type: "result", subtype: "success" };
  };
  const worker = new ClaudeAgentSdkWorker({ query: capture, bridge: NOOP_BRIDGE });
  await worker.run(ASSIGNMENT, ctxOf({ held: true }));
  assert.ok(captured?.includes("Workflow"), "Workflow must be disallowed (it detaches into a background run)");
  assert.ok(captured?.includes("Task"), "Task must be disallowed (it spawns an out-of-band subagent)");
  assert.ok(captured?.includes("Skill"), "Skill must be disallowed (it loads bundled skills that fan out via Workflow)");
});
