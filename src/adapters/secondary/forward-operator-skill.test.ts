import { test } from "node:test";
import assert from "node:assert/strict";

import { loadSkills } from "./skill-loader.js";
import { ToolRegistry } from "./in-memory-tool-host.js";
import type { Grant } from "../../domain/grant.js";
import type { Skill } from "../../ports/skill.js";
import type { WorkerContext } from "../../ports/worker.js";

const ctxWith = (tools: WorkerContext["tools"]): WorkerContext => ({
  tools,
  lease: { held: async () => true, assertHeld: async () => {}, renew: async () => {} },
  onProgress: () => {},
  signal: new AbortController().signal,
});

/** Load the forward-operator skill and build a ToolHost from ITS OWN contributed tools
 *  (forward_query/forward_act), filtered by `grant`. This is what composition does for real. */
async function load(grant: Grant): Promise<{ skill: Skill; ctx: WorkerContext }> {
  const { skills } = await loadSkills("examples/plugins");
  const skill = skills.find((s) => s.name === "forward-operator");
  assert.ok(skill, "forward-operator code skill should load");
  const reg = new ToolRegistry();
  for (const t of skill.tools ?? []) reg.register(t);
  return { skill, ctx: ctxWith(reg.hostFor(grant)) };
}

/** Stub global fetch; record calls; restore via the returned dispose. */
function stubFetch(handler: (url: string, init: any) => { status: number; json: unknown }) {
  const calls: Array<{ url: string; init: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    const { status, json } = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) } as Response;
  }) as typeof fetch;
  return { calls, dispose: () => { globalThis.fetch = orig; } };
}

const withEnv = (over: Record<string, string | undefined>, fn: () => Promise<void>) => async () => {
  const keys = ["FORWARD_BASE_URL", "FORWARD_USERNAME", "FORWARD_PASSWORD", "FORWARD_NETWORK_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const next: Record<string, string | undefined> = { FORWARD_USERNAME: "u", FORWARD_PASSWORD: "t", FORWARD_NETWORK_ID: "net-1", ...over };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

const READ_ONLY: Grant = { tools: "*", maxEffect: "read" };
const OPERATOR: Grant = { tools: "*", maxEffect: "irreversible" };

test("forward networks — parses the list and completes (observe)", withEnv({}, async () => {
  const f = stubFetch(() => ({ status: 200, json: [{ id: "net-1", name: "campus" }, { id: "net-2", name: "dc" }] }));
  try {
    const { skill, ctx } = await load(READ_ONLY);
    const res = await skill.run({ taskId: "t", spec: { goal: "forward networks" } }, ctx);
    assert.equal(res.status, "completed");
    assert.match(res.summary, /2 network\(s\)/);
    assert.match(res.summary, /campus\(net-1\)/);
    assert.match(f.calls[0]!.url, /\/api\/networks$/);
  } finally {
    f.dispose();
  }
}));

test("forward devices — runs NQE inventory against the default network (inspect)", withEnv({}, async () => {
  const f = stubFetch(() => ({ status: 200, json: { items: [{ name: "spine-1" }, { name: "leaf-1" }] } }));
  try {
    const { skill, ctx } = await load(READ_ONLY);
    const res = await skill.run({ taskId: "t", spec: { goal: "forward devices" } }, ctx);
    assert.equal(res.status, "completed");
    assert.match(res.summary, /2 device\(s\) on net-1/);
    // It POSTed NQE with the networkId in the query string.
    assert.equal(f.calls[0]!.init.method, "POST");
    assert.match(f.calls[0]!.url, /\/api\/nqe\?networkId=net-1/);
  } finally {
    f.dispose();
  }
}));

test("forward manage — dry-runs by default, sending nothing (manageGuard)", withEnv({}, async () => {
  const f = stubFetch(() => ({ status: 200, json: {} }));
  try {
    const { skill, ctx } = await load(OPERATOR);
    const res = await skill.run({ taskId: "t", spec: { goal: "forward manage POST /api/networks/net-1/devices/x/tags", inputs: { body: { tag: "vuln" } } } }, ctx);
    assert.equal(res.status, "completed");
    assert.match(res.summary, /dry-run/);
    assert.equal(f.calls.length, 0, "no HTTP call on a dry-run");
  } finally {
    f.dispose();
  }
}));

test("forward manage — a read-only grant cannot mutate (effect ceiling, ADR-0004)", withEnv({}, async () => {
  const f = stubFetch(() => ({ status: 200, json: {} }));
  try {
    const { skill, ctx } = await load(READ_ONLY); // forward_act excluded by maxEffect: read
    const res = await skill.run({ taskId: "t", spec: { goal: "forward manage DELETE /api/x", inputs: { confirm: true } } }, ctx);
    assert.equal(res.status, "failed");
    assert.match(res.summary, /not permitted/i);
    assert.equal(f.calls.length, 0);
  } finally {
    f.dispose();
  }
}));

test("forward — fails clearly without credentials", withEnv({ FORWARD_USERNAME: undefined, FORWARD_PASSWORD: undefined }, async () => {
  const { skill, ctx } = await load(READ_ONLY);
  const res = await skill.run({ taskId: "t", spec: { goal: "forward networks" } }, ctx);
  assert.equal(res.status, "failed");
  assert.equal((res as { error: string }).error, "no_credentials");
}));
