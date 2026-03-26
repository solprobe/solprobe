// Continuous token bucket rate limiter — 60 requests per minute per IP.
// Proportional refill (tokens added per ms elapsed), not fixed-window reset.
// Returns false immediately when bucket empty — no queuing or delay.

const RATE = 60;          // tokens per minute
const REFILL_RATE = RATE / 60_000; // tokens per millisecond
const MAX_ENTRIES = 10_000;

interface Bucket {
  tokens: number;
  lastRefill: number; // timestamp ms
}

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE, bucket.tokens + elapsed * REFILL_RATE);
  bucket.lastRefill = now;
}

export function checkRateLimit(ip: string): boolean {
  if (buckets.size >= MAX_ENTRIES) {
    // Cap exceeded — clear entirely and start fresh
    buckets.clear();
  }

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE, lastRefill: Date.now() };
    buckets.set(ip, bucket);
  }

  refill(bucket);

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}
