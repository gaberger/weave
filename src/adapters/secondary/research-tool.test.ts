import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { researchSaveTool } from "./research-tool.js";

const withDir = () => {
  const root = join(mkdtempSync(join(tmpdir(), "weave-research-")), "research");
  return { root, tool: researchSaveTool(() => root) };
};

test("research_save files report.md under research/<topic>/ and slugifies the topic", async () => {
  const { root, tool } = withDir();
  const r = await tool.execute({ topic: "BMP active vs passive connection modes!", report: "# Findings\nactive is default." });
  assert.equal(r.ok, true);
  const savedTo = (r.output as { savedTo: string }).savedTo;
  assert.equal(savedTo, join(root, "bmp-active-vs-passive-connection-modes", "report.md"));
  assert.equal(readFileSync(savedTo, "utf8"), "# Findings\nactive is default.");
});

test("research_save writes sources/<name>.md (incl. MCP-stringified sources)", async () => {
  const { root, tool } = withDir();
  const r = await tool.execute({
    topic: "ECMP vendor comparison",
    report: "report body",
    sources: '[{"name":"Arista EOS","content":"arista notes"},{"name":"Cisco","content":"cisco notes"}]',
  });
  assert.equal(r.ok, true);
  const dir = join(root, "ecmp-vendor-comparison");
  assert.ok(existsSync(join(dir, "sources", "arista-eos.md")));
  assert.equal(readFileSync(join(dir, "sources", "cisco.md"), "utf8"), "cisco notes");
});

test("research_save requires topic + report", async () => {
  const { tool } = withDir();
  assert.equal((await tool.execute({ report: "x" })).ok, false);
  assert.equal((await tool.execute({ topic: "x" })).ok, false);
});

test("research_save is path-traversal safe (topic can't escape the research root)", async () => {
  const { root, tool } = withDir();
  const r = await tool.execute({ topic: "../../etc/pwn", report: "x" });
  // "../../etc/pwn" slugifies to "etc-pwn" — a single safe segment inside root, never an escape.
  assert.equal(r.ok, true);
  const savedTo = (r.output as { savedTo: string }).savedTo;
  assert.ok(savedTo.startsWith(join(root, "etc-pwn")), `must stay in root: ${savedTo}`);
  assert.equal(tool.effect, "reversible");
});
