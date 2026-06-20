import type { Channel, Notification } from "../../ports/channel.js";

/** Injectable HTTP sender so channel request-shaping is testable without network (ADR-0014). */
export type HttpSend = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

export const realSend: HttpSend = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status };
};

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function slackChannel(cfg: { webhookUrl: string }, send: HttpSend = realSend): Channel {
  return {
    name: "slack",
    async send(n) {
      const text = n.title ? `*${n.title}*\n${n.text}` : n.text;
      const r = await send(cfg.webhookUrl, json({ text }));
      if (!r.ok) throw new Error(`slack send failed (${r.status})`);
    },
  };
}

export function telegramChannel(cfg: { token: string; chatId: string }, send: HttpSend = realSend): Channel {
  return {
    name: "telegram",
    async send(n) {
      const text = n.title ? `${n.title}\n${n.text}` : n.text;
      const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
      const r = await send(url, json({ chat_id: cfg.chatId, text }));
      if (!r.ok) throw new Error(`telegram send failed (${r.status})`);
    },
  };
}

/** Email via an HTTP email API (Resend/SendGrid-shape). HTTP, not raw SMTP (ADR-0014 §2). */
export function emailChannel(
  cfg: { apiUrl: string; apiKey: string; from: string; to: string },
  send: HttpSend = realSend,
): Channel {
  return {
    name: "email",
    async send(n) {
      const r = await send(cfg.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject: n.title ?? "weave notification", text: n.text }),
      });
      if (!r.ok) throw new Error(`email send failed (${r.status})`);
    },
  };
}

export interface ChannelConfig {
  slackWebhook?: string;
  telegramToken?: string;
  telegramChat?: string;
  emailApiUrl?: string;
  emailApiKey?: string;
  emailFrom?: string;
  emailTo?: string;
}

/** Build the channels whose config is present (ADR-0014 §2). */
export function channelsFrom(cfg: ChannelConfig, send: HttpSend = realSend): Channel[] {
  const out: Channel[] = [];
  if (cfg.slackWebhook) out.push(slackChannel({ webhookUrl: cfg.slackWebhook }, send));
  if (cfg.telegramToken && cfg.telegramChat) {
    out.push(telegramChannel({ token: cfg.telegramToken, chatId: cfg.telegramChat }, send));
  }
  if (cfg.emailApiUrl && cfg.emailApiKey && cfg.emailFrom && cfg.emailTo) {
    out.push(
      emailChannel(
        { apiUrl: cfg.emailApiUrl, apiKey: cfg.emailApiKey, from: cfg.emailFrom, to: cfg.emailTo },
        send,
      ),
    );
  }
  return out;
}

/** Fan a notification to all channels, best-effort. Returns how many succeeded. */
export async function notifyAll(channels: readonly Channel[], n: Notification): Promise<number> {
  const results = await Promise.allSettled(channels.map((c) => c.send(n)));
  return results.filter((r) => r.status === "fulfilled").length;
}
