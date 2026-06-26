import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A domain **pack** (ADR-0016, Ring 2): a persona/grounding prompt plus the properties the generic
 * engine should apply when that pack is selected (`--persona <name>`). A pack is data, not engine
 * code — the harness core knows nothing about any specific domain (e.g. "netops"); it only knows how
 * to load a pack and honor what it declares.
 *
 * Declared as YAML-ish frontmatter in `skills/<name>/persona.md`, with the body as the prompt:
 *
 *   ---
 *   name: netops
 *   description: Forward NetOps agent
 *   bundles: [*]                 # skill-dir globs to load from the vendored skills/ root
 *   tools: [Bash]               # capability grants the pack's agent needs
 *   serveForVoice: true          # start an embedded peer under `weave voice`
 *   voiceSummary: voice-summary.md
 *   ---
 *   You are **Forward**, the AI NetOps agent...
 */
export interface Pack {
  readonly name: string;
  readonly description: string;
  readonly prompt: string; // grounding system prompt (the frontmatter body)
  readonly bundles: readonly string[]; // skill-name globs to load from the vendored skills root
  readonly tools: readonly string[]; // capability grants (e.g. ["Bash"]) for the pack's agent
  readonly serveForVoice: boolean; // embed a peer under `weave voice` so it's one command
  readonly voiceSummary?: string; // filename (in the pack dir) of the TTS-summary prompt
}

/** Convert a shell-style glob (only `*`) to an anchored RegExp. `forward-*` → /^forward-.*$/. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const parseFrontmatter = (text: string): { meta: Record<string, string>; body: string } | null => {
  const m = /^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: (m[2] ?? "").trim() };
};

const list = (s?: string): string[] =>
  s ? s.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean) : [];
const bool = (s?: string): boolean => s === "true" || s === "yes" || s === "1";

/** Load the pack at `<skillsRoot>/<name>/persona.md`. Returns null if absent or malformed (the
 *  caller then falls back to the generic agent). The prompt is the frontmatter body. */
export function loadPack(skillsRoot: string, name: string): Pack | null {
  let text: string;
  try {
    text = readFileSync(join(skillsRoot, name, "persona.md"), "utf8");
  } catch {
    return null; // no such pack
  }
  const parsed = parseFrontmatter(text);
  if (!parsed || !parsed.body) return null;
  const { meta, body } = parsed;
  return {
    name: meta["name"] ?? name,
    description: meta["description"] ?? (meta["name"] ?? name),
    prompt: body,
    bundles: list(meta["bundles"]),
    tools: list(meta["tools"]),
    serveForVoice: bool(meta["serveForVoice"]),
    ...(meta["voiceSummary"] ? { voiceSummary: meta["voiceSummary"] } : {}),
  };
}

/** Read an auxiliary prompt file the pack points at (e.g. its `voiceSummary`), from the pack dir.
 *  Returns null if absent. */
export function loadPackFile(skillsRoot: string, name: string, file: string): string | null {
  try {
    return readFileSync(join(skillsRoot, name, file), "utf8").trim() || null;
  } catch {
    return null;
  }
}
