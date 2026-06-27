import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSkillTool } from "./write-skill-tool.js";
import { loadSkills, skillsDirSignature } from "./skill-loader.js";
import { ReloadableSkillSet } from "./reloadable-skill-set.js";
import { SkillRouterWorker } from "./skill-router-worker.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import type { WorkerContext } from "../../ports/worker.js";

const ctx = (): WorkerContext => ({
  tools: { available: () => [], invoke: async () => ({ ok: true, output: {} }) },
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});

// A code skill the agent might author: matches "greet", returns completed.
const GREET_SKILL = `export default {
  name: "greet",
  description: "greets",
  match: (t) => t.spec.goal.includes("greet"),
  run: async () => ({ status: "completed", summary: "hello from a self-authored skill" }),
};
`;

test("write_skill rejects path traversal and bad extensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-ws-"));
  try {
    const tool = writeSkillTool(dir);
    const bad = ["../escape.mjs", "a/b.mjs", "no-ext", "evil.sh"];
    for (const filename of bad) {
      const res = await tool.execute({ filename, content: "x" });
      assert.equal(res.ok, false, `should reject ${filename}`);
    }
    const ok = await tool.execute({ filename: "greet.mjs", content: GREET_SKILL });
    assert.equal(ok.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_skill is irreversible so the grant ceiling gates self-modification", () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-ws-"));
  try {
    const registry = new ToolRegistry().register(writeSkillTool(dir));
    // A read-capped peer cannot reach write_skill...
    const capped = registry.hostFor({ tools: "*", maxEffect: "read" });
    assert.equal(capped.available().some((d) => d.name === "write_skill"), false);
    // ...only an irreversible-grant peer can.
    const trusted = registry.hostFor({ tools: ["write_skill"], maxEffect: "irreversible" });
    assert.equal(trusted.available().some((d) => d.name === "write_skill"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("self-extension loop: write_skill → reload → router routes to the new skill", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-skills-"));
  try {
    const scanner = { signature: () => skillsDirSignature(dir), load: (version: number) => loadSkills(dir, { version }) };
    const skills = new ReloadableSkillSet([], [], scanner);
    const router = new SkillRouterWorker(skills);

    // Before authoring: no skill matches → failed.
    const before = await router.run({ taskId: "t1", spec: { goal: "please greet me" } }, ctx());
    assert.equal(before.status, "failed");

    // The agent authors a skill via the tool; the peer's reload poller does exactly this refresh().
    const write = await writeSkillTool(dir).execute({ filename: "greet.mjs", content: GREET_SKILL });
    assert.equal(write.ok, true);
    const r = await skills.refresh();
    assert.equal(r.changed, true);
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));

    // After reload: the same router (unchanged) now routes to the self-authored skill.
    const after = await router.run({ taskId: "t2", spec: { goal: "please greet me" } }, ctx());
    assert.equal(after.status, "completed");
    assert.match(after.summary, /self-authored/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload picks up a rewritten skill via version cache-bust", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weave-skills-"));
  try {
    const file = join(dir, "v.mjs");
    const mk = (msg: string) =>
      `export default { name: "v", description: "v", match: () => true, run: async () => ({ status: "completed", summary: ${JSON.stringify(msg)} }) };\n`;

    writeFileSync(file, mk("first"));
    const a = await loadSkills(dir, { version: 1 });
    assert.equal((await a.skills[0]!.run({ taskId: "t", spec: { goal: "x" } }, ctx())).summary, "first");

    writeFileSync(file, mk("second"));
    const b = await loadSkills(dir, { version: 2 });
    assert.equal((await b.skills[0]!.run({ taskId: "t", spec: { goal: "x" } }, ctx())).summary, "second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
