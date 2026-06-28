import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMcpServers, mcpToolGrants } from "./mcp-config.js";

function withConfig(body: string, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "weave-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, body);
  try {
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readMcpServers returns the declared server names", () => {
  withConfig(JSON.stringify({ mcpServers: { github: { command: "x" }, slack: { command: "y" } } }), (path) => {
    assert.deepEqual(readMcpServers(path).sort(), ["github", "slack"]);
  });
});

test("readMcpServers fails fast (clear error) on a missing file", () => {
  assert.throws(() => readMcpServers("/no/such/mcp.json"), /cannot read/);
});

test("readMcpServers fails fast on invalid JSON", () => {
  withConfig("{ not json", (path) => assert.throws(() => readMcpServers(path), /not valid JSON/));
});

test("readMcpServers fails fast when there is no mcpServers object", () => {
  withConfig(JSON.stringify({ servers: {} }), (path) => assert.throws(() => readMcpServers(path), /no "mcpServers"/));
});

test("mcpToolGrants grants whole servers by default (mcp__<server>)", () => {
  assert.deepEqual(mcpToolGrants(["github", "slack"]), ["mcp__github", "mcp__slack"]);
});

test("mcpToolGrants honors an explicit allow list (narrow to specific tools)", () => {
  assert.deepEqual(
    mcpToolGrants(["github"], ["mcp__github__create_issue", "mcp__github__get_pr"]),
    ["mcp__github__create_issue", "mcp__github__get_pr"],
  );
});
