/**
 * In-memory cache with a time to live per entry, least-recently-used
 * eviction, and an optional budget on the total size of what it holds.
 * Nothing is written to disk: a new server process starts empty.
 */

// How often expired entries are swept out, so one that is never asked for
// again does not sit in memory until the process ends.
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface CacheLimits {
  /** Most entries kept; the least recently used goes first. */
  maxEntries: number;
  /** Cap on the sum of entry sizes, in whatever unit `set` is given (characters, here). */
  maxSize?: number;
  /** The clock, injectable so tests can move time by hand. */
  now?: () => number;
}

export interface Cache<T> {
  /** The value stored under `key`, unless it is absent or its time to live has passed. */
  get(key: string): T | undefined;
  /**
   * Store `value` for `ttlMs`. `size` counts toward the cache's size budget;
   * a value larger than the whole budget is not stored.
   */
  set(key: string, value: T, ttlMs: number, size?: number): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
  size: number;
}

export function createCache<T>(limits: CacheLimits): Cache<T> {
  const now = limits.now ?? Date.now;
  const maxSize = limits.maxSize ?? Infinity;
  // A Map iterates in insertion order, so re-inserting on use keeps the least
  // recently used entry first.
  const store = new Map<string, Entry<T>>();
  let totalSize = 0;

  const remove = (key: string): void => {
    const entry = store.get(key);
    if (!entry) return;
    store.delete(key);
    totalSize -= entry.size;
  };

  setInterval(() => {
    const time = now();
    for (const [key, entry] of store) {
      if (time > entry.expiresAt) remove(key);
    }
  }, SWEEP_INTERVAL_MS).unref(); // must not keep the process alive

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now() > entry.expiresAt) {
        remove(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key, value, ttlMs, size = 0) {
      remove(key);
      if (size > maxSize) return;
      store.set(key, { value, expiresAt: now() + ttlMs, size });
      totalSize += size;
      while (store.size > limits.maxEntries || totalSize > maxSize) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
    },
  };
}

export interface LoadOptions<T> {
  /** Size of a loaded value, counted toward the cache's size budget. */
  sizeOf?: (value: T) => number;
  /** Return false for a value that should be returned but not cached. */
  keep?: (value: T) => boolean;
}

// Loads in progress, per cache, so callers asking for the same key at the
// same time share one load instead of each starting their own.
const loading = new WeakMap<Cache<unknown>, Map<string, Promise<unknown>>>();

/**
 * Return the value cached under `key`, or run `load`, cache what it resolves
 * to for `ttlMs`, and return that. A failed load is not cached. A `ttlMs` of 0
 * skips the cache entirely.
 */
export async function getOrLoad<T>(
  cache: Cache<T>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  options: LoadOptions<T> = {}
): Promise<T> {
  if (ttlMs <= 0) return load();

  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let inProgress = loading.get(cache as Cache<unknown>);
  if (!inProgress) loading.set(cache as Cache<unknown>, (inProgress = new Map()));
  const existing = inProgress.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const pending = load()
    .then((value) => {
      if (options.keep?.(value) ?? true) cache.set(key, value, ttlMs, options.sizeOf?.(value) ?? 0);
      return value;
    })
    .finally(() => inProgress.delete(key));
  inProgress.set(key, pending);
  return pending;
}
