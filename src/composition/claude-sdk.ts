/**
 * Real Claude Agent SDK bindings — the ONLY module that imports `@anthropic-ai/claude-agent-sdk`.
 * Adapts the SDK to the seam in `claude-agent-sdk-worker.ts` so the worker and its tests stay
 * SDK-free. Requires the package installed and `ANTHROPIC_API_KEY` set at runtime.
 */
import { query as sdkQuery, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Worker } from "../ports/worker.js";
import type { ToolHost } from "../ports/tool-host.js";
import {
  ClaudeAgentSdkWorker,
  type ClaudeQuery,
  type ClaudeWorkerConfig,
  type SdkMessage,
  type ToolBridge,
} from "../adapters/secondary/claude-agent-sdk-worker.js";

type SdkQueryParams = Parameters<typeof sdkQuery>[0];

/** Adapt the SDK's `query` (which returns an async generator of SDK messages). */
export const realClaudeQuery: ClaudeQuery = ({ prompt, options }) =>
  sdkQuery({
    prompt,
    options: options as unknown as NonNullable<SdkQueryParams["options"]>,
  }) as unknown as AsyncIterable<SdkMessage>;

/**
 * Expose each ToolHost tool to the SDK as an in-process MCP tool whose handler routes
 * back through weave's ToolHost — so weave owns execution and the lease gate applies
 * (ADR-0003 §6). v1 uses a loose `args` schema; mapping each tool's JSON schema to a
 * precise zod shape is a follow-up.
 */
export const realToolBridge: ToolBridge = {
  build(host: ToolHost): Record<string, unknown> {
    const tools = host.available().map((d) =>
      tool(
        d.name,
        `${d.description}\n\nCall with an "args" object matching this JSON schema: ${JSON.stringify(d.inputSchema)}`,
        { args: z.unknown() },
        async (a: { args?: unknown }) => {
          try {
            const result = await host.invoke({
              name: d.name,
              args: (a.args ?? {}) as Record<string, unknown>,
            });
            return { content: [{ type: "text" as const, text: JSON.stringify(result.output ?? null) }] };
          } catch (err) {
            return {
              content: [
                { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
              ],
            };
          }
        },
      ),
    );

    const server = createSdkMcpServer({ name: "weave-tools", version: "0.0.0", tools });
    return { "weave-tools": { type: "sdk", name: "weave-tools", instance: server.instance } };
  },
};

/** Worker factory for `createPeer({ newWorker })` — real Claude over the real SDK. */
export function createClaudeWorkerFactory(cfg: ClaudeWorkerConfig = {}): () => Worker {
  return () => new ClaudeAgentSdkWorker({ query: realClaudeQuery, bridge: realToolBridge }, cfg);
}
