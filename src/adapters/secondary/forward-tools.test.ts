import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forwardTools } from "./forward-tools.js";

/** Build a fake package root whose forward-* scripts echo their argv as JSON, so we can assert the
 *  tool builds the right flags and parses JSON — without touching live Forward. */
function fakePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "weave-fwd-"));
  for (const rel of ["forward-inventory/scripts", "forward-vulnerability/scripts",
    "forward-changeset/scripts", "forward-device-tag/scripts", "forward-report-table/scripts"]) {
    mkdirSync(join(root, "skills", rel), { recursive: true });
  }
  const echo = "import sys, json\nprint(json.dumps({'argv': sys.argv[1:]}))\n";
  const fail = "import sys\nsys.stderr.write('boom\\n')\nsys.exit(3)\n";
  for (const s of ["forward-inventory/scripts/list_networks.py", "forward-inventory/scripts/list_snapshots.py",
    "forward-vulnerability/scripts/cve_disposition.py", "forward-changeset/scripts/create_changeset.py",
    "forward-changeset/scripts/delete_changeset.py", "forward-device-tag/scripts/create_tag.py"]) {
    writeFileSync(join(root, "skills", s), echo);
  }
  // A renderer: reads JSON on stdin, emits FORMATTED TEXT (argv + the stdin data) — not JSON.
  writeFileSync(join(root, "skills/forward-report-table/scripts/render.py"),
    "import sys\nprint('ARGV ' + ' '.join(sys.argv[1:]))\nprint('DATA ' + sys.stdin.read())\n");
  // A bash SSH script: echoes its positional argv (so we can assert ordering without touching a device).
  mkdirSync(join(root, "skills/network-ssh-provision/scripts"), { recursive: true });
  writeFileSync(join(root, "skills/network-ssh-provision/scripts/ssh-device.sh"), 'echo "ARGV $*"\n');
  // A separate failing script swapped in per-test by overwriting the target file.
  void chmodSync; void fail;
  return root;
}

const tools = (root: string) => Object.fromEntries(forwardTools({ packageRoot: root }).map((t) => [t.name, t]));

test("read tools are effect:read; write tools are effect:irreversible (lease-gated, ADR-0004)", () => {
  const t = tools(fakePackageRoot());
  for (const name of ["forward_networks", "forward_snapshots", "forward_devices", "forward_cve_audit",
    "nqe_search", "nqe_get_source", "nqe_run", "path_search", "config_get", "config_grep",
    "changeset_list", "tag_list"]) {
    assert.ok(t[name], `missing tool ${name}`);
    assert.equal(t[name]!.effect, "read", `${name} should be read`);
  }
  for (const name of ["changeset_create", "changeset_edit", "changeset_commit", "changeset_delete",
    "tag_create", "tag_delete", "tag_devices", "untag_devices", "ssh_run", "ssh_push"]) {
    assert.ok(t[name], `missing write tool ${name}`);
    assert.equal(t[name]!.effect, "irreversible", `${name} should be irreversible`);
  }
});

test("SSH tool: positional args via bash, execute-gated, raw output (no live device touched)", async () => {
  const t = tools(fakePackageRoot());
  // Without execute: a no-guard WRITE → synthetic plan, NOT spawned (no device contacted).
  const preview = await t["ssh_run"]!.execute({ host: "rtr-1", command: "show version" });
  assert.equal((preview.output as { dryRun?: boolean }).dryRun, true, "must preview, not run");
  assert.equal((preview.output as { content?: string }).content, undefined, "must not spawn");
  // With execute: runs via bash, positional order host→command→username, raw text out.
  const r = await t["ssh_run"]!.execute({ host: "rtr-1", command: "show version", username: "admin", execute: true });
  assert.equal(r.ok, true);
  assert.match((r.output as { content: string }).content, /ARGV rtr-1 show version admin/);
  // Missing required positional is rejected.
  const bad = await t["ssh_run"]!.execute({ host: "rtr-1", execute: true });
  assert.equal(bad.ok, false);
  assert.match(String((bad.output as { error: string }).error), /command is required/);
});

test("WRITE gate: a script with --dry-run previews (spawns with --dry-run) when execute is not set", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["changeset_create"]!.execute({ networkId: "1", name: "cs" });
  assert.equal(r.ok, true);
  const argv = (r.output as { argv: string[] }).argv;
  assert.ok(argv.includes("--dry-run"), "preview must pass --dry-run");
  assert.ok(!argv.includes("--yes") && !argv.includes("--execute"), "preview must not pass a confirm flag");
});

test("WRITE gate: a no-guard script is NOT spawned without execute — returns a synthetic plan", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["tag_create"]!.execute({ networkId: "1", tagName: "prod" });
  assert.equal(r.ok, true);
  const out = r.output as { dryRun?: boolean; wouldRun?: string; argv?: string[] };
  assert.equal(out.dryRun, true, "must be a synthetic dry-run");
  assert.equal(out.argv, undefined, "must NOT have spawned the script");
  assert.match(String(out.wouldRun), /create_tag\.py/);
});

test("WRITE gate: execute:true applies — spawns with the confirm flag (--yes), no --dry-run", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["changeset_delete"]!.execute({ networkId: "1", changesetId: "cs-9", execute: true });
  assert.equal(r.ok, true);
  const argv = (r.output as { argv: string[] }).argv;
  assert.ok(argv.includes("--yes"), "execute must add the script's --yes confirm flag");
  assert.ok(!argv.includes("--dry-run"), "execute must not pass --dry-run");
});

test("WRITE gate: execute:true on a no-guard script spawns it (the real mutation path)", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["tag_create"]!.execute({ networkId: "1", tagName: "prod", execute: true });
  assert.equal(r.ok, true);
  const argv = (r.output as { argv: string[] }).argv;
  assert.deepEqual(argv, ["--network-id", "1", "--tag-name", "prod"]);
});

test("RENDER tool: pipes `data` to stdin (JSON-stringified) and returns raw formatted text", async () => {
  const t = tools(fakePackageRoot());
  // A renderer may write a file (auto-file), so it is reversible — not read.
  assert.equal(t["report_table"]!.effect, "reversible");
  const r = await t["report_table"]!.execute({ data: { rows: [{ a: 1 }] }, format: "markdown" });
  assert.equal(r.ok, true);
  const content = (r.output as { content: string }).content;
  assert.match(content, /ARGV .*--format markdown/, "format flag is passed");
  assert.match(content, /DATA \{"rows":\[\{"a":1\}\]\}/, "data is JSON-stringified onto stdin");
  // raw output: NOT JSON-parsed, and NOT filed (no networkId) → no savedTo.
  assert.equal((r.output as { argv?: unknown }).argv, undefined);
  assert.equal((r.output as { savedTo?: unknown }).savedTo, undefined);
});

test("RENDER tool: listTemplates needs no data and does not hang on stdin", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["report_table"]!.execute({ listTemplates: true });
  assert.equal(r.ok, true);
  assert.match((r.output as { content: string }).content, /ARGV .*--list-templates/);
});

test("RENDER tool: networkId auto-files the artifact under the per-network reports dir", async () => {
  const root = fakePackageRoot();
  const home = mkdtempSync(join(tmpdir(), "weave-home-"));
  const reportsDir = (fwd: string) => join(home, "networks", fwd, "reports");
  const t = Object.fromEntries(forwardTools({ packageRoot: root, reportsDir }).map((x) => [x.name, x]));
  const r = await t["report_table"]!.execute({ data: [{ a: 1 }], format: "csv", networkId: "212984", name: "cve audit!" });
  assert.equal(r.ok, true);
  const savedTo = (r.output as { savedTo: string }).savedTo;
  // name sanitized, extension from format, under networks/<id>/reports/
  assert.equal(savedTo, join(home, "networks", "212984", "reports", "cve-audit.csv"));
  assert.equal(readFileSync(savedTo, "utf8"), (r.output as { content: string }).content);
});

test("RENDER tool: a path-traversal networkId is rejected, not written (security)", async () => {
  const root = fakePackageRoot();
  const home = mkdtempSync(join(tmpdir(), "weave-home-"));
  let resolverCalled = false;
  const reportsDir = (fwd: string) => { resolverCalled = true; return join(home, "networks", fwd, "reports"); };
  const t = Object.fromEntries(forwardTools({ packageRoot: root, reportsDir }).map((x) => [x.name, x]));
  for (const bad of ["../../etc", "..", "a/b", "x/../../y", ""]) {
    const r = await t["report_table"]!.execute({ data: [{ a: 1 }], format: "csv", networkId: bad });
    assert.equal(r.ok, true);
    const out = r.output as { savedTo?: string; saveError?: string; content?: string };
    assert.equal(out.savedTo, undefined, `must not file for networkId ${JSON.stringify(bad)}`);
    if (bad !== "") assert.match(String(out.saveError), /not a valid id/);
    assert.ok(out.content !== undefined, "still returns the rendered content");
  }
  assert.equal(resolverCalled, false, "the reports-dir resolver is never called with an invalid id");
});

test("forward_networks runs the script and parses its JSON", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["forward_networks"]!.execute({});
  assert.equal(r.ok, true);
  assert.deepEqual((r.output as { argv: string[] }).argv, []);
});

test("forward_cve_audit maps args to flags (incl. coerced stringified severity list)", async () => {
  const t = tools(fakePackageRoot());
  const r = await t["forward_cve_audit"]!.execute({
    networkId: "212984",
    disposition: "not-impacted",
    severity: '["CRITICAL","HIGH"]', // MCP bridge may stringify arrays — must be coerced
    limit: "5",
  });
  assert.equal(r.ok, true);
  const argv = (r.output as { argv: string[] }).argv;
  assert.deepEqual(argv, [
    "--network-id", "212984",
    "--disposition", "not-impacted",
    "--severity", "CRITICAL", "--severity", "HIGH",
    "--limit", "5",
  ]);
});

test("forward_cve_audit requires networkId and omits absent optional args", async () => {
  const t = tools(fakePackageRoot());
  const missing = await t["forward_cve_audit"]!.execute({});
  assert.equal(missing.ok, false);
  assert.match(String((missing.output as { error: string }).error), /networkId is required/);

  // Only networkId given -> optional flags omitted (the scaffold drops undefined args).
  const r = await t["forward_cve_audit"]!.execute({ networkId: "1" });
  assert.deepEqual((r.output as { argv: string[] }).argv, ["--network-id", "1"]);
});

test("a non-zero script exit surfaces stderr as ok:false (never silently empty)", async () => {
  const root = fakePackageRoot();
  // Overwrite cve_disposition with a failing script.
  writeFileSync(join(root, "skills/forward-vulnerability/scripts/cve_disposition.py"),
    "import sys\nsys.stderr.write('boom\\n')\nsys.exit(3)\n");
  const t = tools(root);
  const r = await t["forward_cve_audit"]!.execute({ networkId: "1" });
  assert.equal(r.ok, false);
  assert.match(String((r.output as { error: string }).error), /boom/);
});
