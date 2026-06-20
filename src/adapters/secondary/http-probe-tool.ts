import type { ToolDefinition } from "../../ports/tool-host.js";
import type { ToolRegistry } from "./in-memory-tool-host.js";
import type { ProbeResult } from "../../domain/interrogation.js";

/** The `http_probe` interrogation tool (ADR-0011 §1): a read-effect HTTP request returning
 *  status, latency, and reachability. Uses global `fetch`/`performance` (Node 18+ & Bun). */
export const httpProbeTool: ToolDefinition = {
  name: "http_probe",
  description: "HTTP-probe a target URL; returns status code, latency (ms), and reachability.",
  effect: "read",
  inputSchema: { target: "string (url)", method: "string (optional, default GET)" },
  execute: async (args) => {
    const target = String(args["target"] ?? "");
    const method = typeof args["method"] === "string" ? args["method"] : "GET";
    const t0 = performance.now();
    try {
      const res = await fetch(target, { method });
      const body = await res.text();
      const output: ProbeResult = {
        target,
        status: res.status,
        ms: Math.round(performance.now() - t0),
        healthy: res.ok,
        bytes: body.length,
      };
      return { ok: true, output };
    } catch (e) {
      const output: ProbeResult = {
        target,
        status: 0,
        ms: Math.round(performance.now() - t0),
        healthy: false,
        error: e instanceof Error ? e.message : String(e),
      };
      return { ok: false, output };
    }
  },
};

/** Convenience: register `http_probe` on a registry. */
export function registerHttpProbe(registry: ToolRegistry): ToolRegistry {
  return registry.register(httpProbeTool);
}
