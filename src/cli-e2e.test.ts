/**
 * End-to-end CLI flows that span the real arg-parsing → workspace/network resolution → substrate →
 * output path. Drives the real `cli.ts` as a subprocess (no mocks of the wiring) against real on-disk
 * SQLite, exercising surfaces cli-features.test.ts doesn't: per-network isolation (separate dbs under
 * the home), the engine-repo guard, and the `networks` / `compact` command dispatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FakeClock } from "./domain/clock.js";
import { TaskKind } from "./domain/task.js";
import { SqliteSubstrate } from "./adapters/secondary/sqlite-substrate.js";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/src$/, "");
const CLI = join(REPO, "src", "cli.ts");

const mkHome = () => mkdtempSync(join(tmpdir(), "weave-e2e-"));

/** Run the real CLI as a subprocess, rooted at workspace `home`. */
function weave(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("node", ["--import", "tsx", CLI, ...args, "--workspace", home], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

/** The on-disk db path the CLI uses for a non-default network under `home` (state nests in .weave/). */
const netDb = (home: string, net: string) => join(home, ".weave", "networks", net, "weave.db");

test("network isolation: tasks declared under different --network-id don't see each other", () => {
  const home = mkHome();
  try {
    assert.equal(weave(home, ["task", "alpha-goal", "--network-id", "netA", "--no-tier"]).status, 0);
    assert.equal(weave(home, ["task", "beta-goal", "--network-id", "netB", "--no-tier"]).status, 0);

    const a = weave(home, ["status", "--network-id", "netA"]);
    const b = weave(home, ["status", "--network-id", "netB"]);
    assert.match(a.stdout, /alpha-goal/, "netA sees its own task");
    assert.ok(!a.stdout.includes("beta-goal"), "netA must NOT see netB's task");
    assert.match(b.stdout, /beta-goal/, "netB sees its own task");
    assert.ok(!b.stdout.includes("alpha-goal"), "netB must NOT see netA's task");

    // Each network got its own db file on disk.
    assert.ok(existsSync(netDb(home, "netA")), "netA db exists");
    assert.ok(existsSync(netDb(home, "netB")), "netB db exists");
    assert.notEqual(netDb(home, "netA"), netDb(home, "netB"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("engine-repo guard: refuses the weave source tree as a workspace", () => {
  // Point --workspace AT the engine repo; resolveWorkspace must refuse (a project must not live in
  // the engine's own source tree, ADR-0016).
  const r = spawnSync("node", ["--import", "tsx", CLI, "status", "--workspace", REPO], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(`${r.stderr}${r.stdout}`, /refusing to use the weave engine repo/);
});

test("networks: lists a network after a task is declared into it", () => {
  const home = mkHome();
  try {
    assert.equal(weave(home, ["task", "g", "--network-id", "netX", "--no-tier"]).status, 0);
    const n = weave(home, ["networks"]);
    assert.equal(n.status, 0, n.stderr);
    const out = n.stdout.replace(/\x1b\[[0-9;]*m/g, ""); // drop ANSI color
    // The home lists the implicit `default` network plus the one we declared into.
    assert.match(out, /netX\s+\S+\s+yes/, "netX is listed with its own db");
    assert.match(out, /2 networks\b/, "home line reports default + netX");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("compact: folds settled subjects and reports before→after counts", async () => {
  const home = mkHome();
  const db = join(home, "weave.db");
  // Seed a settled task (declared + completed) directly through the substrate.
  const sub = new SqliteSubstrate({ filename: db, clock: new FakeClock(1000) });
  try {
    await sub.append({ id: "d1", kind: TaskKind.Declared, actor: "client", subject: "t1", payload: { spec: { goal: "x" } } });
    await sub.append({ id: "c1", kind: TaskKind.Completed, actor: "p", subject: "t1", payload: { summary: "done" } });
  } finally {
    sub.close();
  }
  try {
    const r = weave(home, ["compact", "--db", db]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compacted — folded 1 settled subject/, "reports the fold");
    assert.match(r.stdout, /log \d+ → \d+ events/, "reports before→after counts");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
