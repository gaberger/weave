import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileTool, editFileTool, grepTool } from "./fs-tools.js";
import { ToolRegistry } from "./in-memory-tool-host.js";

test("read_file returns content and is confined to its root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-fs-"));
  try {
    writeFileSync(join(dir, "a.md"), "hello adr");
    const tool = readFileTool(dir);
    const ok = (await tool.execute({ path: "a.md" })).output as { content: string };
    assert.equal(ok.content, "hello adr");

    const esc = await tool.execute({ path: "../../../etc/passwd" });
    assert.equal(esc.ok, false, "must reject path escaping root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file refuses a symlink that escapes root (symlink-bypass guard)", async () => {
  const root = mkdtempSync(join(tmpdir(), "weave-fs-root-"));
  const outside = mkdtempSync(join(tmpdir(), "weave-fs-out-"));
  try {
    writeFileSync(join(outside, "secret"), "TOP SECRET");
    // A symlink that lives INSIDE root but points OUTSIDE it — a plain prefix check would pass.
    symlinkSync(join(outside, "secret"), join(root, "link"));
    const res = await readFileTool(root).execute({ path: "link" });
    assert.equal(res.ok, false, "must refuse to read through an escaping symlink");
    assert.match((res.output as { error: string }).error, /escapes root/);

    // A symlinked subdir must not smuggle a path out either.
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "f"), "x");
    symlinkSync(join(outside, "sub"), join(root, "subdir"));
    const res2 = await readFileTool(root).execute({ path: "subdir/f" });
    assert.equal(res2.ok, false, "must refuse a path under a symlinked dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("edit_file replaces literal text and fails cleanly when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-fs-"));
  try {
    const f = join(dir, "ADR.md");
    writeFileSync(f, "- **Status:** Proposed\n\nbody\n");
    const tool = editFileTool(dir);

    const hit = await tool.execute({ path: "ADR.md", oldText: "Proposed", newText: "Accepted" });
    assert.equal(hit.ok, true);
    assert.match(readFileSync(f, "utf8"), /\*\*Status:\*\* Accepted/);

    // Re-running is a clean miss, not a corruption — idempotent-friendly.
    const miss = await tool.execute({ path: "ADR.md", oldText: "Proposed", newText: "Accepted" });
    assert.equal(miss.ok, false);
    assert.equal((miss.output as { replaced: number }).replaced, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep finds regex matches across the tree, skips ignored dirs, and is read-effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-fs-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "// see ADR-0042 here\nconst x = 1;\n");
    writeFileSync(join(dir, "src", "b.ts"), "no refs\n");
    writeFileSync(join(dir, "node_modules", "pkg", "c.ts"), "ADR-9999 should be ignored\n");
    const host = new ToolRegistry().register(grepTool(dir)).hostFor({ tools: "*", maxEffect: "read" });
    const res = await host.invoke({ name: "grep", args: { pattern: "ADR-[0-9]{4}", path: "src" } });
    assert.equal(res.ok, true);
    const matches = (res.output as { matches: Array<{ file: string; line: number; text: string }> }).matches;
    assert.equal(matches.length, 1); // node_modules skipped
    assert.equal(matches[0]?.file, "src/a.ts");
    assert.equal(matches[0]?.line, 1);
    // grep is read-effect: a read-capped grant still exposes it.
    assert.ok(new ToolRegistry().register(grepTool(dir)).hostFor({ tools: "*", maxEffect: "read" }).available().some((d) => d.name === "grep"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep refuses a path escaping root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-fs-"));
  try {
    const host = new ToolRegistry().register(grepTool(dir)).hostFor({ tools: "*", maxEffect: "read" });
    const res = await host.invoke({ name: "grep", args: { pattern: "x", path: "../.." } });
    assert.equal(res.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file is irreversible so the grant ceiling gates who may write files", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-fs-"));
  try {
    const registry = new ToolRegistry().register(readFileTool(dir)).register(editFileTool(dir));
    // A read-capped peer sees read_file but NOT edit_file.
    const reader = registry.hostFor({ tools: "*", maxEffect: "read" });
    const names = reader.available().map((d) => d.name).sort();
    assert.deepEqual(names, ["read_file"]);
    // An irreversible-grant peer (e.g. the ADR auditor) gets both.
    const editor = registry.hostFor({ tools: "*", maxEffect: "irreversible" });
    assert.ok(editor.available().some((d) => d.name === "edit_file"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
