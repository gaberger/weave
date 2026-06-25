import type { Substrate } from "../ports/substrate.js";
import type { AgentId } from "../domain/ids.js";

/** Cache entry for a hot query. */
export interface CacheEntry {
  utterance: string;
  answer: string;
  cachedAt: number;
  hits: number;
  ttl: number;
}

/** Simple in-memory cache for hot queries. */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 3600_000; // 1 hour

/**
 * Get a cached answer for an utterance.
 * Returns null if not cached or expired.
 */
export function getCachedAnswer(utterance: string): CacheEntry | null {
  const entry = cache.get(utterance);
  if (!entry) return null;

  const age = Date.now() - entry.cachedAt;
  if (age > entry.ttl) {
    cache.delete(utterance);
    return null;
  }

  // Update hit count
  entry.hits++;
  return entry;
}

/**
 * Store an answer in the cache for future use.
 */
export function cacheAnswer(utterance: string, answer: string): void {
  const existing = cache.get(utterance);
  cache.set(utterance, {
    utterance,
    answer,
    cachedAt: Date.now(),
    hits: (existing?.hits ?? 0) + 1,
    ttl: CACHE_TTL,
  });
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { size: number; entries: Array<{ utterance: string; hits: number }> } {
  return {
    size: cache.size,
    entries: [...cache.entries()].map(([k, v]) => ({ utterance: k, hits: v.hits })),
  };
}

/**
 * Clear expired cache entries.
 */
export function clearExpiredCache(): number {
  const now = Date.now();
  let cleared = 0;

  for (const [utterance, entry] of cache.entries()) {
    if (now - entry.cachedAt > entry.ttl) {
      cache.delete(utterance);
      cleared++;
    }
  }

  return cleared;
}