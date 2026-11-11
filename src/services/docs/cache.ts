/**
 * Generic in-memory TTL + LRU cache.
 */

// Shared by the page cache and the framework-index cache: same eviction and
// expiry rules, different size and TTL per use.

export const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000;

 // 1 minute

export function createTtlCache<T>(ttlMs: number, maxSize: number) {
  const store = new Map<string, { value: T; expiresAt: number }>();

  // Proactive cleanup: purge expired entries periodically so they don't
  // accumulate when a key is never re-accessed after expiring.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }, CACHE_CLEANUP_INTERVAL_MS).unref(); // unref so it doesn't keep the process alive

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      // LRU: move to end by re-inserting (Map preserves insertion order)
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T): void {
      if (store.has(key)) store.delete(key);
      if (store.size >= maxSize) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
