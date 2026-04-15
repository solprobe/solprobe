import { getDexScreenerToken, deriveLPStatus, classifyLPModel, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary, stripLPFalsePositives } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned, getWalletAgeDays, detectCircularWashTrading, getAuthorityHistory, getTokenSwapTransactions, getWalletSwapFeePayers, getMintDeployer, checkPoolLiquiditySafety, type PoolLiquiditySafety } from "../sources/helius.js";
import { buildTxGraph, heliusTxsToEdges } from "../analysis/walletGraph.js";
import { detectClusters } from "../analysis/clusterDetection.js";
import { getBirdeyeToken, getBirdeyeTokenSecurity, getBirdeyeHolderList, getBirdeyeTopHolders, getTokenCreationInfo } from "../sources/birdeye.js";
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
  AuthorityHistory, MetadataImmutability,
} from "./types.js";
import { classifyWalletFundingSource } from "../utils/walletClassifier.js";
import { deduplicate, getOrFetch } from "../cache.js";
import { isProtocolAddress, isLPBurnLaunchpad, PROGRAMS } from "../constants.js";
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
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  lp_burned: boolean | null;
  lp_model: LPModel;
  lp_status: LPStatus;
  dex_id: string | null;
  rugcheck_risk_score: number | null;
  single_holder_danger: boolean;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  dev_wallet_analysis: DevWalletAnalysis;
  liquidity_lock_status: LiquidityLockStatus;
  trading_pattern: TradingPattern;
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;
  volume_24h: number;
  price_change_24h_pct: number;
  momentum_score: number;
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
  /** Data quality */
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  /** Fields that could not be populated */
  missing_fields: string[];
  /** Holder concentration after excluding burn/DEX/protocol addresses */
  adjusted_holder_concentration: AdjustedHolderConcentration;
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

/** 0–100 momentum score derived entirely from on-chain/DEX signals. */
function calculateMomentumScore(data: {
  price_change_24h_pct: number | null;
  volume_24h: number | null;
  buy_sell_ratio_1h: number | null;
  unique_buyers_24h: number | null;
  liquidity_usd: number | null;
}): number {
  let score = 50;  // neutral baseline

  // Component 1: Price momentum (weight 40)
  // Normalise: ±50% maps to ±40 points
  const price = data.price_change_24h_pct ?? 0;
  const price_component = Math.max(-40, Math.min(40, price * 0.8));
  score += price_component;

  // Component 2: Volume relative to liquidity (weight 25)
  // volume/liquidity > 1 = very active, < 0.1 = dormant
  if (data.volume_24h !== null && data.liquidity_usd && data.liquidity_usd > 0) {
    const vol_ratio = data.volume_24h / data.liquidity_usd;
    const vol_component = vol_ratio >= 2   ?  25
                        : vol_ratio >= 0.5 ?  12
                        : vol_ratio >= 0.1 ?   0
                        : -10;
    score += vol_component;
  }

  // Component 3: Buy pressure (weight 20)
  const bsr = data.buy_sell_ratio_1h ?? 0.5;
  const buy_component = bsr > 0.7  ?  20
                      : bsr > 0.55 ?  10
                      : bsr > 0.45 ?   0
                      : bsr > 0.3  ? -10
                      : -20;
  score += buy_component;

  // Component 4: Unique buyer momentum (weight 15)
  // > 3000 unique buyers in 24h = high organic interest
  const buyers = data.unique_buyers_24h ?? 0;
  const buyer_component = buyers > 5000 ?  15
                        : buyers > 2000 ?   8
                        : buyers > 500  ?   0
                        : -5;
  score += buyer_component;

  return Math.max(0, Math.min(100, Math.round(score)));
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
}): { action: "AVOID" | "WATCH" | "CONSIDER" | "DYOR"; reason: string; confidence: number; time_horizon: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM" } {
  const highRisks = Object.entries(data.risk_breakdown)
    .filter(([, v]) => v === "HIGH")
    .map(([k]) => k.replace("_risk", "").toUpperCase());

  if (data.risk_grade === "F" || highRisks.length >= 3) {
    return { action: "AVOID", reason: highRisks.join(" + ") || "CRITICAL_GRADE", confidence: 0.9, time_horizon: "SHORT_TERM" };
  }
  if (data.historical_flags.includes("PAST_RUG") || data.historical_flags.includes("DEV_ASSOCIATED_WITH_PREVIOUS_RUG")) {
    return { action: "AVOID", reason: "CONFIRMED_RUG_HISTORY", confidence: 0.95, time_horizon: "SHORT_TERM" };
  }
  if (data.risk_grade === "D" || highRisks.length >= 1) {
    return { action: "WATCH", reason: highRisks.join(" + ") || "ELEVATED_RISK", confidence: data.confidence_model, time_horizon: "SHORT_TERM" };
  }
  if (data.risk_grade === "A" || data.risk_grade === "B") {
    return { action: "CONSIDER", reason: "ACCEPTABLE_STRUCTURAL_RISK", confidence: data.confidence_model, time_horizon: "MEDIUM_TERM" };
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

  // Level 1: check the token account's raw program owner.
  // For AMMs that own vault accounts directly (PumpSwap, some Meteora variants),
  // getAccountInfo(tokenAccountAddress).owner === DEX program ID.
  const tokenAcctInfo = await rpcCall("getAccountInfo", [tokenAccountAddress, { encoding: "base58" }], timeoutMs);
  if (tokenAcctInfo?.value === null || tokenAcctInfo?.value === undefined) return "BURN";
  const tokenAcctOwner: string | undefined = tokenAcctInfo?.value?.owner;
  if (tokenAcctOwner && DEX_PROGRAMS.has(tokenAcctOwner)) return "DEX_POOL";

  // Level 2: check the wallet/authority address itself.
  // For Raydium AMM V4, Orca, etc. the vault ATA is owned by the Token Program,
  // but its authority is a PDA whose program owner is the DEX program.
  const ownerInfo = await rpcCall("getAccountInfo", [ownerAddress, { encoding: "base58" }], timeoutMs);
  if (ownerInfo?.value === null || ownerInfo?.value === undefined) return "BURN";
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
         creationInfoResult] =
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
    ]);

  const dexData       = dexResult.status         === "fulfilled" ? dexResult.value         : null;
  const rugData       = rugResult.status         === "fulfilled" ? rugResult.value         : null;
  const mintData      = mintResult.status        === "fulfilled" ? mintResult.value        : null;
  const birdData      = birdResult.status        === "fulfilled" ? birdResult.value        : null;
  const mintAuthAddress = mintAuthResult.status  === "fulfilled" ? mintAuthResult.value    : null;
  const mintDeployerAddress = mintDeployerResult.status === "fulfilled" ? mintDeployerResult.value : null;
  const creationInfo  = creationInfoResult.status === "fulfilled" ? creationInfoResult.value : null;
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

  // Infer launch program from dexId heuristic.
  // Used here (before pump_fun_launched is declared) to decide whether to apply
  // the DAS deployer fallback for tokens with no live mint authority.
  const inferredProgramId = dexData?.pairs.some((p) =>
    p.dexId?.toLowerCase().includes("pump")
  ) ? PROGRAMS.PUMP_FUN : null;
  const launchedFromLPBurnPad = inferredProgramId
    ? isLPBurnLaunchpad(inferredProgramId)
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

  // CLMM/DLMM pools have no fungible LP mint — skip the burn check entirely.
  const lpBurnPromise: Promise<boolean | null> =
    lp_model === "CLMM_DLMM"
      ? Promise.resolve(null)
      : launchedFromLPBurnPad
        ? Promise.resolve(true as boolean | null)
        : (lpMint ? checkLPBurned(lpMint, { timeout: 2000 }) : Promise.resolve(null));

  const [lpBurnResult, walletAgeResult, devWalletSigsResult] = await Promise.allSettled([
    lpBurnPromise,
    devWalletForAge ? getWalletAgeDays(devWalletForAge, { timeout: 5000 }) : Promise.resolve(null),
    devWalletForAge ? rpcCall("getSignaturesForAddress", [devWalletForAge, { limit: 200 }], 4000) : Promise.resolve(null),
  ]);

  const lp_burned           = lpBurnResult.status  === "fulfilled" ? lpBurnResult.value  : null;
  const dev_wallet_age_days = walletAgeResult.status === "fulfilled" ? walletAgeResult.value : null;
  const lp_status           = deriveLPStatus(lp_burned, lp_model);

  // Strip LP-related false positives from RugCheck now that lp_burned + lp_model are known.
  const rugcheckAdjusted = rugData
    ? stripLPFalsePositives(rugData, { lp_burned, lp_model })
    : null;

  // Oldest dev wallet sig — needed for funding source classification
  const devWalletSigs: any[] | null = devWalletSigsResult.status === "fulfilled" ? devWalletSigsResult.value : null;
  const devWalletOldestSig: string | null = Array.isArray(devWalletSigs) && devWalletSigs.length > 0
    ? (devWalletSigs[devWalletSigs.length - 1]?.signature ?? null)
    : null;

  // Top holders, total supply, and swap transactions from Phase 1
  const topHoldersData = topHoldersResult.status === "fulfilled" ? topHoldersResult.value : null;
  const tokenSupplyRaw = tokenSupplyResult.status === "fulfilled" ? tokenSupplyResult.value : null;
  const swapTxsData    = swapTxsResult.status    === "fulfilled" ? swapTxsResult.value    : null;
  const totalSupplyValue: number | null = typeof tokenSupplyRaw?.value?.uiAmount === "number"
    ? tokenSupplyRaw.value.uiAmount
    : null;

  // Funding source + adjusted concentration — run in parallel
  const _defaultFundingSource: FundingSource = {
    funder_address: null, funder_type: "UNKNOWN", funder_age_days: null,
    funder_tx_count: null, shared_funder_wallets: [], cluster_size: 1,
    risk: "MEDIUM", risk_reason: "dev wallet unavailable", action_guidance: "verify funding source manually",
  };
  const [fundingSourceResult, adjustedConcentrationResult] = await Promise.allSettled([
    devWalletForAge
      ? classifyWalletFundingSource(devWalletForAge, devWalletOldestSig, 6000)
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

  // ── Holder concentration (RugCheck, protocol addrs already filtered) ───────
  const top_10_holder_pct = rugData?.top_10_holder_pct ?? null;
  const is_honeypot       = rugData?.is_honeypot       ?? false;
  const has_rug_history   = rugData?.has_rug_history   ?? false;

  // ── RugCheck report age ────────────────────────────────────────────────────
  const rugcheck_report_age_seconds = rugData?.report_age_seconds ?? null;

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
  const bundled_launch_detected = rugData?.bundled_launch_detected
    ?? ((token_age_days != null && token_age_days < 1) && (top_10_holder_pct != null && top_10_holder_pct > 90));

  const factors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: bundled_launch_detected,
    buy_sell_ratio: buy_sell_ratio_1h,
    token_age_days,
    rugcheck_risk_score: rugcheckAdjusted?.adjusted_score ?? null,
    single_holder_danger: rugData?.single_holder_danger ?? false,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    dev_wallet_age_days,
    is_mutable_metadata: is_mutable,
    update_authority_is_deployer: update_authority !== null && mintAuthAddress !== null
      ? update_authority === mintAuthAddress
      : null,
    authority_ever_regranted: authority_history.authority_ever_regranted,
    wash_trading_circular_pairs: circular_pairs,
    post_launch_mints,
    adjusted_top_10_holder_pct: adjusted_holder_concentration.adjusted_top_10_pct,
    dev_funder_type: devWalletForAge ? dev_funding_source.funder_type : null,
    rugcheck_lp_stripped: rugcheckAdjusted?.lp_risks_stripped ?? false,
    rugcheck_raw_score: rugData?.score ?? null,
  };
  const { exempt: authority_exempt, reason: authority_exempt_reason } = await resolveAuthorityExempt(address);
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
    const devSolBalance = effectiveDevAddress
      ? await getSolBalance(effectiveDevAddress, 3000)
      : null;
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
  const poolsToCheck = (dexData?.pairs ?? [])
    .slice()
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, 5);
  const poolSafetyResults = await Promise.allSettled(
    poolsToCheck.map((p) =>
      checkPoolLiquiditySafety(p.pairAddress, (p as any).info?.liquidityToken?.address ?? null, { timeout: 3000 })
    )
  );
  const poolSafeties: PoolLiquiditySafety[] = poolSafetyResults
    .filter((r): r is PromiseFulfilledResult<PoolLiquiditySafety> => r.status === "fulfilled")
    .map((r) => r.value);
  const liquidity_lock_status = deriveOverallLockType(poolSafeties, dex_id);

  // ── Trading pattern scalars (needed by momentum_score below) ─────────────
  // Full trading_pattern object is assembled after clusterResult (see below).
  const unique_buyers_24h = dexData?.pair?.txns?.h24?.buys ?? 0;
  const wash_trading_score = deriveWashTradingScore(buy_sell_ratio_1h, volume_24h || null, liquidity_usd);

  // ── Momentum score ────────────────────────────────────────────────────────
  const momentum_score = calculateMomentumScore({
    price_change_24h_pct,
    volume_24h: volume_24h || null,
    buy_sell_ratio_1h,
    unique_buyers_24h,
    liquidity_usd,
  });

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
    rugcheck_age_seconds: rugcheck_report_age_seconds ?? undefined,
  });
  const data_confidence = confidenceToString(confidence.model);

  // ── Historical flags ───────────────────────────────────────────────────────
  const historical_flags: HistoricalFlag[] = buildHistoricalFlags({
    has_rug_history,
    bundled_launch: bundled_launch_detected,
    single_holder_danger: rugData?.single_holder_danger ?? false,
    dev_wallet_analysis: { previous_rugs: has_rug_history },
  });
  if (is_mutable === true) historical_flags.push("MUTABLE_METADATA");
  if (authority_history.authority_ever_regranted) historical_flags.push("AUTHORITY_REGRANTED");
  if (devWalletForAge && dev_funding_source.funder_type === "MIXER") historical_flags.push("DEV_MIXER_FUNDED");

  // ── Risk breakdown ────────────────────────────────────────────────────────
  const contract_risk: "LOW" | "MEDIUM" | "HIGH" =
    (is_honeypot || has_rug_history || !mint_authority_revoked || !freeze_authority_revoked || authority_history.authority_ever_regranted) ? "HIGH"
    : (rugcheckAdjusted?.adjusted_score ?? 0) > 2000 ? "MEDIUM"
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

  const behavioral_risk: "LOW" | "MEDIUM" | "HIGH" =
    bundled_launch_detected || (rugData?.insider_flags ?? false) ? "HIGH"
    : (rugData?.single_holder_danger ?? false) ? "MEDIUM"
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

  // DEX pool addresses from DexScreener — exclude from target wallets
  const knownPoolAddresses = new Set(
    (dexData?.pairs ?? []).map((p: { pairAddress: string }) => p.pairAddress).filter(Boolean)
  );

  // Build target wallet list: top holders minus protocol + DEX pool addresses
  const targetWallets = (topHoldersData ?? [])
    .map((h: { owner: string }) => h.owner)
    .filter((addr: string) => !isProtocolAddress(addr) && !knownPoolAddresses.has(addr));

  // Phase 1b: parallel fee payer lookups (1500ms each, max 20 wallets)
  const feePayerResults = await Promise.allSettled(
    targetWallets.map(w => getWalletSwapFeePayers(w, { timeout: 1500, limit: 5 }))
  );

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
    : (rugData?.insider_flags ? 15 : null);

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
    : (rugData?.single_holder_danger ?? false) ? "MEDIUM"
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
  });

  // ── Data quality ──────────────────────────────────────────────────────────
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    sources.length === 4 ? "FULL" : sources.length >= 2 ? "PARTIAL" : "LIMITED";

  const missing_fields: string[] = [];
  if (dexData  === null) missing_fields.push("price", "volume", "liquidity", "buy_sell_ratio");
  if (rugData  === null) missing_fields.push("rugcheck_risk_score", "bundled_launch", "single_holder_danger");
  if (mintData === null) missing_fields.push("mint_authority_revoked", "freeze_authority_revoked");
  if (birdData === null) missing_fields.push("birdeye_price");
  if (effectiveDevAddress === null) missing_fields.push("dev_wallet_address");

  // ── Quick-scan-style one-liner summary ─────────────────────────────────────
  const flags: string[] = [];
  if (is_honeypot) flags.push("honeypot");
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
    is_honeypot,
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
    rugcheck_risk_score: rugcheckAdjusted?.adjusted_score ?? null,
    insider_flags: rugData?.insider_flags ?? false,
    authority_exempt,
    authority_exempt_reason,
    factors: scoringFactors,
    historical_flags,
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
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    lp_burned,
    lp_model,
    lp_status,
    dex_id,
    rugcheck_risk_score: factors.rugcheck_risk_score,
    single_holder_danger: factors.single_holder_danger,
    risk_grade,
    summary,
    dev_wallet_analysis,
    liquidity_lock_status,
    trading_pattern,
    pump_fun_launched,
    bundled_launch_detected,
    volume_24h,
    price_change_24h_pct,
    momentum_score,
    full_risk_report,
    recommendation,
    data_confidence,
    rugcheck_report_age_seconds,
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
