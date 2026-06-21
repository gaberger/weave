import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import type { Skill } from "../../ports/skill.js";
import type { TaskAssignment, WorkerContext, WorkerResult } from "../../ports/worker.js";
import type { ToolCall, ToolHost, ToolResult } from "../../ports/tool-host.js";

/**
 * Thread entry for {@link SandboxedSkillRunner} (ADR-0017 §4). Loads a code skill and runs it
 * with a `ToolHost` shim whose every call is an RPC to the parent — the skill never holds a
 * real tool, only a message channel the parent gates against its grant.
 */

const port = parentPort;
if (!port) throw new Error("sandboxed-skill-entry must run as a worker thread");

const { skillFile, task } = workerData as { skillFile: string; task: TaskAssignment };

// Correlate async tool RPCs by id.
let nextId = 0;
const pending = new Map<number, (r: ToolResult | { error: string }) => void>();
port.on("message", (msg: { id: number; result?: ToolResult; error?: string }) => {
  const resolve = pending.get(msg.id);
  if (!resolve) return;
  pending.delete(msg.id);
  resolve(msg.error !== undefined ? { error: msg.error } : (msg.result as ToolResult));
});

const tools: ToolHost = {
  available: () => [], // the agent is told its grant out-of-band; the shim only proxies invoke
  invoke: (call: ToolCall) =>
    new Promise<ToolResult>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (r) => ("error" in r ? reject(new Error(r.error)) : resolve(r)));
      port.postMessage({ type: "tool", id, call });
    }),
};

const ctx: WorkerContext = {
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: (note: string) => port.postMessage({ type: "progress", note }),
  signal: new AbortController().signal, // parent enforces timeout/abort by terminating the thread
};

function isSkill(x: unknown): x is Skill {
  return typeof x === "object" && x !== null && typeof (x as Skill).run === "function";
}

async function main(): Promise<void> {
  const mod = (await import(pathToFileURL(skillFile).href)) as Record<string, unknown>;
  const candidate = mod["default"] ?? mod["skill"];
  if (!isSkill(candidate)) {
    port!.postMessage({ type: "error", message: `no Skill export in ${skillFile}` });
    return;
  }
  const result: WorkerResult = await candidate.run(task, ctx);
  port!.postMessage({ type: "done", result });
}

main().catch((e: unknown) => {
  port!.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
});
