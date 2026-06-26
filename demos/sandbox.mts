// Container sandbox isolation demo (run via tsx). A code skill runs inside a locked-down Docker
// container — `docker run --rm -i --network none --read-only --cap-drop ALL --pids-limit 64
// --memory 256m`. The skill (a) tries to reach the network directly, which the kernel BLOCKS, and
// (b) calls a granted `ping` tool that still round-trips to the parent over stdio RPC. A passing run
// proves both halves at once: OS-level isolation holds AND the capability boundary still works, so
// the container is confined but not crippled. (ADR-0018)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSkillRunner } from "../src/adapters/secondary/docker-skill-runner.js";
import { ToolRegistry } from "../src/adapters/secondary/in-memory-tool-host.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

console.log("   building the sandbox image (idempotent)…");
execFileSync("docker", ["build", "-t", "weave-sandbox", "-f", "sandbox/Dockerfile", "sandbox"], {
  stdio: "ignore",
  cwd: repoRoot,
});

const dir = mkdtempSync(join(tmpdir(), "weave-dsbx-"));
let code = 1;
try {
  const file = join(dir, "s.mjs");
  // The skill runs INSIDE the container. It tries the net directly (must fail: --network none),
  // then asks the parent for a granted tool (must succeed: stdio RPC crosses the boundary).
  writeFileSync(
    file,
    `export default { name: "s", description: "", match: () => true, run: async (task, ctx) => {
       let direct = "blocked";
       try { await fetch("http://example.com"); direct = "REACHED"; } catch {}
       const r = await ctx.tools.invoke({ name: "ping", args: {} });
       return { status: "completed", summary: direct + ":" + r.output.pong };
     } };\n`,
  );

  const ping = { name: "ping", description: "", effect: "read", execute: async () => ({ ok: true, output: { pong: "ok" } }) };
  const host = new ToolRegistry().register(ping).hostFor({ tools: "*", maxEffect: "read" });
  const ctx = {
    tools: host,
    lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
    onProgress: () => {},
    signal: new AbortController().signal,
  };

  console.log("   running a code skill inside  docker run --network none --read-only --cap-drop ALL\n");
  const runner = new DockerSkillRunner(() => file, { image: "weave-sandbox", timeoutMs: 60_000 });
  const res = await runner.run({ taskId: "t", spec: { goal: "go", skill: "s" } }, ctx);

  const [net, tool] = String(res.summary ?? "").split(":");
  console.log(`   container returned:  ${res.status} / "${res.summary}"`);
  console.log(`   • direct fetch(example.com)  → ${net === "blocked" ? "BLOCKED by the kernel ✓" : "REACHED ✗ (isolation breach!)"}`);
  console.log(`   • granted ping tool via RPC  → ${tool === "ok" ? "worked ✓" : "failed ✗"}`);

  code = res.status === "completed" && net === "blocked" && tool === "ok" ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
