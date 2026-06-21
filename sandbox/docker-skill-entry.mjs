// Executor entry baked into the weave-sandbox image (ADR-0018). Runs INSIDE the confined
// container (node:alpine, plain ESM — no tsx). It loads the mounted code skill and runs it with
// a ToolHost shim whose every call is an RPC line to the parent over stdout; replies arrive on
// stdin. The skill holds no real tool — only this channel, which the parent gates by grant.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const skillFile = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Correlate async tool RPCs by id.
let nextId = 0;
const pending = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(msg.id);
  if (!resolve) return;
  pending.delete(msg.id);
  resolve(msg);
});

const tools = {
  available: () => [],
  invoke: (call) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error !== undefined ? reject(new Error(msg.error)) : resolve(msg.result)));
      send({ type: "tool", id, call });
    }),
};

const ctx = {
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: (note) => send({ type: "progress", note }),
  signal: new AbortController().signal, // the parent enforces timeout/abort by killing the container
};

try {
  const mod = await import(pathToFileURL(skillFile).href);
  const skill = mod.default ?? mod.skill;
  if (!skill || typeof skill.run !== "function") {
    send({ type: "error", message: `no Skill export in ${skillFile}` });
    process.exit(0);
  }
  const result = await skill.run({ taskId: "sandboxed", spec: { goal: "" } }, ctx);
  send({ type: "done", result });
  process.exit(0);
} catch (e) {
  send({ type: "error", message: e instanceof Error ? e.message : String(e) });
  process.exit(0);
}
