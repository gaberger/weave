import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Skill } from "../../ports/skill.js";
import { loadSkills, skillsDirSignature } from "./skill-loader.js";
import { ReloadableSkillSet } from "./reloadable-skill-set.js";

/** A code-skill module whose `description` carries a marker — so a reload that re-evaluates the
 *  module (busting the ESM cache) is observable, and a `size`-changing body defeats coarse mtime. */
function skillFile(name: string, marker: string): string {
  return (
    `export default { name: ${JSON.stringify(name)}, description: ${JSON.stringify(marker)}, ` +
    `match: () => false, async run() { return { status: "completed", summary: ${JSON.stringify(marker)} }; } };\n`
  );
}

const FALLBACK: Skill = {
  name: "fallback",
  description: "static tail",
  match: () => true,
  async run() {
    return { status: "completed", summary: "fb" };
  },
};

/** Build a set the way cmdUp does: initial code via loadSkills, then wrap with the static tail. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "weave-reload-"));
  const added: string[] = [];
  const scanner = {
    signature: () => skillsDirSignature(dir),
    load: (version: number) => loadSkills(dir, { version }),
  };
  const make = async () => {
    const { skills } = await loadSkills(dir);
    return new ReloadableSkillSet(skills, [FALLBACK], scanner, (a) => added.push(...a.map((s) => s.name)));
  };
  return { dir, added, make };
}

test("all() returns the code-skill slice ahead of the static tail", async () => {
  const { dir, make } = await setup();
  try {
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v1"));
    const set = await make();
    assert.deepEqual(set.all().map((s) => s.name), ["a", "fallback"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh() is a no-op (changed:false) when the dir hasn't moved", async () => {
  const { dir, make } = await setup();
  try {
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v1"));
    const set = await make();
    const r = await set.refresh();
    assert.equal(r.changed, false);
    assert.deepEqual(r.added, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh() picks up a newly-dropped skill and reports it as added", async () => {
  const { dir, added, make } = await setup();
  try {
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v1"));
    const set = await make();
    writeFileSync(join(dir, "b.mjs"), skillFile("b", "v1")); // drop a new skill after start
    const r = await set.refresh();
    assert.equal(r.changed, true);
    assert.deepEqual(r.names, ["a", "b"]);
    assert.deepEqual(r.added.map((s) => s.name), ["b"]);
    assert.deepEqual(added, ["b"]); // onChange fired for tool registration
    assert.deepEqual(set.all().map((s) => s.name), ["a", "b", "fallback"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh() re-evaluates an edited skill (busts the ESM module cache)", async () => {
  const { dir, make } = await setup();
  try {
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v1"));
    const set = await make();
    assert.equal(set.all().find((s) => s.name === "a")?.description, "v1");
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v2-longer")); // rewrite in place (size changes too)
    const r = await set.refresh();
    assert.equal(r.changed, true);
    // Without the version cache-bust this would still read "v1" from the import cache.
    assert.equal(set.all().find((s) => s.name === "a")?.description, "v2-longer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh() drops a removed skill", async () => {
  const { dir, make } = await setup();
  try {
    writeFileSync(join(dir, "a.mjs"), skillFile("a", "v1"));
    writeFileSync(join(dir, "b.mjs"), skillFile("b", "v1"));
    const set = await make();
    assert.deepEqual(set.all().map((s) => s.name), ["a", "b", "fallback"]);
    rmSync(join(dir, "b.mjs"));
    const r = await set.refresh();
    assert.equal(r.changed, true);
    assert.deepEqual(set.all().map((s) => s.name), ["a", "fallback"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
