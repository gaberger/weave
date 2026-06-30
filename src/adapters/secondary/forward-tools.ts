import { spawn } from "node:child_process";
import { join } from "node:path";

import type { Effect } from "../../domain/effect.js";
import type { ToolDefinition, ToolResult } from "../../ports/tool-host.js";

/**
 * First-class weave tools for the Forward Networks NetOps pack (ADR-0012 §1, ADR-0016 Ring 2).
 *
 * Each tool is a typed front door over a vendored `skills/forward-<name>/scripts` python — which
 * owns ALL Forward knowledge (API auth, NQE, the datastore model). The tool invokes it with
 * STRUCTURED args and returns parsed JSON. The LLM is the ORCHESTRATOR (ADR-0012): it calls a typed
 * tool with parameters and narrates the result. It never hand-writes NQE, shells Bash, touches
 * credentials, or guesses a network id — the failure mode that motivated this conversion.
 *
 * Tools are declared as data (`SPECS`) and built by one factory, so the forward-* fan-out is a
 * matter of adding spec rows, not bespoke code. The contract is the project standard: structured
 * args in → one `python3 <script> <flags>` invocation → JSON out (creds via the env's .env).
 */

export interface ForwardToolsOptions {
  /** Package root containing `skills/` (resolvePackageRoot in cli.ts). */
  readonly packageRoot: string;
  /** Working dir the python runs in — must be where the Forward `.env` lives (creds auto-load). */
  readonly cwd?: string;
  /** Kill a script after this long (default 180s — full-network pulls are slow). */
  readonly timeoutMs?: number;
  /** Cap captured stdout (default 8 MiB — bounded but large enough for a full audit). */
  readonly maxBytes?: number;
}

type ArgKind = "string" | "int" | "list" | "bool" | "positional";

interface ArgSpec {
  /** Tool-input key the orchestrator supplies. */
  readonly key: string;
  /** CLI flag, e.g. "--network-id". Ignored for kind "positional". */
  readonly flag?: string;
  readonly kind: ArgKind;
  readonly required?: boolean;
  /** One-line schema/usage hint shown to the orchestrator. */
  readonly desc: string;
}

interface ScriptToolSpec {
  readonly name: string;
  readonly script: string; // path under skills/, e.g. "forward-nqe-query/scripts/run_query.py"
  readonly effect?: Effect; // default "read"
  readonly description: string;
  readonly args: readonly ArgSpec[];
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

function isTruthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Build the CLI argv for a spec from the orchestrator's args, or return an error string. */
function buildFlags(spec: ScriptToolSpec, args: Readonly<Record<string, unknown>>): string[] | { error: string } {
  const flags: string[] = [];
  for (const a of spec.args) {
    const raw = args[a.key];
    if (a.kind === "bool") {
      if (isTruthy(raw) && a.flag) flags.push(a.flag);
      continue;
    }
    if (a.kind === "list") {
      const vals = asList(raw);
      if (a.required && vals.length === 0) return { error: `${a.key} is required` };
      for (const v of vals) if (a.flag) flags.push(a.flag, v);
      continue;
    }
    const val = a.kind === "int" ? asInt(raw) : asStr(raw);
    if (val === undefined) {
      if (a.required) return { error: `${a.key} is required` };
      continue;
    }
    if (a.kind === "positional") flags.push(val);
    else if (a.flag) flags.push(a.flag, val);
  }
  return flags;
}

/** Run one forward-* python script with fixed args; resolve to a parsed-JSON ToolResult. */
function runScript(opts: ForwardToolsOptions, scriptRelPath: string, flags: string[]): Promise<ToolResult> {
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
        resolve({ ok: false, output: { error: "output exceeded cap; narrow the query (filters / --limit)", script: scriptRelPath } });
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

function buildTool(opts: ForwardToolsOptions, spec: ScriptToolSpec): ToolDefinition {
  const inputSchema: Record<string, string> = {};
  for (const a of spec.args) inputSchema[a.key] = a.desc;
  return {
    name: spec.name,
    description: spec.description,
    effect: spec.effect ?? "read",
    inputSchema,
    execute: (args) => {
      const flags = buildFlags(spec, args);
      if (!Array.isArray(flags)) return Promise.resolve({ ok: false, output: { error: flags.error } });
      return runScript(opts, spec.script, flags);
    },
  };
}

// --- Tool specs (the fan-out lives here as data) --------------------------------------------------
// Slice 1: vulnerability + inventory substrate. Batch 2: core read skills (nqe, path, config).
// Write-effect skills (changeset/device-tag/predict/snapshot-collection) and the remaining read
// skills are pending batches — see forward-pack memory.
const SPECS: readonly ScriptToolSpec[] = [
  // -- inventory (network/snapshot/device discovery) --
  {
    name: "forward_networks",
    script: "forward-inventory/scripts/list_networks.py",
    description:
      "List the Forward networks available to this org (id, name). Call FIRST to resolve a network " +
      "by name — never assume a network id. Returns JSON.",
    args: [{ key: "name", flag: "--name", kind: "string", desc: "optional name substring filter" }],
  },
  {
    name: "forward_snapshots",
    script: "forward-inventory/scripts/list_snapshots.py",
    description:
      "List snapshots for a network, or just the latest processed. Every query runs against one " +
      "snapshot; default is the latest processed.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "latest", flag: "--latest", kind: "bool", desc: "only the latest processed snapshot" },
    ],
  },
  {
    name: "forward_devices",
    script: "forward-inventory/scripts/list_devices.py",
    description: "List devices in a network snapshot (name, vendor, model, os). Optional vendor filter.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "vendor", flag: "--vendor", kind: "string", desc: "filter to a vendor (e.g. ARISTA, CISCO)" },
    ],
  },
  // -- vulnerability (Slice 1) --
  {
    name: "forward_cve_audit",
    script: "forward-vulnerability/scripts/cve_disposition.py",
    description:
      "CVE disposition audit: every CVE Forward evaluated, its disposition (IMPACTED / " +
      "POTENTIALLY_IMPACTED / NOT_IMPACTED / NOT_EVALUATED) and the REASON — including the filtered-" +
      "out (NOT_IMPACTED) CVEs and why. For 'show the CVEs we filtered out and why', coverage, and " +
      "audit artifacts. Returns a partition summary + per-CVE rows with per-OS evidence.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "disposition", flag: "--disposition", kind: "string", desc: "impacted|potentially-impacted|not-impacted|not-evaluated|all" },
      { key: "severity", flag: "--severity", kind: "list", desc: "CRITICAL/HIGH/MEDIUM/LOW (string or list)" },
      { key: "limit", flag: "--limit", kind: "int", desc: "cap rows returned" },
    ],
  },
  // -- NQE (catalog search + run) --
  {
    name: "nqe_search",
    script: "forward-nqe-query/scripts/smart_search_catalog.py",
    description:
      "Search the NQE query catalog (ranked, fuzzy, synonym-aware). Use to FIND a prebuilt query by " +
      "topic before running it. Returns ranked {queryId, path, category, score}. Pass terms as a list.",
    args: [
      { key: "terms", kind: "list", required: true, desc: "search terms (list, e.g. [\"bgp\",\"neighbor\"])" },
      { key: "category", flag: "--category", kind: "string", desc: "filter to a top-level category" },
      { key: "minMatches", flag: "--min-matches", kind: "int", desc: "min term matches to include" },
      { key: "limit", flag: "--limit", kind: "int", desc: "max results (default 20)" },
    ],
  },
  {
    name: "nqe_get_source",
    script: "forward-nqe-query/scripts/get_query_source.py",
    description:
      "Fetch the NQE source for a catalog query by path — READ the source to confirm what columns it " +
      "returns before running it. Returns {intent, sourceCode, ...}.",
    args: [
      { key: "path", flag: "--path", kind: "string", required: true, desc: "full query path, e.g. /L3/Routes/BGP peers" },
      { key: "head", flag: "--head", kind: "bool", desc: "use HEAD commit" },
      { key: "repo", flag: "--repo", kind: "string", desc: "fwd or org (default: try both)" },
    ],
  },
  {
    name: "nqe_run",
    script: "forward-nqe-query/scripts/run_query.py",
    description:
      "Run an NQE query against a snapshot — by catalog queryId (FQ_...) OR a raw NQE string. SQL over " +
      "the parsed network model. Returns rows. Prefer a catalog query (nqe_search → nqe_get_source → " +
      "here). Always pass a limit unless the user wants everything.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "queryId", flag: "--query-id", kind: "string", desc: "catalog query id (FQ_...)" },
      { key: "query", flag: "--query", kind: "string", desc: "raw NQE query string" },
      { key: "param", flag: "--param", kind: "list", desc: "key=value query params (list)" },
      { key: "limit", flag: "--limit", kind: "int", desc: "max rows (default 1000)" },
    ],
  },
  // -- path analysis --
  {
    name: "path_search",
    script: "forward-path-analysis/scripts/search_path.py",
    description:
      "Trace whether/how traffic can flow A→B across the modeled network (forwarding behavior, drops, " +
      "and why). For 'can A reach B', 'why is traffic to X dropping', 'what path does this take'. " +
      "Returns path candidates with hop-by-hop forwarding and drop reasons.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "dstIp", flag: "--dst-ip", kind: "string", required: true, desc: "destination IP (required)" },
      { key: "srcIp", flag: "--src-ip", kind: "string", desc: "source IP" },
      { key: "from", flag: "--from", kind: "string", desc: "source device/location to start from" },
      { key: "ipProto", flag: "--ip-proto", kind: "string", desc: "IP protocol (e.g. 6=TCP, 17=UDP)" },
      { key: "dstPort", flag: "--dst-port", kind: "string", desc: "destination port" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
    ],
  },
  // -- device config --
  {
    name: "config_get",
    script: "forward-device-config/scripts/get_config.py",
    description:
      "Get a device's running config (or a category/stanza of it) from a snapshot. For 'show me the " +
      "config for device X', 'what's the BGP config on Y'. Returns the config text/structure.",
    args: [
      { key: "device", flag: "--device", kind: "string", required: true, desc: "device name (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "category", flag: "--category", kind: "string", desc: "config category/section" },
      { key: "stanza", flag: "--stanza", kind: "string", desc: "a specific config stanza" },
      { key: "maxLines", flag: "--max-lines", kind: "int", desc: "cap output lines" },
    ],
  },
  {
    name: "config_grep",
    script: "forward-device-config/scripts/grep_configs.py",
    description:
      "Search device configs network-wide for a pattern (which devices have telnet, a given ACL line, " +
      "etc.). For 'which devices have X configured'. Returns per-device matches.",
    args: [
      { key: "pattern", flag: "--pattern", kind: "string", required: true, desc: "regex/substring to search for (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "device", flag: "--device", kind: "string", desc: "limit to a device" },
      { key: "category", flag: "--category", kind: "string", desc: "limit to a config category" },
      { key: "ignoreCase", flag: "--ignore-case", kind: "bool", desc: "case-insensitive match" },
    ],
  },
];

/** Build the Forward NetOps tools. Registered only when the netops pack is active (cli.ts). */
export function forwardTools(opts: ForwardToolsOptions): ToolDefinition[] {
  return SPECS.map((s) => buildTool(opts, s));
}
