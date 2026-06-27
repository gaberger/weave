import { resolve } from "node:path";

import type { ToolRegistry } from "../adapters/secondary/in-memory-tool-host.js";
import { readFileTool, editFileTool, writeFileTool, grepTool } from "../adapters/secondary/fs-tools.js";

/**
 * Register the agent's file-inspection tools, honoring `--target` (least-privilege, ADR-0016).
 *
 * `--target <dir>` roots the read/grep tools at an arbitrary directory to INSPECT it WITHOUT making it
 * the workspace — so weave can analyze any repo (including its own engine source) without tripping the
 * engine-repo guard or needing `--bash`. Target mode is **read-only**: no `edit_file` tool is granted
 * (least-privilege — you don't get write access to a tree you only asked to inspect).
 *
 * Without a target the tools root at `cwd` and `write_file` + `edit_file` (irreversible, grant-gated)
 * are added — `write_file` creates/overwrites, `edit_file` does precise in-place edits.
 *
 * Returns the resolved file root (for logging). Extracted from cli.ts so the invariant is unit-testable.
 */
export function registerInspectTools(registry: ToolRegistry, target: string, cwd: string): string {
  const fileRoot = target ? resolve(target) : cwd;
  registry.register(readFileTool(fileRoot)); // read repo files (e.g. the ADR auditor); rooted at --target
  registry.register(grepTool(fileRoot)); // scan/discover refs across the tree (read)
  if (!target) {
    registry.register(writeFileTool(cwd)); // create/overwrite — off in read-only --target mode
    registry.register(editFileTool(cwd)); // precise in-place edit — off in read-only --target mode
  }
  return fileRoot;
}
