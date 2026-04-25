import { getDexScreenerToken, deriveLPStatus, classifyLPModel, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned, getWalletAgeDays, detectCircularWashTrading, getAuthorityHistory, getTokenSwapTransactions, getWalletSwapFeePayers, getMintDeployer, checkPoolLiquiditySafety, getWalletIdentity, type PoolLiquiditySafety } from "../sources/helius.js";
import { buildTxGraph, heliusTxsToEdges } from "../analysis/walletGraph.js";
import { detectClusters } from "../analysis/clusterDetection.js";
import { getBirdeyeToken, getBirdeyeTokenSecurity, getBirdeyeHolderList, getBirdeyeTopHolders, getTokenCreationInfo, detectBundledLaunchViaBirdeye, getBirdeyeWalletTxList, BUNDLER_NULL_RESULT, type BundlerDetectionResult } from "../sources/birdeye.js";
import { getSolscanMeta } from "../sources/solscan.js";
import {
  calculateRiskGrade,
  calculateConfidence,
  confidenceToString,
  buildHistoricalFlags,
  type RiskFactors,
} from "./riskScorer.js";
import type {
  ScoringFactor, HistoricalFlag, KeyDriver, AdjustedHolderConcentration, ExclusionCategory,
  FundingSource, LiquidityLockStatus, PoolSafetyBreakdown, WashTradingRisk, TradingPattern,
  AuthorityHistory, MetadataImmutability, LastTrade, VestingRisk,
} from "./types.js";
import { classifyWalletFundingSource } from "../utils/walletClassifier.js";
import { deduplicate, getOrFetch } from "../cache.js";
import { isProtocolAddress, isLPBurnLaunchpad, PROGRAMS, CUSTODIAL_DEX_LP_PLATFORMS, KNOWN_VESTING_PROGRAMS } from "../constants.js";
import { resolveAuthorityExempt } from "../sources/jupiterTokenList.js";
import {
  generateDeepDiveReport,
  fallbackDeepReport,
  type DeepDiveData,
} from "../llm/narrativeEngine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DevWalletAnalysis {
  address: string | null;   // null when deployer genuinely cannot be retrieved
  /** null when the address is a Virtuals Protocol address */
  sol_balance: number | null;
  /** null when the address is a Virtuals Protocol address */
  created_tokens_count: number | null;
  previous_rugs: boolean;
  is_protocol_address?: boolean;
  funding_source: FundingSource | null;
  funding_risk_note: string | null;
}

// LiquidityLockStatus, WashTradingRisk, TradingPattern, AuthorityChange,
// AuthorityHistory, MetadataImmutability — imported from ./types.js

export interface DilutionRisk {
  total_supply: number | null;
  post_launch_mints: number;
  risk: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
}

export interface DeepDiveResult {
  schema_version: "2.0";
  token_address: string;
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  /** Birdeye-live adjusted top-10 holder concentration (protocol/DEX/burn addresses excluded). */
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  lp_burned: boolean | null;
  lp_model: LPModel;
  lp_status: LPStatus;
  /** Human-readable note for CUSTODIAL lp_status; null for all other statuses. */
  lp_status_note: string | null;
  dex_id: string | null;
  single_holder_danger: boolean;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  dev_wallet_analysis: DevWalletAnalysis;
  liquidity_lock_status: LiquidityLockStatus;
  trading_pattern: TradingPattern;
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;
  momentum_score: number;
  momentum_tier: "STRONG" | "MODERATE" | "WEAK" | "DEAD";
  momentum_interpretation: string;
  last_trade: LastTrade;
  full_risk_report: string;
  /** Structured recommendation — never a bare string */
  recommendation: {
    action: "AVOID" | "WATCH" | "CONSIDER" | "DYOR";
    reason: string;
    confidence: number;
    time_horizon: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM";
  };
  /** Adversarial risk categorisation */
  risk_breakdown: {
    contract_risk: "LOW" | "MEDIUM" | "HIGH";
    liquidity_risk: "LOW" | "MEDIUM" | "HIGH";
    market_risk: "LOW" | "MEDIUM" | "HIGH";
    behavioral_risk: "LOW" | "MEDIUM" | "HIGH";
  };
  /** Adversarial wallet layer */
  wallet_analysis: {
    clustered_wallets: number;
    insider_control_percent: number | null;
    dev_wallet_linked: boolean;
    funding_wallet_overlap: number | null;
    funding_source_risk: "LOW" | "MEDIUM" | "HIGH";
  };
  /** Token metadata immutability (deep dive only) */
  metadata_immutability: MetadataImmutability;
  /** Mint authority change history (deep dive only) */
  authority_history: AuthorityHistory;
  /** Post-launch supply dilution risk (deep dive only) */
  dilution_risk: DilutionRisk;
  /** Launch classification */
  launch_pattern: "STEALTH_LAUNCH" | "FAIR_LAUNCH" | "UNKNOWN";
  /** Sniper activity at launch */
  sniper_activity: "LOW" | "MEDIUM" | "HIGH";
  /** Top contributing factors in agent-friendly shape */
  key_drivers: KeyDriver[];
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
  /** Data quality */
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  /** Fields that could not be populated */
  missing_fields: string[];
  /** Holder concentration after excluding burn/DEX/protocol addresses */
  adjusted_holder_concentration: AdjustedHolderConcentration;
  /** All LP model types detected across all pools (not just the primary pool) */
  pool_types_detected: Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">;
  /** Structured bundled-launch detection result from Birdeye launch-window analysis */
  bundler_analysis: BundlerDetectionResult;
  /** Vested token dump risk — null when check was skipped (e.g. no top holder >= 5%) */
  vesting_risk: VestingRisk | null;
}

// ---------------------------------------------------------------------------
// Helpers — lightweight RPC calls for dev wallet analysis
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

async function rpcCall(method: string, params: unknown[], timeoutMs: number): Promise<any> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    if (json?.error) return null;
    return json?.result ?? null;
  } catch {
    return null;
  }
}

/** Extract mint authority pubkey using jsonParsed encoding. */
async function getMintAuthorityAddress(mintAddress: string, timeoutMs: number): Promise<string | null> {
  const result = await rpcCall("getAccountInfo", [mintAddress, { encoding: "jsonParsed" }], timeoutMs);
  const info = result?.value?.data?.parsed?.info;
  return info?.mintAuthority ?? null;
}

/** Get SOL balance in SOL (not lamports). */
async function getSolBalance(address: string, timeoutMs: number): Promise<number | null> {
  const result = await rpcCall("getBalance", [address], timeoutMs);
  return typeof result?.value === "number" ? result.value / 1e9 : null;
}

// ---------------------------------------------------------------------------
// Multi-pool liquidity lock aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-pool safety results into a single LiquidityLockStatus.
 * Called after all pool checks have settled.
 */
function deriveOverallLockType(
  pools: PoolLiquiditySafety[],
  dexId: string | null
): LiquidityLockStatus {
  if (pools.length === 0) {
    return {
      locked: false, lock_type: "UNKNOWN", lock_duration_days: null,
      locked_pct: 0, note: "No pool data available.",
      pools_assessed: 0, pools_safe: 0, pool_safety_breakdown: [],
    };
  }

  const breakdown: PoolSafetyBreakdown[] = pools.map((p) => ({
    pool_address: p.pool_address,
    dex: dexId,
    pool_type: p.pool_type,
    safety: p.safety,
    safety_note: p.safety_note,
  }));

  const safePools = pools.filter(
    (p) => p.safety === "BURNED" || p.safety === "PROGRAM_CONTROLLED"
  );
  const unsafePools = pools.filter(
    (p) => p.safety === "UNLOCKED"
  );

  const allSafe    = safePools.length === pools.length;
  const noneSafe   = safePools.length === 0;
  const allBurned  = pools.every((p) => p.safety === "BURNED");
  const allProgCtl = pools.every((p) => p.safety === "PROGRAM_CONTROLLED");

  let lock_type: LiquidityLockStatus["lock_type"];
  let locked: boolean;
  let note: string | null;

  if (allBurned) {
    lock_type = "PERMANENT_BURN";
    locked = true;
    note = `All ${pools.length} pool(s) have LP tokens burned — liquidity permanently locked.`;
  } else if (allProgCtl) {
    lock_type = "PROGRAM_CONTROLLED";
    locked = true;
    note = `All ${pools.length} pool(s) are CLMM/DLMM — no fungible LP token; liquidity is program-controlled.`;
  } else if (allSafe && !allBurned && !allProgCtl) {
    // Mix of burned + program-controlled — all safe
    lock_type = "PERMANENT_BURN";
    locked = true;
    note = `All ${pools.length} pool(s) are safe (burned or program-controlled).`;
  } else if (noneSafe && unsafePools.length > 0) {
    lock_type = "UNLOCKED";
    locked = false;
    note = `${unsafePools.length} of ${pools.length} pool(s) have unlocked LP — rug risk.`;
  } else if (!allSafe && !noneSafe) {
    lock_type = "MIXED";
    locked = false;
    note = `${safePools.length} of ${pools.length} pool(s) are safe; ${unsafePools.length} pool(s) have unlocked LP.`;
  } else {
    lock_type = "UNKNOWN";
    locked = false;
    note = "LP lock status could not be fully determined.";
  }

  return {
    locked,
    lock_type,
    lock_duration_days: locked ? null : 0,
    locked_pct: locked ? 100 : 0,
    note,
    pools_assessed: pools.length,
    pools_safe: safePools.length,
    pool_safety_breakdown: breakdown,
  };
}

// ---------------------------------------------------------------------------
// Derived signal helpers
// ---------------------------------------------------------------------------

/**
 * Multi-timeframe momentum score (0–100).
 * Weights: 5m=0.25, 30m=0.30, 1h=0.25, 8h=0.12, 24h=0.08
 * Normalization: ±20% maps to ±1.0, scaled to ±60 pts max.
 * A recency factor [0.0–1.0] multiplies (score − 50); returns 0 immediately at 0.0.
 */
function calculateMomentumScore(data: {
  price_change_5m_pct:  number | null;
  price_change_30m_pct: number | null;
  price_change_1h_pct:  number | null;
  price_change_8h_pct:  number | null;
  price_change_24h_pct: number | null;
  volume_1h_usd:        number | null;
  volume_24h_usd:       number | null;
  buy_sell_ratio_1h:    number | null;
  hours_since_last_trade: number | null;
}): number {
  // Recency factor: collapse everything to 0 when token is dormant/dead
  const hrs = data.hours_since_last_trade;
  const recency_factor =
    hrs === null ? 1.0
    : hrs < 6    ? 1.0
    : hrs < 24   ? 0.85
    : hrs < 168  ? 0.5    // 7 days
    : hrs < 720  ? 0.15   // 30 days
    : 0.0;                // dead

  if (recency_factor === 0.0) return 0;

  // Weighted price component: ±20% → ±1.0, scaled to ±60 pts
  const normalize = (pct: number | null) => pct === null ? null : Math.max(-1, Math.min(1, pct / 20));
  const w5m  = 0.25, w30m = 0.30, w1h  = 0.25, w8h  = 0.12, w24h = 0.08;

  const n5m  = normalize(data.price_change_5m_pct);
  const n30m = normalize(data.price_change_30m_pct);
  const n1h  = normalize(data.price_change_1h_pct);
  const n8h  = normalize(data.price_change_8h_pct);
  const n24h = normalize(data.price_change_24h_pct);

  // Only average over timeframes that have data
  let weightSum = 0;
  let weightedPriceSum = 0;
  if (n5m  !== null) { weightedPriceSum += n5m  * w5m;  weightSum += w5m;  }
  if (n30m !== null) { weightedPriceSum += n30m * w30m; weightSum += w30m; }
  if (n1h  !== null) { weightedPriceSum += n1h  * w1h;  weightSum += w1h;  }
  if (n8h  !== null) { weightedPriceSum += n8h  * w8h;  weightSum += w8h;  }
  if (n24h !== null) { weightedPriceSum += n24h * w24h; weightSum += w24h; }

  const price_component = weightSum > 0 ? (weightedPriceSum / weightSum) * 60 : 0;

  // Volume confirmation: ±15 pts (1h vs 24h hourly average)
  let vol_component = 0;
  if (data.volume_1h_usd !== null && data.volume_24h_usd !== null && data.volume_24h_usd > 0) {
    const hourly_avg = data.volume_24h_usd / 24;
    const ratio = data.volume_1h_usd / hourly_avg;
    vol_component = ratio >= 3 ? 15 : ratio >= 1.5 ? 8 : ratio >= 0.5 ? 0 : -8;
  }

  // Buy pressure: ±15 pts
  const bsr = data.buy_sell_ratio_1h ?? 0.5;
  const buy_component = bsr > 0.7  ?  15
                      : bsr > 0.55 ?   7
                      : bsr > 0.45 ?   0
                      : bsr > 0.3  ?  -7
                      : -15;

  const raw = 50 + price_component + vol_component + buy_component;
  const clamped = Math.max(0, Math.min(100, raw));

  // Apply recency: compress toward 50 for stale/dormant, then clamp
  const with_recency = 50 + (clamped - 50) * recency_factor;
  return Math.max(0, Math.min(100, Math.round(with_recency)));
}

/** Adversarial freshness signal — when did the token last trade? */
function deriveLastTrade(last_trade_unix_time: number | null): import("./types.js").LastTrade {
  if (last_trade_unix_time === null) {
    return {
      timestamp: null,
      hours_ago: null,
      recency: "UNKNOWN",
      recency_note: "Last trade timestamp unavailable.",
    };
  }
  const hours_ago = (Date.now() / 1000 - last_trade_unix_time) / 3600;
  const recency =
    hours_ago < 6    ? "ACTIVE"
    : hours_ago < 24   ? "RECENT"
    : hours_ago < 168  ? "STALE"
    : hours_ago < 720  ? "DORMANT"
    : "DEAD";
  const recency_note =
    recency === "ACTIVE"  ? `Last trade ${hours_ago.toFixed(1)}h ago — token is actively trading.`
    : recency === "RECENT"  ? `Last trade ${hours_ago.toFixed(0)}h ago — recent activity within 24h.`
    : recency === "STALE"   ? `Last trade ${(hours_ago / 24).toFixed(1)}d ago — limited recent activity.`
    : recency === "DORMANT" ? `Last trade ${(hours_ago / 24).toFixed(0)}d ago — token appears dormant.`
    : `Last trade ${(hours_ago / 24).toFixed(0)}d ago — token appears dead.`;
  return {
    timestamp: last_trade_unix_time,
    hours_ago: Math.round(hours_ago * 10) / 10,
    recency,
    recency_note,
  };
}

/**
 * Wash trading heuristic: very balanced buys/sells + high volume relative to
 * liquidity = suspicious recycling pattern. Score 0–100.
 */
function deriveWashTradingScore(
  buy_sell_ratio: number | null,
  volume_24h: number | null,
  liquidity_usd: number | null
): number {
  let score = 0;

  // Ratio suspiciously balanced (0.45–0.55 = near-perfect balance)
  if (buy_sell_ratio != null) {
    const balance = 1 - 2 * Math.abs(buy_sell_ratio - 0.5);
    score += balance * 30; // up to 30 pts for perfect balance
  }

  // High volume / liquidity ratio
  if (volume_24h != null && liquidity_usd != null && liquidity_usd > 0) {
    const vl = volume_24h / liquidity_usd;
    if (vl > 10) score += 40;
    else if (vl > 5) score += 25;
    else if (vl > 2) score += 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

const WASH_TRADING_MEANING: Record<WashTradingRisk, string> = {
  NONE:     "No wash trading signals detected.",
  LOW:      "Minor wash trading indicators; likely noise or thin liquidity.",
  ELEVATED: "Moderate wash trading signals; buy/sell ratio or volume patterns suggest artificial activity.",
  HIGH:     "Strong wash trading signals; significant circular or self-trading patterns detected.",
  EXTREME:  "Severe wash trading detected; volume is likely fabricated and not indicative of real demand.",
};

const WASH_TRADING_ACTION_GUIDANCE: Record<WashTradingRisk, string> = {
  NONE:     "No action required for wash trading risk.",
  LOW:      "Monitor volume; thin liquidity can create false signals.",
  ELEVATED: "Discount volume figures by 30–50%; verify with independent sources before acting on volume signals.",
  HIGH:     "Do not rely on volume or buy pressure signals; wash trading likely inflates apparent demand.",
  EXTREME:  "Treat all volume and buy pressure data as unreliable; avoid large positions.",
};

const METADATA_RISK_MEANING: Record<"MUTABLE" | "IMMUTABLE" | "UNKNOWN", string> = {
  MUTABLE:   "Token metadata can be changed by the update authority — name, symbol, or URI could be altered post-launch.",
  IMMUTABLE: "Token metadata is permanently locked — name, symbol, and URI cannot be changed.",
  UNKNOWN:   "Metadata mutability status could not be determined from available sources.",
};

const METADATA_RISK_ACTION: Record<"MUTABLE" | "IMMUTABLE" | "UNKNOWN", string> = {
  MUTABLE:   "Verify the update authority is a trusted party or revoked before taking a position.",
  IMMUTABLE: "No metadata risk — proceed based on other signals.",
  UNKNOWN:   "Treat as mutable until confirmed — check Metaplex metadata on-chain.",
};

function deriveWashTradingRisk(score: number): WashTradingRisk {
  if (score === 0)  return "NONE";
  if (score <= 20)  return "LOW";
  if (score <= 45)  return "ELEVATED";
  if (score <= 70)  return "HIGH";
  return "EXTREME";
}

/**
 * Derive recommendation — never undefined, defaults to DYOR on low confidence.
 */
function buildRecommendation(data: {
  risk_grade: string;
  risk_breakdown: { contract_risk: string; liquidity_risk: string; market_risk: string; behavioral_risk: string };
  historical_flags: HistoricalFlag[];
  confidence_model: number;
  last_trade_recency: "ACTIVE" | "RECENT" | "STALE" | "DORMANT" | "DEAD" | "UNKNOWN";
}): { action: "AVOID" | "WATCH" | "CONSIDER" | "DYOR"; reason: string; confidence: number; time_horizon: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM" } {
  const highRisks = Object.entries(data.risk_breakdown)
    .filter(([, v]) => v === "HIGH")
    .map(([k]) => k.replace("_risk", "").toUpperCase());

  const inactive = data.last_trade_recency === "DEAD" || data.last_trade_recency === "DORMANT";

  if (data.risk_grade === "F" || highRisks.length >= 3) {
    return { action: "AVOID", reason: highRisks.join(" + ") || "CRITICAL_GRADE", confidence: 0.9, time_horizon: "SHORT_TERM" };
  }
  if (data.historical_flags.includes("PAST_RUG") || data.historical_flags.includes("DEV_ASSOCIATED_WITH_PREVIOUS_RUG")) {
    return { action: "AVOID", reason: "CONFIRMED_RUG_HISTORY", confidence: 0.95, time_horizon: "SHORT_TERM" };
  }
  if (data.risk_grade === "D" || highRisks.length >= 1) {
    const action = inactive ? "AVOID" : "WATCH";
    return { action, reason: inactive ? "INACTIVE_TOKEN" : (highRisks.join(" + ") || "ELEVATED_RISK"), confidence: data.confidence_model, time_horizon: "SHORT_TERM" };
  }
  if (data.risk_grade === "A" || data.risk_grade === "B") {
    const action = inactive ? "WATCH" : "CONSIDER";
    return { action, reason: inactive ? "INACTIVE_TOKEN" : "ACCEPTABLE_STRUCTURAL_RISK", confidence: data.confidence_model, time_horizon: inactive ? "SHORT_TERM" : "MEDIUM_TERM" };
  }
  // DYOR / C grade
  if (inactive) {
    return { action: "AVOID", reason: "INACTIVE_TOKEN", confidence: data.confidence_model, time_horizon: "SHORT_TERM" };
  }
  return { action: "DYOR", reason: "INCONCLUSIVE_SIGNALS", confidence: Math.min(data.confidence_model, 0.5), time_horizon: "SHORT_TERM" };
}

function buildKeyDrivers(
  factors: ScoringFactor[],
  marketData?: {
    price_change_24h_pct: number | null;
    volume_24h: number | null;
    liquidity_usd: number | null;
    adjusted_top_10_pct: number | null;
  },
): KeyDriver[] {
  // Synthesise positive market signal factors so clean tokens surface real drivers
  const synthetic: ScoringFactor[] = [];
  if (marketData) {
    const { price_change_24h_pct, volume_24h, liquidity_usd, adjusted_top_10_pct } = marketData;

    if (price_change_24h_pct !== null) {
      const abs = Math.abs(price_change_24h_pct);
      if (abs >= 20) synthetic.push({ name: "price_change_24h", value: price_change_24h_pct, impact: price_change_24h_pct > 0 ? 25 : -25, interpretation: `24h price change ${price_change_24h_pct > 0 ? "+" : ""}${price_change_24h_pct.toFixed(1)}%` });
      else if (abs >= 5) synthetic.push({ name: "price_change_24h", value: price_change_24h_pct, impact: price_change_24h_pct > 0 ? 12 : -12, interpretation: `24h price change ${price_change_24h_pct > 0 ? "+" : ""}${price_change_24h_pct.toFixed(1)}%` });
    }

    if (volume_24h !== null && liquidity_usd !== null && liquidity_usd > 0) {
      const ratio = volume_24h / liquidity_usd;
      if (ratio >= 5)       synthetic.push({ name: "volume_to_liquidity_ratio", value: ratio, impact: 25, interpretation: `High volume/liquidity ratio ${ratio.toFixed(1)}x — strong activity` });
      else if (ratio >= 1)  synthetic.push({ name: "volume_to_liquidity_ratio", value: ratio, impact: 12, interpretation: `Moderate volume/liquidity ratio ${ratio.toFixed(1)}x` });
    }

    if (adjusted_top_10_pct !== null) {
      if (adjusted_top_10_pct < 30)       synthetic.push({ name: "adjusted_holder_concentration", value: adjusted_top_10_pct, impact: 20, interpretation: `Top-10 hold ${adjusted_top_10_pct.toFixed(1)}% — well distributed` });
      else if (adjusted_top_10_pct < 50)  synthetic.push({ name: "adjusted_holder_concentration", value: adjusted_top_10_pct, impact: 10, interpretation: `Top-10 hold ${adjusted_top_10_pct.toFixed(1)}% — moderate concentration` });
    }
  }

  const combined = [...factors, ...synthetic];
  return combined
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5)
    .map(f => ({
      factor: f.name,
      impact: Math.abs(f.impact) >= 20 ? "HIGH" as const : Math.abs(f.impact) >= 10 ? "MEDIUM" as const : "LOW" as const,
      direction: f.impact < 0 ? "NEGATIVE" as const : f.impact > 0 ? "POSITIVE" as const : "NEUTRAL" as const,
    }));
}

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
}

// Known DEX program owners — if a wallet's owner program or a token account's
// owner program is in this set, the holder is a DEX pool vault, not an insider.
const DEX_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM V4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "LBUZKhRxPF3XUpBCjp4YzTKgLLjLsrHnHDEhGSoeVJu",  // Meteora DLMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // Pump.fun AMM
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",   // PumpSwap (Pump.fun v2)
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca AMM v1
]);

// Known burn/black-hole addresses — any holder matching these is excluded as BURN.
const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",   // native SOL mint (placeholder burns)
]);

// Known CEX hot-wallet addresses — any holder matching these is excluded as CEX.
// Extend as new addresses are confirmed.
const KNOWN_CEX_ADDRESSES = new Set([
  "5tzFkiKscXHK5ZXCGbXZxdw7gSLEW1sZXJKFHe2YNs",  // Binance hot wallet (confirmed)
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", // Coinbase Prime (confirmed)
]);

/**
 * Classify a token account holder as BURN, CEX, DEX_POOL, or INSIDER.
 *
 * Two-level check:
 * 1. Token account's raw program owner — new AMMs (e.g. PumpSwap) may own their vault
 *    accounts directly with the AMM program rather than using SPL ATA ownership.
 * 2. Wallet address's program owner — for standard Raydium/Orca pools the vault
 *    account is an SPL ATA whose *authority* (owner field) is a PDA; that PDA's
 *    program owner will be the DEX program.
 */
async function classifyHolderAddress(
  ownerAddress: string,
  tokenAccountAddress: string,
  timeoutMs: number,
): Promise<ExclusionCategory> {
  // Fast-path: static sets require no RPC
  if (BURN_ADDRESSES.has(ownerAddress)) return "BURN";
  if (KNOWN_CEX_ADDRESSES.has(ownerAddress)) return "CEX";
  if (isProtocolAddress(ownerAddress)) return "CEX";

  // Helius identity lookup — dynamically identifies exchange and protocol wallets.
  // Runs before expensive RPC calls; timeout kept short (1000ms) to stay within budget.
  const identity = await getWalletIdentity(ownerAddress, { timeout: 1000 });
  if (identity?.type === "exchange" || identity?.type === "protocol") return "CEX";

  // Level 1: check the token account's raw program owner.
  // For AMMs that own vault accounts directly (PumpSwap, some Meteora variants),
  // getAccountInfo(tokenAccountAddress).owner === DEX program ID.
  const tokenAcctInfo = await rpcCall("getAccountInfo", [tokenAccountAddress, { encoding: "base58" }], timeoutMs);
  // null value = RPC failure or account not found — cannot confirm it's a burn address, keep as insider
  if (tokenAcctInfo?.value === null || tokenAcctInfo?.value === undefined) return "INSIDER";
  const tokenAcctOwner: string | undefined = tokenAcctInfo?.value?.owner;
  if (tokenAcctOwner && DEX_PROGRAMS.has(tokenAcctOwner)) return "DEX_POOL";

  // Level 2: check the wallet/authority address itself.
  // For Raydium AMM V4, Orca, etc. the vault ATA is owned by the Token Program,
  // but its authority is a PDA whose program owner is the DEX program.
  const ownerInfo = await rpcCall("getAccountInfo", [ownerAddress, { encoding: "base58" }], timeoutMs);
  // null value = wallet has no on-chain state (zero SOL, never transacted) — still a real wallet, not burn
  if (ownerInfo?.value === null || ownerInfo?.value === undefined) return "INSIDER";
  const ownerProgram: string | undefined = ownerInfo?.value?.owner;
  if (!ownerProgram) return "INSIDER";

  // Executable programs that hold tokens are pools/protocols, not wallets
  if (ownerInfo?.value?.executable === true) return "DEX_POOL";
  // PDA owned by a DEX program — pool vault authority
  if (DEX_PROGRAMS.has(ownerProgram)) return "DEX_POOL";

  return "INSIDER";
}

async function computeAdjustedConcentration(
  holders: Array<{ owner: string; token_account: string; ui_amount: number }>,
  totalSupply: number | null
): Promise<AdjustedHolderConcentration> {
  if (totalSupply === null || totalSupply === 0 || holders.length === 0) {
    return { adjusted_top_10_pct: null, excluded_count: 0, excluded_pct: 0, exclusions: [], method: "UNAVAILABLE" };
  }

  // Classify all holders in parallel (1500ms each, 6000ms total budget)
  const classifications = await Promise.allSettled(
    holders.map(h => classifyHolderAddress(h.owner, h.token_account, 1500))
  );

  const exclusions: AdjustedHolderConcentration["exclusions"] = [];
  let excludedPct = 0;
  let adjustedPct = 0;
  let insiderCount = 0;

  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const settled = classifications[i];
    const category: ExclusionCategory = settled.status === "fulfilled" ? settled.value : "INSIDER";
    const pct = (h.ui_amount / totalSupply) * 100;

    if (category !== "INSIDER") {
      exclusions.push({ address: h.owner, category, pct });
      excludedPct += pct;
    } else {
      insiderCount++;
      if (insiderCount <= 10) adjustedPct += pct;
    }
  }

  return {
    adjusted_top_10_pct: adjustedPct,
    excluded_count: exclusions.length,
    excluded_pct: excludedPct,
    exclusions,
    method: "BIRDEYE_SUPPLY",
  };
}

// ---------------------------------------------------------------------------
// Vesting risk check — detects if the top real holder received tokens from a
// known vesting program and has since transferred them out.
// Only runs when the top holder holds >= 5% of supply. Budget: ~1s.
// ---------------------------------------------------------------------------

async function checkVestingRisk(
  tokenMint: string,
  topHoldersData: Array<{ owner: string; ui_amount: number }> | null,
  totalSupplyValue: number | null,
  knownPoolAddresses: Set<string>,
  options: { timeout?: number } = {}
): Promise<VestingRisk> {
  const SKIPPED: VestingRisk = {
    checked: false,
    holder_address: null,
    holder_supply_pct: null,
    vesting_platform: null,
    inflow_token_amount: null,
    inflow_pct_of_supply: null,
    outflow_detected: false,
    outflow_token_amount: null,
    risk: "UNKNOWN",
    risk_reason: "check skipped — no qualifying top holder",
  };

  if (!topHoldersData || topHoldersData.length === 0 || !totalSupplyValue) return SKIPPED;

  // Find the top real holder with >= 5% supply
  const topHolder = topHoldersData
    .filter(h => !isProtocolAddress(h.owner) && !knownPoolAddresses.has(h.owner))
    .map(h => ({ ...h, supply_pct: (h.ui_amount / totalSupplyValue) * 100 }))
    .find(h => h.supply_pct >= 5);

  if (!topHolder) {
    return { ...SKIPPED, risk_reason: "check skipped — no holder with >= 5% supply" };
  }

  const txTimeout = options.timeout ?? 3000;

  const txList = await getBirdeyeWalletTxList(topHolder.owner, { timeout: txTimeout, limit: 100 });
  if (!txList) {
    return {
      checked: true,
      holder_address: topHolder.owner,
      holder_supply_pct: topHolder.supply_pct,
      vesting_platform: null,
      inflow_token_amount: null,
      inflow_pct_of_supply: null,
      outflow_detected: false,
      outflow_token_amount: null,
      risk: "UNKNOWN",
      risk_reason: "tx history unavailable",
    };
  }

  // Inflows: TRANSFER where this holder received the target token
  const inflows = txList.flatMap(tx =>
    tx.token_transfers.filter(
      t => t.mint === tokenMint && t.to_user_account === topHolder.owner
    ).map(t => ({ ...t, tx_hash: tx.tx_hash }))
  );

  // Outflows: TRANSFER where this holder sent the target token to a non-DEX non-protocol address
  const outflows = txList.flatMap(tx =>
    tx.token_transfers.filter(
      t => t.mint === tokenMint &&
        t.from_user_account === topHolder.owner &&
        !knownPoolAddresses.has(t.to_user_account) &&
        !isProtocolAddress(t.to_user_account)
    )
  );

  if (inflows.length === 0) {
    return {
      checked: true,
      holder_address: topHolder.owner,
      holder_supply_pct: topHolder.supply_pct,
      vesting_platform: null,
      inflow_token_amount: null,
      inflow_pct_of_supply: null,
      outflow_detected: outflows.length > 0,
      outflow_token_amount: outflows.length > 0
        ? outflows.reduce((s, t) => s + t.token_amount, 0) : null,
      risk: "LOW",
      risk_reason: "no vesting inflows detected",
    };
  }

  // Check if any inflow sender is owned by a known vesting program.
  // Also check inflow tx program IDs for completed escrows whose accounts
  // have been closed (Streamflow closes the escrow ATA after full withdrawal).
  const uniqueSenders = [...new Set(inflows.map(t => t.from_user_account))].slice(0, 5);

  // Map sender → tx_hashes for the closed-account fallback
  const senderTxHashes = new Map<string, string[]>();
  for (const inflow of inflows) {
    if (!inflow.tx_hash) continue;
    const existing = senderTxHashes.get(inflow.from_user_account) ?? [];
    if (!existing.includes(inflow.tx_hash)) existing.push(inflow.tx_hash);
    senderTxHashes.set(inflow.from_user_account, existing);
  }

  let vesting_platform: string | null = null;
  let totalInflow = 0;

  const heliusApiKey = process.env.HELIUS_API_KEY;

  for (const sender of uniqueSenders) {
    try {
      const accountInfo = await rpcCall("getAccountInfo", [sender, { encoding: "base64" }], 1500);
      const ownerProgram: string | null = accountInfo?.value?.owner ?? null;
      if (ownerProgram && KNOWN_VESTING_PROGRAMS.has(ownerProgram)) {
        vesting_platform = KNOWN_VESTING_PROGRAMS.get(ownerProgram)!;
        totalInflow += inflows
          .filter(t => t.from_user_account === sender)
          .reduce((s, t) => s + t.token_amount, 0);
        break;
      }

      // Fallback: account is closed — inspect the inflow transaction program IDs.
      // Vesting escrow PDAs (Streamflow, Valhalla, Unloc) are closed after
      // full withdrawal, making getAccountInfo return null.
      // Use Helius RPC getTransaction (separate rate limit from Enhanced API).
      if (accountInfo?.value == null && heliusApiKey) {
        const txHashes = (senderTxHashes.get(sender) ?? []).slice(0, 2);
        for (const txHash of txHashes) {
          try {
            const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
            const txRes = await fetch(rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTransaction",
                params: [txHash, { encoding: "json", maxSupportedTransactionVersion: 0 }],
              }),
              signal: AbortSignal.timeout(2000),
            }).catch(() => null);
            if (!txRes?.ok) continue;
            const rpcJson = await txRes.json().catch(() => null) as {
              result?: {
                transaction?: {
                  message?: {
                    accountKeys?: string[];
                    instructions?: Array<{ programIdIndex?: number }>;
                  };
                };
              };
            } | null;
            const message = rpcJson?.result?.transaction?.message;
            if (!message) continue;
            const accountKeys: string[] = message.accountKeys ?? [];
            const instructions = message.instructions ?? [];
            const programIds = instructions
              .map(ix => accountKeys[ix.programIdIndex ?? -1])
              .filter((id): id is string => !!id);
            const matchedPid = programIds.find(pid => KNOWN_VESTING_PROGRAMS.has(pid));
            if (matchedPid) {
              vesting_platform = KNOWN_VESTING_PROGRAMS.get(matchedPid)!;
              totalInflow += inflows
                .filter(t => t.from_user_account === sender)
                .reduce((s, t) => s + t.token_amount, 0);
              break;
            }
          } catch {
            // skip this tx
          }
          if (vesting_platform) break;
        }
      }
    } catch {
      // RPC failure — skip this sender
    }
    if (vesting_platform) break;
  }

  if (!vesting_platform) {
    return {
      checked: true,
      holder_address: topHolder.owner,
      holder_supply_pct: topHolder.supply_pct,
      vesting_platform: null,
      inflow_token_amount: null,
      inflow_pct_of_supply: null,
      outflow_detected: outflows.length > 0,
      outflow_token_amount: outflows.length > 0
        ? outflows.reduce((s, t) => s + t.token_amount, 0) : null,
      risk: "LOW",
      risk_reason: "transfer inflows detected but no vesting program identified",
    };
  }

  const outflow_total = outflows.reduce((s, t) => s + t.token_amount, 0);
  const inflow_pct_of_supply = totalInflow > 0
    ? (totalInflow / totalSupplyValue) * 100 : null;
  const outflow_detected = outflows.length > 0;
  const risk: "LOW" | "MEDIUM" | "HIGH" = outflow_detected ? "HIGH" : "MEDIUM";
  const risk_reason = outflow_detected
    ? `${vesting_platform} vesting unlock received; tokens transferred out — possible coordinated dump`
    : `${vesting_platform} vesting unlock received; no outflow detected yet`;

  return {
    checked: true,
    holder_address: topHolder.owner,
    holder_supply_pct: topHolder.supply_pct,
    vesting_platform,
    inflow_token_amount: totalInflow > 0 ? totalInflow : null,
    inflow_pct_of_supply,
    outflow_detected,
    outflow_token_amount: outflow_detected ? outflow_total : null,
    risk,
    risk_reason,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function deepDive(address: string): Promise<DeepDiveResult> {
  const cacheKey = `sol_deep_dive:${address}`;
  return deduplicate(cacheKey, () => getOrFetch(cacheKey, () => _fetchDeepDive(address)));
}

async function _fetchDeepDive(address: string): Promise<DeepDiveResult> {
  const fetchStart = Date.now();

  // All sources run in parallel. getTokenMintInfo is NOT sequential.
  const [dexResult, rugResult, mintResult, birdResult, scanResult, mintAuthResult,
         securityResult, holderListResult, washTradingResult, authHistoryResult,
         topHoldersResult, tokenSupplyResult, swapTxsResult, mintDeployerResult,
         creationInfoResult, bundlerResult] =
    await Promise.allSettled([
      getDexScreenerToken(address, { timeout: 4000 }),
      getRugCheckSummary(address, { timeout: 5000 }),
      getTokenMintInfo(address, { timeout: 3000 }),  // sole source for authority flags
      getBirdeyeToken(address, { timeout: 4000 }),
      getSolscanMeta(address, { timeout: 4000 }),
      getMintAuthorityAddress(address, 4000),
      getBirdeyeTokenSecurity(address, { timeout: 4000 }),
      getBirdeyeHolderList(address, 20, { timeout: 4000 }),
      detectCircularWashTrading(address, { timeout: 5000 }),
      getAuthorityHistory(address, { timeout: 5000 }),
      getBirdeyeTopHolders(address, 20, { timeout: 6000 }),
      rpcCall("getTokenSupply", [address], 3000),
      getTokenSwapTransactions(address, { timeout: 5000, limit: 100, order: "asc" }),
      getMintDeployer(address, { timeout: 3000 }),   // DAS getAsset — deployer fallback for pump.fun
      getTokenCreationInfo(address, { timeout: 3000 }), // Birdeye — primary source for creator wallet
      detectBundledLaunchViaBirdeye(address, 0, { timeout: 4000 }), // bundler detection; 0 = anchor on first trade
    ]);

  const dexData       = dexResult.status         === "fulfilled" ? dexResult.value         : null;
  const rugData       = rugResult.status         === "fulfilled" ? rugResult.value         : null;
  const mintData      = mintResult.status        === "fulfilled" ? mintResult.value        : null;
  const birdData      = birdResult.status        === "fulfilled" ? birdResult.value        : null;
  const mintAuthAddress = mintAuthResult.status  === "fulfilled" ? mintAuthResult.value    : null;
  const mintDeployerAddress = mintDeployerResult.status === "fulfilled" ? mintDeployerResult.value : null;
  const creationInfo  = creationInfoResult.status === "fulfilled" ? creationInfoResult.value : null;
  const bundlerData   = bundlerResult.status === "fulfilled" ? bundlerResult.value : BUNDLER_NULL_RESULT;
  const securityData  = securityResult.status    === "fulfilled" ? securityResult.value    : null;
  const holderListData = holderListResult.status === "fulfilled" ? holderListResult.value  : null;
  const washTradingData = washTradingResult.status === "fulfilled" ? washTradingResult.value : null;
  const authHistoryData = authHistoryResult.status === "fulfilled" ? authHistoryResult.value : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason,   address);
  if (mintResult.status === "rejected") logError("helius_rpc",  mintResult.reason,  address);
  if (birdResult.status === "rejected") logError("birdeye",     birdResult.reason,  address);
  if (scanResult.status === "rejected") logError("solscan",     scanResult.reason,  address);

  // ── Phase 2: LP burn check + dev wallet age ──────────────────────────────
  // Both depend on phase 1 results; run in parallel to minimise latency.
  const lp_model = dexData?.lp_model ?? "UNKNOWN";
  const dex_id   = dexData?.dex_id   ?? null;
  const lpMint   = dexData?.lp_mint_address ?? null;

  // Detect pump.fun launch via Helius transaction source field.
  // swapTxsData (fetched in Phase 1, order=asc) contains Helius parsed transactions
  // where the `source` field identifies the originating protocol (e.g. "PUMP_FUN").
  // This replaces the deprecated DexScreener dexId heuristic.
  // Secondary signal: DAS update authority matching the pump.fun program address.
  const swapTxsPhase1 = swapTxsResult.status === "fulfilled" ? swapTxsResult.value : null;
  const heliusPumpFun = Array.isArray(swapTxsPhase1)
    && swapTxsPhase1.some((tx: any) => tx?.source === "PUMP_FUN");
  const dasPumpFun = mintDeployerAddress === PROGRAMS.PUMP_FUN;
  const isPumpFunFromHelius = heliusPumpFun || dasPumpFun;
  const inferredProgramId = isPumpFunFromHelius ? PROGRAMS.PUMP_FUN : null;
  const launchedFromLPBurnPad = isPumpFunFromHelius
    ? isLPBurnLaunchpad(PROGRAMS.PUMP_FUN)
    : false;

  // Priority for dev wallet address:
  //   1. Birdeye token_creation_info.creator — always the original deployer, works for
  //      both standard and pump.fun tokens (no authority-burned edge case).
  //   2. mintAuthAddress — live on-chain mint authority; fallback when Birdeye is down.
  //   3. mintDeployerAddress (DAS) — pump.fun fallback when both above are unavailable.
  const isPumpFunToken = inferredProgramId === PROGRAMS.PUMP_FUN;
  const effectiveDevAddress: string | null =
    (creationInfo?.creator && !isProtocolAddress(creationInfo.creator))
      ? creationInfo.creator
      : (mintAuthAddress && !isProtocolAddress(mintAuthAddress))
        ? mintAuthAddress
        : (isPumpFunToken && mintDeployerAddress && !isProtocolAddress(mintDeployerAddress))
          ? mintDeployerAddress
          : null;
  const devWalletForAge = effectiveDevAddress;

  // Phase 1 result: top holders — extracted early so Phase 4 and Phase 1b can start immediately.
  const topHoldersData = topHoldersResult.status === "fulfilled" ? topHoldersResult.value : null;

  // Start Phase 4 (pool safety), Phase 1b (fee-payer lookups), and two previously-sequential
  // awaits in the background immediately after Phase 1. All only need Phase 1 data, so they
  // can overlap with the Phase 2 / Phase 3 sequential chain (saving up to ~6 s on cold paths).
  const _poolsToCheck = (dexData?.pairs ?? [])
    .slice()
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, 5);
  const poolSafetyPromise = Promise.allSettled(
    _poolsToCheck.map((p) =>
      checkPoolLiquiditySafety(p.pairAddress, (p as any).info?.liquidityToken?.address ?? null, { timeout: 3000 })
    )
  );

  const _knownPoolAddresses = new Set(
    (dexData?.pairs ?? []).map((p: { pairAddress: string }) => p.pairAddress).filter(Boolean)
  );
  const targetWallets = (topHoldersData ?? [])
    .map((h: { owner: string }) => h.owner)
    .filter((addr: string) => !isProtocolAddress(addr) && !_knownPoolAddresses.has(addr));
  const feePayerPromise = Promise.allSettled(
    targetWallets.map(w => getWalletSwapFeePayers(w, { timeout: 1500, limit: 5 }))
  );

  // resolveAuthorityExempt makes a Jupiter API call (3000ms timeout) for unknown tokens —
  // starting it here in parallel with Phase 2/3 saves up to 3s on the critical path.
  const authorityExemptPromise = resolveAuthorityExempt(address);

  // getSolBalance is a sequential 3000ms RPC call — start it now so it overlaps with Phase 2/3.
  // The protocol-address fast-path is preserved: if mintAuthAddress is a protocol address the
  // dev_wallet_analysis block below short-circuits and never awaits this promise.
  const _devSolBalanceProtocol = mintAuthAddress && isProtocolAddress(mintAuthAddress);
  const devSolBalancePromise: Promise<number | null> = (!_devSolBalanceProtocol && effectiveDevAddress)
    ? getSolBalance(effectiveDevAddress, 3000)
    : Promise.resolve(null);

  // CLMM/DLMM pools have no fungible LP mint — skip the burn check entirely.
  const lpBurnPromise: Promise<boolean | null> =
    lp_model === "CLMM_DLMM"
      ? Promise.resolve(null)
      : launchedFromLPBurnPad
        ? Promise.resolve(true as boolean | null)
        : (lpMint ? checkLPBurned(lpMint, { timeout: 2000 }) : Promise.resolve(null));

  const [lpBurnResult, walletAgeResult, devWalletSigsResult] = await Promise.allSettled([
    lpBurnPromise,
    devWalletForAge ? getWalletAgeDays(devWalletForAge, { timeout: 1500 }) : Promise.resolve(null),
    devWalletForAge ? rpcCall("getSignaturesForAddress", [devWalletForAge, { limit: 200 }], 2000) : Promise.resolve(null),
  ]);

  const lp_burned           = lpBurnResult.status  === "fulfilled" ? lpBurnResult.value  : null;
  const dev_wallet_age_days = walletAgeResult.status === "fulfilled" ? walletAgeResult.value : null;
  const lp_status           = deriveLPStatus(lp_burned, lp_model);

  // ── Custodial LP override ──────────────────────────────────────────────────
  const custodialPlatform = (lp_burned === null && lp_model === "TRADITIONAL_AMM" && dex_id)
    ? CUSTODIAL_DEX_LP_PLATFORMS.get(dex_id) ?? null
    : null;
  const effective_lp_status: LPStatus = custodialPlatform ? "CUSTODIAL" : lp_status;
  const lp_status_note: string | null = custodialPlatform
    ? custodialPlatform.risk_implication
    : null;

  // Oldest dev wallet sig — needed for funding source classification
  const devWalletSigs: any[] | null = devWalletSigsResult.status === "fulfilled" ? devWalletSigsResult.value : null;
  const devWalletOldestSig: string | null = Array.isArray(devWalletSigs) && devWalletSigs.length > 0
    ? (devWalletSigs[devWalletSigs.length - 1]?.signature ?? null)
    : null;

  // Total supply and swap transactions from Phase 1
  const tokenSupplyRaw = tokenSupplyResult.status === "fulfilled" ? tokenSupplyResult.value : null;
  const swapTxsData    = swapTxsResult.status    === "fulfilled" ? swapTxsResult.value    : null;
  const totalSupplyValue: number | null = typeof tokenSupplyRaw?.value?.uiAmount === "number"
    ? tokenSupplyRaw.value.uiAmount
    : null;

  // Vesting dump risk — start in background now that totalSupplyValue and topHoldersData are ready.
  // Runs in ~1s (1 Birdeye tx_list call + up to 5 sequential getAccountInfo calls).
  const vestingRiskPromise = checkVestingRisk(
    address,
    topHoldersData as Array<{ owner: string; ui_amount: number }> | null,
    totalSupplyValue,
    _knownPoolAddresses,
    { timeout: 3000 }
  );

  // Funding source + adjusted concentration — run in parallel
  const _defaultFundingSource: FundingSource = {
    funder_address: null, funder_type: "UNKNOWN", funder_age_days: null,
    funder_tx_count: null, shared_funder_wallets: [], cluster_size: 1,
    risk: "MEDIUM", risk_reason: "dev wallet unavailable", action_guidance: "verify funding source manually",
  };
  const [fundingSourceResult, adjustedConcentrationResult] = await Promise.allSettled([
    devWalletForAge
      ? classifyWalletFundingSource(devWalletForAge, devWalletOldestSig, 1000)
      : Promise.resolve(_defaultFundingSource),
    computeAdjustedConcentration(topHoldersData ?? [], totalSupplyValue),
  ]);
  const dev_funding_source = fundingSourceResult.status === "fulfilled"
    ? fundingSourceResult.value
    : _defaultFundingSource;
  const adjusted_holder_concentration = adjustedConcentrationResult.status === "fulfilled"
    ? adjustedConcentrationResult.value
    : { adjusted_top_10_pct: null, excluded_count: 0, excluded_pct: 0, exclusions: [], method: "UNAVAILABLE" as const };

  // ── Authority flags: Helius only, unconditionally ─────────────────────────
  const mint_authority_revoked   = mintData?.mint_authority_revoked   ?? false;
  const freeze_authority_revoked = mintData?.freeze_authority_revoked ?? false;

  // ── Holder concentration (Birdeye-live, adjusted) ────────────────────────
  const top_10_holder_pct = adjusted_holder_concentration.adjusted_top_10_pct;
  const has_rug_history   = rugData?.has_rug_history   ?? false;

  // ── Single holder danger (Birdeye ≥15% threshold) ────────────────────────
  let live_single_holder_danger_deep = false;
  if (topHoldersData && topHoldersData.length > 0 && totalSupplyValue && totalSupplyValue > 0) {
    const excludedAddresses = new Set(adjusted_holder_concentration.exclusions.map(e => e.address));
    const maxPct = (topHoldersData as Array<{ owner: string; ui_amount: number }>)
      .filter(h => !excludedAddresses.has(h.owner) && !isProtocolAddress(h.owner))
      .reduce((max, h) => Math.max(max, (h.ui_amount / totalSupplyValue) * 100), 0);
    live_single_holder_danger_deep = maxPct >= 15;
  }

  // ── Price / volume (priority: DexScreener → Birdeye) ─────────────────────
  const liquidity_usd        = dexData?.liquidity_usd        ?? birdData?.liquidity_usd        ?? null;
  const volume_24h           = dexData?.volume_24h_usd       ?? birdData?.volume_24h_usd       ?? 0;
  const price_change_24h_pct = dexData?.price_change_24h_pct ?? birdData?.price_change_24h_pct ?? 0;
  const buy_sell_ratio_1h    = dexData?.buy_sell_ratio_1h ?? null;

  // ── Token age ─────────────────────────────────────────────────────────────
  let token_age_days: number | null = null;
  if (dexData?.pair_created_at_ms != null) {
    token_age_days = (Date.now() - dexData.pair_created_at_ms) / 86_400_000;
  }

  // ── Supplemental deep-dive signals ───────────────────────────────────────

  // Metadata immutability (Birdeye token_security)
  const is_mutable = securityData?.mutable_metadata ?? null;
  const update_authority = securityData?.metaplex_update_authority ?? null;
  const metaRisk: "MUTABLE" | "IMMUTABLE" | "UNKNOWN" =
    is_mutable === null ? "UNKNOWN" : is_mutable ? "MUTABLE" : "IMMUTABLE";
  const metadata_immutability: MetadataImmutability = {
    is_mutable,
    update_authority,
    risk: metaRisk,
    meaning:        METADATA_RISK_MEANING[metaRisk],
    action_guidance: METADATA_RISK_ACTION[metaRisk],
  };

  // Authority history (Helius SET_AUTHORITY + MINT_TO)
  // authHistoryData.mint_authority_changes is a count — we expose an empty array
  // since we do not yet fetch per-change tx details from Helius.
  const post_launch_mints: number = authHistoryData?.post_launch_mints ?? 0;
  const authority_history: AuthorityHistory = {
    mint_authority_changes: [],   // populated when per-tx Helius data available
    authority_ever_regranted: authHistoryData?.authority_ever_regranted ?? false,
  };

  // Dilution risk
  const total_supply = securityData?.total_supply ?? null;
  const dilution_risk: DilutionRisk = {
    total_supply,
    post_launch_mints,
    risk: post_launch_mints > 0 ? "HIGH"
      : total_supply === null ? "UNKNOWN"
      : "LOW",
  };

  // Circular wash trading (Helius SWAP tx analysis)
  const circular_pairs = washTradingData?.circular_pairs ?? 0;

  // Funding wallet overlap (top-20 holders vs dev wallet)
  const funding_wallet_overlap = holderListData !== null && mintAuthAddress !== null
    ? holderListData.filter(h => h.owner === mintAuthAddress).length
    : null;
  const funding_source_risk: "LOW" | "MEDIUM" | "HIGH" =
    funding_wallet_overlap !== null && funding_wallet_overlap > 0 ? "MEDIUM" : "LOW";

  // ── Risk grade ────────────────────────────────────────────────────────────
  // Bundled launch detection: Birdeye v1 launch-window analysis via detectBundledLaunchViaBirdeye.
  // Falls back to RugCheck signal when Birdeye detection_method is "UNKNOWN" (unavailable).
  const bundled_launch_detected =
    bundlerData.detection_method !== "UNKNOWN"
      ? bundlerData.bundled_launch_detected
      : (rugData?.bundled_launch_detected ?? false);

  // Confidence is only meaningful from the Birdeye live detector.
  // RugCheck fallback has no confidence field → null (scorer treats as HIGH, conservative).
  const bundled_launch_confidence: "HIGH" | "MEDIUM" | "LOW" | null =
    bundlerData.detection_method !== "UNKNOWN"
      ? (bundlerData.confidence ?? null)
      : null;

  const factors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    adjusted_top_10_holder_pct: adjusted_holder_concentration.adjusted_top_10_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: bundled_launch_detected,
    bundled_launch_confidence,
    buy_sell_ratio: buy_sell_ratio_1h,
    token_age_days,
    single_holder_danger: live_single_holder_danger_deep,
    lp_burned,
    lp_model,
    lp_status: effective_lp_status,
    dex_id,
    dev_wallet_age_days,
    is_mutable_metadata: is_mutable,
    update_authority_is_deployer: update_authority !== null && mintAuthAddress !== null
      ? update_authority === mintAuthAddress
      : null,
    authority_ever_regranted: authority_history.authority_ever_regranted,
    wash_trading_circular_pairs: circular_pairs,
    post_launch_mints,
    dev_funder_type: devWalletForAge ? dev_funding_source.funder_type : null,
  };
  const { exempt: authority_exempt, reason: authority_exempt_reason } = await authorityExemptPromise;
  const { grade: risk_grade, scoringFactors } = calculateRiskGrade(factors, authority_exempt);

  // ── Deep-only signals ─────────────────────────────────────────────────────
  const pump_fun_launched = inferredProgramId === PROGRAMS.PUMP_FUN;

  // ── Dev wallet analysis ───────────────────────────────────────────────────
  let dev_wallet_analysis: DevWalletAnalysis;
  if (mintAuthAddress && isProtocolAddress(mintAuthAddress)) {
    // Protocol address — skip expensive RPC calls, return sentinel shape
    dev_wallet_analysis = {
      address: mintAuthAddress,
      is_protocol_address: true,
      sol_balance: null,
      created_tokens_count: null,
      previous_rugs: false,
      funding_source: null,
      funding_risk_note: null,
    };
  } else {
    // Use effectiveDevAddress: mintAuthAddress for standard tokens,
    // DAS update authority for pump.fun tokens where mintAuthority is burned.
    const devSolBalance = await devSolBalancePromise;
    const funding_risk_note: string | null =
      dev_funding_source.funder_type === "MIXER"          ? "Dev wallet funded via mixer — high anonymous funding risk"
      : dev_funding_source.funder_type === "DEPLOYER"     ? "Dev wallet funded by deployer-pattern wallet — elevated risk"
      : dev_funding_source.funder_type === "FRESH_WALLET" ? "Dev wallet funded by fresh wallet — possible proxy setup"
      : null;
    dev_wallet_analysis = {
      address: effectiveDevAddress,   // null when genuinely unavailable — never "unknown"
      sol_balance: devSolBalance ?? 0,
      created_tokens_count: 0, // requires tx history — unavailable on public RPC
      previous_rugs: has_rug_history,
      funding_source: devWalletForAge ? dev_funding_source : null,
      funding_risk_note,
    };
  }

  // LP lock — multi-pool assessment (up to 5 highest-liquidity pools)
  // poolSafetyPromise was started in the background after Phase 1, so this just awaits the result.
  const poolSafetyResults = await poolSafetyPromise;
  const poolSafeties: PoolLiquiditySafety[] = poolSafetyResults
    .filter((r): r is PromiseFulfilledResult<PoolLiquiditySafety> => r.status === "fulfilled")
    .map((r) => r.value);
  const rawLockStatus = deriveOverallLockType(poolSafeties, dex_id);
  // When on-chain pool checks return no clear burn/lock but the dex_id maps to a
  // verified protocol custodian, override with CUSTODIAL rather than UNKNOWN/UNLOCKED.
  const liquidity_lock_status: LiquidityLockStatus = custodialPlatform &&
    (rawLockStatus.lock_type === "UNKNOWN" || rawLockStatus.lock_type === "UNLOCKED" || rawLockStatus.lock_type === "NONE")
    ? {
        ...rawLockStatus,
        lock_type: "CUSTODIAL" as const,
        note: custodialPlatform.risk_implication,
        pool_safety_breakdown: rawLockStatus.pool_safety_breakdown.map(p => ({
          ...p,
          safety: "CUSTODIAL" as const,
          safety_note: `LP held by ${custodialPlatform.platform} protocol wallet`,
        })),
        custody_info: {
          custodial_wallets: custodialPlatform.custodial_wallets,
          treasury_wallets:  custodialPlatform.treasury_wallets,
          platform:          custodialPlatform.platform,
          type_description:  custodialPlatform.type_description,
          risk_implication:  custodialPlatform.risk_implication,
        },
      }
    : rawLockStatus;

  // ── Trading pattern scalars (needed by momentum_score below) ─────────────
  // Full trading_pattern object is assembled after clusterResult (see below).
  const unique_buyers_24h = dexData?.pair?.txns?.h24?.buys ?? 0;
  const wash_trading_score = deriveWashTradingScore(buy_sell_ratio_1h, volume_24h || null, liquidity_usd);

  // ── Last trade (adversarial freshness signal) ─────────────────────────────
  const last_trade = deriveLastTrade(birdData?.last_trade_unix_time ?? null);
  const hours_since_last_trade = last_trade.hours_ago;

  // ── Momentum score (multi-timeframe) ─────────────────────────────────────
  const momentum_score = calculateMomentumScore({
    price_change_5m_pct:  birdData?.price_change_5m_pct  ?? null,
    price_change_30m_pct: birdData?.price_change_30m_pct ?? null,
    price_change_1h_pct:  dexData?.price_change_1h_pct   ?? birdData?.price_change_1h_pct ?? null,
    price_change_8h_pct:  birdData?.price_change_8h_pct  ?? null,
    price_change_24h_pct: price_change_24h_pct,
    volume_1h_usd:        birdData?.volume_1h_usd         ?? null,
    volume_24h_usd:       volume_24h || null,
    buy_sell_ratio_1h,
    hours_since_last_trade,
  });
  const momentum_tier: "STRONG" | "MODERATE" | "WEAK" | "DEAD" =
    momentum_score >= 75 ? "STRONG"
    : momentum_score >= 50 ? "MODERATE"
    : momentum_score >= 25 ? "WEAK"
    : "DEAD";
  const momentum_interpretation: string =
    momentum_score >= 75 ? "Strong upward momentum — active buying, rising price, healthy volume (75–100)"
    : momentum_score >= 50 ? "Moderate momentum — some buying activity but not dominant (50–74)"
    : momentum_score >= 25 ? "Weak momentum — low volume or sell pressure outweighs buys (25–49)"
    : "Dead or declining — near-zero volume, strong sell pressure, or price collapse (0–24)";

  // ── Data confidence ────────────────────────────────────────────────────────
  const sources = [
    dexData  !== null ? "dexscreener" : null,
    rugData  !== null ? "rugcheck"    : null,
    mintData !== null ? "helius"      : null,
    birdData !== null ? "birdeye"     : null,
  ].filter((s): s is string => s !== null);
  const data_age_ms = Date.now() - fetchStart;
  const confidence = calculateConfidence({
    sources_available: sources.length,
    sources_total: 4,
    data_age_ms,
  });
  const data_confidence = confidenceToString(confidence.model);

  // ── Historical flags ───────────────────────────────────────────────────────
  const vestingRisk = await vestingRiskPromise;

  const historical_flags: HistoricalFlag[] = buildHistoricalFlags({
    has_rug_history,
    bundled_launch: bundled_launch_detected,
    single_holder_danger: live_single_holder_danger_deep,
    dev_wallet_analysis: { previous_rugs: has_rug_history },
  });
  if (is_mutable === true) historical_flags.push("MUTABLE_METADATA");
  if (authority_history.authority_ever_regranted) historical_flags.push("AUTHORITY_REGRANTED");
  if (devWalletForAge && dev_funding_source.funder_type === "MIXER") historical_flags.push("DEV_MIXER_FUNDED");
  if (vestingRisk.risk === "HIGH") historical_flags.push("VESTING_UNLOCK_DUMP_RISK");

  // ── Risk breakdown ────────────────────────────────────────────────────────
  const contract_risk: "LOW" | "MEDIUM" | "HIGH" =
    (has_rug_history || !mint_authority_revoked || !freeze_authority_revoked || authority_history.authority_ever_regranted) ? "HIGH"
    : "LOW";

  const liquidity_risk: "LOW" | "MEDIUM" | "HIGH" =
    (liquidity_usd ?? 0) < 1_000 ? "HIGH"
    : (liquidity_usd ?? 0) < 10_000 ? "MEDIUM"
    : lp_burned === false && lp_model === "TRADITIONAL_AMM" ? "MEDIUM"
    : "LOW";

  const market_risk: "LOW" | "MEDIUM" | "HIGH" =
    volume_24h < 1_000 ? "HIGH"
    : volume_24h < 10_000 || (buy_sell_ratio_1h !== null && buy_sell_ratio_1h < 0.3) ? "MEDIUM"
    : "LOW";

  // behavioral_risk reflects the effective bundled-launch threat, not just the raw boolean.
  // A MEDIUM-confidence detection on a 280-day-old token is not the same threat as a
  // HIGH-confidence detection on a 3-day-old token. Mirror the confidence + age logic
  // from the scorer: HIGH confidence fresh token → HIGH risk; decayed/low-conf → MEDIUM.
  const effectiveBundledHigh =
    bundled_launch_detected
    && (bundled_launch_confidence === "HIGH" || bundled_launch_confidence === null)
    && (token_age_days === null || token_age_days <= 90);
  const effectiveBundledMedium =
    bundled_launch_detected && !effectiveBundledHigh;

  const behavioral_risk: "LOW" | "MEDIUM" | "HIGH" =
    effectiveBundledHigh ? "HIGH"
    : effectiveBundledMedium || live_single_holder_danger_deep ? "MEDIUM"
    : "LOW";

  const risk_breakdown = { contract_risk, liquidity_risk, market_risk, behavioral_risk };

  // ── Graph-based cluster detection (Phase 2 — runs after all source fetches) ──
  // Strategy: fetch each top holder's earliest swap fee payers in parallel (Phase 1b).
  // Shared fee payers among multiple holders are the primary on-chain signal for
  // coordinated/bundled buying — more reliable than token-level swap history.

  // Token creation time for temporal cluster boost (unix seconds)
  const tokenCreationTime = dexData?.pair_created_at_ms != null
    ? Math.floor(dexData.pair_created_at_ms / 1000)
    : null;

  // Phase 1b fee payer lookups were started in the background after Phase 1; await here.
  const feePayerResults = await feePayerPromise;

  // Build fee_payer → wallets[] map from Phase 1b results.
  // Shared fee payer = strong bundled-launch signal.
  const feePayerToWallets = new Map<string, Array<{ wallet: string; block_time: number }>>();
  for (let i = 0; i < targetWallets.length; i++) {
    const result = feePayerResults[i];
    if (result.status !== "fulfilled" || !result.value) continue;
    for (const { fee_payer, block_time } of result.value) {
      if (!fee_payer || fee_payer === targetWallets[i]) continue;
      if (!feePayerToWallets.has(fee_payer)) feePayerToWallets.set(fee_payer, []);
      feePayerToWallets.get(fee_payer)!.push({ wallet: targetWallets[i], block_time });
    }
  }

  // Create pairwise edges between holders that share a fee payer.
  // fee_payer_map in TxGraph requires two DIFFERENT wallets per entry — self-edges won't work.
  const syntheticEdges: import("../analysis/walletGraph.js").TxEdge[] = [];
  for (const [fee_payer, entries] of feePayerToWallets.entries()) {
    const unique = [...new Map(entries.map(e => [e.wallet, e])).values()];
    if (unique.length < 2) continue;
    // Create edges between all pairs sharing this fee payer
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const block_time = Math.min(unique[i].block_time, unique[j].block_time);
        syntheticEdges.push({
          from: unique[i].wallet,
          to: unique[j].wallet,
          value_lamports: 0,
          block_time,
          program: "FEE_PAYER_LINK",
          tx_signature: `feepair_${i}_${j}_${fee_payer.slice(0, 8)}`,
          fee_payer,
        });
      }
    }
  }

  // Supplement with token-level swap edges for temporal + fan-out signals
  const allEdges = swapTxsData ? heliusTxsToEdges(swapTxsData, address) : [];
  const txGraph = buildTxGraph([...allEdges, ...syntheticEdges]);

  const clusterResult = detectClusters(txGraph, targetWallets, tokenCreationTime);

  // Populate cluster supply_pct_combined from holder percentages
  const holderPctMap = new Map<string, number>();
  if (topHoldersData && typeof (topHoldersData[0] as any)?.ui_amount === "number" && totalSupplyValue) {
    for (const h of topHoldersData as Array<{ owner: string; ui_amount: number }>) {
      holderPctMap.set(h.owner, (h.ui_amount / totalSupplyValue) * 100);
    }
  }
  for (const cluster of clusterResult.clusters) {
    cluster.supply_pct_combined = cluster.wallets.reduce(
      (sum, w) => sum + (holderPctMap.get(w) ?? 0), 0
    );
  }

  // ── Trading pattern (assembled here — needs clusterResult for wash_method) ──
  // wash_method: "GRAPH_ANALYSIS" when graph ran (targetWallets were analysed),
  // "HEURISTIC" when no holder data was available (score is ratio/volume only).
  const wash_trading_risk = deriveWashTradingRisk(wash_trading_score);
  const wash_method: TradingPattern["wash_method"] =
    targetWallets.length > 0 ? "GRAPH_ANALYSIS" : "HEURISTIC";
  const trading_pattern: TradingPattern = {
    buy_sell_ratio_1h: buy_sell_ratio_1h ?? 0.5,
    unique_buyers_24h,
    wash_trading_score,
    wash_trading_risk,
    wash_trading_meaning:        WASH_TRADING_MEANING[wash_trading_risk],
    wash_trading_action_guidance: WASH_TRADING_ACTION_GUIDANCE[wash_trading_risk],
    circular_pairs,
    wash_method,
  };

  // ── Wallet analysis (adversarial layer) ───────────────────────────────────
  const dev_wallet_linked = dev_wallet_analysis.sol_balance !== null && dev_wallet_analysis.sol_balance > 0;

  // insider_control_percent: sum supply % across all detected clusters
  const insider_control_percent = clusterResult.clusters.length > 0
    ? clusterResult.clusters.reduce((sum, c) => sum + (c.supply_pct_combined ?? 0), 0)
    : null;

  const wallet_analysis = {
    clustered_wallets: clusterResult.total_clustered_wallets,
    insider_control_percent,
    dev_wallet_linked,
    funding_wallet_overlap,
    funding_source_risk,
  };

  // ── Launch pattern ────────────────────────────────────────────────────────
  const launch_pattern: "STEALTH_LAUNCH" | "FAIR_LAUNCH" | "UNKNOWN" =
    bundled_launch_detected ? "STEALTH_LAUNCH"
    : pump_fun_launched ? "FAIR_LAUNCH"
    : "UNKNOWN";

  // ── Sniper activity ───────────────────────────────────────────────────────
  const sniper_activity: "LOW" | "MEDIUM" | "HIGH" =
    bundled_launch_detected ? "HIGH"
    : live_single_holder_danger_deep ? "MEDIUM"
    : "LOW";

  // ── Key drivers ───────────────────────────────────────────────────────────
  const key_drivers = buildKeyDrivers(scoringFactors, {
    price_change_24h_pct: price_change_24h_pct ?? null,
    volume_24h: volume_24h ?? null,
    liquidity_usd: liquidity_usd ?? null,
    adjusted_top_10_pct: adjusted_holder_concentration.adjusted_top_10_pct,
  });

  // ── Structured recommendation ─────────────────────────────────────────────
  const recommendation = buildRecommendation({
    risk_grade,
    risk_breakdown,
    historical_flags,
    confidence_model: confidence.model,
    last_trade_recency: last_trade.recency,
  });

  // ── Data quality ──────────────────────────────────────────────────────────
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    sources.length === 4 ? "FULL" : sources.length >= 2 ? "PARTIAL" : "LIMITED";

  const missing_fields: string[] = [];
  if (dexData  === null) missing_fields.push("price", "volume", "liquidity", "buy_sell_ratio");
  if (rugData  === null) missing_fields.push("has_rug_history");
  if (mintData === null) missing_fields.push("mint_authority_revoked", "freeze_authority_revoked");
  if (birdData === null) missing_fields.push("birdeye_price");
  const symbol   = birdData?.symbol   ?? null;
  const name     = birdData?.name     ?? null;
  const logo_uri = birdData?.logo_uri ?? null;
  if (symbol === null && name === null) missing_fields.push("token_metadata");
  if (effectiveDevAddress === null) missing_fields.push("dev_wallet_address");

  // ── Quick-scan-style one-liner summary ─────────────────────────────────────
  const flags: string[] = [];
  if (has_rug_history) flags.push("rug history");
  if (!mint_authority_revoked) flags.push("mint authority active");
  if (!freeze_authority_revoked) flags.push("freeze authority active");
  const liqStr = liquidity_usd != null
    ? `$${liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} liquidity`
    : "liquidity unknown";
  const conf = data_confidence !== "HIGH" ? ` (${data_confidence.toLowerCase()} confidence)` : "";
  const flagStr = flags.length > 0 ? `${flags.join(", ")}; ` : "";
  const summary = `${flagStr}${liqStr}; grade ${risk_grade}; momentum ${momentum_score}/100${conf}.`;

  // ── LLM full risk report — sequential, after all parallel fetches complete ─
  const llmInput: DeepDiveData = {
    risk_grade,
    has_rug_history,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    volume_24h,
    momentum_score,
    pump_fun_launched,
    bundled_launch_detected,
    data_confidence,
    recommendation: recommendation.action,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
    historical_flags,
    name,
    symbol,
  };

  const llmStart = Date.now();
  let full_risk_report: string;
  try {
    full_risk_report = await generateDeepDiveReport(llmInput);
  } catch {
    full_risk_report = fallbackDeepReport(llmInput);
  }
  const llmElapsed = Date.now() - llmStart;
  const totalElapsed = Date.now() - fetchStart;
  console.info(`[deepDive] ${address} total=${totalElapsed}ms llm=${llmElapsed}ms`);

  return {
    schema_version: "2.0" as const,
    token_address: address,
    symbol,
    name,
    logo_uri,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    single_holder_danger: live_single_holder_danger_deep,
    liquidity_usd,
    lp_burned,
    lp_model,
    lp_status: effective_lp_status,
    lp_status_note,
    dex_id,
    risk_grade,
    summary,
    dev_wallet_analysis,
    liquidity_lock_status,
    trading_pattern,
    pump_fun_launched,
    bundled_launch_detected,
    momentum_score,
    momentum_tier,
    momentum_interpretation,
    last_trade,
    full_risk_report,
    recommendation,
    data_confidence,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
    confidence,
    historical_flags,
    risk_breakdown,
    wallet_analysis,
    launch_pattern,
    sniper_activity,
    key_drivers,
    data_quality,
    missing_fields,
    metadata_immutability,
    authority_history,
    dilution_risk,
    adjusted_holder_concentration,
    pool_types_detected: [...new Set(
      (dexData?.pairs ?? []).map(pair => classifyLPModel(pair.dexId))
    )] as Array<"TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN">,
    bundler_analysis: bundlerData,
    vesting_risk: vestingRisk,
  };
}
