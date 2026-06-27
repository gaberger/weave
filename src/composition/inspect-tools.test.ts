/**
 * Guards the `--target` least-privilege invariant (cli.ts → registerInspectTools).
 *
 *   target set   → read_file + grep, rooted at <target>, NO edit_file (read-only inspection)
 *   target unset → read_file + grep + edit_file, rooted at cwd
 *
 * The "no edit tool in target mode" rule is a security property (you don't get write access to a tree
 * you only asked to inspect), so it deserves a test with teeth, not just a comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../adapters/secondary/in-memory-tool-host.js";
import { registerInspectTools } from "./inspect-tools.js";

const ALL = { tools: "*" as const, maxEffect: "irreversible" as const };
const toolNames = (reg: ToolRegistry): string[] =>
  reg.hostFor(ALL).available().map((t) => t.name).sort();

test("--target mode is read-only: read_file + grep, but NO edit_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-inspect-"));
  try {
    const reg = new ToolRegistry();
    const root = registerInspectTools(reg, dir, "/some/cwd");
    const names = toolNames(reg);
    assert.ok(names.includes("read_file"), "read_file must be granted");
    assert.ok(names.includes("grep"), "grep must be granted");
    assert.ok(!names.includes("edit_file"), "edit_file must NOT be granted in --target mode");
    assert.equal(root, dir, "file root must be the resolved target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no target: read_file + grep + edit_file, rooted at cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "weave-cwd-"));
  try {
    const reg = new ToolRegistry();
    const root = registerInspectTools(reg, "", cwd);
    const names = toolNames(reg);
    assert.deepEqual(names, ["edit_file", "grep", "read_file"], "all three tools when not inspecting");
    assert.equal(root, cwd, "file root must be cwd when no target");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("--target roots reads at the target and confines them (no escape)", async () => {
  const target = mkdtempSync(join(tmpdir(), "weave-target-"));
  const cwd = mkdtempSync(join(tmpdir(), "weave-cwd-"));
  try {
    writeFileSync(join(target, "inside.md"), "inside the target");
    const reg = new ToolRegistry();
    registerInspectTools(reg, target, cwd);
    const host = reg.hostFor(ALL);

    const ok = await host.invoke({ name: "read_file", args: { path: "inside.md" } });
    assert.equal((ok.output as { content: string }).content, "inside the target");

    const escape = await host.invoke({ name: "read_file", args: { path: "../../../etc/passwd" } });
    assert.equal(escape.ok, false, "reads must stay confined to the target root");
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
