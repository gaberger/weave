import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forwardTools } from "./forward-tools.js";

/** Build a fake package root whose forward-* scripts echo their argv as JSON, so we can assert the
 *  tool builds the right flags and parses JSON — without touching live Forward. */
function fakePackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "weave-fwd-"));
  for (const rel of ["forward-inventory/scripts", "forward-vulnerability/scripts"]) {
    mkdirSync(join(root, "skills", rel), { recursive: true });
  }
  const echo = "import sys, json\nprint(json.dumps({'argv': sys.argv[1:]}))\n";
  const fail = "import sys\nsys.stderr.write('boom\\n')\nsys.exit(3)\n";
  writeFileSync(join(root, "skills/forward-inventory/scripts/list_networks.py"), echo);
  writeFileSync(join(root, "skills/forward-inventory/scripts/list_snapshots.py"), echo);
  writeFileSync(join(root, "skills/forward-vulnerability/scripts/cve_disposition.py"), echo);
  // A separate failing script swapped in per-test by overwriting the target file.
  void chmodSync; void fail;
  return root;
}

const tools = (root: string) => Object.fromEntries(forwardTools({ packageRoot: root }).map((t) => [t.name, t]));

test("forward tools are typed read tools with the expected names", () => {
  const t = tools(fakePackageRoot());
  assert.deepEqual(Object.keys(t).sort(), ["forward_cve_audit", "forward_networks", "forward_snapshots"]);
  for (const def of Object.values(t)) assert.equal(def.effect, "read");
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

test("forward_cve_audit omits disposition=all and requires networkId", async () => {
  const t = tools(fakePackageRoot());
  const missing = await t["forward_cve_audit"]!.execute({});
  assert.equal(missing.ok, false);
  assert.match(String((missing.output as { error: string }).error), /networkId is required/);

  const r = await t["forward_cve_audit"]!.execute({ networkId: "1", disposition: "all" });
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
