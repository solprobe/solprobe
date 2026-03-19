export type SourceName = "dexscreener" | "rugcheck" | "helius_rpc" | "birdeye" | "solscan";
export type BreakerStateValue = "CLOSED" | "OPEN" | "HALF_OPEN";

interface BreakerState {
  failures: number;
  openedAt: number | null;
  state: BreakerStateValue;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

const breakers = new Map<SourceName, BreakerState>();

function getBreaker(source: SourceName): BreakerState {
  if (!breakers.has(source)) {
    breakers.set(source, { failures: 0, openedAt: null, state: "CLOSED" });
  }
  return breakers.get(source)!;
}

export function isAvailable(source: SourceName): boolean {
  const b = getBreaker(source);
  if (b.state === "CLOSED") return true;
  if (b.state === "OPEN") {
    if (Date.now() - (b.openedAt ?? 0) > COOLDOWN_MS) {
      b.state = "HALF_OPEN"; // allow one probe request
      return true;
    }
    return false;
  }
  return true; // HALF_OPEN: allow the probe
}

export function recordSuccess(source: SourceName): void {
  const b = getBreaker(source);
  b.failures = 0;
  b.state = "CLOSED";
  b.openedAt = null;
}

export function recordFailure(source: SourceName): void {
  const b = getBreaker(source);
  b.failures++;
  if (b.failures >= FAILURE_THRESHOLD) {
    b.state = "OPEN";
    b.openedAt = Date.now();
  }
}

/** Returns current state of all breakers — used by /health endpoint */
export function getBreakerStates(): Record<SourceName, BreakerStateValue> {
  const sources: SourceName[] = ["dexscreener", "rugcheck", "helius_rpc", "birdeye", "solscan"];
  return Object.fromEntries(
    sources.map((s) => [s, getBreaker(s).state])
  ) as Record<SourceName, BreakerStateValue>;
}

/** Resets all breakers — for testing only */
export function _resetBreakers(): void {
  breakers.clear();
}
