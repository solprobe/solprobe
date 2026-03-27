const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    backoff?: "linear" | "exponential";
    label?: string;
  } = {}
): Promise<T> {
  const {
    attempts = 3,
    delayMs = 400,
    backoff = "exponential",
    label = "operation",
  } = options;

  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const wait =
        backoff === "exponential" ? delayMs * 2 ** (i - 1) : delayMs * i;
      console.warn(
        `[retry] ${label} attempt ${i}/${attempts} failed — waiting ${wait}ms`
      );
      if (i < attempts) await sleep(wait);
    }
  }

  throw lastError;
}

// Per-attempt timeout — not total budget. Resets each retry.
// Total worst-case time = (timeoutMs × attempts) + sum of backoff delays.
export const RETRY_CONFIG = {
  sol_quick_scan: {
    attempts: 3,
    delayMs: 300,
    timeoutMs: 4_000,
  },
  sol_wallet_risk: {
    attempts: 3,
    delayMs: 500,
    timeoutMs: 6_000,
  },
  sol_market_intel: {
    attempts: 3,
    delayMs: 400,
    timeoutMs: 5_000,
  },
  sol_deep_dive: {
    attempts: 3,
    delayMs: 800,
    timeoutMs: 8_000,
  },
} as const;
