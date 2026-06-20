import { test } from "node:test";
import assert from "node:assert/strict";

import { slackChannel, telegramChannel, emailChannel, channelsFrom, notifyAll, type HttpSend } from "./channels.js";
import { notifyTool } from "../../composition/notify-tool.js";

interface Captured {
  url: string;
  init: { method: string; headers?: Record<string, string>; body?: string };
}

const recorder = (): { send: HttpSend; calls: Captured[] } => {
  const calls: Captured[] = [];
  const send: HttpSend = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  return { send, calls };
};

test("slackChannel posts {text} to the webhook", async () => {
  const { send, calls } = recorder();
  await slackChannel({ webhookUrl: "https://hooks.slack/x" }, send).send({ title: "T", text: "hello" });
  assert.equal(calls[0]?.url, "https://hooks.slack/x");
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? "{}"), { text: "*T*\nhello" });
});

test("telegramChannel posts chat_id + text to the bot API", async () => {
  const { send, calls } = recorder();
  await telegramChannel({ token: "TOK", chatId: "42" }, send).send({ text: "ping" });
  assert.match(calls[0]?.url ?? "", /api\.telegram\.org\/botTOK\/sendMessage/);
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? "{}"), { chat_id: "42", text: "ping" });
});

test("emailChannel posts to the email API with bearer auth", async () => {
  const { send, calls } = recorder();
  await emailChannel({ apiUrl: "https://api.email/send", apiKey: "KEY", from: "a@x", to: "b@y" }, send).send({
    title: "Subj",
    text: "body",
  });
  assert.equal(calls[0]?.init.headers?.["authorization"], "Bearer KEY");
  const body = JSON.parse(calls[0]?.init.body ?? "{}");
  assert.equal(body.subject, "Subj");
  assert.deepEqual(body.to, ["b@y"]);
});

test("channelsFrom builds only configured channels", () => {
  const { send } = recorder();
  const chans = channelsFrom({ slackWebhook: "u", telegramToken: "t", telegramChat: "c" }, send);
  assert.deepEqual(chans.map((c) => c.name).sort(), ["slack", "telegram"]);
  assert.equal(channelsFrom({}, send).length, 0);
});

test("notify tool is irreversible and fans out to all channels", async () => {
  const { send, calls } = recorder();
  const chans = channelsFrom({ slackWebhook: "u", telegramToken: "t", telegramChat: "c" }, send);
  const tool = notifyTool(chans);
  assert.equal(tool.effect, "irreversible"); // lease-gated comms (ADR-0014 §3)
  const res = await tool.execute({ text: "alert", title: "x" });
  assert.equal((res.output as { sent: number }).sent, 2);
  assert.equal(calls.length, 2);
});

test("notifyAll is best-effort: one failing channel doesn't sink the rest", async () => {
  const ok = slackChannel({ webhookUrl: "u" }, async () => ({ ok: true, status: 200 }));
  const bad = slackChannel({ webhookUrl: "u" }, async () => ({ ok: false, status: 500 }));
  const sent = await notifyAll([ok, bad], { text: "x" });
  assert.equal(sent, 1);
});
