import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, extname, basename } from "node:path";

import type { ToolDefinition } from "../../ports/tool-host.js";

const ALLOWED_EXTS = new Set([".md", ".json", ".js", ".mjs", ".ts", ".mts"]);
/** Bare filename: letters, digits, dot, dash, underscore. No slash → no path traversal. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `write_skill` (ADR-0017): author a new skill file into the skills directory so an agent can
 * extend its own capabilities. The written file is later imported and either runs as code (a
 * code skill) or steers an LLM (a declarative `.md`) — so its effect is `irreversible`. That
 * is the whole safety switch: self-modification is gated by the grant's `maxEffect` ceiling
 * exactly like any other tool (ADR-0004). A peer that must not self-extend simply is not
 * granted `write_skill`, or is capped below `irreversible`.
 *
 * The filename is validated to a bare, allowlisted-extension name; the write is pinned inside
 * `dir`. (Confining what the *written code* can then do is the sandbox's job — ADR-0017 §4.)
 */
export function writeSkillTool(dir: string): ToolDefinition {
  return {
    name: "write_skill",
    description:
      "Author a skill file in the skills directory: { filename, content }. " +
      "filename must be a bare name like 'triage.md' or 'scan.mjs' (no slashes/paths).",
    effect: "irreversible",
    inputSchema: { filename: "string (bare, e.g. triage.md)", content: "string" },
    execute: async (args) => {
      const filename = String(args["filename"] ?? "");
      const content = String(args["content"] ?? "");

      if (!SAFE_NAME.test(filename) || basename(filename) !== filename) {
        return { ok: false, output: { error: `unsafe filename: ${JSON.stringify(filename)}` } };
      }
      const ext = extname(filename);
      if (!ALLOWED_EXTS.has(ext)) {
        return { ok: false, output: { error: `disallowed extension: ${ext || "(none)"}` } };
      }

      const path = resolve(dir, filename);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, content, "utf8");
        return { ok: true, output: { written: path, bytes: Buffer.byteLength(content) } };
      } catch (e) {
        return { ok: false, output: { error: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}
