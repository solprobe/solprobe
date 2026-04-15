import { getDexScreenerToken, deriveLPStatus, classifyLPModel, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary, stripLPFalsePositives } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned, getMintCreationBlock } from "../sources/helius.js";
import { getTokenCreationInfo } from "../sources/birdeye.js";
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
// Launch Anomaly Detection
// ---------------------------------------------------------------------------

export type LaunchPattern = "SAME_BLOCK" | "WITHIN_5_BLOCKS" | "NORMAL" | "UNKNOWN";

export interface LaunchAnomaly {
  mint_block: number | null;
  pool_init_block: number | null;
  blocks_apart: number | null;
  same_block_launch: boolean | null;
  launch_pattern: LaunchPattern;
  risk_note: string;
  action_guidance: string;
}

const LAUNCH_ANOMALY_TEXT: Record<LaunchPattern, { risk_note: string; action_guidance: string }> = {
  SAME_BLOCK: {
    risk_note: "Token mint and liquidity pool were created in the same block. This is consistent with pre-planned coordinated launches.",
    action_guidance: "Treat as bundled_launch_detected regardless of RugCheck result. Significant rug risk signal.",
  },
  WITHIN_5_BLOCKS: {
    risk_note: "Liquidity pool was initialised within 5 blocks of token mint. May indicate coordinated launch.",
    action_guidance: "Cross-reference bundled_launch_detected and top holder concentration before acting.",
  },
  NORMAL: {
    risk_note: "Liquidity pool was created materially after token mint. No same-block anomaly detected.",
    action_guidance: "No launch timing anomaly. Evaluate other structural signals normally.",
  },
  UNKNOWN: {
    risk_note: "Launch timing data could not be retrieved.",
    action_guidance: "Launch pattern cannot be assessed. Use RugCheck bundled_launch_detected as fallback.",
  },
};

/** Solana: ~400ms per slot */
const MS_PER_SLOT = 400;

function deriveLaunchAnomaly(data: {
  mintBlockTime: number | null;   // Unix seconds
  poolCreatedAtMs: number | null; // Unix milliseconds (from DexScreener pairCreatedAt)
  mintSlot: number | null;
}): LaunchAnomaly {
  const { mintBlockTime, poolCreatedAtMs, mintSlot } = data;

  if (mintBlockTime === null || poolCreatedAtMs === null) {
    return {
      mint_block: mintSlot,
      pool_init_block: null,
      blocks_apart: null,
      same_block_launch: null,
      launch_pattern: "UNKNOWN",
      ...LAUNCH_ANOMALY_TEXT.UNKNOWN,
    };
  }

  const mintMs = mintBlockTime * 1000;
  const diffMs = poolCreatedAtMs - mintMs;
  const blocks_apart = Math.round(diffMs / MS_PER_SLOT);

  // Negative means pool appeared before mint in the data — treat as unknown
  if (blocks_apart < 0) {
    return {
      mint_block: mintSlot,
      pool_init_block: null,
      blocks_apart: null,
      same_block_launch: null,
      launch_pattern: "UNKNOWN",
      ...LAUNCH_ANOMALY_TEXT.UNKNOWN,
    };
  }

  const pattern: LaunchPattern =
    blocks_apart === 0 ? "SAME_BLOCK" :
    blocks_apart <= 5  ? "WITHIN_5_BLOCKS" :
    "NORMAL";

  // Estimate pool block from slot approximation
  const estimatedPoolSlot = mintSlot !== null
    ? mintSlot + blocks_apart
    : null;

  return {
    mint_block: mintSlot,
    pool_init_block: estimatedPoolSlot,
    blocks_apart,
    same_block_launch: blocks_apart === 0,
    launch_pattern: pattern,
    ...LAUNCH_ANOMALY_TEXT[pattern],
  };
}

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
  /** Launch timing anomaly — mint vs pool creation block comparison */
  launch_anomaly: LaunchAnomaly;
  /** LP lock status — multi-pool assessment */
  liquidity_lock_status: import("./types.js").LiquidityLockStatus;
  /** True when RugCheck LP false positives were stripped before scoring */
  rugcheck_lp_adjusted: boolean;
  /** Raw RugCheck score before LP correction; null when RugCheck was unavailable */
  rugcheck_raw_score: number | null;
  /** All LP model types detected across all pools (not just the primary pool) */
  pool_types_detected: Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">;
  /** Detailed RugCheck score correction metadata; null when RugCheck unavailable */
  rugcheck_score_details: {
    raw_score: number | null;
    adjusted_score: number | null;
    lp_false_positive_stripped: boolean;
    stripped_score_amount: number;
    reason: string | null;
  } | null;
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

  // All sources run in parallel.
  // Birdeye token_creation_info is primary for mint timestamp; Helius is the fallback.
  const [dexResult, rugResult, mintResult, birdeyeCreationResult, mintBlockResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenMintInfo(address, { timeout: 3000 }),          // sole source for authority flags
    getTokenCreationInfo(address, { timeout: 3000 }),      // primary for mint creation time
    getMintCreationBlock(address, { timeout: 2000 }),      // fallback for mint creation time
  ]);

  const dexData            = dexResult.status            === "fulfilled" ? dexResult.value            : null;
  const rugData            = rugResult.status            === "fulfilled" ? rugResult.value            : null;
  const mintData           = mintResult.status           === "fulfilled" ? mintResult.value           : null;
  const birdeyeCreationData = birdeyeCreationResult.status === "fulfilled" ? birdeyeCreationResult.value : null;
  const mintBlockData      = mintBlockResult.status      === "fulfilled" ? mintBlockResult.value      : null;

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

  // Strip LP-related false positives from RugCheck now that lp_burned + lp_model are known.
  const rugcheckAdjusted = rugData
    ? stripLPFalsePositives(rugData, { lp_burned, lp_model })
    : null;

  // ── Liquidity lock status (single-pool view for quick scan) ──────────────
  const primaryPairAddress = dexData?.pairs.slice()
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]?.pairAddress ?? null;
  const liquidity_lock_status: import("./types.js").LiquidityLockStatus = (() => {
    if (lp_model === "CLMM_DLMM") {
      return {
        locked: true, lock_type: "PROGRAM_CONTROLLED" as const, lock_duration_days: null,
        locked_pct: 100, note: "CLMM/DLMM pool — no fungible LP token; liquidity is program-controlled.",
        pools_assessed: primaryPairAddress ? 1 : 0, pools_safe: primaryPairAddress ? 1 : 0,
        pool_safety_breakdown: primaryPairAddress ? [{
          pool_address: primaryPairAddress, dex: dex_id, pool_type: "DLMM_CLMM" as const,
          safety: "PROGRAM_CONTROLLED" as const, safety_note: "CLMM/DLMM — no fungible LP token",
        }] : [],
      };
    }
    if (lp_burned === true) {
      return {
        locked: true, lock_type: "PERMANENT_BURN" as const, lock_duration_days: null,
        locked_pct: 100, note: "LP tokens sent to burn address — liquidity permanently locked.",
        pools_assessed: primaryPairAddress ? 1 : 0, pools_safe: primaryPairAddress ? 1 : 0,
        pool_safety_breakdown: primaryPairAddress ? [{
          pool_address: primaryPairAddress, dex: dex_id, pool_type: "TRADITIONAL_AMM" as const,
          safety: "BURNED" as const, safety_note: "LP tokens confirmed burned",
        }] : [],
      };
    }
    return {
      locked: false, lock_type: "NONE" as const, lock_duration_days: 0,
      locked_pct: 0, note: null,
      pools_assessed: primaryPairAddress ? 1 : 0, pools_safe: 0,
      pool_safety_breakdown: primaryPairAddress ? [{
        pool_address: primaryPairAddress, dex: dex_id, pool_type: "TRADITIONAL_AMM" as const,
        safety: "UNLOCKED" as const, safety_note: "LP not burned",
      }] : [],
    };
  })();

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

  // ── Launch anomaly detection ───────────────────────────────────────────────
  // Birdeye token_creation_info is primary; Helius getSignaturesForAddress is fallback.
  // Birdeye returns accurate data for tokens of any age (including 2022-era tokens like BONK).
  // Helius falls back to oldest signature in 1000-entry page which is unreliable for high-tx tokens.
  const mintBlockTime = birdeyeCreationData?.block_unix_time ?? mintBlockData?.blockTime ?? null;
  const mintSlot      = birdeyeCreationData?.slot            ?? mintBlockData?.slot      ?? null;

  const launch_anomaly = deriveLaunchAnomaly({
    mintBlockTime,
    poolCreatedAtMs: dexData?.pair_created_at_ms ?? null,
    mintSlot,
  });

  const riskFactors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: rugData?.bundled_launch_detected ?? false,
    buy_sell_ratio: dexData?.buy_sell_ratio_1h ?? null,
    token_age_days,
    rugcheck_risk_score: rugcheckAdjusted?.adjusted_score ?? null,
    single_holder_danger: rugData?.single_holder_danger ?? false,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    dev_wallet_age_days: null, // quickScan never fetches this
    launch_pattern: launch_anomaly.launch_pattern,
    rugcheck_lp_stripped: rugcheckAdjusted?.lp_risks_stripped ?? false,
    rugcheck_raw_score: rugData?.score ?? null,
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
    launch_pattern: launch_anomaly.launch_pattern,
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
    launch_anomaly,
    liquidity_lock_status,
    rugcheck_lp_adjusted: rugcheckAdjusted?.lp_risks_stripped ?? false,
    rugcheck_raw_score: rugData?.score ?? null,
    pool_types_detected: [...new Set(
      (dexData?.pairs ?? []).map(pair => classifyLPModel(pair.dexId))
    )] as Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">,
    rugcheck_score_details: rugData ? {
      raw_score: rugData.score,
      adjusted_score: rugcheckAdjusted?.adjusted_score ?? rugData.score,
      lp_false_positive_stripped: rugcheckAdjusted?.lp_risks_stripped ?? false,
      stripped_score_amount: rugData.score - (rugcheckAdjusted?.adjusted_score ?? rugData.score),
      reason: rugcheckAdjusted?.lp_risks_stripped
        ? lp_burned === true
          ? "LP tokens confirmed burned on-chain — RugCheck LP unlock flag is a false positive"
          : "DLMM/CLMM pool confirmed — no LP token exists, RugCheck LP assessment does not apply"
        : null,
    } : null,
  };
}
