import { getDexScreenerToken, deriveLPStatus, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned } from "../sources/helius.js";
import {
  calculateRiskGrade,
  calculateConfidence,
  confidenceToString,
  buildHistoricalFlags,
  type RiskFactors,
} from "./riskScorer.js";
import { resolveAuthorityExempt } from "../sources/jupiterTokenList.js";
import { isLPBurnLaunchpad, PROGRAMS } from "../constants.js";
import { deduplicate, getOrFetch } from "../cache.js";
import {
  generateQuickScanSummary,
  fallbackQuickSummary,
  type QuickScanData,
} from "../llm/narrativeEngine.js";
import type { ScoringFactor, HistoricalFlag } from "./types.js";

// ---------------------------------------------------------------------------
// Liquidity Check — structured object with actionable guidance
// ---------------------------------------------------------------------------

export type LiquidityRating = "DEEP" | "ADEQUATE" | "THIN" | "CRITICAL" | "UNKNOWN";

export interface LiquidityCheck {
  rating: LiquidityRating;
  meaning: string;
  threshold_usd: number | null;
  action_guidance: string;
}

const LIQUIDITY_CHECK_LOOKUP: Record<LiquidityRating, LiquidityCheck> = {
  DEEP: {
    rating: "DEEP",
    meaning: "Liquidity exceeds $500k. Large positions can be executed with minimal price impact.",
    threshold_usd: 500_000,
    action_guidance: "Liquidity is not a limiting factor. Proceed based on structural and market signals.",
  },
  ADEQUATE: {
    rating: "ADEQUATE",
    meaning: "Liquidity is between $50k and $500k. Suitable for moderate position sizes.",
    threshold_usd: 50_000,
    action_guidance: "Exercise normal position sizing. Monitor for liquidity changes on active trades.",
  },
  THIN: {
    rating: "THIN",
    meaning: "Liquidity is between $5k and $50k. Execution risk is elevated for any meaningful position.",
    threshold_usd: 5_000,
    action_guidance: "Use small position sizes only. High slippage likely on entry and exit.",
  },
  CRITICAL: {
    rating: "CRITICAL",
    meaning: "Liquidity is below $5k. Exit liquidity is effectively zero for most position sizes.",
    threshold_usd: null,
    action_guidance: "Do not execute. Treat as equivalent to a D or F structural grade regardless of other signals.",
  },
  UNKNOWN: {
    rating: "UNKNOWN",
    meaning: "Liquidity data could not be retrieved from available sources.",
    threshold_usd: null,
    action_guidance: "Do not rely on liquidity signals from this response. Verify independently before acting.",
  },
};

export function deriveLiquidityCheck(liquidity_usd: number | null | undefined): LiquidityCheck {
  if (liquidity_usd === null || liquidity_usd === undefined) return LIQUIDITY_CHECK_LOOKUP.UNKNOWN;
  if (liquidity_usd >= 500_000) return LIQUIDITY_CHECK_LOOKUP.DEEP;
  if (liquidity_usd >= 50_000)  return LIQUIDITY_CHECK_LOOKUP.ADEQUATE;
  if (liquidity_usd >= 5_000)   return LIQUIDITY_CHECK_LOOKUP.THIN;
  return LIQUIDITY_CHECK_LOOKUP.CRITICAL;
}

export interface QuickScanResult {
  schema_version: "2.0";
  /** Always "STRUCTURAL_SAFETY" — this service evaluates on-chain token structure only */
  grade_type: "STRUCTURAL_SAFETY";
  /** Scope declaration — clarifies what is and is not covered */
  scope: {
    includes: string[];
    excludes: string[];
  };
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  /** Structured liquidity assessment — does not replace sol_market_intel */
  liquidity_check: LiquidityCheck;
  lp_burned: boolean | null;
  lp_model: LPModel;
  lp_status: LPStatus;
  dex_id: string | null;
  rugcheck_risk_score: number | null;
  single_holder_danger: boolean;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  /** Backwards-compat string confidence derived from numeric confidence */
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Age in seconds of the RugCheck report used; null if RugCheck was unavailable. */
  rugcheck_report_age_seconds: number | null;
  /** True when this token is on the Jupiter strict list with a legitimately retained authority. */
  authority_exempt: boolean;
  /** Human-readable reason for the exemption, or null when not exempt. */
  authority_exempt_reason: string | null;
  /** Structured breakdown of all scoring contributors */
  factors: ScoringFactor[];
  /** Structured confidence breakdown */
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  /** Historical event flags derived from source data */
  historical_flags: HistoricalFlag[];
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
}

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
}

export async function quickScan(address: string): Promise<QuickScanResult> {
  const cacheKey = `sol_quick_scan:${address}`;
  return deduplicate(cacheKey, () => getOrFetch(cacheKey, () => _fetchQuickScan(address)));
}

async function _fetchQuickScan(address: string): Promise<QuickScanResult> {
  const fetchStart = Date.now();

  // All three sources run in parallel. getTokenMintInfo is NOT sequential.
  const [dexResult, rugResult, mintResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenMintInfo(address, { timeout: 3000 }),  // sole source for authority flags
  ]);

  const dexData  = dexResult.status  === "fulfilled" ? dexResult.value  : null;
  const rugData  = rugResult.status  === "fulfilled" ? rugResult.value  : null;
  const mintData = mintResult.status === "fulfilled" ? mintResult.value : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason,   address);
  if (mintResult.status === "rejected") logError("helius_rpc",  mintResult.reason,  address);

  // ── Phase 2: LP burn check — requires LP mint from phase 1 ───────────────
  const lp_model = dexData?.lp_model ?? "UNKNOWN";
  const dex_id   = dexData?.dex_id   ?? null;
  const lpMint   = dexData?.lp_mint_address ?? null;

  // CLMM/DLMM pools have no fungible LP mint — skip the burn check entirely.
  // quickScan does not call Helius getAsset, so no creatorProgramId is available.
  // Infer the launch program from the dexId heuristic and gate on LP_BURN_LAUNCHPADS.
  // When Helius getAsset is wired up here, replace inferredProgramId with the
  // real creatorProgramId and drop the heuristic entirely.
  let lp_burned: boolean | null = null;
  if (lp_model !== "CLMM_DLMM") {
    const inferredProgramId = dexData?.pairs.some((p) =>
      p.dexId?.toLowerCase().includes("pump")
    ) ? PROGRAMS.PUMP_FUN : null;
    const launchedFromLPBurnPad = inferredProgramId
      ? isLPBurnLaunchpad(inferredProgramId)
      : false;
    lp_burned = launchedFromLPBurnPad
      ? true
      : (lpMint ? await checkLPBurned(lpMint, { timeout: 2000 }) : null);
  }

  const lp_status = deriveLPStatus(lp_burned, lp_model);

  // ── Authority flags: Helius only, unconditionally ─────────────────────────
  // On null (RPC failure), default to false (conservative — treat as not revoked).
  const mint_authority_revoked   = mintData?.mint_authority_revoked   ?? false;
  const freeze_authority_revoked = mintData?.freeze_authority_revoked ?? false;

  // ── Holder concentration: from RugCheck (already filtered for protocol addrs) ─
  const top_10_holder_pct = rugData?.top_10_holder_pct ?? null;

  // ── Liquidity ─────────────────────────────────────────────────────────────
  const liquidity_usd = dexData?.liquidity_usd ?? null;

  // ── Honeypot + rug history ─────────────────────────────────────────────────
  const is_honeypot    = rugData?.is_honeypot    ?? false;
  const has_rug_history = rugData?.has_rug_history ?? false;

  // ── RugCheck report age ────────────────────────────────────────────────────
  const rugcheck_report_age_seconds = rugData?.report_age_seconds ?? null;

  // ── Token age ─────────────────────────────────────────────────────────────
  let token_age_days: number | null = null;
  if (dexData?.pair_created_at_ms != null) {
    token_age_days = (Date.now() - dexData.pair_created_at_ms) / (1000 * 60 * 60 * 24);
  }

  const riskFactors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: rugData?.bundled_launch_detected ?? false,
    buy_sell_ratio: dexData?.buy_sell_ratio_1h ?? null,
    token_age_days,
    rugcheck_risk_score: rugData?.rugcheck_risk_score ?? null,
    single_holder_danger: rugData?.single_holder_danger ?? false,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    dev_wallet_age_days: null, // quickScan never fetches this
  };

  const { exempt: authority_exempt, reason: authority_exempt_reason } = await resolveAuthorityExempt(address);

  const { grade: risk_grade, scoringFactors } = calculateRiskGrade(riskFactors, authority_exempt);

  // ── Data confidence ────────────────────────────────────────────────────────
  const sources = [
    dexData  !== null ? "dexscreener" : null,
    rugData  !== null ? "rugcheck"    : null,
    mintData !== null ? "helius"      : null,
  ].filter((s): s is string => s !== null);

  const data_age_ms = Date.now() - fetchStart;
  const confidence = calculateConfidence({
    sources_available: sources.length,
    sources_total: 3,
    data_age_ms,
    rugcheck_age_seconds: rugcheck_report_age_seconds ?? undefined,
  });
  const data_confidence = confidenceToString(confidence.model);

  // ── Historical flags ───────────────────────────────────────────────────────
  const historical_flags = buildHistoricalFlags({
    has_rug_history,
    bundled_launch: riskFactors.bundled_launch,
    single_holder_danger: riskFactors.single_holder_danger,
  });

  // ── Scope declaration ─────────────────────────────────────────────────────
  const grade_type = "STRUCTURAL_SAFETY" as const;
  const scope = {
    includes: ["mint_authority", "freeze_authority", "holder_distribution"],
    excludes: ["liquidity", "volume", "price_action", "market_behavior"],
  };

  // ── Liquidity check (structured heuristic — no raw $ in response) ─────────
  const liquidity_check = deriveLiquidityCheck(liquidity_usd);

  // ── Data quality ──────────────────────────────────────────────────────────
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    sources.length === 3 ? "FULL" : sources.length >= 2 ? "PARTIAL" : "LIMITED";

  const missing_fields: string[] = [];
  if (dexData  === null) missing_fields.push("liquidity_usd", "dex_id", "lp_model");
  if (rugData  === null) missing_fields.push("rugcheck_risk_score", "top_10_holder_pct", "has_rug_history");
  if (mintData === null) missing_fields.push("mint_authority_revoked", "freeze_authority_revoked");

  // ── LLM summary — sequential, after all parallel fetches complete ──────────
  const llmInputData: QuickScanData = {
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    risk_grade,
    data_confidence,
    has_rug_history,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
  };

  let summary: string;
  const elapsed = Date.now() - fetchStart;
  if (elapsed >= 4_200) {
    // SLA headroom exhausted — skip LLM to guarantee response time
    console.warn(`[quickScan] skipping LLM summary — elapsed ${elapsed}ms exceeds 4200ms`);
    summary = fallbackQuickSummary(llmInputData);
  } else {
    summary = await generateQuickScanSummary(llmInputData);
  }

  return {
    schema_version: "2.0" as const,
    grade_type,
    scope,
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_check,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    rugcheck_risk_score: riskFactors.rugcheck_risk_score,
    single_holder_danger: riskFactors.single_holder_danger,
    risk_grade,
    summary,
    data_confidence,
    rugcheck_report_age_seconds,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
    confidence,
    historical_flags,
    data_quality,
    missing_fields,
  };
}
