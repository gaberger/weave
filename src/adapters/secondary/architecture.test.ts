import { test } from "node:test";
import assert from "node:assert/strict";

import { checkArchitecture, layerOf } from "../../domain/architecture.js";
import { scanSourceFiles } from "./source-scan.js";

test("layerOf classifies files by directory + composition entries", () => {
  assert.equal(layerOf("src/domain/event.ts"), "domain");
  assert.equal(layerOf("src/ports/substrate.ts"), "ports");
  assert.equal(layerOf("src/usecases/peer-loop.ts"), "usecases");
  assert.equal(layerOf("src/adapters/secondary/sqlite-substrate.ts"), "adapters");
  assert.equal(layerOf("src/composition-root.ts"), "composition");
  assert.equal(layerOf("src/cli.ts"), "composition");
});

test("checkArchitecture flags inner-imports-outer and missing .js", () => {
  const v = checkArchitecture([
    { path: "src/domain/x.ts", imports: ["../adapters/secondary/y.js"] }, // domain -> adapters
    { path: "src/usecases/u.ts", imports: ["../adapters/secondary/y.js"] }, // usecases -> adapters
    { path: "src/ports/p.ts", imports: ["../domain/x"] }, // missing .js
  ]);
  assert.equal(v.length, 3);
  assert.ok(v.some((x) => x.reason.includes("domain must not import adapters")));
  assert.ok(v.some((x) => x.reason.includes("usecases must not import adapters")));
  assert.ok(v.some((x) => x.reason.includes(".js")));
});

test("checkArchitecture allows the legal cone (and adapter->adapter by default)", () => {
  const v = checkArchitecture([
    { path: "src/ports/p.ts", imports: ["../domain/x.js"] },
    { path: "src/usecases/u.ts", imports: ["../ports/p.js", "../domain/x.js"] },
    { path: "src/adapters/secondary/a.ts", imports: ["../../ports/p.js", "./b.js"] },
    { path: "src/composition-root.ts", imports: ["./adapters/secondary/a.js", "./usecases/u.js"] },
  ]);
  assert.deepEqual(v, []);
});

test("ENFORCED: the weave source tree has no hex boundary violations (STRICT)", () => {
  const files = scanSourceFiles("src");
  const v = checkArchitecture(files, { strict: true }); // strict: no adapter→adapter either
  const report = v.map((x) => `  ${x.file} -> ${x.importPath}: ${x.reason}`).join("\n");
  assert.equal(v.length, 0, `hex architecture violations:\n${report}`);
  assert.ok(files.length > 20, "scanner should find the source files");
});
