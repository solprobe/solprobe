import { getDexScreenerToken, deriveLPStatus, type LPModel, type LPStatus } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned, getWalletAgeDays, detectCircularWashTrading, getAuthorityHistory } from "../sources/helius.js";
import { getBirdeyeToken, getBirdeyeTokenSecurity, getBirdeyeHolderList, getBirdeyeTopHolders } from "../sources/birdeye.js";
import { getSolscanMeta } from "../sources/solscan.js";
import {
  calculateRiskGrade,
  calculateConfidence,
  confidenceToString,
  buildHistoricalFlags,
  type RiskFactors,
} from "./riskScorer.js";
import type { ScoringFactor, HistoricalFlag, KeyDriver, AdjustedHolderConcentration, ExclusionCategory, FundingSource } from "./types.js";
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
  address: string;
  /** null when the address is a Virtuals Protocol address */
  sol_balance: number | null;
  /** null when the address is a Virtuals Protocol address */
  created_tokens_count: number | null;
  previous_rugs: boolean;
  is_protocol_address?: boolean;
  funding_source: FundingSource | null;
  funding_risk_note: string | null;
}

export interface LiquidityLockStatus {
  locked: boolean;
  lock_duration_days: number;
  locked_pct: number;
}

export interface TradingPattern {
  buy_sell_ratio_1h: number;
  unique_buyers_24h: number;
  wash_trading_score: number;
  circular_pairs: number;
  wash_method: "HEURISTIC" | "CIRCULAR_SWAP";
}

export interface MetadataImmutability {
  is_mutable: boolean | null;
  update_authority: string | null;
  risk: "MUTABLE" | "IMMUTABLE" | "UNKNOWN";
}

export interface AuthorityHistory {
  mint_authority_changes: number;
  authority_ever_regranted: boolean;
  post_launch_mints: number;
}

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
// Derived signal helpers
// ---------------------------------------------------------------------------

/** 0–100 momentum score derived entirely from on-chain/DEX signals. */
function deriveMomentumScore(
  volume_1h: number | null,
  volume_24h: number | null,
  price_change_1h: number | null,
  buy_sell_ratio: number | null
): number {
  let score = 50;

  // Volume acceleration vs 24 h average
  if (volume_1h != null && volume_24h != null && volume_24h > 0) {
    const hourlyAvg = volume_24h / 24;
    if (hourlyAvg > 0) {
      const ratio = volume_1h / hourlyAvg;
      if (ratio > 3) score += 20;
      else if (ratio > 1.5) score += 10;
      else if (ratio < 0.25) score -= 20;
      else if (ratio < 0.5) score -= 10;
    }
  }

  // Price change contribution
  if (price_change_1h != null) {
    if (price_change_1h > 10) score += 15;
    else if (price_change_1h > 5) score += 10;
    else if (price_change_1h > 0) score += 5;
    else if (price_change_1h < -10) score -= 15;
    else if (price_change_1h < -5) score -= 10;
  }

  // Buy/sell pressure
  if (buy_sell_ratio != null) {
    if (buy_sell_ratio > 0.7) score += 15;
    else if (buy_sell_ratio > 0.6) score += 10;
    else if (buy_sell_ratio < 0.3) score -= 15;
    else if (buy_sell_ratio < 0.4) score -= 10;
  }

  return Math.max(0, Math.min(100, score));
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

function buildKeyDrivers(factors: ScoringFactor[]): KeyDriver[] {
  return [...factors]
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

// Known DEX program owners — their ATAs are DEX_POOL, not INSIDER
const DEX_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM V4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "LBUZKhRxPF3XUpBCjp4YzTKgLLjLsrHnHDEhGSoeVJu",  // Meteora DLMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // Pump.fun
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

async function classifyHolderAddress(ownerAddress: string, timeoutMs: number): Promise<ExclusionCategory> {
  // Burn addresses have no account
  const result = await rpcCall("getAccountInfo", [ownerAddress, { encoding: "base58" }], timeoutMs);
  if (result?.value === null || result?.value === undefined) return "BURN";
  const accountOwner: string | undefined = result?.value?.owner;
  if (!accountOwner) return "INSIDER";
  if (DEX_PROGRAMS.has(accountOwner)) return "DEX_POOL";
  if (accountOwner === SYSTEM_PROGRAM) return "INSIDER";
  return "INSIDER";
}

async function computeAdjustedConcentration(
  holders: Array<{ owner: string; ui_amount: number }>,
  totalSupply: number | null
): Promise<AdjustedHolderConcentration> {
  if (totalSupply === null || totalSupply === 0 || holders.length === 0) {
    return { adjusted_top_10_pct: null, excluded_count: 0, excluded_pct: 0, exclusions: [], method: "UNAVAILABLE" };
  }

  // Classify all holders in parallel (1500ms each, 6000ms total budget)
  const classifications = await Promise.allSettled(
    holders.map(h => classifyHolderAddress(h.owner, 1500))
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
         topHoldersResult, tokenSupplyResult] =
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
    ]);

  const dexData       = dexResult.status         === "fulfilled" ? dexResult.value         : null;
  const rugData       = rugResult.status         === "fulfilled" ? rugResult.value         : null;
  const mintData      = mintResult.status        === "fulfilled" ? mintResult.value        : null;
  const birdData      = birdResult.status        === "fulfilled" ? birdResult.value        : null;
  const mintAuthAddress = mintAuthResult.status  === "fulfilled" ? mintAuthResult.value    : null;
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
  const devWalletForAge = (mintAuthAddress && !isProtocolAddress(mintAuthAddress))
    ? mintAuthAddress
    : null;

  // Infer launch program from dexId heuristic (no Helius getAsset call here yet).
  // When creatorProgramId is wired from Helius getAsset, replace inferredProgramId
  // with the real value and drop this heuristic.
  const inferredProgramId = dexData?.pairs.some((p) =>
    p.dexId?.toLowerCase().includes("pump")
  ) ? PROGRAMS.PUMP_FUN : null;
  const launchedFromLPBurnPad = inferredProgramId
    ? isLPBurnLaunchpad(inferredProgramId)
    : false;

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

  // Oldest dev wallet sig — needed for funding source classification
  const devWalletSigs: any[] | null = devWalletSigsResult.status === "fulfilled" ? devWalletSigsResult.value : null;
  const devWalletOldestSig: string | null = Array.isArray(devWalletSigs) && devWalletSigs.length > 0
    ? (devWalletSigs[devWalletSigs.length - 1]?.signature ?? null)
    : null;

  // Top holders and total supply from Phase 1
  const topHoldersData = topHoldersResult.status === "fulfilled" ? topHoldersResult.value : null;
  const tokenSupplyRaw = tokenSupplyResult.status === "fulfilled" ? tokenSupplyResult.value : null;
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
  const volume_1h_usd        = dexData?.volume_1h_usd        ?? birdData?.volume_1h_usd        ?? null;
  const volume_24h           = dexData?.volume_24h_usd       ?? birdData?.volume_24h_usd       ?? 0;
  const price_change_24h_pct = dexData?.price_change_24h_pct ?? birdData?.price_change_24h_pct ?? 0;
  const price_change_1h_pct  = dexData?.price_change_1h_pct  ?? birdData?.price_change_1h_pct  ?? null;
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
  const metadata_immutability: MetadataImmutability = {
    is_mutable,
    update_authority,
    risk: is_mutable === null ? "UNKNOWN" : is_mutable ? "MUTABLE" : "IMMUTABLE",
  };

  // Authority history (Helius SET_AUTHORITY + MINT_TO)
  const authority_history: AuthorityHistory = {
    mint_authority_changes: authHistoryData?.mint_authority_changes ?? 0,
    authority_ever_regranted: authHistoryData?.authority_ever_regranted ?? false,
    post_launch_mints: authHistoryData?.post_launch_mints ?? 0,
  };

  // Dilution risk
  const total_supply = securityData?.total_supply ?? null;
  const dilution_risk: DilutionRisk = {
    total_supply,
    post_launch_mints: authority_history.post_launch_mints,
    risk: authority_history.post_launch_mints > 0 ? "HIGH"
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
    rugcheck_risk_score: rugData?.rugcheck_risk_score ?? null,
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
    post_launch_mints: authority_history.post_launch_mints,
    adjusted_top_10_holder_pct: adjusted_holder_concentration.adjusted_top_10_pct,
    dev_funder_type: devWalletForAge ? dev_funding_source.funder_type : null,
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
    const devSolBalance = mintAuthAddress
      ? await getSolBalance(mintAuthAddress, 3000)
      : null;
    const funding_risk_note: string | null =
      dev_funding_source.funder_type === "MIXER"        ? "Dev wallet funded via mixer — high anonymous funding risk"
      : dev_funding_source.funder_type === "DEPLOYER"   ? "Dev wallet funded by deployer-pattern wallet — elevated risk"
      : dev_funding_source.funder_type === "FRESH_WALLET" ? "Dev wallet funded by fresh wallet — possible proxy setup"
      : null;
    dev_wallet_analysis = {
      address: mintAuthAddress ?? "unknown",
      sol_balance: devSolBalance ?? 0,
      created_tokens_count: 0, // requires tx history — unavailable on public RPC
      previous_rugs: has_rug_history,
      funding_source: devWalletForAge ? dev_funding_source : null,
      funding_risk_note,
    };
  }

  // LP lock — cannot be verified via on-chain lock program without specialised API
  const liquidity_lock_status: LiquidityLockStatus = {
    locked: false,
    lock_duration_days: 0,
    locked_pct: 0,
  };

  // ── Trading pattern ───────────────────────────────────────────────────────
  const unique_buyers_24h = dexData?.pair?.txns?.h24?.buys ?? 0;
  const wash_trading_score = deriveWashTradingScore(buy_sell_ratio_1h, volume_24h || null, liquidity_usd);
  const wash_method: "HEURISTIC" | "CIRCULAR_SWAP" = circular_pairs > 0 ? "CIRCULAR_SWAP" : "HEURISTIC";
  const trading_pattern: TradingPattern = {
    buy_sell_ratio_1h: buy_sell_ratio_1h ?? 0.5,
    unique_buyers_24h,
    wash_trading_score,
    circular_pairs,
    wash_method,
  };

  // ── Momentum score ────────────────────────────────────────────────────────
  const momentum_score = deriveMomentumScore(volume_1h_usd, volume_24h || null, price_change_1h_pct, buy_sell_ratio_1h);

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
    : (rugData?.rugcheck_risk_score ?? 0) > 2000 ? "MEDIUM"
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

  // ── Wallet analysis (adversarial layer) ───────────────────────────────────
  const dev_wallet_linked = dev_wallet_analysis.sol_balance !== null && dev_wallet_analysis.sol_balance > 0;
  const wallet_analysis = {
    clustered_wallets: bundled_launch_detected ? 3 : 0,   // heuristic — bundled = coordinated wallets
    insider_control_percent: rugData?.insider_flags ? 15 : null, // heuristic from flag
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
  const key_drivers = buildKeyDrivers(scoringFactors);

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
    rugcheck_risk_score: rugData?.rugcheck_risk_score ?? null,
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
  };
}
