import { getDexScreenerToken } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo } from "../sources/helius.js";
import { getBirdeyeToken } from "../sources/birdeye.js";
import { getSolscanMeta } from "../sources/solscan.js";
import { calculateRiskGrade, scoreConfidence, type RiskFactors } from "./riskScorer.js";
import { deduplicate, getOrFetch } from "../cache.js";
import { isProtocolAddress } from "../constants.js";
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
}

export interface DeepDiveResult {
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
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
  recommendation: "BUY" | "AVOID" | "WATCH" | "DYOR";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Age in seconds of the RugCheck report used; null if RugCheck was unavailable. */
  rugcheck_report_age_seconds: number | null;
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
function deriveRecommendation(
  risk_grade: string,
  is_honeypot: boolean,
  has_rug_history: boolean,
  momentum_score: number,
  data_confidence: string
): "BUY" | "AVOID" | "WATCH" | "DYOR" {
  if (has_rug_history || is_honeypot || risk_grade === "F") return "AVOID";
  if (risk_grade === "D") return "AVOID";
  if (data_confidence === "LOW") return "DYOR";
  if (risk_grade === "A" && momentum_score >= 65) return "WATCH";
  if ((risk_grade === "A" || risk_grade === "B") && momentum_score >= 45) return "WATCH";
  if (risk_grade === "C" && momentum_score >= 70) return "WATCH";
  return "DYOR";
}

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
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
  const [dexResult, rugResult, mintResult, birdResult, scanResult, mintAuthResult] =
    await Promise.allSettled([
      getDexScreenerToken(address, { timeout: 4000 }),
      getRugCheckSummary(address, { timeout: 5000 }),
      getTokenMintInfo(address, { timeout: 3000 }),  // sole source for authority flags
      getBirdeyeToken(address, { timeout: 4000 }),
      getSolscanMeta(address, { timeout: 4000 }),
      getMintAuthorityAddress(address, 4000),
    ]);

  const dexData  = dexResult.status  === "fulfilled" ? dexResult.value  : null;
  const rugData  = rugResult.status  === "fulfilled" ? rugResult.value  : null;
  const mintData = mintResult.status === "fulfilled" ? mintResult.value : null;
  const birdData = birdResult.status === "fulfilled" ? birdResult.value : null;
  const mintAuthAddress = mintAuthResult.status === "fulfilled" ? mintAuthResult.value : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason,   address);
  if (mintResult.status === "rejected") logError("helius_rpc",  mintResult.reason,  address);
  if (birdResult.status === "rejected") logError("birdeye",     birdResult.reason,  address);
  if (scanResult.status === "rejected") logError("solscan",     scanResult.reason,  address);

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
  };
  const risk_grade = calculateRiskGrade(factors);

  // ── Deep-only signals ─────────────────────────────────────────────────────
  const pump_fun_launched = dexData?.pairs.some((p) =>
    p.dexId?.toLowerCase().includes("pump")
  ) ?? false;

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
    };
  } else {
    const devSolBalance = mintAuthAddress
      ? await getSolBalance(mintAuthAddress, 3000)
      : null;
    dev_wallet_analysis = {
      address: mintAuthAddress ?? "unknown",
      sol_balance: devSolBalance ?? 0,
      created_tokens_count: 0, // requires tx history — unavailable on public RPC
      previous_rugs: has_rug_history,
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
  const trading_pattern: TradingPattern = {
    buy_sell_ratio_1h: buy_sell_ratio_1h ?? 0.5,
    unique_buyers_24h,
    wash_trading_score,
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
  const data_confidence = scoreConfidence(
    sources,
    Date.now() - fetchStart,
    rugcheck_report_age_seconds !== null ? rugcheck_report_age_seconds : undefined
  );

  const recommendation = deriveRecommendation(risk_grade, is_honeypot, has_rug_history, momentum_score, data_confidence);

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
    recommendation,
    rugcheck_risk_score: rugData?.rugcheck_risk_score ?? null,
    insider_flags: rugData?.insider_flags ?? false,
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
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
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
  };
}
