import { spawn } from "node:child_process";
import { join } from "node:path";

import type { ToolDefinition, ToolResult } from "../../ports/tool-host.js";

/**
 * First-class weave tools for the Forward Networks NetOps pack (ADR-0012 §1, ADR-0016 Ring 2).
 *
 * These are typed front doors over the vendored `skills/forward-<name>/scripts` python — which owns
 * ALL Forward knowledge (API auth, NQE, the datastore model); the tool just invokes it with
 * structured args and returns parsed JSON. The LLM is the ORCHESTRATOR (ADR-0012): it calls a
 * typed tool with parameters and narrates the result. It never hand-writes NQE, never shells Bash,
 * never touches credentials or guesses network IDs — which is exactly what went wrong when these
 * capabilities were only reachable as prose skills run by a generic agent.
 *
 * Determinism lives here: a fixed `python3 <script> <flags>` invocation, JSON-parsed, size-bounded.
 */

export interface ForwardToolsOptions {
  /** Package root containing `skills/` (resolvePackageRoot in cli.ts). */
  readonly packageRoot: string;
  /** Working dir the python runs in — must be where the Forward `.env` lives (creds auto-load). */
  readonly cwd?: string;
  /** Kill a script after this long (default 180s — full-network vuln pulls are slow). */
  readonly timeoutMs?: number;
  /** Cap captured stdout (default 8 MiB — a full CVE audit is large but bounded). */
  readonly maxBytes?: number;
}

/** Coerce a value the MCP bridge may have stringified (Haiku sends arrays/numbers as JSON strings,
 *  see the realToolBridge gotcha) back to a string array of CLI values. */
function asList(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x));
      } catch {
        /* fall through to single value */
      }
    }
    return [s];
  }
  return [String(v)];
}

function asStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function asInt(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

/** Run one forward-* python script with fixed args; resolve to a parsed-JSON ToolResult. */
function runScript(
  opts: ForwardToolsOptions,
  scriptRelPath: string,
  flags: string[],
): Promise<ToolResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const script = join(opts.packageRoot, "skills", scriptRelPath);
  return new Promise<ToolResult>((resolve) => {
    const child = spawn("python3", [script, ...flags], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < maxBytes) stdout += c.toString("utf8");
      else truncated = true;
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString("utf8");
    });
    child.on("error", (e) =>
      (clearTimeout(timer), resolve({ ok: false, output: { error: e.message, script: scriptRelPath } })));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, output: { error: `timed out after ${Math.round(timeoutMs / 1000)}s`, script: scriptRelPath } });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, output: { error: stderr.trim() || `exited ${code}`, code, script: scriptRelPath } });
        return;
      }
      if (truncated) {
        resolve({ ok: false, output: { error: "output exceeded cap; narrow the query (e.g. --disposition / --severity / --limit)", script: scriptRelPath } });
        return;
      }
      try {
        resolve({ ok: true, output: JSON.parse(stdout) });
      } catch {
        resolve({ ok: false, output: { error: "script did not emit JSON", raw: stdout.slice(0, 2000), script: scriptRelPath } });
      }
    });
  });
}

/** Build the Forward NetOps tools. Registered only when the netops pack is active (cli.ts). */
export function forwardTools(opts: ForwardToolsOptions): ToolDefinition[] {
  return [
    {
      name: "forward_networks",
      description:
        "List the Forward networks available to this org (id, name). Call this FIRST to resolve a " +
        "network by name — never assume a network id. Returns JSON.",
      effect: "read",
      inputSchema: {},
      execute: () => runScript(opts, "forward-inventory/scripts/list_networks.py", []),
    },
    {
      name: "forward_snapshots",
      description:
        "List snapshots for a Forward network, or the latest processed one. Args: { networkId, " +
        "latest? (bool) }. Every query runs against one snapshot; default is the latest processed.",
      effect: "read",
      inputSchema: { networkId: "string (required)", latest: "boolean (optional; latest processed only)" },
      execute: (args) => {
        const networkId = asStr(args["networkId"]);
        if (!networkId) return Promise.resolve({ ok: false, output: { error: "networkId is required" } });
        const flags = ["--network-id", networkId];
        if (args["latest"] === true || asStr(args["latest"]) === "true") flags.push("--latest");
        return runScript(opts, "forward-inventory/scripts/list_snapshots.py", flags);
      },
    },
    {
      name: "forward_cve_audit",
      description:
        "CVE disposition audit for a Forward network: every CVE Forward evaluated, its disposition " +
        "(IMPACTED / POTENTIALLY_IMPACTED / NOT_IMPACTED / NOT_EVALUATED) and the REASON it landed " +
        "there — including the filtered-out (NOT_IMPACTED) CVEs and why. Use for 'show the CVEs we " +
        "filtered out and why', vulnerability coverage, and audit artifacts. Returns a summary " +
        "partition plus per-CVE rows with per-OS evidence (version, config-dependence, device counts). " +
        "Args: { networkId (required), snapshotId? (default latest), disposition? (impacted | " +
        "potentially-impacted | not-impacted | not-evaluated | all), severity? (CRITICAL/HIGH/MEDIUM/LOW; " +
        "string or list), limit? (cap rows) }.",
      effect: "read",
      inputSchema: {
        networkId: "string (required)",
        snapshotId: "string (optional; default latest processed)",
        disposition: "string (optional: impacted|potentially-impacted|not-impacted|not-evaluated|all)",
        severity: "string or list (optional: CRITICAL/HIGH/MEDIUM/LOW)",
        limit: "number (optional; cap rows returned)",
      },
      execute: (args) => {
        const networkId = asStr(args["networkId"]);
        if (!networkId) return Promise.resolve({ ok: false, output: { error: "networkId is required" } });
        const flags = ["--network-id", networkId];
        const snap = asStr(args["snapshotId"]);
        if (snap) flags.push("--snapshot-id", snap);
        const disp = asStr(args["disposition"]);
        if (disp && disp !== "all") flags.push("--disposition", disp);
        for (const s of asList(args["severity"])) flags.push("--severity", s);
        const limit = asInt(args["limit"]);
        if (limit) flags.push("--limit", limit);
        return runScript(opts, "forward-vulnerability/scripts/cve_disposition.py", flags);
      },
    },
  ];
}
