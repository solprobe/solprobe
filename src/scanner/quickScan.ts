import { getDexScreenerToken, deriveLPStatus, classifyLPModel, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned, getMintCreationBlock } from "../sources/helius.js";
import { getTokenCreationInfo, getBirdeyeTokenMetadata, getBirdeyeTokenSecurity, getBirdeyeTopHolders, getBirdeyeWalletFirstFunded } from "../sources/birdeye.js";
import {
  calculateRiskGrade,
  calculateConfidence,
  confidenceToString,
  buildHistoricalFlags,
  type RiskFactors,
} from "./riskScorer.js";
import { resolveAuthorityExempt } from "../sources/jupiterTokenList.js";
import { isLPBurnLaunchpad, PROGRAMS, isProtocolAddress } from "../constants.js";
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
  token_address: string;
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
  /** Always "STRUCTURAL_SAFETY" — this service evaluates on-chain token structure only */
  grade_type: "STRUCTURAL_SAFETY";
  /** Scope declaration — clarifies what is and is not covered */
  scope: {
    includes: string[];
    excludes: string[];
  };
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  /** Birdeye-live adjusted top-10 holder concentration (protocol/DEX/burn addresses excluded). Null when holder data unavailable. */
  top_10_holder_pct: number | null;
  /** Structural LP burn and liquidity presence check — does not replace sol_market_intel depth signals */
  liquidity_check: LiquidityCheck;
  lp_burned: boolean | null;
  lp_model: LPModel;
  lp_status: LPStatus;
  dex_id: string | null;
  /** Creator/deployer wallet analysis — derived from Birdeye token_creation_info + wallet first-funded */
  creator_wallet: {
    address: string | null;
    wallet_age_days: number | null;
    /** True when the deployer wallet was funded fewer than 7 days before token creation — strong rug signal */
    is_fresh_deployer: boolean;
  };
  /** True when at least one traditional AMM pool was detected across all pairs */
  traditional_amm_pool_present: boolean;
  /**
   * True when the traditional AMM pool's LP burn status has been assessed.
   * False when the primary pool is CLMM/DLMM — secondary traditional AMM pools are not LP-assessed in this tier.
   */
  traditional_amm_lp_assessed: boolean;
  single_holder_danger: boolean;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  /** Backwards-compat string confidence derived from numeric confidence */
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
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
  /** All LP model types detected across all pools (not just the primary pool) */
  pool_types_detected: Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">;
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
  const [dexResult, rugResult, mintResult, birdeyeCreationResult, mintBlockResult, metadataResult, securityResult, holdersResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenMintInfo(address, { timeout: 3000 }),          // sole source for authority flags
    getTokenCreationInfo(address, { timeout: 3000 }),      // primary for mint creation time
    getMintCreationBlock(address, { timeout: 2000 }),      // fallback for mint creation time
    getBirdeyeTokenMetadata(address, { timeout: 2000 }),   // token identity (symbol/name/logo)
    getBirdeyeTokenSecurity(address, { timeout: 2500 }),   // creator_percentage, total_supply
    getBirdeyeTopHolders(address, 15, { timeout: 2500 }),  // live holder concentration
  ]);

  const dexData            = dexResult.status            === "fulfilled" ? dexResult.value            : null;
  const rugData            = rugResult.status            === "fulfilled" ? rugResult.value            : null;
  const mintData           = mintResult.status           === "fulfilled" ? mintResult.value           : null;
  const birdeyeCreationData = birdeyeCreationResult.status === "fulfilled" ? birdeyeCreationResult.value : null;
  const mintBlockData      = mintBlockResult.status      === "fulfilled" ? mintBlockResult.value      : null;
  const metadataData       = metadataResult.status       === "fulfilled" ? metadataResult.value       : null;
  const securityData       = securityResult.status       === "fulfilled" ? securityResult.value       : null;
  const holdersData        = holdersResult.status        === "fulfilled" ? holdersResult.value        : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason,   address);
  if (mintResult.status === "rejected") logError("helius_rpc",  mintResult.reason,  address);

  // ── Phase 2: LP burn + creator wallet age — parallel, both depend on phase 1 ─
  const lp_model = dexData?.lp_model ?? "UNKNOWN";
  const dex_id   = dexData?.dex_id   ?? null;
  const lpMint   = dexData?.lp_mint_address ?? null;

  // Creator address: Birdeye token_creation_info is primary (field: .data.creator,
  // verified via live curl 2026-04-20). RugCheck .creator is fallback.
  const creatorAddress: string | null =
    (birdeyeCreationData?.creator && birdeyeCreationData.creator.length > 0)
      ? birdeyeCreationData.creator
      : (rugData?.creator ?? null);

  // Infer pump.fun launchpad from dexId for LP burn check (see CLMM comment below).
  // Only exact pump.fun dexIds qualify — "pumpswap" is a separate DEX and must not match.
  const PUMP_FUN_DEX_IDS = new Set(["pumpfun", "pump"]);
  const inferredProgramId = dexData?.pairs.some((p) => {
    const id = p.dexId?.toLowerCase();
    return id !== undefined && PUMP_FUN_DEX_IDS.has(id);
  }) ? PROGRAMS.PUMP_FUN : null;
  const launchedFromLPBurnPad = inferredProgramId ? isLPBurnLaunchpad(inferredProgramId) : false;

  // Run LP burn check and creator wallet age lookup in parallel.
  // CLMM/DLMM pools have no fungible LP mint — LP burn check is skipped for them.
  // getBirdeyeWalletFirstFunded: verified field path json.data[wallet].block_unix_time (2026-04-20).
  const [lpBurnResult, creatorFirstFundedResult] = await Promise.allSettled([
    (lp_model !== "CLMM_DLMM" && !launchedFromLPBurnPad && lpMint)
      ? checkLPBurned(lpMint, { timeout: 2000 })
      : Promise.resolve(null),
    creatorAddress
      ? getBirdeyeWalletFirstFunded(creatorAddress, { timeout: 2000 })
      : Promise.resolve(null),
  ]);

  let lp_burned: boolean | null =
    lp_model === "CLMM_DLMM" ? null :
    launchedFromLPBurnPad     ? true :
    lpBurnResult.status === "fulfilled" ? lpBurnResult.value : null;

  // Creator wallet age derived from Birdeye first-funded block_unix_time.
  const creatorFirstFundedUnix =
    creatorFirstFundedResult.status === "fulfilled" ? creatorFirstFundedResult.value : null;
  const creatorWalletAgeDays = creatorFirstFundedUnix !== null
    ? (Date.now() / 1000 - creatorFirstFundedUnix) / 86400
    : null;

  const lp_status = deriveLPStatus(lp_burned, lp_model);

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

  // ── Holder concentration: live Birdeye data (falls back to RugCheck) ────────
  // Fast address-only exclusion — no getAccountInfo per holder.
  // Exclude known protocol, burn, and DEX program addresses by static check only.
  const HOLDER_EXCLUDE = new Set<string>([
    "1nc1nerator11111111111111111111111111111111",  // burn address
    PROGRAMS.RAYDIUM_AMM_V4,
    PROGRAMS.ORCA_WHIRLPOOL,
    PROGRAMS.TOKEN_PROGRAM,
    PROGRAMS.TOKEN_2022,
    PROGRAMS.PUMP_FUN,
  ]);

  let live_single_holder_danger: boolean | null = null;
  let live_top_10_holder_pct: number | null = null;

  if (holdersData && holdersData.length > 0 && securityData?.total_supply && securityData.total_supply > 0) {
    const totalSupply = securityData.total_supply;
    const filtered = holdersData.filter(h => !HOLDER_EXCLUDE.has(h.owner) && !isProtocolAddress(h.owner));
    const withPct = filtered.map(h => ({ pct: (h.ui_amount / totalSupply) * 100 }));
    const top_holder_pct = withPct.length > 0 ? Math.max(...withPct.map(h => h.pct)) : null;
    const top10sum = withPct.slice(0, 10).reduce((s, h) => s + h.pct, 0);
    live_single_holder_danger = top_holder_pct !== null && top_holder_pct >= 15;
    live_top_10_holder_pct = Math.min(100, top10sum);
  }

  // Birdeye-live only — no RugCheck fallback for holder data
  const top_10_holder_pct = live_top_10_holder_pct !== null ? Math.round(live_top_10_holder_pct * 100) / 100 : null;
  const single_holder_danger_live = live_single_holder_danger ?? false;

  // ── Liquidity ─────────────────────────────────────────────────────────────
  const liquidity_usd = dexData?.liquidity_usd ?? null;

  // ── Rug history (sole RugCheck field retained) ────────────────────────────
  const has_rug_history = rugData?.has_rug_history ?? false;

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
    adjusted_top_10_holder_pct: top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: false, // RugCheck bundler detection removed; no Birdeye bundler in quick scan
    buy_sell_ratio: dexData?.buy_sell_ratio_1h ?? null,
    token_age_days,
    single_holder_danger: single_holder_danger_live,
    creator_supply_pct: securityData?.creator_percentage ?? null,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    dev_wallet_age_days: creatorWalletAgeDays, // Birdeye first-funded for creator wallet
    launch_pattern: launch_anomaly.launch_pattern,
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
    includes: ["mint_authority", "freeze_authority", "holder_distribution", "lp_burn_status", "liquidity_presence"],
    excludes: ["market_liquidity_depth", "volume", "price_action", "market_behavior"],
  };

  // ── Liquidity check (structured heuristic — no raw $ in response) ─────────
  const liquidity_check = deriveLiquidityCheck(liquidity_usd);

  // ── Data quality ──────────────────────────────────────────────────────────
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    sources.length === 3 ? "FULL" : sources.length >= 2 ? "PARTIAL" : "LIMITED";

  const symbol   = metadataData?.symbol   ?? null;
  const name     = metadataData?.name     ?? null;
  const logo_uri = metadataData?.logo_uri ?? null;

  const missing_fields: string[] = [];
  if (dexData  === null) missing_fields.push("liquidity_usd", "dex_id", "lp_model");
  if (rugData  === null) missing_fields.push("has_rug_history");
  if (holdersData === null) missing_fields.push("top_10_holder_pct");
  if (mintData === null) missing_fields.push("mint_authority_revoked", "freeze_authority_revoked");
  if (symbol === null && name === null) missing_fields.push("token_metadata");

  // ── LLM summary — sequential, after all parallel fetches complete ──────────
  const llmInputData: QuickScanData = {
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
    token_address: address,
    symbol,
    name,
    logo_uri,
    grade_type,
    scope,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_check,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    creator_wallet: {
      address: creatorAddress,
      wallet_age_days: creatorWalletAgeDays !== null ? Math.round(creatorWalletAgeDays * 10) / 10 : null,
      is_fresh_deployer: creatorWalletAgeDays !== null && creatorWalletAgeDays < 7,
    },
    single_holder_danger: riskFactors.single_holder_danger,
    risk_grade,
    summary,
    data_confidence,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
    confidence,
    historical_flags,
    data_quality,
    missing_fields,
    launch_anomaly,
    liquidity_lock_status,
    pool_types_detected: [...new Set(
      (dexData?.pairs ?? []).map(pair => classifyLPModel(pair.dexId))
    )] as Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">,
    traditional_amm_pool_present: (dexData?.pairs ?? []).some(p => classifyLPModel(p.dexId) === "TRADITIONAL_AMM"),
    // LP burn is only assessed for the primary (highest-liquidity) pool.
    // When the primary is CLMM/DLMM, secondary traditional AMM pools are detected but not LP-assessed.
    traditional_amm_lp_assessed: lp_model === "TRADITIONAL_AMM",
  };
}
