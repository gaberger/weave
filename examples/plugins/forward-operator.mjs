// Example CODE skill (deterministic, keyless) — a network operator that drives Forward
// Networks Enterprise to INSPECT, OBSERVE, and MANAGE a network. The counterpart to the
// declarative net-monitor.md, but it needs no LLM and no ANTHROPIC_API_KEY: `run` parses a
// `forward <verb> …` goal and calls Forward's REST API directly.
//
// Why this is a CODE skill and not a .md prompt: the harness's built-in `http_fetch` is
// GET-only with no auth headers, but Forward's API needs HTTP Basic auth and a POST to run
// NQE (ADR for the API: `POST /api/nqe?networkId=…`, `Authorization: Basic base64(user:token)`).
// A Skill may contribute its OWN tools (ADR-0012 §1), so this file ships the Forward client it
// needs as two effect-gated ToolDefinitions:
//
//   • forward_query  (effect: "read")          — GET + NQE POST. The inspect/observe lane.
//   • forward_act    (effect: "irreversible")  — POST/PUT/PATCH/DELETE. The manage lane.
//
// The split IS the safety model (ADR-0004): a read-only monitoring peer is granted only
// forward_query, so it physically cannot mutate the network — the grant ceiling enforces it,
// not a runtime check. An operator peer additionally grants forward_act to manage.
//
// Config (env, read by the tools at execute time):
//   FORWARD_BASE_URL    Forward base, e.g. https://fwd.app (default) or https://<on-prem-host>
//   FORWARD_USERNAME    Basic-auth user  (an API key id works here)
//   FORWARD_PASSWORD    Basic-auth token (the API key secret)
//   FORWARD_NETWORK_ID  default networkId when the goal/inputs omit one
//
// Goal grammar (task.spec.goal):
//   forward networks                     list networks                         (observe)
//   forward snapshots [networkId]        list snapshots, flag the latest       (observe)
//   forward devices  [networkId]         device inventory via NQE              (inspect)
//   forward nqe <queryId> [networkId]    run a saved NQE query (or inputs.nqeCode inline)
//   forward manage <METHOD> <path>       a mutating call via forward_act       (manage, gated)
//
// inputs (task.spec.inputs, all optional):
//   networkId   override the default network
//   nqeCode     inline NQE source for `forward nqe` (instead of a saved queryId)
//   limit       NQE page size (default 1000, the API default)
//   body        JSON body for `forward manage`
//   confirm     boolean — see manageGuard(): management writes are dry-run unless confirmed

// ── Forward client tools (contributed to the shared ToolHost) ─────────────────────────────

const MAX_BYTES = 512 * 1024; // cap response bodies so findings/context stay bounded

function forwardConfig() {
  const baseUrl = (process.env.FORWARD_BASE_URL || "https://fwd.app").replace(/\/+$/, "");
  const user = process.env.FORWARD_USERNAME || "";
  const pass = process.env.FORWARD_PASSWORD || "";
  if (!user || !pass) {
    return { error: "missing FORWARD_USERNAME / FORWARD_PASSWORD" };
  }
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return { baseUrl, auth, defaultNetworkId: process.env.FORWARD_NETWORK_ID || "" };
}

/** Build one effect-gated Forward HTTP tool. `allowed` caps which verbs the tool will send,
 *  so forward_query (read) cannot be coerced into a DELETE even if a caller asks for one. */
function makeForwardTool(name, effect, allowed) {
  return {
    name,
    description:
      effect === "read"
        ? "Read-only Forward Enterprise API call (GET, or POST to run NQE). Returns parsed JSON + status."
        : "Mutating Forward Enterprise API call (POST/PUT/PATCH/DELETE) — manages network state.",
    effect,
    inputSchema: { method: "string", path: "string (e.g. /api/networks)", query: "object?", body: "object?" },
    execute: async (args) => {
      const cfg = forwardConfig();
      if (cfg.error) return { ok: false, output: { status: 0, error: cfg.error } };

      const method = String(args.method || (effect === "read" ? "GET" : "POST")).toUpperCase();
      if (!allowed.includes(method)) {
        return { ok: false, output: { status: 0, error: `method ${method} not allowed for ${name}` } };
      }
      const path = String(args.path || "");
      if (!path.startsWith("/")) return { ok: false, output: { status: 0, error: "path must start with /" } };

      const qs = args.query ? "?" + new URLSearchParams(args.query).toString() : "";
      const url = cfg.baseUrl + path + qs;
      const init = { method, headers: { Authorization: cfg.auth, Accept: "application/json" } };
      if (args.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
      }

      try {
        const res = await fetch(url, init);
        const text = await res.text();
        const capped = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
        let json;
        try {
          json = JSON.parse(capped);
        } catch {
          json = undefined;
        }
        return {
          ok: res.ok,
          output: { status: res.status, url, json, body: json === undefined ? capped : undefined },
        };
      } catch (e) {
        return { ok: false, output: { status: 0, url, error: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

const forwardQueryTool = makeForwardTool("forward_query", "read", ["GET", "POST"]);
const forwardActTool = makeForwardTool("forward_act", "irreversible", ["POST", "PUT", "PATCH", "DELETE"]);

// ── helpers ───────────────────────────────────────────────────────────────────────────────

/** Invoke forward_query and return parsed rows/JSON, or throw a tidy operator error. */
async function query(ctx, { method = "GET", path, query, body }) {
  const res = await ctx.tools.invoke({ name: "forward_query", args: { method, path, query, body } });
  const out = res.output || {};
  if (!res.ok) throw new Error(out.error || `HTTP ${out.status} ${path}`);
  return out.json ?? out.body;
}

function resolveNetwork(inputs, args, cfg) {
  return inputs.networkId || args[0] || cfg.defaultNetworkId || "";
}

// NQE device inventory — uses the data model in nqe/nqe-reference.md (device.platform.*).
const DEVICE_INVENTORY_NQE = `
foreach device in network.devices
select {
  name: device.name,
  vendor: device.platform.vendor,
  model: device.platform.model,
  os: device.platform.osVersion
}`;

/**
 * manageGuard — the safety policy gating every MANAGE (forward_act) write.
 *
 * THIS IS THE INTENTIONAL DECISION POINT. Managing a production network is a security-vs-
 * autonomy trade-off and the policy should be yours, not a default I picked. The conservative
 * default below DRY-RUNS every write (returns the planned request without sending it) unless
 * the task explicitly sets inputs.confirm === true. Replace the body to encode your real policy,
 * e.g.:
 *   • allowlist safe paths (device tags, change-sets) but always dry-run snapshot/commit writes;
 *   • require a notify-then-approve handshake before any DELETE;
 *   • permit writes only against a change-set sandbox, never the live snapshot.
 *
 * @param plan    { method, path, body } — the mutating request about to be sent
 * @param inputs  task.spec.inputs (carries `confirm`, and whatever you key your policy on)
 * @returns { allow: boolean, reason: string }  allow=false ⇒ run() reports a dry-run, sends nothing
 */
function manageGuard(plan, inputs) {
  // TODO(operator): replace this with your management policy. Conservative default:
  if (inputs.confirm === true) return { allow: true, reason: "confirmed by inputs.confirm" };
  return { allow: false, reason: "dry-run (set inputs.confirm=true to execute)" };
}

// ── the skill ───────────────────────────────────────────────────────────────────────────────

export default {
  name: "forward-operator",
  description:
    "Network operator: inspect, observe, and manage a network via Forward Enterprise (networks, snapshots, device inventory, NQE, gated writes). Keyless/deterministic.",
  tools: [forwardQueryTool, forwardActTool],
  match: (task) => /^forward\b/i.test(task.spec.goal.trim()),

  async run(task, ctx) {
    const cfg = forwardConfig();
    if (cfg.error) return { status: "failed", summary: cfg.error, error: "no_credentials" };

    const inputs = task.spec.inputs ?? {};
    const parts = task.spec.goal.trim().split(/\s+/).slice(1); // drop the leading "forward"
    const verb = (parts[0] || "").toLowerCase();
    const rest = parts.slice(1);
    const limit = Number(inputs.limit ?? 1000);

    try {
      switch (verb) {
        case "networks": {
          ctx.onProgress("listing networks");
          const data = await query(ctx, { path: "/api/networks" });
          const nets = Array.isArray(data) ? data : data?.networks ?? [];
          const summary = `${nets.length} network(s): ${nets.map((n) => `${n.name ?? n.id}(${n.id})`).join(", ") || "none"}`;
          return { status: "completed", summary, artifacts: [{ kind: "forward-networks", ref: JSON.stringify(nets) }] };
        }

        case "snapshots": {
          const networkId = resolveNetwork(inputs, rest, cfg);
          if (!networkId) return { status: "failed", summary: "no networkId (set FORWARD_NETWORK_ID, inputs.networkId, or pass it)", error: "no_network" };
          ctx.onProgress(`listing snapshots for network ${networkId}`);
          const data = await query(ctx, { path: `/api/networks/${networkId}/snapshots` });
          const snaps = Array.isArray(data) ? data : data?.snapshots ?? [];
          const latest = snaps[0];
          const summary = `${snaps.length} snapshot(s) for ${networkId}; latest=${latest ? latest.id : "none"}`;
          return { status: "completed", summary, artifacts: [{ kind: "forward-snapshots", ref: JSON.stringify(snaps) }] };
        }

        case "devices": {
          const networkId = resolveNetwork(inputs, rest, cfg);
          if (!networkId) return { status: "failed", summary: "no networkId for device inventory", error: "no_network" };
          ctx.onProgress(`device inventory via NQE on network ${networkId}`);
          const data = await query(ctx, {
            method: "POST",
            path: "/api/nqe",
            query: { networkId },
            body: { nqeCode: DEVICE_INVENTORY_NQE, queryOptions: { offset: 0, limit } },
          });
          const rows = data?.items ?? (Array.isArray(data) ? data : []);
          const summary = `${rows.length} device(s) on ${networkId}: ${rows.slice(0, 8).map((r) => r.name).join(", ")}${rows.length > 8 ? "…" : ""}`;
          return { status: "completed", summary, artifacts: [{ kind: "forward-devices", ref: JSON.stringify(rows) }] };
        }

        case "nqe": {
          const queryId = rest[0];
          const networkId = resolveNetwork(inputs, rest.slice(1), cfg);
          if (!networkId) return { status: "failed", summary: "no networkId for NQE run", error: "no_network" };
          if (!queryId && !inputs.nqeCode) return { status: "failed", summary: "give a queryId (forward nqe FQ_… ) or inputs.nqeCode", error: "no_query" };
          ctx.onProgress(`running NQE ${queryId ?? "(inline)"} on ${networkId}`);
          const body = queryId
            ? { queryId, queryOptions: { offset: 0, limit } }
            : { nqeCode: String(inputs.nqeCode), queryOptions: { offset: 0, limit } };
          const data = await query(ctx, { method: "POST", path: "/api/nqe", query: { networkId }, body });
          const rows = data?.items ?? (Array.isArray(data) ? data : []);
          return {
            status: "completed",
            summary: `NQE returned ${rows.length} row(s)`,
            artifacts: [{ kind: "forward-nqe", ref: JSON.stringify(rows) }],
          };
        }

        case "manage": {
          const method = (rest[0] || "").toUpperCase();
          const path = rest[1];
          if (!method || !path) return { status: "failed", summary: "usage: forward manage <METHOD> <path>", error: "bad_usage" };
          const plan = { method, path, body: inputs.body };

          const verdict = manageGuard(plan, inputs);
          if (!verdict.allow) {
            return {
              status: "completed",
              summary: `dry-run ${method} ${path} — ${verdict.reason}; nothing sent`,
              artifacts: [{ kind: "forward-manage-dryrun", ref: JSON.stringify(plan) }],
            };
          }

          ctx.onProgress(`MANAGE ${method} ${path} (${verdict.reason})`);
          // Goes through forward_act → effect "irreversible" → blocked unless the peer's grant
          // permits it (NotPermittedError surfaces below as a clean failure).
          const res = await ctx.tools.invoke({ name: "forward_act", args: { method, path, body: inputs.body } });
          const out = res.output || {};
          if (!res.ok) return { status: "failed", summary: `${method} ${path} → HTTP ${out.status}`, error: out.error || `http_${out.status}` };
          return {
            status: "completed",
            summary: `${method} ${path} → ${out.status}`,
            artifacts: [{ kind: "forward-manage", ref: JSON.stringify(out.json ?? out.body ?? {}) }],
          };
        }

        default:
          return {
            status: "failed",
            summary: `unknown verb "${verb}". try: networks | snapshots | devices | nqe | manage`,
            error: "unknown_verb",
          };
      }
    } catch (e) {
      // NotPermittedError (grant withheld forward_act) lands here too — an honest failure.
      return { status: "failed", summary: e instanceof Error ? e.message : String(e), error: "forward_error" };
    }
  },
};
