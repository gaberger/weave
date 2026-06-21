import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSkills } from "./skill-loader.js";
import { readFileTool, editFileTool } from "./fs-tools.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import type { WorkerContext } from "../../ports/worker.js";

const ctxWith = (tools: WorkerContext["tools"]): WorkerContext => ({
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});

// Deterministic, keyless: the adr-audit code skill runs through the harness's real read_file /
// edit_file tools to reconcile and advance ADR statuses — the audit weave can run on itself.
test("adr-audit reconciles file⟷INDEX and advances finished ADRs (no LLM)", async () => {
  const root = mkdtempSync(join(tmpdir(), "weave-adr-"));
  try {
    mkdirSync(join(root, "docs", "adrs"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "foo.ts"), "export const foo = 1;\n"); // evidence for 0099

    writeFileSync(
      join(root, "docs", "adrs", "INDEX.md"),
      [
        "| ADR | Title | Status | Date |",
        "|-----|-------|--------|------|",
        "| [0099](ADR-0099-x.md) | X | Proposed | 2026-06-21 |",
        "| [0011](ADR-0011-y.md) | Y | Superseded by 0016 | 2026-06-20 |",
        "| [0002](ADR-0002-z.md) | Z | Accepted | 2026-06-19 |",
        "",
      ].join("\n"),
    );
    const adr = (n: string, st: string) => writeFileSync(join(root, "docs", "adrs", n), `# t\n\n- **Status:** ${st}\n`);
    adr("ADR-0099-x.md", "Proposed"); // matches INDEX; has evidence → should advance to Accepted
    adr("ADR-0011-y.md", "Proposed"); // STALE vs INDEX (Superseded) → file should be reconciled
    adr("ADR-0002-z.md", "Accepted"); // already settled → untouched

    const { skills } = await loadSkills("examples/plugins");
    const audit = skills.find((s) => s.name === "adr-audit");
    assert.ok(audit, "adr-audit code skill should load");

    const host = new ToolRegistry().register(readFileTool(root)).register(editFileTool(root)).hostFor({ tools: "*", maxEffect: "irreversible" });
    const res = await audit.run(
      { taskId: "t", spec: { goal: "adr audit", inputs: { indexPath: "docs/adrs/INDEX.md", evidence: { "0099": ["src/foo.ts"] } } } },
      ctxWith(host),
    );

    assert.equal(res.status, "completed");

    const read = (n: string) => readFileSync(join(root, "docs", "adrs", n), "utf8");
    const index = readFileSync(join(root, "docs", "adrs", "INDEX.md"), "utf8");

    // 0099 advanced in BOTH file and INDEX (evidence present).
    assert.match(read("ADR-0099-x.md"), /\*\*Status:\*\* Accepted/);
    assert.match(index, /\[0099\][^\n]*\| Accepted \|/);
    // 0011 file reconciled to the settled INDEX value.
    assert.match(read("ADR-0011-y.md"), /\*\*Status:\*\* Superseded by 0016/);
    // 0002 untouched.
    assert.match(read("ADR-0002-z.md"), /\*\*Status:\*\* Accepted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adr-audit is a clean no-op when everything is already reconciled (idempotent)", async () => {
  const root = mkdtempSync(join(tmpdir(), "weave-adr-"));
  try {
    mkdirSync(join(root, "docs", "adrs"), { recursive: true });
    writeFileSync(
      join(root, "docs", "adrs", "INDEX.md"),
      "| ADR | Title | Status | Date |\n|--|--|--|--|\n| [0002](a.md) | Z | Accepted | 2026-06-19 |\n",
    );
    writeFileSync(join(root, "docs", "adrs", "a.md"), "# t\n\n- **Status:** Accepted\n");

    const { skills } = await loadSkills("examples/plugins");
    const audit = skills.find((s) => s.name === "adr-audit");
    assert.ok(audit, "adr-audit code skill should load");
    const host = new ToolRegistry().register(readFileTool(root)).register(editFileTool(root)).hostFor({ tools: "*", maxEffect: "irreversible" });
    const res = await audit.run({ taskId: "t", spec: { goal: "adr audit", inputs: { indexPath: "docs/adrs/INDEX.md" } } }, ctxWith(host));
    assert.equal(res.status, "completed");
    assert.match(res.summary, /no-op/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
