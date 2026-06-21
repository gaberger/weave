import { readFileSync, writeFileSync, realpathSync, openSync, closeSync, constants } from "node:fs";
import { resolve, sep, dirname, basename, join } from "node:path";

import type { ToolDefinition } from "../../ports/tool-host.js";

const MAX_BYTES = 512 * 1024;

/**
 * Resolve `p` under `root`, or null if it would escape — a path-traversal guard that also
 * defeats **symlink** escapes: a `../` is caught by the prefix check, but a symlink living
 * inside `root` that points outside would slip a plain `resolve()` check, so we canonicalize
 * with `realpathSync` (resolving every symlink) before comparing. For a target that does not
 * exist yet, we canonicalize its parent dir and re-append the basename, so a symlinked parent
 * can't smuggle a write out of root either.
 */
function inRoot(root: string, p: string): string | null {
  let base: string;
  try {
    base = realpathSync(resolve(root));
  } catch {
    base = resolve(root);
  }
  const target = resolve(base, p);
  let real: string;
  try {
    real = realpathSync(target); // existing file: resolves all symlinks incl. the leaf
  } catch {
    try {
      real = join(realpathSync(dirname(target)), basename(target)); // missing leaf: pin the real parent
    } catch {
      real = target;
    }
  }
  return real === base || real.startsWith(base + sep) ? real : null;
}

/**
 * `read_file` (ADR-0019): read a text file confined to `root`. Effect `read`. This is the
 * primitive weave lacked — without it a skill cannot inspect repo files (e.g. an ADR auditor
 * reconciling docs/ with code). Scoped to a root so a skill's reach is the dir it is granted.
 */
export function readFileTool(root: string): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file (capped), path relative to the tool's root: { path }.",
    effect: "read",
    inputSchema: { path: "string (relative to root)" },
    execute: async (args) => {
      const abs = inRoot(root, String(args["path"] ?? ""));
      if (abs === null) return { ok: false, output: { error: "path escapes root" } };
      try {
        const full = readFileSync(abs, "utf8");
        const truncated = full.length > MAX_BYTES;
        return { ok: true, output: { path: abs, truncated, content: truncated ? full.slice(0, MAX_BYTES) : full } };
      } catch (e) {
        return { ok: false, output: { error: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

/**
 * `edit_file` (ADR-0019): replace literal text in a file confined to `root`. Effect
 * `irreversible` — it mutates a tracked file — so the grant ceiling (ADR-0004) gates which
 * peers may use it. Fails (no write) if `oldText` is absent, so an edit is precise and
 * idempotent-friendly: re-running after success is a no-op miss, not a corruption.
 */
export function editFileTool(root: string): ToolDefinition {
  return {
    name: "edit_file",
    description: "Replace literal text in a file: { path, oldText, newText, all? }. Fails if oldText is absent.",
    effect: "irreversible",
    inputSchema: { path: "string", oldText: "string", newText: "string", all: "boolean?" },
    execute: async (args) => {
      const abs = inRoot(root, String(args["path"] ?? ""));
      if (abs === null) return { ok: false, output: { error: "path escapes root" } };
      const oldText = String(args["oldText"] ?? "");
      const newText = String(args["newText"] ?? "");
      if (oldText === "") return { ok: false, output: { error: "oldText must be non-empty" } };
      try {
        const before = readFileSync(abs, "utf8");
        if (!before.includes(oldText)) return { ok: false, output: { error: "oldText not found", replaced: 0 } };
        const all = args["all"] === true;
        const after = all ? before.split(oldText).join(newText) : before.replace(oldText, newText);
        const replaced = all ? before.split(oldText).length - 1 : 1;
        // O_NOFOLLOW: if the (already realpath-checked) leaf was swapped for a symlink between
        // the check and now, the open fails rather than following it out of root (TOCTOU guard).
        const fd = openSync(abs, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
        try {
          writeFileSync(fd, after, "utf8");
        } finally {
          closeSync(fd);
        }
        return { ok: true, output: { path: abs, replaced } };
      } catch (e) {
        return { ok: false, output: { error: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}
