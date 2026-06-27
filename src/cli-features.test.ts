/**
 * End-to-end guards for CLI surface features that previously had no automated coverage — they were
 * "validated by live runs only", so CI couldn't catch a regression. These drive the REAL cli.ts as a
 * subprocess (no mocks) against a substrate seeded with controlled completed/failed events:
 *
 *   - `report --json`   machine-readable rows (taskId, actor, status, summary, error)
 *   - `report`          error visibility — a failed task's real error (in payload.error, often
 *                       different from the generic summary) is surfaced, not buried
 *   - `log`             fmt() shows a failed event's first error line in the feed
 *   - `task --file`     batch fan-out: one task per non-blank, non-comment line; `-` reads stdin
 *
 * The substrate is seeded directly via the append seam, then read back through the real CLI — so the
 * arg-parsing → substrate → output wiring is exercised exactly as a user would hit it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FakeClock } from "./domain/clock.js";
import { TaskKind } from "./domain/task.js";
import { SqliteSubstrate } from "./adapters/secondary/sqlite-substrate.js";

const REPO = dirname(fileURLToPath(import.meta.url)).replace(/\/src$/, "");
const CLI = join(REPO, "src", "cli.ts");
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

/** A fresh temp home with a seeded db, ready to drive the CLI at `--db <db> --workspace <home>`. */
function seed(events: Array<{ id: string; kind: string; actor: string; subject: string; payload: unknown }>) {
  const home = mkdtempSync(join(tmpdir(), "weave-cli-"));
  const db = join(home, "weave.db");
  const sub = new SqliteSubstrate({ filename: db, clock: new FakeClock(1000) });
  return (async () => {
    try {
      for (const e of events) await sub.append(e);
    } finally {
      sub.close();
    }
    return { home, db };
  })();
}

/** Run the real CLI as a subprocess, rooted at a temp workspace + db so it's hermetic. */
function weave(home: string, db: string, args: string[], input?: string) {
  return spawnSync("node", ["--import", "tsx", CLI, ...args, "--workspace", home, "--db", db], {
    cwd: REPO,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
}

const COMPLETED = { id: "e1", kind: TaskKind.Completed, actor: "agent-a", subject: "task-ok", payload: { summary: "all good" } };
// A failed task whose generic summary differs from the real error in payload.error — the exact shape
// the error-visibility fix targets (the cause used to be invisible without a db dig).
const FAILED = {
  id: "e2",
  kind: TaskKind.Failed,
  actor: "agent-b",
  subject: "task-bad",
  payload: { summary: "claude worker errored", error: "Error: boom happened\n  at someStackFrame" },
};

test("report --json emits machine-readable rows with status, summary, and error", async () => {
  const { home, db } = await seed([COMPLETED, FAILED]);
  try {
    const r = weave(home, db, ["report", "--json"]);
    assert.equal(r.status, 0, `report --json should exit 0.\n${r.stderr}`);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    const ok = rows.find((x) => x["taskId"] === "task-ok");
    const bad = rows.find((x) => x["taskId"] === "task-bad");
    assert.deepEqual(ok, { taskId: "task-ok", actor: "agent-a", status: "completed", summary: "all good", error: null });
    assert.equal(bad?.["status"], "failed");
    assert.equal(bad?.["error"], "Error: boom happened\n  at someStackFrame");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("report surfaces a failed task's real error (not just the generic summary)", async () => {
  const { home, db } = await seed([FAILED]);
  try {
    const r = weave(home, db, ["report"]);
    assert.equal(r.status, 0, `report should exit 0.\n${r.stderr}`);
    const out = stripAnsi(r.stdout);
    assert.match(out, /claude worker errored/, "the summary is shown");
    assert.match(out, /error:\s*Error: boom happened/, "the real error cause is surfaced");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("log (fmt) shows a failed event's FIRST error line in the feed", async () => {
  const { home, db } = await seed([FAILED]);
  try {
    const r = weave(home, db, ["log"]);
    assert.equal(r.status, 0, `log should exit 0.\n${r.stderr}`);
    const out = stripAnsi(r.stdout);
    const failedLine = out.split("\n").find((l) => l.includes("task.failed")) ?? "";
    assert.match(failedLine, /— Error: boom happened/, "first error line is appended to the event");
    // fmt truncates to the first line, so the rest of the stack must never reach the feed at all —
    // if it leaks (no `.split("\n")[0]`), the embedded newline drops it onto a CONTINUATION line, which
    // a per-line check would miss. Assert against the WHOLE output so this guard actually has teeth.
    assert.ok(!out.includes("someStackFrame"), "only the FIRST error line — the stack must not leak into the feed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("task --file declares one task per non-blank, non-comment line", async () => {
  const { home, db } = await seed([]);
  const goalsFile = join(home, "goals.txt");
  writeFileSync(goalsFile, ["research alpha", "# a comment, skip me", "   ", "research beta", "research gamma"].join("\n"));
  try {
    const r = weave(home, db, ["task", "--file", goalsFile, "--no-tier"]);
    assert.equal(r.status, 0, `task --file should exit 0.\n${r.stderr}`);
    const declared = r.stdout.split("\n").filter((l) => l.startsWith("weave: declared"));
    assert.equal(declared.length, 3, "exactly three non-blank, non-comment goals");
    assert.match(r.stdout, /→ 3 tasks declared/);
    assert.ok(!r.stdout.includes("a comment"), "comment lines must be skipped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("task --file - reads goals from stdin", async () => {
  const { home, db } = await seed([]);
  try {
    const r = weave(home, db, ["task", "--file", "-", "--no-tier"], "from stdin one\nfrom stdin two\n");
    assert.equal(r.status, 0, `task --file - should exit 0.\n${r.stderr}`);
    assert.match(r.stdout, /→ 2 tasks declared/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Drop a minimal code skill into the workspace's `.weave/skills/` so the CLI loads it like a user's. */
function writeSkill(home: string, name: string) {
  const dir = join(home, ".weave", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.mjs`),
    `export default { name: ${JSON.stringify(name)}, description: "test skill", ` +
      `match: (t) => t.spec.goal.includes(${JSON.stringify(name)}), ` +
      `async run(t) { return { status: "completed", summary: t.spec.goal.toUpperCase() }; } };\n`,
  );
}

test("skills --workspace lists a skill in THAT workspace (honors --workspace, not the engine cwd)", async () => {
  const { home, db } = await seed([]);
  try {
    writeSkill(home, "shout");
    const r = weave(home, db, ["skills", "--fake"]);
    assert.equal(r.status, 0, `skills should exit 0.\n${r.stderr}`);
    // The workspace skill must appear, and the header must name the resolved dir (not a hardcoded path).
    assert.match(stripAnsi(r.stdout), /\bshout\b/);
    assert.match(stripAnsi(r.stdout), new RegExp(`from ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.weave/skills`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("task --skill rejects an unknown skill at declare-time (fail-fast, lists what's available)", async () => {
  const { home, db } = await seed([]);
  try {
    writeSkill(home, "shout");
    const r = weave(home, db, ["task", "--fake", "--skill", "nope", "hi"]);
    assert.equal(r.status, 1, `unknown --skill should exit 1.\n${r.stdout}`);
    assert.match(stripAnsi(r.stderr), /no skill named "nope"/);
    assert.match(stripAnsi(r.stderr), /Available:.*shout/); // tells the user the real options
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("task --skill accepts a real workspace skill (declares it)", async () => {
  const { home, db } = await seed([]);
  try {
    writeSkill(home, "shout");
    const r = weave(home, db, ["task", "--fake", "--no-tier", "--skill", "shout", "shout please"]);
    assert.equal(r.status, 0, `valid --skill should exit 0.\n${r.stderr}`);
    assert.match(stripAnsi(r.stdout), /declared .*\[skill:shout\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
