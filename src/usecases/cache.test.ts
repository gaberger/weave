/**
 * The hot-query answer cache (src/usecases/cache.ts) — added with the learning usecase and previously
 * untested. It's module-global mutable state keyed by utterance with a 1-hour TTL, so these tests use
 * UNIQUE utterances (no cross-test bleed) and mock Date.now to drive expiry deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { getCachedAnswer, cacheAnswer, getCacheStats, clearExpiredCache } from "./cache.js";

/** Run `fn` with Date.now() pinned to `t`, always restoring the real clock. */
function atTime<T>(t: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => t;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

const TTL = 3600_000;

test("getCachedAnswer returns null for an utterance that was never cached", () => {
  assert.equal(getCachedAnswer("cache-test: never-seen-utterance"), null);
});

test("cacheAnswer then getCachedAnswer round-trips the answer and counts hits", () => {
  const u = "cache-test: what is the capital";
  cacheAnswer(u, "Paris");
  const first = getCachedAnswer(u);
  assert.ok(first);
  assert.equal(first!.answer, "Paris");
  // cacheAnswer seeds hits at 1; each successful get increments.
  const before = first!.hits;
  const second = getCachedAnswer(u);
  assert.equal(second!.hits, before + 1, "each hit increments the counter");
});

test("an entry past its TTL is treated as a miss (and evicted)", () => {
  const u = "cache-test: stale entry";
  atTime(1_000_000, () => cacheAnswer(u, "old answer"));
  assert.ok(atTime(1_000_000, () => getCachedAnswer(u)), "fresh at cache time");
  assert.equal(atTime(1_000_000 + TTL + 1, () => getCachedAnswer(u)), null, "expired after TTL");
  // Eviction happened on the expired read, so it's gone even back at the original time.
  assert.equal(atTime(1_000_000, () => getCachedAnswer(u)), null, "expired entry was evicted");
});

test("getCacheStats reports the cached entry and its hit count", () => {
  const u = "cache-test: stats entry";
  cacheAnswer(u, "v");
  getCachedAnswer(u); // bump hits
  const stats = getCacheStats();
  const mine = stats.entries.find((e) => e.utterance === u);
  assert.ok(mine, "the entry appears in stats");
  assert.ok(mine!.hits >= 2, "hit count is reflected");
  assert.equal(stats.size, stats.entries.length, "size matches the entry list length");
});

test("clearExpiredCache removes only entries past their TTL and returns the count", () => {
  const fresh = "cache-test: clear-keeps-fresh";
  const stale = "cache-test: clear-drops-stale";
  cacheAnswer(fresh, "keep me"); // cached at real now → not expired
  atTime(500_000, () => cacheAnswer(stale, "drop me"));

  const cleared = atTime(500_000 + TTL + 1, () => clearExpiredCache());
  assert.ok(cleared >= 1, "at least the stale entry was cleared");
  assert.equal(getCachedAnswer(stale), null, "stale entry is gone");
  assert.ok(getCachedAnswer(fresh), "fresh entry survives a sweep");
});
