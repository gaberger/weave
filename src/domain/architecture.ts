/** Hexagonal boundary checker (ADR-0015). Pure — no I/O; fed file records by a scanner. */

export type Layer = "domain" | "ports" | "usecases" | "adapters" | "composition" | "other";

export interface SourceFile {
  readonly path: string;
  /** Specifiers from `from "..."` / `import("...")`. */
  readonly imports: readonly string[];
}

export interface Violation {
  readonly file: string;
  readonly importPath: string;
  readonly reason: string;
}

const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  ports: ["domain", "ports"],
  usecases: ["domain", "ports", "usecases"],
  adapters: ["domain", "ports", "adapters"],
  composition: ["domain", "ports", "usecases", "adapters", "composition"],
  other: ["domain", "ports", "usecases", "adapters", "composition", "other"],
};

export function layerOf(path: string): Layer {
  const p = path.replace(/\\/g, "/").replace(/\.(ts|js|mts|mjs)$/, "");
  if (p.endsWith("/composition-root") || p.endsWith("/cli") || p === "src/cli") return "composition";
  if (p.includes("/domain/")) return "domain";
  if (p.includes("/ports/")) return "ports";
  if (p.includes("/usecases/")) return "usecases";
  if (p.includes("/adapters/")) return "adapters";
  return "other";
}

function resolveRelative(fromFile: string, spec: string): string {
  const dir = fromFile.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const out: string[] = [];
  for (const part of `${dir}/${spec}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const isTest = (path: string): boolean => path.includes(".test.") || path.includes("-test.");

export function checkArchitecture(
  files: readonly SourceFile[],
  opts: { strict?: boolean } = {},
): Violation[] {
  const allowed: Record<Layer, readonly Layer[]> = opts.strict
    ? { ...ALLOWED, adapters: ["domain", "ports"] } // strict: adapters import no other adapters
    : ALLOWED;

  const violations: Violation[] = [];
  for (const f of files) {
    if (isTest(f.path)) continue; // tests may import anything
    const from = layerOf(f.path);
    for (const spec of f.imports) {
      if (!spec.startsWith(".")) continue; // package / node: builtin
      if (!spec.endsWith(".js")) {
        violations.push({ file: f.path, importPath: spec, reason: "relative import must end in .js (NodeNext)" });
      }
      const to = layerOf(resolveRelative(f.path, spec));
      if (!allowed[from].includes(to)) {
        violations.push({ file: f.path, importPath: spec, reason: `${from} must not import ${to}` });
      }
    }
  }
  return violations;
}
