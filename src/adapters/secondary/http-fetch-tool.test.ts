import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { ToolRegistry } from "./in-memory-tool-host.js";
import { httpFetchTool } from "./http-fetch-tool.js";

test("http_fetch returns body + status from a real local server", async () => {
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

test("http_fetch reports status 0 on connection failure", async () => {
  const host = new ToolRegistry().register(httpFetchTool).hostFor({ tools: "*", maxEffect: "read" });
  const out = (await host.invoke({ name: "http_fetch", args: { target: "http://127.0.0.1:1/" } }))
    .output as { status: number };
  assert.equal(out.status, 0);
});
