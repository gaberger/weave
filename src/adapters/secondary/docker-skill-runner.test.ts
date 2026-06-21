import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { DockerSkillRunner, type SandboxProcess } from "./docker-skill-runner.js";
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

/** A fake container child that speaks the line protocol, so the parent-drive logic is tested
 *  with no Docker. `start` runs once the parent has wired onLine; `onParentLine` reacts to
 *  replies the parent sends back. */
function fakeChild(script: {
  start: (emit: (o: unknown) => void) => void;
  onParentLine?: (line: string, emit: (o: unknown) => void) => void;
  onKilled?: () => void;
}): SandboxProcess {
  let lineCb: ((l: string) => void) | undefined;
  const emit = (o: unknown): void => lineCb?.(JSON.stringify(o));
  return {
    send: (line) => script.onParentLine?.(line, emit),
    onLine: (cb) => {
      lineCb = cb;
      queueMicrotask(() => script.start(emit));
    },
    onError: () => {},
    onExit: () => {},
    kill: () => script.onKilled?.(),
  };
}

test("docker runner: tool RPC round-trips through the parent's grant-filtered host", async () => {
  const echo: ToolDefinition = {
    name: "echo",
    description: "echo +1",
    effect: "read",
    execute: async (args) => ({ ok: true, output: { v: Number(args["v"]) + 1 } }),
  };
  const host = new ToolRegistry().register(echo).hostFor({ tools: "*", maxEffect: "read" });

  const runner = new DockerSkillRunner(() => "/skill/s.mjs", {
    image: "unused-in-fake",
    timeoutMs: 2000,
    spawnProcess: () =>
      fakeChild({
        start: (emit) => emit({ type: "tool", id: 0, call: { name: "echo", args: { v: 41 } } }),
        onParentLine: (line, emit) => {
          const msg = JSON.parse(line) as { id: number; result: { output: { v: number } } };
          emit({ type: "done", result: { status: "completed", summary: `echoed ${msg.result.output.v}` } });
        },
      }),
  });

  const res = await runner.run(assignment("go"), ctxWith(host));
  assert.equal(res.status, "completed");
  assert.equal(res.summary, "echoed 42"); // proves the real tool ran in the parent, relayed in
});

test("docker runner: a runaway container is killed by the timeout and reported failed", async () => {
  let killed = false;
  const runner = new DockerSkillRunner(() => "/skill/s.mjs", {
    image: "unused-in-fake",
    timeoutMs: 100,
    spawnProcess: () => fakeChild({ start: () => {} /* never reports done */, onKilled: () => (killed = true) }),
  });
  const res = await runner.run(assignment("go"), ctxWith({ available: () => [], invoke: async () => ({ ok: true, output: {} }) }));
  assert.equal(res.status, "failed");
  assert.equal(res.error, "timeout");
  assert.equal(killed, true, "the container must be killed on timeout");
});

test("docker runner: no skill file resolved -> failed (not a crash)", async () => {
  const runner = new DockerSkillRunner(() => undefined, { image: "x", timeoutMs: 1000, spawnProcess: () => fakeChild({ start: () => {} }) });
  const res = await runner.run(assignment("go"), ctxWith({ available: () => [], invoke: async () => ({ ok: true, output: {} }) }));
  assert.equal(res.status, "failed");
  assert.equal(res.error, "no_skill_file");
});

// Real end-to-end against the Docker daemon. Opt-in (slow; needs Docker + a built image):
//   WEAVE_DOCKER_SANDBOX=1 npm test
const dockerReady = (() => {
  if (process.env["WEAVE_DOCKER_SANDBOX"] !== "1") return "set WEAVE_DOCKER_SANDBOX=1 (and have Docker) to run";
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return false as const;
  } catch {
    return "docker not available";
  }
})();

test(
  "LIVE: a --network none container cannot reach the net but can call a granted parent tool",
  { skip: dockerReady, timeout: 180_000 },
  async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // Build the sandbox image (idempotent).
    execFileSync("docker", ["build", "-t", "weave-sandbox", "-f", "sandbox/Dockerfile", "sandbox"], { stdio: "ignore" });

    const dir = mkdtempSync(join(tmpdir(), "weave-dsbx-"));
    try {
      const file = join(dir, "s.mjs");
      // The skill tries the net directly (must fail: --network none) then asks the parent tool.
      writeFileSync(
        file,
        `export default { name: "s", description: "", match: () => true, run: async (task, ctx) => {
           let direct = "blocked";
           try { await fetch("http://example.com"); direct = "REACHED"; } catch {}
           const r = await ctx.tools.invoke({ name: "ping", args: {} });
           return { status: "completed", summary: direct + ":" + r.output.pong };
         } };\n`,
      );
      const ping: ToolDefinition = { name: "ping", description: "", effect: "read", execute: async () => ({ ok: true, output: { pong: "ok" } }) };
      const host = new ToolRegistry().register(ping).hostFor({ tools: "*", maxEffect: "read" });
      const runner = new DockerSkillRunner(() => file, { image: "weave-sandbox", timeoutMs: 60_000 });
      const res = await runner.run(assignment("go"), ctxWith(host));
      assert.equal(res.status, "completed");
      assert.equal(res.summary, "blocked:ok"); // net blocked by OS; granted tool worked via RPC
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
