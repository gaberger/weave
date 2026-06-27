/**
 * Guards the generic pack system (pack.ts, ADR-0016 Ring 2): `--persona <name>` loads
 * skills/<name>/persona.md, whose frontmatter DECLARES what the engine applies (bundles, tool grants,
 * voice). The engine knows no specific domain — "netops" is just a pack dir — so the parser is the
 * whole contract. These tests pin the frontmatter parsing, defaults, glob matching, and aux-file reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPack, loadPackFile, globToRegExp } from "./pack.js";

/** Write skills/<name>/<file> under a fresh temp skills root and return the root. */
function packDir(name: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "weave-pack-"));
  mkdirSync(join(root, name), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, name, f), body);
  return root;
}

test("globToRegExp: '*' is a wildcard, everything else is literal", () => {
  assert.ok(globToRegExp("forward-*").test("forward-operator"));
  assert.ok(globToRegExp("forward-*").test("forward-"));
  assert.ok(!globToRegExp("forward-*").test("netops"));
  assert.ok(globToRegExp("*").test("anything-at-all"));
  // A literal dot must not act as a regex metachar.
  assert.ok(globToRegExp("a.b").test("a.b"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("loadPack: parses frontmatter and uses the body as the prompt", () => {
  const root = packDir("netops", {
    "persona.md": [
      "---",
      "name: netops",
      "description: Forward NetOps agent",
      "bundles: [forward-*, recall]",
      "tools: [Bash]",
      "serveForVoice: true",
      "voiceSummary: voice-summary.md",
      "---",
      "You are **Forward**, the AI NetOps agent.",
    ].join("\n"),
  });
  try {
    const pack = loadPack(root, "netops");
    assert.ok(pack, "pack must load");
    assert.equal(pack!.name, "netops");
    assert.equal(pack!.description, "Forward NetOps agent");
    assert.equal(pack!.prompt, "You are **Forward**, the AI NetOps agent.");
    assert.deepEqual(pack!.bundles, ["forward-*", "recall"]);
    assert.deepEqual(pack!.tools, ["Bash"]);
    assert.equal(pack!.serveForVoice, true);
    assert.equal(pack!.voiceSummary, "voice-summary.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPack: sane defaults when frontmatter is sparse", () => {
  const root = packDir("minimal", {
    "persona.md": ["---", "description: just a prompt", "---", "Be helpful."].join("\n"),
  });
  try {
    const pack = loadPack(root, "minimal");
    assert.ok(pack);
    assert.equal(pack!.name, "minimal", "name falls back to the dir name");
    assert.equal(pack!.prompt, "Be helpful.");
    assert.deepEqual(pack!.bundles, [], "bundles default to empty");
    assert.deepEqual(pack!.tools, [], "tools default to empty");
    assert.equal(pack!.serveForVoice, false, "serveForVoice defaults to false");
    assert.equal(pack!.voiceSummary, undefined, "no voiceSummary key → undefined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPack: returns null for a missing pack or one with no body", () => {
  const root = packDir("empty", {
    "persona.md": ["---", "name: empty", "---", "   "].join("\n"), // frontmatter but no body
  });
  try {
    assert.equal(loadPack(root, "does-not-exist"), null, "missing pack → null (fall back to generic)");
    assert.equal(loadPack(root, "empty"), null, "no body → null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPackFile: reads an aux prompt file, null when absent", () => {
  const root = packDir("netops", {
    "persona.md": ["---", "name: netops", "---", "body"].join("\n"),
    "voice-summary.md": "  Speak the result aloud.  \n",
  });
  try {
    assert.equal(loadPackFile(root, "netops", "voice-summary.md"), "Speak the result aloud.");
    assert.equal(loadPackFile(root, "netops", "missing.md"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
