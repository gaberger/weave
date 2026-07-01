import { test } from "node:test";
import assert from "node:assert/strict";

import { startHttpGateway, type GatewayEvent } from "./http-gateway.js";

/** Start a gateway on an ephemeral port; returns the base URL + the events onEvent saw. */
async function gateway(opts: { secret?: string; fail?: boolean; cors?: boolean } = {}) {
  const seen: GatewayEvent[] = [];
  let n = 0;
  const h = await startHttpGateway({
    port: 0,
    route: "/hook",
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(opts.cors ? { cors: true } : {}),
    onEvent: async (e) => {
      if (opts.fail) throw new Error("nope");
      seen.push(e);
      return { taskId: `task-${++n}` };
    },
  });
  return { url: `http://127.0.0.1:${h.port}`, seen, close: h.close };
}

test("POST to the route declares a task and returns 202 { taskId }", async () => {
  const g = await gateway();
  try {
    const res = await fetch(`${g.url}/hook`, { method: "POST", body: JSON.stringify({ goal: "do it" }) });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { taskId: "task-1" });
    assert.equal(g.seen.length, 1);
    assert.equal(g.seen[0]!.body, JSON.stringify({ goal: "do it" }));
  } finally {
    await g.close();
  }
});

test("GET the route (and /health) is a health check that never declares", async () => {
  const g = await gateway();
  try {
    for (const p of ["/hook", "/health"]) {
      const res = await fetch(`${g.url}${p}`);
      assert.equal(res.status, 200, p);
      assert.equal(await res.text(), "ok");
    }
    assert.equal(g.seen.length, 0, "health checks must not declare tasks");
  } finally {
    await g.close();
  }
});

test("an unknown path is 404 and a non-POST to the route is 405", async () => {
  const g = await gateway();
  try {
    assert.equal((await fetch(`${g.url}/nope`)).status, 404);
    assert.equal((await fetch(`${g.url}/hook`, { method: "PUT" })).status, 405);
  } finally {
    await g.close();
  }
});

test("a configured secret gates declaration (401 without/with wrong, 202 with correct)", async () => {
  const g = await gateway({ secret: "s3cr3t" });
  try {
    assert.equal((await fetch(`${g.url}/hook`, { method: "POST", body: "x" })).status, 401);
    assert.equal(
      (await fetch(`${g.url}/hook`, { method: "POST", headers: { "x-weave-secret": "wrong" }, body: "x" })).status,
      401,
    );
    const ok = await fetch(`${g.url}/hook`, { method: "POST", headers: { "x-weave-secret": "s3cr3t" }, body: "x" });
    assert.equal(ok.status, 202);
    assert.equal(g.seen.length, 1);
  } finally {
    await g.close();
  }
});

test("an onEvent that throws becomes a 400 with the error (declaration rejected, not crashed)", async () => {
  const g = await gateway({ fail: true });
  try {
    const res = await fetch(`${g.url}/hook`, { method: "POST", body: "x" });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /nope/);
  } finally {
    await g.close();
  }
});

test("with cors on, OPTIONS preflight is 204 with CORS headers and POST echoes the origin", async () => {
  const g = await gateway({ cors: true });
  try {
    const pre = await fetch(`${g.url}/hook`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8788" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://127.0.0.1:8788");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-weave-secret/);
    // the actual declare also carries the ACAO so the browser can read the 202
    const res = await fetch(`${g.url}/hook`, { method: "POST", headers: { origin: "http://127.0.0.1:8788" }, body: JSON.stringify({ goal: "hi" }) });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:8788");
    assert.equal(g.seen.length, 1);
  } finally {
    await g.close();
  }
});

test("preflight does not require the secret, but the POST still does", async () => {
  const g = await gateway({ cors: true, secret: "s3cr3t" });
  try {
    assert.equal((await fetch(`${g.url}/hook`, { method: "OPTIONS" })).status, 204, "preflight carries no secret");
    assert.equal((await fetch(`${g.url}/hook`, { method: "POST", body: "x" })).status, 401, "POST still gated");
    assert.equal(g.seen.length, 0);
  } finally {
    await g.close();
  }
});

test("without cors, OPTIONS is not special-cased (405) and no ACAO header leaks", async () => {
  const g = await gateway();
  try {
    const res = await fetch(`${g.url}/hook`, { method: "OPTIONS" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await g.close();
  }
});
