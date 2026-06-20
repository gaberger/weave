import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SourceFile } from "../../domain/architecture.js";

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Scan a source tree into `{path, imports}` records for the architecture checker (ADR-0015). */
export function scanSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith(".ts")) {
        const raw = readFileSync(p, "utf8");
        // Strip comments so doc examples like `from "..."` aren't mistaken for imports.
        const text = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but keep `://` in URLs
        const imports: string[] = [];
        let m: RegExpExecArray | null;
        IMPORT_RE.lastIndex = 0;
        while ((m = IMPORT_RE.exec(text)) !== null) {
          if (m[1]) imports.push(m[1]);
        }
        files.push({ path: p.replace(/\\/g, "/"), imports });
      }
    }
  };
  walk(root);
  return files;
}
