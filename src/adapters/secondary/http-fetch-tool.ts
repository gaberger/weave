import type { ToolDefinition } from "../../ports/tool-host.js";

const MAX_BYTES = 512 * 1024; // cap response body to keep findings/context bounded

/** `http_fetch` (ADR-0008 §2): a read-effect tool returning the response BODY (size-capped)
 *  plus status — for reading feeds/pages, where `http_probe` only reports reachability. */
export const httpFetchTool: ToolDefinition = {
  name: "http_fetch",
  description: "HTTP GET a URL and return its body text (capped) and status code.",
  effect: "read",
  inputSchema: { target: "string (url)" },
  execute: async (args) => {
    const target = String(args["target"] ?? "");
    try {
      const res = await fetch(target, { method: "GET" });
      const full = await res.text();
      const body = full.length > MAX_BYTES ? full.slice(0, MAX_BYTES) : full;
      return {
        ok: res.ok,
        output: { target, status: res.status, bytes: full.length, truncated: full.length > MAX_BYTES, body },
      };
    } catch (e) {
      return {
        ok: false,
        output: { target, status: 0, bytes: 0, truncated: false, body: "", error: e instanceof Error ? e.message : String(e) },
      };
    }
  },
};
