export type SourceName =
  | "dexscreener"
  | "rugcheck"
  | "helius"
  | "birdeye"
  | "solscan";

interface SourceStats {
  priority: number;
  successRate: number;
  avgLatencyMs: number;
  totalCalls: number;
  failures: number;
}

const SOURCE_STATS: Record<SourceName, SourceStats> = {
  dexscreener: { priority: 1, successRate: 0.97, avgLatencyMs: 800,  totalCalls: 0, failures: 0 },
  rugcheck:    { priority: 2, successRate: 0.94, avgLatencyMs: 1200, totalCalls: 0, failures: 0 },
  helius:      { priority: 3, successRate: 0.91, avgLatencyMs: 400,  totalCalls: 0, failures: 0 },
  birdeye:     { priority: 4, successRate: 0.88, avgLatencyMs: 1100, totalCalls: 0, failures: 0 },
  solscan:     { priority: 5, successRate: 0.85, avgLatencyMs: 900,  totalCalls: 0, failures: 0 },
};

/** Call after every source fetch — pass success=false on any thrown error or non-200. */
export function recordSourceResult(
  source: SourceName,
  success: boolean,
  latencyMs: number
): void {
  const s = SOURCE_STATS[source];
  s.totalCalls++;
  if (!success) s.failures++;

  // Exponential moving average latency (α=0.1)
  s.avgLatencyMs = s.avgLatencyMs * 0.9 + latencyMs * 0.1;

  // Recalculate rolling success rate every 100 calls
  if (s.totalCalls % 100 === 0) {
    s.successRate = 1 - s.failures / s.totalCalls;
  }
}

/** Returns sources ranked by current success rate (best first). */
export function rankSources(candidates?: SourceName[]): SourceName[] {
  const pool = candidates ?? (Object.keys(SOURCE_STATS) as SourceName[]);
  return [...pool].sort(
    (a, b) => SOURCE_STATS[b].successRate - SOURCE_STATS[a].successRate
  );
}

/** Snapshot of current stats — exposed via /health for observability. */
export function getSourceStats(): Record<SourceName, SourceStats> {
  return { ...SOURCE_STATS };
}
