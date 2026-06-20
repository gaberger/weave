import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ToolHost, ToolCall } from "../../ports/tool-host.js";
import type { LeaseGuard } from "../../ports/lease.js";
import type { WorkerContext } from "../../ports/worker.js";
import { parseArxivAtom } from "../../domain/arxiv.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import { httpFetchTool } from "./http-fetch-tool.js";
import { arxivDiscoverSkill } from "./arxiv-skills.js";

const FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2406.00001v1</id>
    <published>2024-06-01T00:00:00Z</published>
    <title>Scaling Laws for Large Language Models</title>
    <summary>We study scaling &amp; behaviour.</summary>
    <author><name>Alice A</name></author>
    <author><name>Bob B</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2406.00002v1</id>
    <published>2024-06-02T00:00:00Z</published>
    <title>Tool Use in Agents</title>
    <summary>Agents use tools.</summary>
    <author><name>Carol C</name></author>
  </entry>
</feed>`;

test("parseArxivAtom: extracts papers, ids, titles, authors", () => {
  const papers = parseArxivAtom(FIXTURE);
  assert.equal(papers.length, 2);
  assert.equal(papers[0]?.id, "2406.00001v1");
  assert.equal(papers[0]?.title, "Scaling Laws for Large Language Models");
  assert.deepEqual(papers[0]?.authors, ["Alice A", "Bob B"]);
  assert.match(papers[0]?.summary ?? "", /scaling & behaviour/);
  assert.equal(papers[1]?.id, "2406.00002v1");
});

test("http_fetch: returns body + status from a real local server", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("hello body");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const host = new ToolRegistry().register(httpFetchTool).hostFor({ tools: "*", maxEffect: "read" });
  try {
    const out = (await host.invoke({ name: "http_fetch", args: { target: `http://127.0.0.1:${port}/` } }))
      .output as { status: number; body: string };
    assert.equal(out.status, 200);
    assert.equal(out.body, "hello body");
  } finally {
    server.close();
  }
});

test("arxiv discover skill: fans out one detail task per paper (subject arxiv:<id>)", async () => {
  const spawned: ToolCall["args"][] = [];
  const tools: ToolHost = {
    available: () => [],
    invoke: async (call: ToolCall) => {
      if (call.name === "http_fetch") return { ok: true, output: { status: 200, body: FIXTURE } };
      if (call.name === "spawn_task") {
        spawned.push(call.args);
        return { ok: true, output: { declared: call.args["subject"] } };
      }
      return { ok: true, output: null };
    },
  };
  const lease: LeaseGuard = { held: async () => true, assertHeld: async () => {}, renew: async () => {} };
  const ctx: WorkerContext = { tools, lease, onProgress: () => {}, signal: new AbortController().signal };

  const res = await arxivDiscoverSkill.run(
    { taskId: "t", spec: { goal: "arxiv llm", inputs: { feedUrl: "http://local/feed" } } },
    ctx,
  );

  assert.equal(res.status, "completed");
  assert.match(res.summary, /2 papers/);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]?.["subject"], "arxiv:2406.00001v1");
  assert.equal(spawned[0]?.["skill"], "arxiv-paper");
});
