// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

export const CACHE_TTL: Record<string, number> = {
  sol_quick_scan:   30_000,   // 30s
  sol_market_intel: 10_000,   // 10s
  sol_wallet_risk:  300_000,  // 5 min
  sol_deep_dive:    60_000,   // 1 min
};

/** Derive TTL from cache key prefix (e.g. "quick:EPj...") */
function ttlForKey(key: string): number {
  const prefix = key.split(":")[0];
  return CACHE_TTL[prefix] ?? 60_000;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

let _cacheHits = 0;
let _totalRequests = 0;

export function getCacheStats(): { cache_hits: number; total_requests: number } {
  return { cache_hits: _cacheHits, total_requests: _totalRequests };
}

/**
 * Return cached value if fresh, otherwise call `fn`, store the result, and return it.
 * TTL is inferred from the key prefix.
 */
export async function getOrFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  _totalRequests++;

  const entry = store.get(key) as CacheEntry<T> | undefined;
  if (entry && Date.now() < entry.expiresAt) {
    _cacheHits++;
    return entry.value;
  }

  const value = await fn();
  store.set(key, { value, expiresAt: Date.now() + ttlForKey(key) });
  return value;
}

// ---------------------------------------------------------------------------
// In-flight request deduplication
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Coalesce concurrent calls for the same key into a single in-flight promise.
 * Prevents thundering-herd bursts from triggering N identical upstream calls.
 */
export async function deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) return inFlight.get(key) as Promise<T>;

  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Token bucket rate limiter (self-implemented, no library)
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
  /** tokens added per millisecond */
  ratePerMs: number;
  capacity: number;
}

const buckets = new Map<string, TokenBucket>();

const BUCKET_CONFIG: Record<string, { reqPerMin: number }> = {
  dexscreener: { reqPerMin: 300 },
  rugcheck:    { reqPerMin: 100 },
};

function getBucket(source: string): TokenBucket {
  if (!buckets.has(source)) {
    const cfg = BUCKET_CONFIG[source];
    if (!cfg) throw new Error(`No rate limit config for source: ${source}`);
    const capacity = cfg.reqPerMin;
    buckets.set(source, {
      tokens: capacity,
      lastRefillMs: Date.now(),
      ratePerMs: cfg.reqPerMin / 60_000,
      capacity,
    });
  }
  return buckets.get(source)!;
}

/**
 * Attempt to consume one token from the source's bucket.
 * Returns true if allowed, false if the bucket is empty (fail immediately — do not queue).
 */
export function tryAcquire(source: "dexscreener" | "rugcheck"): boolean {
  const bucket = getBucket(source);
  const now = Date.now();
  const elapsed = now - bucket.lastRefillMs;

  // Refill proportionally to elapsed time
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.ratePerMs);
  bucket.lastRefillMs = now;

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Resets all cache state — for testing only */
export function _resetCache(): void {
  store.clear();
  inFlight.clear();
  buckets.clear();
  _cacheHits = 0;
  _totalRequests = 0;
}
