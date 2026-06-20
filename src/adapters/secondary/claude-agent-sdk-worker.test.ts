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
}): WorkerContext => ({
  tools: opts.toolName ? hostWith(opts.toolName, opts.toolEffect ?? "irreversible") : new ToolRegistry().hostFor(GRANT),
  lease: lease(opts.held),
  onProgress: (n) => opts.progress?.push(n),
  signal: opts.signal ?? new AbortController().signal,
});

/** A fake `query` that optionally drives the gate via canUseTool, then emits text + a result. */
const fakeQuery = (script: {
  toolCall?: string;
  assistantText?: string[];
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
