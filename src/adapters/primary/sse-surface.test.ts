import { test } from "node:test";
import assert from "node:assert/strict";

import { startSseSurface } from "./sse-surface.js";
import type { SealedEvent } from "../../domain/event.js";

function ev(seq: number, kind = "task.declared"): SealedEvent {
  return { id: `e${seq}`, kind, actor: "gateway", subject: `task-${seq}`, payload: { note: `n${seq}` }, seq, ts: 1_000 + seq };
}

/**
 * Start a surface on an ephemeral port with an INJECTED subscribe we control, so tests can (a) emit
 * events into any connected stream and (b) assert on the offset the surface subscribed from and on
 * unsubscribe-on-disconnect — no real substrate needed.
 */
async function surface(opts: { secret?: string; filter?: (e: SealedEvent) => boolean } = {}) {
  const handlers: Array<(e: SealedEvent) => void> = [];
  let lastFrom: number | undefined;
  let unsubs = 0;
  const h = await startSseSurface({
    port: 0,
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(opts.filter ? { filter: opts.filter } : {}),
    subscribe: (from, handler) => {
      lastFrom = from;
      handlers.push(handler);
      return { unsubscribe: () => { unsubs++; } };
    },
    page: "<html>BLACKBOARD_MARKER</html>",
  });
  return {
    url: `http://127.0.0.1:${h.port}`,
    emit: (e: SealedEvent) => handlers.forEach((fn) => fn(e)),
    from: () => lastFrom,
    unsubs: () => unsubs,
    clients: h.clients,
    close: h.close,
  };
}

/** Read whatever SSE text arrives within `ms`, then give up (the stream never ends on its own). */
async function readFor(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Promise.resolve().then(() => new Promise<void>((r) => setTimeout(r, ms)));
  await Promise.race([
    (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; out += dec.decode(value); } })(),
    deadline,
  ]);
  await reader.cancel().catch(() => {});
  return out;
}

test("GET / serves the blackboard page; /health is ok", async () => {
  const s = await surface();
  try {
    const page = await fetch(`${s.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /BLACKBOARD_MARKER/);
    const health = await fetch(`${s.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
  } finally {
    await s.close();
  }
});

test("unknown path is 404; a non-GET is 405 (the surface is read-only)", async () => {
  const s = await surface();
  try {
    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
    assert.equal((await fetch(`${s.url}/events`, { method: "POST" })).status, 405);
  } finally {
    await s.close();
  }
});

test("a connected stream receives pushed events as id/data SSE frames", async () => {
  const s = await surface();
  try {
    const res = await fetch(`${s.url}/events`); // handler runs synchronously → subscribe is registered
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    s.emit(ev(7));
    const text = await readFor(res, 400);
    assert.match(text, /^id: 7$/m, "frame carries the seq as the SSE id");
    const data = text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    assert.equal(JSON.parse(data).subject, "task-7");
  } finally {
    await s.close();
  }
});

test("?from replays inclusively; Last-Event-ID resumes strictly after", async () => {
  const s = await surface();
  try {
    const a = await fetch(`${s.url}/events?from=5`);
    assert.equal(s.from(), 5, "?from=N is inclusive");
    await a.body!.cancel();
    const b = await fetch(`${s.url}/events`, { headers: { "last-event-id": "9" } });
    assert.equal(s.from(), 10, "Last-Event-ID=9 resumes at 10 (after the last delivered)");
    await b.body!.cancel();
  } finally {
    await s.close();
  }
});

test("the filter drops events before they reach the wire", async () => {
  const s = await surface({ filter: (e) => e.kind !== "lease.renewed" });
  try {
    const res = await fetch(`${s.url}/events`);
    s.emit(ev(1, "lease.renewed"));
    s.emit(ev(2, "task.declared"));
    const text = await readFor(res, 400);
    assert.doesNotMatch(text, /lease\.renewed/, "filtered event must not be pushed");
    assert.match(text, /task\.declared/, "allowed event is pushed");
  } finally {
    await s.close();
  }
});

test("a configured secret gates the stream (401 without/with wrong; 200 via ?secret or header)", async () => {
  const s = await surface({ secret: "s3cr3t" });
  try {
    assert.equal((await fetch(`${s.url}/events`)).status, 401);
    assert.equal((await fetch(`${s.url}/events?secret=nope`)).status, 401);
    const q = await fetch(`${s.url}/events?secret=s3cr3t`);
    assert.equal(q.status, 200);
    await q.body!.cancel();
    const hdr = await fetch(`${s.url}/events`, { headers: { "x-weave-secret": "s3cr3t" } });
    assert.equal(hdr.status, 200);
    await hdr.body!.cancel();
    // The page itself stays open (no secret needed to load the shell; the stream is what's gated).
    assert.equal((await fetch(`${s.url}/`)).status, 200);
  } finally {
    await s.close();
  }
});

test("disconnecting a client unsubscribes it from the substrate", async () => {
  const s = await surface();
  try {
    const res = await fetch(`${s.url}/events`);
    assert.equal(s.unsubs(), 0);
    await res.body!.cancel(); // client hangs up
    // the server's 'close' handler fires asynchronously; poll briefly for it
    for (let i = 0; i < 50 && s.unsubs() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.unsubs(), 1, "closing the stream must release its subscription");
    assert.equal(s.clients(), 0, "no lingering client after disconnect");
  } finally {
    await s.close();
  }
});
