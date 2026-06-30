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
  // --- write semantics (ADR-0004). A `write` tool MUTATES the live Forward network. It is gated two
  //     ways: (1) effect "irreversible" → the worker's canUseTool blocks it unless the lease is held;
  //     (2) the UNIFORM tool gate below — it NEVER mutates unless the caller passes `execute: true`.
  //     Without execute it returns a non-mutating preview: spawn the script with `dryRunFlag` if it has
  //     one (a real "what would happen"), else a synthetic plan with NO spawn (fail-safe for scripts
  //     that mutate immediately with no guard). With execute it adds `confirmFlag` (--yes / --execute)
  //     where the script requires one. ---
  readonly write?: boolean;
  readonly dryRunFlag?: string; // flag that forces a SAFE preview when not executing (e.g. "--dry-run")
  readonly confirmFlag?: string; // flag the script needs to actually mutate (e.g. "--yes" / "--execute")
  // --- renderer semantics (report-doc/graph/table). These read JSON on STDIN and emit a formatted
  //     artifact (markdown/HTML/CSV/Mermaid), NOT JSON. `stdinArg` names the input key piped to stdin
  //     (JSON-stringified if an object); `rawOutput` returns stdout as text instead of JSON-parsing. ---
  readonly stdinArg?: string;
  readonly rawOutput?: boolean;
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

interface RunOpts {
  /** Piped to the child's stdin (for renderers that read JSON on stdin). */
  readonly stdin?: string;
  /** Return stdout as raw text (renderers emit markdown/HTML/CSV/Mermaid, not JSON). */
  readonly rawOutput?: boolean;
}

/** Run one forward-* python script with fixed args; resolve to a parsed-JSON ToolResult (or raw
 *  text for renderers). stdin is ALWAYS ended — a script that reads stdin gets the data or a clean
 *  EOF, never a hang. */
function runScript(opts: ForwardToolsOptions, scriptRelPath: string, flags: string[], run: RunOpts = {}): Promise<ToolResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const script = join(opts.packageRoot, "skills", scriptRelPath);
  return new Promise<ToolResult>((resolve) => {
    const child = spawn("python3", [script, ...flags], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: process.env,
    });
    // Always feed+close stdin so a stdin-reading script never blocks (renderers read JSON here).
    if (run.stdin) child.stdin.write(run.stdin);
    child.stdin.end();
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
      if (run.rawOutput) {
        // Renderer: stdout is the formatted artifact (markdown/HTML/CSV/Mermaid), not JSON.
        resolve({ ok: true, output: { content: stdout } });
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
  if (spec.write) inputSchema["execute"] = "boolean — MUST be true to actually apply this change; omit/false = a non-mutating dry-run preview";
  if (spec.stdinArg) inputSchema[spec.stdinArg] = "the data to render — a JSON object/array (or JSON string) piped to the renderer";
  return {
    name: spec.name,
    description: spec.description,
    // A write tool defaults to irreversible (lease-gated) unless it explicitly down-classes.
    effect: spec.effect ?? (spec.write ? "irreversible" : "read"),
    inputSchema,
    execute: (args) => {
      const flags = buildFlags(spec, args);
      if (!Array.isArray(flags)) return Promise.resolve({ ok: false, output: { error: flags.error } });
      // Renderer: pipe the data arg to stdin (JSON-stringify objects), return raw formatted text.
      if (spec.stdinArg || spec.rawOutput) {
        const v = args[spec.stdinArg ?? ""];
        const stdin = v === undefined || v === null || v === "" ? undefined : typeof v === "string" ? v : JSON.stringify(v);
        return runScript(opts, spec.script, flags, { ...(stdin ? { stdin } : {}), rawOutput: true });
      }
      if (spec.write && !isTruthy(args["execute"])) {
        // NON-MUTATING preview. Prefer the script's own dry-run (real "what would happen"); else, for a
        // script that mutates immediately with no guard, do NOT spawn at all — synthesize the plan.
        if (spec.dryRunFlag) return runScript(opts, spec.script, [...flags, spec.dryRunFlag]);
        return Promise.resolve({
          ok: true,
          output: {
            dryRun: true,
            wouldRun: `${spec.script} ${flags.join(" ")}`.trim(),
            note: "This is a WRITE that would change the live network and was NOT applied. Confirm with the user, then re-run with execute:true to apply.",
          },
        });
      }
      if (spec.write && spec.confirmFlag) flags.push(spec.confirmFlag);
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
  // -- device intel (parsed live state: arp / bgp peers / interfaces / device info) --
  // All four share _entity.add_common_args: --network-id (req), --snapshot-id, --device-name, --limit.
  ...(["arp", "bgp_peers", "device_info", "interfaces"] as const).map((kind) => {
    const meta: Record<string, { tool: string; what: string }> = {
      arp: { tool: "device_arp", what: "ARP table entries (IP↔MAC↔interface)" },
      bgp_peers: { tool: "device_bgp_peers", what: "BGP neighbor sessions and their state" },
      device_info: { tool: "device_info", what: "device platform / OS version / model" },
      interfaces: { tool: "device_interfaces", what: "interface inventory and status (up/down, speed, IP)" },
    };
    const m = meta[kind]!;
    return {
      name: m.tool,
      script: `forward-device-intel/scripts/get_${kind}.py`,
      description: `Parsed ${m.what} from a snapshot. Optionally filter to one device. Returns rows.`,
      args: [
        { key: "networkId", flag: "--network-id", kind: "string" as const, required: true, desc: "network id (required)" },
        { key: "snapshotId", flag: "--snapshot-id", kind: "string" as const, desc: "snapshot id (default latest processed)" },
        { key: "deviceName", flag: "--device-name", kind: "string" as const, desc: "filter to one device name" },
        { key: "limit", flag: "--limit", kind: "int" as const, desc: "max rows (default 1000)" },
      ],
    };
  }),
  // -- compliance (STIG sweep) --
  {
    name: "stig_sweep",
    script: "forward-compliance-check/scripts/stig_sweep.py",
    description:
      "Run STIG / hardening compliance checks across the network and summarize pass/fail. For 'STIG " +
      "compliance', 'hardening posture', 'are we compliant'. Narrow with vendor/platform; bound with " +
      "limitQueries/rowLimit (the full catalog sweep is slow). Returns per-check results.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "vendor", flag: "--vendor", kind: "string", desc: "filter to a vendor (e.g. Cisco)" },
      { key: "platform", flag: "--platform", kind: "string", desc: "filter to a platform/OS" },
      { key: "pathContains", flag: "--path-contains", kind: "string", desc: "only checks whose catalog path contains this" },
      { key: "limitQueries", flag: "--limit-queries", kind: "int", desc: "cap how many STIG checks run (bound runtime)" },
      { key: "rowLimit", flag: "--row-limit", kind: "int", desc: "cap rows per check" },
    ],
  },
  // -- BGP prefix (where a prefix lives / is originated / how it's reached) --
  {
    name: "bgp_prefix_search",
    script: "forward-bgp-prefix/scripts/search_prefix.py",
    description: "Find where a BGP prefix lives across the network (which devices carry it). For 'where is prefix X'.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "prefix", flag: "--prefix", kind: "string", required: true, desc: "CIDR, e.g. 10.24.0.0/24 (required)" },
    ],
  },
  {
    name: "bgp_prefix_details",
    script: "forward-bgp-prefix/scripts/prefix_details.py",
    description: "BGP attributes/details for a prefix (optionally on a specific device). For 'show me the BGP details for X'.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "prefix", flag: "--prefix", kind: "string", required: true, desc: "CIDR (required)" },
      { key: "device", flag: "--device", kind: "string", desc: "limit to a device" },
    ],
  },
  {
    name: "bgp_prefix_trace",
    script: "forward-bgp-prefix/scripts/trace_prefix.py",
    description: "Trace a prefix's origin and propagation (who originates it, how it spreads). For 'who originates X', 'trace prefix X'.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "prefix", flag: "--prefix", kind: "string", required: true, desc: "CIDR (required)" },
      { key: "device", flag: "--device", kind: "string", desc: "start device" },
      { key: "vrf", flag: "--vrf", kind: "string", desc: "VRF" },
      { key: "originVrf", flag: "--origin-vrf", kind: "string", desc: "origin VRF" },
    ],
  },
  {
    name: "bgp_prefix_on_device",
    script: "forward-bgp-prefix/scripts/device_prefix_info.py",
    description: "What a specific device knows about a prefix (its RIB/attributes for it). For 'what does device X know about prefix Y'.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "device", flag: "--device", kind: "string", required: true, desc: "device name (required)" },
      { key: "prefix", flag: "--prefix", kind: "string", required: true, desc: "CIDR (required)" },
    ],
  },
  // -- security posture (zone-to-zone reachability matrix; read) --
  {
    name: "security_matrix",
    script: "forward-security-posture/scripts/get_matrix.py",
    description:
      "Zone-to-zone security posture matrix: what traffic is allowed between zones/regions. For 'security " +
      "posture', 'what can reach the DMZ', 'segmentation matrix'. Returns the allowed/blocked matrix.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "filterId", flag: "--filter-id", kind: "string", desc: "a saved matrix filter id" },
      { key: "src", flag: "--src", kind: "string", desc: "source zone/region" },
      { key: "dst", flag: "--dst", kind: "string", desc: "destination zone/region" },
    ],
  },
  {
    name: "security_matrix_filters",
    script: "forward-security-posture/scripts/list_matrix_filters.py",
    description: "List saved security-matrix filters (named zone definitions) for a network.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "name", flag: "--name", kind: "string", desc: "filter by name substring" },
    ],
  },
  // ============ WRITE tools (batch 4) — MUTATE the live network; irreversible + execute-gated ============
  // -- changeset (config change-management lifecycle: create → edit → commit; delete). All have a real
  //    --dry-run, so the preview spawns the script safely. commit/edit default-execute without --dry-run. --
  {
    name: "changeset_list",
    script: "forward-changeset/scripts/list_changesets.py",
    description: "List config change-sets (drafts) for a network. Read-only — call this before editing/committing.",
    args: [{ key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" }],
  },
  {
    name: "changeset_create",
    script: "forward-changeset/scripts/create_changeset.py",
    description: "Create a new config change-set (draft) on a network. WRITE: dry-run unless execute:true.",
    write: true, dryRunFlag: "--dry-run",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "name", flag: "--name", kind: "string", required: true, desc: "change-set name (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "base snapshot (default latest processed)" },
      { key: "dirPath", flag: "--dir-path", kind: "string", desc: "directory path for the change-set" },
    ],
  },
  {
    name: "changeset_edit",
    script: "forward-changeset/scripts/edit_commands.py",
    description: "Stage device config commands into a change-set. WRITE: dry-run unless execute:true.",
    write: true, dryRunFlag: "--dry-run",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "device", flag: "--device", kind: "string", required: true, desc: "target device name (required)" },
      { key: "commands", flag: "--commands", kind: "string", desc: "config commands (inline)" },
      { key: "commandsFile", flag: "--commands-file", kind: "string", desc: "path to a file of commands" },
    ],
  },
  {
    name: "changeset_commit",
    script: "forward-changeset/scripts/commit_changeset.py",
    description: "COMMIT a change-set (applies staged config to the modeled network). WRITE: dry-run unless execute:true.",
    write: true, dryRunFlag: "--dry-run",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "note", flag: "--note", kind: "string", desc: "commit note" },
    ],
  },
  {
    name: "changeset_delete",
    script: "forward-changeset/scripts/delete_changeset.py",
    description: "DELETE a change-set (destructive). WRITE: dry-run unless execute:true (adds the script's --yes).",
    write: true, dryRunFlag: "--dry-run", confirmFlag: "--yes",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
    ],
  },
  // -- device tags. These scripts have NO guard flag (they mutate immediately), so when execute is not
  //    set the tool returns a SYNTHETIC plan and does NOT spawn — the fail-safe path. --
  {
    name: "tag_list",
    script: "forward-device-tag/scripts/list_tags.py",
    description: "List device tags for a network. Read-only.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "withDevices", flag: "--with-devices", kind: "bool", desc: "include each tag's device membership" },
    ],
  },
  {
    name: "tag_create",
    script: "forward-device-tag/scripts/create_tag.py",
    description: "Create a device tag. WRITE (no dry-run in the script): only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "tagName", flag: "--tag-name", kind: "string", required: true, desc: "tag name (required)" },
      { key: "color", flag: "--color", kind: "string", desc: "tag color" },
    ],
  },
  {
    name: "tag_delete",
    script: "forward-device-tag/scripts/delete_tag.py",
    description: "Delete a device tag (destructive). WRITE: only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "tagName", flag: "--tag-name", kind: "string", required: true, desc: "tag name (required)" },
    ],
  },
  {
    name: "tag_devices",
    script: "forward-device-tag/scripts/tag_devices.py",
    description: "Apply a tag to devices. WRITE: only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "tagName", flag: "--tag-name", kind: "string", required: true, desc: "tag name (required)" },
      { key: "devices", flag: "--devices", kind: "string", desc: "device names (comma-separated)" },
      { key: "devicesFile", flag: "--devices-file", kind: "string", desc: "path to a file of device names" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
    ],
  },
  {
    name: "untag_devices",
    script: "forward-device-tag/scripts/untag_devices.py",
    description: "Remove a tag from devices (or all). WRITE: only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "tagName", flag: "--tag-name", kind: "string", required: true, desc: "tag name (required)" },
      { key: "devices", flag: "--devices", kind: "string", desc: "device names (comma-separated)" },
      { key: "removeAll", flag: "--remove-all", kind: "bool", desc: "remove the tag from ALL devices" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
    ],
  },
  // -- predict: BGP advertisements injected into a change-set for what-if modeling. add/import have a
  //    real --dry-run; remove needs --yes. list is read. --
  {
    name: "predict_advert_list",
    script: "forward-predict/scripts/list_advertisements.py",
    description: "List the predicted BGP advertisements staged in a change-set. Read-only.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "device", flag: "--device", kind: "string", desc: "filter to a device" },
    ],
  },
  {
    name: "predict_advert_add",
    script: "forward-predict/scripts/add_advertisement.py",
    description: "Add a predicted BGP advertisement to a change-set (what-if). WRITE: dry-run unless execute:true.",
    write: true, dryRunFlag: "--dry-run",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "device", flag: "--device", kind: "string", required: true, desc: "advertising device (required)" },
      { key: "prefix", flag: "--prefix", kind: "string", required: true, desc: "CIDR to advertise (required)" },
      { key: "nextHop", flag: "--next-hop", kind: "string", desc: "next-hop IP" },
      { key: "externalPeer", flag: "--external-peer", kind: "string", desc: "external peer IP" },
      { key: "vrf", flag: "--vrf", kind: "string", desc: "VRF" },
      { key: "type", flag: "--type", kind: "string", desc: "EBGP or IBGP" },
      { key: "asPath", flag: "--as-path", kind: "string", desc: "AS path" },
      { key: "localPref", flag: "--local-pref", kind: "int", desc: "LOCAL_PREF" },
      { key: "med", flag: "--med", kind: "int", desc: "MED" },
    ],
  },
  {
    name: "predict_advert_remove",
    script: "forward-predict/scripts/remove_advertisement.py",
    description: "Remove a predicted advertisement from a change-set (destructive). WRITE: dry-run unless execute:true (adds --yes).",
    write: true, dryRunFlag: "--dry-run", confirmFlag: "--yes",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "device", flag: "--device", kind: "string", desc: "advertising device" },
      { key: "prefix", flag: "--prefix", kind: "string", desc: "CIDR" },
      { key: "nextHop", flag: "--next-hop", kind: "string", desc: "next-hop IP" },
      { key: "vrf", flag: "--vrf", kind: "string", desc: "VRF" },
      { key: "type", flag: "--type", kind: "string", desc: "EBGP or IBGP" },
    ],
  },
  {
    name: "predict_advert_import",
    script: "forward-predict/scripts/import_advertisements.py",
    description: "Bulk-import predicted advertisements from a file into a change-set. WRITE: dry-run unless execute:true.",
    write: true, dryRunFlag: "--dry-run",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "changesetId", flag: "--changeset-id", kind: "string", required: true, desc: "change-set id (required)" },
      { key: "inputFile", flag: "--input-file", kind: "string", required: true, desc: "path to the advertisements file (required)" },
    ],
  },
  // -- intent checks. create/delete have NO guard → synthetic preview; patch defaults to dry-run and
  //    needs --execute to apply. list/get are read. --
  {
    name: "intent_list",
    script: "forward-intent-check/scripts/list_checks.py",
    description: "List intent checks for a network (status, priority, type). Read-only.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "status", flag: "--status", kind: "string", desc: "filter by status (PASS/FAIL/…)" },
      { key: "priority", flag: "--priority", kind: "string", desc: "filter by priority" },
    ],
  },
  {
    name: "intent_get",
    script: "forward-intent-check/scripts/get_check.py",
    description: "Get one intent check's definition and result. Read-only.",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "checkId", flag: "--check-id", kind: "string", required: true, desc: "check id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
    ],
  },
  {
    name: "intent_predefined",
    script: "forward-intent-check/scripts/list_predefined.py",
    description: "List the predefined intent-check types available. Read-only.",
    args: [],
  },
  {
    name: "intent_create",
    script: "forward-intent-check/scripts/create_check.py",
    description: "Create an intent check (predefined type or an NQE query). WRITE (no script guard): only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "name", flag: "--name", kind: "string", desc: "check name" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "note", flag: "--note", kind: "string", desc: "description/note" },
      { key: "priority", flag: "--priority", kind: "string", desc: "priority" },
      { key: "predefinedType", flag: "--predefined-type", kind: "string", desc: "a predefined check type (see intent_predefined)" },
      { key: "queryId", flag: "--query-id", kind: "string", desc: "an NQE query id to bind (FQ_…)" },
      { key: "srcIp", flag: "--src-ip", kind: "string", desc: "source IP (for reachability checks)" },
      { key: "dstIp", flag: "--dst-ip", kind: "string", desc: "destination IP (for reachability checks)" },
      { key: "tags", flag: "--tags", kind: "string", desc: "tags (comma-separated)" },
    ],
  },
  {
    name: "intent_delete",
    script: "forward-intent-check/scripts/delete_check.py",
    description: "Delete an intent check (destructive, no script guard). WRITE: only applied when execute:true.",
    write: true,
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "checkId", flag: "--check-id", kind: "string", required: true, desc: "check id (required)" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
    ],
  },
  {
    name: "intent_patch",
    script: "forward-intent-check/scripts/patch_check.py",
    description: "Update intent check(s) — status, name, note, priority, tags. WRITE: dry-run unless execute:true (adds --execute).",
    write: true, confirmFlag: "--execute",
    args: [
      { key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" },
      { key: "checkId", flag: "--check-id", kind: "string", desc: "target check id (or use matchName/matchTag)" },
      { key: "matchName", flag: "--match-name", kind: "string", desc: "select checks by name" },
      { key: "matchTag", flag: "--match-tag", kind: "string", desc: "select checks by tag" },
      { key: "snapshotId", flag: "--snapshot-id", kind: "string", desc: "snapshot id (default latest processed)" },
      { key: "status", flag: "--status", kind: "string", desc: "new status" },
      { key: "setName", flag: "--set-name", kind: "string", desc: "rename" },
      { key: "setNote", flag: "--set-note", kind: "string", desc: "set note" },
      { key: "priority", flag: "--priority", kind: "string", desc: "set priority" },
      { key: "addTag", flag: "--add-tag", kind: "string", desc: "add a tag" },
      { key: "removeTag", flag: "--remove-tag", kind: "string", desc: "remove a tag" },
    ],
  },
  // -- snapshot collection. start/cancel have no guard → synthetic preview. status/schedules are read. --
  {
    name: "snapshot_schedules",
    script: "forward-snapshot-collection/scripts/list_schedules.py",
    description: "List snapshot-collection schedules for a network. Read-only.",
    args: [{ key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" }],
  },
  {
    name: "snapshot_status",
    script: "forward-snapshot-collection/scripts/get_collection_status.py",
    description: "Get the status of a snapshot-collection task. Read-only.",
    args: [{ key: "taskId", flag: "--task-id", kind: "string", required: true, desc: "collection task id (required)" }],
  },
  {
    name: "snapshot_collect",
    script: "forward-snapshot-collection/scripts/start_collection.py",
    description: "Start a new snapshot collection on a network. WRITE (no script guard): only applied when execute:true.",
    write: true,
    args: [{ key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" }],
  },
  {
    name: "snapshot_collect_cancel",
    script: "forward-snapshot-collection/scripts/cancel_collection.py",
    description: "Cancel the in-progress snapshot collection on a network. WRITE (no script guard): only applied when execute:true.",
    write: true,
    args: [{ key: "networkId", flag: "--network-id", kind: "string", required: true, desc: "network id (required)" }],
  },
  // ============ RENDER tools (report-doc/graph/table) — read JSON via `data`, emit a formatted ============
  // artifact (markdown/HTML/CSV/Mermaid) as text. Pure formatters, not API calls; data comes from a
  // prior query the agent ran. listTemplates lists the available templates (no data needed).
  {
    name: "report_doc",
    script: "forward-report-doc/scripts/render.py",
    description:
      "Render structured data as a NARRATIVE report (network review, incident report, change ticket, " +
      "compliance/drift writeup) in markdown or standalone HTML. Pass `data` as " +
      "{ title: string, sections: [{ title: string, body: string }] } — body is markdown (or a list of " +
      "typed blocks: {kind:'table'|'code'|'mermaid'|'callout', …}). `template` " +
      "(incident-report|change-ticket|compliance-audit|network-review|action-plan|drift-report|generic) " +
      "ORDERS the sections by their title. For \"write this up as a report\", \"give me an HTML report\". " +
      "Set listTemplates:true to see each template's section list.",
    stdinArg: "data", rawOutput: true,
    args: [
      { key: "format", flag: "--format", kind: "string", desc: "markdown (default) | html | json" },
      { key: "template", flag: "--template", kind: "string", desc: "template name (see listTemplates)" },
      { key: "title", flag: "--title", kind: "string", desc: "report title" },
      { key: "scaffold", flag: "--scaffold", kind: "bool", desc: "emit placeholder sections from the template" },
      { key: "listTemplates", flag: "--list-templates", kind: "bool", desc: "list available templates (no data needed)" },
    ],
  },
  {
    name: "report_graph",
    script: "forward-report-graph/scripts/render.py",
    description:
      "Render data as a DIAGRAM — Mermaid (default; pastes into GitHub/Notion), Graphviz DOT, or " +
      "standalone interactive HTML. Pass `data` as { nodes: [{ id, label? }], edges: [{ from, to, label? }] }. " +
      "For \"draw the path\", \"show the topology\", \"graph the BGP peerings\", \"give me a Mermaid diagram\". " +
      "listTemplates lists templates.",
    stdinArg: "data", rawOutput: true,
    args: [
      { key: "format", flag: "--format", kind: "string", desc: "mermaid (default) | dot | html | json" },
      { key: "template", flag: "--template", kind: "string", desc: "template name (path-trace, topology, bgp-mesh, config-diff)" },
      { key: "direction", flag: "--direction", kind: "string", desc: "graph direction (e.g. LR, TB)" },
      { key: "labelEdges", flag: "--label-edges", kind: "bool", desc: "label edges" },
      { key: "listTemplates", flag: "--list-templates", kind: "bool", desc: "list available templates (no data needed)" },
    ],
  },
  {
    name: "report_table",
    script: "forward-report-table/scripts/render.py",
    description:
      "Render rows as a TABLE — ANSI terminal, GitHub-flavored Markdown, standalone HTML (sortable), or " +
      "CSV. Pass `data` as a JSON ARRAY of flat row objects (or { data: [...] }) — each object's keys become " +
      "columns. For \"show me a table of …\", \"format as a grid\", \"export to CSV\", \"a Markdown table I can " +
      "paste\". Narrow/order with columns; sort/group with sort/groupBy. listTemplates lists templates.",
    stdinArg: "data", rawOutput: true,
    args: [
      { key: "format", flag: "--format", kind: "string", desc: "ansi (default) | markdown | html | csv | json" },
      { key: "template", flag: "--template", kind: "string", desc: "template name (stig, device-list, security-matrix, diff)" },
      { key: "columns", flag: "--columns", kind: "string", desc: "comma-separated columns to include/order" },
      { key: "sort", flag: "--sort", kind: "string", desc: "column to sort by" },
      { key: "groupBy", flag: "--group-by", kind: "string", desc: "column to group by" },
      { key: "listTemplates", flag: "--list-templates", kind: "bool", desc: "list available templates (no data needed)" },
    ],
  },
];

/** Build the Forward NetOps tools. Registered only when the netops pack is active (cli.ts). */
export function forwardTools(opts: ForwardToolsOptions): ToolDefinition[] {
  return SPECS.map((s) => buildTool(opts, s));
}
