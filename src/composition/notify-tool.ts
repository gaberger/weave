import type { ToolDefinition } from "../ports/tool-host.js";
import type { Channel, Notification } from "../ports/channel.js";
import { notifyAll } from "../adapters/secondary/channels.js";

/** `notify` tool (ADR-0014 §3): send to all configured channels. Effect is IRREVERSIBLE —
 *  an external message can't be unsent — so it's lease-gated (no duplicate alerts after a
 *  worker loses its lease). Best-effort fan-out; reports how many channels accepted it. */
export function notifyTool(channels: readonly Channel[]): ToolDefinition {
  return {
    name: "notify",
    description: "Send a notification to configured channels (email/slack/telegram).",
    effect: "irreversible",
    inputSchema: { text: "string", title: "string?" },
    execute: async (args) => {
      const n: Notification = {
        text: String(args["text"] ?? ""),
        ...(typeof args["title"] === "string" ? { title: args["title"] } : {}),
      };
      const sent = await notifyAll(channels, n);
      return { ok: sent > 0 || channels.length === 0, output: { sent, channels: channels.map((c) => c.name) } };
    },
  };
}
