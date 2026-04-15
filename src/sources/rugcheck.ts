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
  single_holder_danger: boolean;
  insider_flags: boolean;
  /** Seconds since the RugCheck report was generated. -1 if no timestamp found. */
  report_age_seconds: number;
  /** Top-10 holder concentration (%), excluding Virtuals Protocol addresses. */
  top_10_holder_pct: number | null;
  is_honeypot: boolean;
  /** Raw unbounded RugCheck score (same as rugcheck_risk_score, 0 when null). */
  score: number;
  /** Normalised score from RugCheck API (0–10000 range). */
  score_normalised: number;
  /** Full risks array from RugCheck — needed by stripLPFalsePositives(). */
  risks: Array<{ name: string; score: number; level: string; value?: string }>;
  /** True when LP-related false positives have been removed from this result. */
  lp_risks_stripped: boolean;
  /** Score after LP false positive risks have been subtracted. */
  adjusted_score: number;
  /** Normalised score after LP false positive risks have been subtracted. */
  adjusted_score_normalised: number;
}

// Risk names that RugCheck incorrectly flags when LP is burned or pool is CLMM/DLMM.
// Burned LP tokens appear as "unlocked" wallets; DLMM pools have no fungible LP token.
const LP_RISK_NAMES = new Set([
  "Large Amount of LP Unlocked",
  "LP Unlocked",
  "Unlocked Liquidity",
  "Low LP Locked",
]);

/**
 * Remove LP-related false positives from a RugCheck result.
 * Must be called AFTER on-chain LP state (lp_burned, lp_model) is resolved.
 * - lp_burned === true: LP tokens sent to burn address; RugCheck counts burn addr as unlocked
 * - lp_model === "CLMM_DLMM": no fungible LP token exists; LP unlock flag is meaningless
 */
export function stripLPFalsePositives(
  rugcheck: RugCheckResult,
  onChainLP: { lp_burned: boolean | null; lp_model: "TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN" }
): RugCheckResult {
  const isLPFalsePositive =
    onChainLP.lp_burned === true || onChainLP.lp_model === "CLMM_DLMM";
  if (!isLPFalsePositive) {
    return { ...rugcheck, lp_risks_stripped: false, adjusted_score: rugcheck.score, adjusted_score_normalised: rugcheck.score_normalised };
  }
  const filteredRisks = rugcheck.risks.filter(r => !LP_RISK_NAMES.has(r.name));
  const strippedScore = rugcheck.risks
    .filter(r => LP_RISK_NAMES.has(r.name))
    .reduce((sum, r) => sum + r.score, 0);
  const adjusted_score = Math.max(0, rugcheck.score - strippedScore);
  const adjusted_score_normalised = rugcheck.score > 0
    ? Math.round((adjusted_score / rugcheck.score) * rugcheck.score_normalised)
    : 0;
  console.log(`[rugcheck] stripped LP false positive: lp_burned=${onChainLP.lp_burned} lp_model=${onChainLP.lp_model} score ${rugcheck.score} → ${adjusted_score} (removed ${strippedScore} points from LP flags)`);
  return { ...rugcheck, risks: filteredRisks, score: adjusted_score, score_normalised: adjusted_score_normalised, lp_risks_stripped: true, adjusted_score, adjusted_score_normalised };
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
  const rugcheck_risk_score = raw.score ?? null;

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

  const single_holder_danger = risks.some(
    (r) => r.name === "Single holder ownership" && r.level === "danger"
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

  const score = rugcheck_risk_score ?? 0;
  const score_normalised = raw.score_normalised ?? 0;

  return {
    has_rug_history,
    bundled_launch_detected,
    rugcheck_risk_score,
    single_holder_danger,
    insider_flags,
    report_age_seconds,
    top_10_holder_pct,
    is_honeypot,
    score,
    score_normalised,
    risks,
    lp_risks_stripped: false,
    adjusted_score: score,
    adjusted_score_normalised: score_normalised,
  };
}
