import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ToolHost } from "../../ports/tool-host.js";
import type { LeaseGuard } from "../../ports/lease.js";
import type { WorkerContext } from "../../ports/worker.js";
import type { ProbeResult } from "../../domain/interrogation.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import { httpProbeTool } from "./http-probe-tool.js";
import { ProbeWorker } from "./probe-worker.js";

const heldLease: LeaseGuard = { held: async () => true, assertHeld: async () => {}, renew: async () => {} };

const hostReturning = (output: ProbeResult): ToolHost => ({
  available: () => [{ name: "http_probe", description: "", effect: "read", inputSchema: {} }],
  invoke: async () => ({ ok: output.healthy, output }),
});

const ctxWith = (tools: ToolHost, progress: string[] = []): WorkerContext => ({
  tools,
  lease: heldLease,
  onProgress: (n) => progress.push(n),
  signal: new AbortController().signal,
});

const run = (host: ToolHost, inputs: Record<string, unknown>, progress?: string[]) =>
  new ProbeWorker().run({ taskId: "t1", spec: { goal: "probe", inputs } }, ctxWith(host, progress));

test("ProbeWorker: healthy target -> completed OK with finding artifact", async () => {
  const res = await run(hostReturning({ target: "x", status: 200, ms: 12, healthy: true }), { target: "x" });
  assert.equal(res.status, "completed");
  assert.match(res.summary, /OK 200/);
  const finding = JSON.parse(res.status === "completed" ? (res.artifacts?.[0]?.ref ?? "{}") : "{}");
  assert.equal(finding.ok, true);
});

test("ProbeWorker: assertion violation is recorded but task still completes", async () => {
  const res = await run(hostReturning({ target: "x", status: 503, ms: 5, healthy: false }), { target: "x", expectStatus: 200 });
  assert.equal(res.status, "completed"); // the interrogation ran; the finding is negative
  assert.match(res.summary, /VIOLATION/);
  const finding = JSON.parse(res.status === "completed" ? (res.artifacts?.[0]?.ref ?? "{}") : "{}");
  assert.equal(finding.ok, false);
  assert.equal(finding.violated, true);
});

test("ProbeWorker: unreachable (status 0) -> completed with UNREACHABLE finding", async () => {
  const res = await run(hostReturning({ target: "x", status: 0, ms: 1, healthy: false, error: "ECONNREFUSED" }), { target: "x" });
  assert.equal(res.status, "completed");
  assert.match(res.summary, /UNREACHABLE/);
});

test("ProbeWorker: tool throwing -> failed (interrogation could not run)", async () => {
  const host: ToolHost = {
    available: () => [],
    invoke: async () => {
      throw new Error("boom");
    },
  };
  const res = await run(host, { target: "x" });
  assert.equal(res.status, "failed");
});

test("http_probe: real round-trip against a local server", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const host = new ToolRegistry().register(httpProbeTool).hostFor({ tools: "*", maxEffect: "read" });
  try {
    const ok = (await host.invoke({ name: "http_probe", args: { target: `http://127.0.0.1:${port}/health` } })).output as ProbeResult;
    assert.equal(ok.status, 200);
    assert.equal(ok.healthy, true);
    assert.ok(ok.ms >= 0);

    const missing = (await host.invoke({ name: "http_probe", args: { target: `http://127.0.0.1:${port}/missing` } })).output as ProbeResult;
    assert.equal(missing.status, 404);
    assert.equal(missing.healthy, false);
  } finally {
    server.close();
  }
});
