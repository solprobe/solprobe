import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { tryAcquire } from "../cache.js";
import { recordSourceResult } from "./resolver.js";
import { isProtocolAddress } from "../constants.js";

const BASE_URL = "https://api.rugcheck.xyz/v1/tokens";

// mint_authority_revoked and freeze_authority_revoked are intentionally absent.
// Helius RPC is the sole source for those fields (via getTokenMintInfo).
export interface RugCheckResult {
  has_rug_history: boolean;
  bundled_launch_detected: boolean;
  rugcheck_risk_score: number | null;
  insider_flags: boolean;
  /** Seconds since the RugCheck report was generated. -1 if no timestamp found. */
  report_age_seconds: number;
  /** Top-10 holder concentration (%), excluding Virtuals Protocol addresses. */
  top_10_holder_pct: number | null;
  is_honeypot: boolean;
}

interface RawRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: string;
}

interface RawHolder {
  address: string;
  amount: number;
  decimals?: number;
  pct: number;
  uiAmount: number;
  uiAmountString: string;
}

interface RawReport {
  mint: string;
  score?: number;
  score_normalised?: number;
  risks?: RawRisk[];
  topHolders?: RawHolder[];
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  detectedAt?: string;
  createdAt?: string;
  token?: unknown;
}

export async function getRugCheckSummary(
  address: string,
  options: { timeout?: number } = {}
): Promise<RugCheckResult | null> {
  if (!isAvailable("rugcheck")) return null;
  if (!tryAcquire("rugcheck")) return null;

  const timeout = options.timeout ?? 3000;
  const url = `${BASE_URL}/${address}/report`;
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    recordSourceResult("rugcheck", false, Date.now() - start);
    recordFailure("rugcheck");
    throw err;
  }

  // 400/404 = bad address — don't penalise the breaker, but return null
  if (res.status === 400 || res.status === 404) {
    return null;
  }

  if (!res.ok) {
    recordSourceResult("rugcheck", false, Date.now() - start);
    recordFailure("rugcheck");
    const err = new Error(`RugCheck HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const raw = (await res.json()) as RawReport;
  recordSourceResult("rugcheck", true, Date.now() - start);
  recordSuccess("rugcheck");

  // ── Report age ──────────────────────────────────────────────────────────────
  let report_age_seconds = -1;
  const tsStr = raw.detectedAt ?? raw.createdAt;
  if (tsStr) {
    const ts = Date.parse(tsStr);
    if (!isNaN(ts)) {
      report_age_seconds = Math.floor((Date.now() - ts) / 1000);
    }
  }

  // ── Risk score ─────────────────────────────────────────────────────────────
  const rugcheck_risk_score = raw.score_normalised ?? raw.score ?? null;

  // ── Rug history ─────────────────────────────────────────────────────────────
  const has_rug_history = raw.rugged === true;

  // ── Risks array analysis ────────────────────────────────────────────────────
  const risks = raw.risks ?? [];

  const is_honeypot = risks.some(
    (r) =>
      r.name?.toLowerCase().includes("honeypot") ||
      r.description?.toLowerCase().includes("honeypot")
  );

  const bundled_launch_detected = risks.some(
    (r) =>
      r.name?.toLowerCase().includes("bundl") ||
      r.description?.toLowerCase().includes("bundl")
  );

  const insider_flags = risks.some(
    (r) =>
      r.name?.toLowerCase().includes("insider") ||
      r.description?.toLowerCase().includes("insider") ||
      r.name?.toLowerCase().includes("sniper")
  );

  // ── Top-10 holder concentration (protocol addresses filtered out) ────────────
  let top_10_holder_pct: number | null = null;
  if (Array.isArray(raw.topHolders) && raw.topHolders.length > 0) {
    const filtered = raw.topHolders.filter((h) => !isProtocolAddress(h.address));
    const top10 = filtered.slice(0, 10);
    if (top10.length > 0) {
      top_10_holder_pct = Math.min(100, top10.reduce((sum, h) => sum + (h.pct ?? 0), 0));
    }
  }

  return {
    has_rug_history,
    bundled_launch_detected,
    rugcheck_risk_score,
    insider_flags,
    report_age_seconds,
    top_10_holder_pct,
    is_honeypot,
  };
}
