/**
 * Regression guards for scripts/ship.sh — the git-ship skill's deterministic ship flow.
 *
 * These bugs were originally caught by *dogfooding* (running ship.sh on itself), not by a test, so a
 * future edit could silently reintroduce them. This harness drives the REAL ship.sh against REAL git
 * (a throwaway working repo pushing to a local bare remote) with a FAKE `gh` on PATH — we only stub the
 * one boundary we can't exercise hermetically (GitHub). The fake `gh`'s `--watch` deliberately FAILS if
 * it is called before any check has registered, which is what gives the "CI-race" guard its teeth.
 *
 * Covered:
 *   1. happy path  — untracked files get committed (bug #1), branch-first, PR opened, merged on green
 *   2. CI race     — checks register a few polls late; ship must wait, then merge (bug #2)
 *   3. red CI      — a failing check gates the merge (ship exits non-zero, does NOT merge)
 *   4. no CI       — no checks ever register → refuse to merge unless --allow-no-ci
 *   5. usage       — missing -m is a usage error
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHIP = join(dirname(fileURLToPath(import.meta.url)), "scripts", "ship.sh");

// A throwaway `gh`. State lives in $STUB_DIR; behaviour is tuned via env vars passed to ship.sh:
//   CHECKS_REGISTER_AFTER  number of bare `gh pr checks` polls before checks appear (models CI lag)
//   CHECKS_RESULT          green | red — what `--watch` reports once checks have registered
// `--watch` exits 1 ("no checks reported") if called before registration — so a ship.sh that skips the
// wait-for-register loop (the bug-#2 regression) fails this test instead of silently merging.
const GH_STUB = [
  "#!/usr/bin/env bash",
  'echo "$*" >> "$STUB_DIR/gh.log"',
  'case "$1" in',
  "  auth) exit 0 ;;", // gh auth status
  "  pr)",
  '    case "$2" in',
  "      view)",
  "        # `gh pr view <branch>` (existence) | `--json number` | `--json url`",
  `        if printf '%s ' "$@" | grep -q -- '--json number'; then echo 1; exit 0; fi`,
  `        if printf '%s ' "$@" | grep -q -- '--json url'; then echo 'http://example.test/pr/1'; exit 0; fi`,
  '        [ -f "$STUB_DIR/pr_created" ] && exit 0 || exit 1 ;;',
  '      create) touch "$STUB_DIR/pr_created"; echo "http://example.test/pr/1"; exit 0 ;;',
  "      checks)",
  `        if printf '%s ' "$@" | grep -q -- '--watch'; then`,
  '          n=$(cat "$STUB_DIR/poll_count" 2>/dev/null || echo 0)',
  '          if [ "$n" -lt "${CHECKS_REGISTER_AFTER:-0}" ]; then echo "no checks reported" >&2; exit 1; fi',
  '          [ "${CHECKS_RESULT:-green}" = "green" ] && exit 0 || { echo "ci/test  fail" >&2; exit 1; }',
  "        else",
  "          # registration probe — empty until enough polls have happened",
  '          n=$(cat "$STUB_DIR/poll_count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_DIR/poll_count"',
  '          [ "$n" -ge "${CHECKS_REGISTER_AFTER:-0}" ] && echo "ci/test  pass  0s  http://example.test"',
  "          exit 0",
  "        fi ;;",
  '      merge) touch "$STUB_DIR/merged"; git push -q origin "HEAD:${STUB_BASE:-main}"; exit 0 ;;',
  "      *) exit 0 ;;",
  "    esac ;;",
  "  *) exit 0 ;;",
  "esac",
  "",
].join("\n");

// Instant `sleep` so the wait-for-register loop doesn't actually pause the test suite.
const SLEEP_STUB = "#!/usr/bin/env bash\nexit 0\n";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A fresh working repo on `main` with one commit, pushing to a local bare `origin`. */
function setup(): { root: string; work: string; bin: string; stubDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ship-test-"));
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  const bin = join(root, "bin");
  const stubDir = join(root, "stub");
  mkdirSync(work);
  mkdirSync(bin);
  mkdirSync(stubDir);

  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  git(work, "init", "-b", "main");
  git(work, "config", "user.email", "ship@test.local");
  git(work, "config", "user.name", "Ship Test");
  git(work, "config", "commit.gpgsign", "false");
  writeFileSync(join(work, "README.md"), "# repo\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-u", "origin", "main");

  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
  writeFileSync(join(bin, "sleep"), SLEEP_STUB, { mode: 0o755 });
  return { root, work, bin, stubDir };
}

function runShip(
  ctx: { work: string; bin: string; stubDir: string },
  args: string[],
  env: Record<string, string> = {},
) {
  return spawnSync("bash", [SHIP, ...args], {
    cwd: ctx.work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env["PATH"]}`, // fake gh + sleep win; real git/sed/etc. fall through
      STUB_DIR: ctx.stubDir,
      STUB_BASE: "main",
      ...env,
    },
  });
}

const tracked = (work: string) =>
  execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: work, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

test("happy path: commits untracked files, branches first, opens a PR, merges on green", () => {
  const ctx = setup();
  try {
    // An UNTRACKED file — the exact shape of bug #1 (git diff alone misses it; ship must `git add -A`).
    writeFileSync(join(ctx.work, "feature.txt"), "new work\n");

    const r = runShip(ctx, ["-m", "feat(x): add feature"]);
    assert.equal(r.status, 0, `ship should exit 0 on green CI.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    // The untracked file made it into the merged history (bug #1 guard).
    git(ctx.work, "checkout", "main");
    git(ctx.work, "pull", "--ff-only", "origin", "main");
    assert.ok(tracked(ctx.work).includes("feature.txt"), "untracked file must be committed and merged");

    const log = execFileSync("cat", [join(ctx.stubDir, "gh.log")], { encoding: "utf8" });
    assert.match(log, /--head ship\//, "must branch off main, not commit to it directly");
    assert.ok(existsSync(join(ctx.stubDir, "pr_created")), "a PR must have been opened");
    assert.ok(existsSync(join(ctx.stubDir, "merged")), "the PR must have been merged on green");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("CI race: waits for late-registering checks, then merges (bug #2 guard)", () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work, "feature.txt"), "x\n");
    // Checks don't appear until the 2nd poll. A ship.sh that skips the wait loop would hit `--watch`
    // at poll 0 → the stub returns "no checks reported" (exit 1) → ship would NOT merge → test fails.
    const r = runShip(ctx, ["-m", "fix(y): thing"], { CHECKS_REGISTER_AFTER: "2" });
    assert.equal(r.status, 0, `ship should wait for checks then merge.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(existsSync(join(ctx.stubDir, "merged")), "must merge once late checks pass");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("red CI gates the merge: ship exits non-zero and does NOT merge", () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.work, "feature.txt"), "x\n");
    const r = runShip(ctx, ["-m", "feat: risky"], { CHECKS_RESULT: "red" });
    assert.notEqual(r.status, 0, "a failing check must make ship exit non-zero");
    assert.ok(!existsSync(join(ctx.stubDir, "merged")), "must NOT merge when CI is red");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("no CI: refuses to merge without --allow-no-ci, merges with it", () => {
  const a = setup();
  try {
    writeFileSync(join(a.work, "feature.txt"), "x\n");
    // CHECKS_REGISTER_AFTER far beyond the 20-poll wait window → no check ever registers.
    const refuse = runShip(a, ["-m", "chore: no ci"], { CHECKS_REGISTER_AFTER: "999" });
    assert.notEqual(refuse.status, 0, "no registered checks must refuse the merge by default");
    assert.ok(!existsSync(join(a.stubDir, "merged")), "must NOT merge when no CI registered");
  } finally {
    rmSync(a.root, { recursive: true, force: true });
  }

  const b = setup();
  try {
    writeFileSync(join(b.work, "feature.txt"), "x\n");
    const allow = runShip(b, ["-m", "chore: no ci", "--allow-no-ci"], { CHECKS_REGISTER_AFTER: "999" });
    assert.equal(allow.status, 0, `--allow-no-ci must merge.\nstdout:\n${allow.stdout}\nstderr:\n${allow.stderr}`);
    assert.ok(existsSync(join(b.stubDir, "merged")), "--allow-no-ci must merge despite no CI");
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
});

test("missing -m is a usage error", () => {
  const ctx = setup();
  try {
    const r = runShip(ctx, []);
    assert.notEqual(r.status, 0, "ship without -m must fail");
    assert.match(`${r.stderr}${r.stdout}`, /-m .* required|usage/i);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
