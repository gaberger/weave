import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SandboxedSkillRunner } from "./sandboxed-skill-runner.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import type { ToolDefinition } from "../../ports/tool-host.js";
import type { TaskAssignment, WorkerContext } from "../../ports/worker.js";

const ctxWith = (host: WorkerContext["tools"], signal?: AbortSignal): WorkerContext => ({
  tools: host,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: signal ?? new AbortController().signal,
});

const assignment = (goal: string): TaskAssignment => ({ taskId: "t", spec: { goal, skill: "s" } });

test("sandboxed code skill runs in a thread and returns its result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-sbx-"));
  try {
    const file = join(dir, "ok.mjs");
    writeFileSync(
      file,
      `export default { name: "s", description: "", match: () => true,
         run: async () => ({ status: "completed", summary: "ran in thread" }) };\n`,
    );
    const runner = new SandboxedSkillRunner(() => file, { timeoutMs: 5000 });
    const res = await runner.run(assignment("go"), ctxWith({ available: () => [], invoke: async () => ({ ok: true, output: {} }) }));
    assert.equal(res.status, "completed");
    assert.equal(res.summary, "ran in thread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandboxed skill reaches tools ONLY via RPC to the parent's grant-filtered host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-sbx-"));
  try {
    const file = join(dir, "uses-tool.mjs");
    // The skill calls a tool by name; it never imports the tool — the parent owns it.
    writeFileSync(
      file,
      `export default { name: "s", description: "", match: () => true, run: async (task, ctx) => {
         const r = await ctx.tools.invoke({ name: "echo", args: { v: 41 } });
         return { status: "completed", summary: "echoed " + r.output.v };
       } };\n`,
    );
    const echo: ToolDefinition = {
      name: "echo",
      description: "echo +1",
      effect: "read",
      execute: async (args) => ({ ok: true, output: { v: Number(args["v"]) + 1 } }),
    };
    const host = new ToolRegistry().register(echo).hostFor({ tools: "*", maxEffect: "read" });
    const runner = new SandboxedSkillRunner(() => file, { timeoutMs: 5000 });
    const res = await runner.run(assignment("go"), ctxWith(host));
    assert.equal(res.status, "completed");
    assert.equal(res.summary, "echoed 42"); // proves the RPC round-trip executed the real tool
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runaway sandboxed skill is killed by the timeout and reported failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-sbx-"));
  try {
    const file = join(dir, "runaway.mjs");
    writeFileSync(
      file,
      `export default { name: "s", description: "", match: () => true,
         run: () => new Promise(() => {}) /* never resolves */ };\n`,
    );
    const runner = new SandboxedSkillRunner(() => file, { timeoutMs: 300 });
    const res = await runner.run(assignment("go"), ctxWith({ available: () => [], invoke: async () => ({ ok: true, output: {} }) }));
    assert.equal(res.status, "failed");
    assert.equal(res.error, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
