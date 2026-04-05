import { getDexScreenerToken, type DexScreenerTokenData, type DexScreenerPair } from "../sources/dexscreener.js";
import { getBirdeyeTokenOverview, getTokenOHLCV, getBirdeyeOHLCV, type BirdeyeTokenOverview, type OHLCVCandle } from "../sources/birdeye.js";
import { getCoinGeckoATH } from "../sources/coingecko.js";
import { calculateConfidence, confidenceToString } from "./riskScorer.js";
import { deduplicate, getOrFetch } from "../cache.js";
import {
  generateMarketIntelSummary,
  fallbackMarketIntelSummary,
  type MarketIntelData,
} from "../llm/narrativeEngine.js";
import type { ScoringFactor, SignalSubtype, OHLCVSummary, LiquidityConcentration, TokenMaturity, TradingVelocity, MomentumAlignment } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-timeframe data (Fix 2)
// ---------------------------------------------------------------------------

export interface MarketTimeframe {
  price_change_pct: number | null;
  volume_usd: number | null;
  txns: number | null;
  buys: number | null;
  sells: number | null;
  buy_volume_usd: number | null;
  sell_volume_usd: number | null;
  unique_wallets: number | null;
  buy_sell_ratio: number | null;
  buy_sell_pressure: "HIGH" | "MEDIUM" | "LOW";
}

export interface MarketIntelResult {
  schema_version: "2.0";
  current_price_usd: number;
  price_change_5m_pct: number | null;
  price_change_15m_pct: number | null;  // mapped from Birdeye 30m (no 15m available)
  price_change_1h_pct: number;
  price_change_6h_pct: number | null;   // mapped from Birdeye 8h (no 6h available)
  price_change_24h_pct: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  /** Numeric buy/(buy+sell) ratio e.g. 0.62 */
  buy_sell_ratio: number;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  /** Which timeframe the buy/sell pressure is derived from */
  buy_pressure_window: string;
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  large_txs_last_hour: number;  // txs > $10k (estimated from volume/count)
  /** Derived from short-term price variance */
  volatility: "LOW" | "MEDIUM" | "HIGH";
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  /** Composite signal score (-100 to +100) */
  signal_score: number;
  signal_subtype: SignalSubtype;
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  pct_from_ath: number | null;          // % below all-time high (negative = below ATH)
  ath_price_usd: number | null;         // ATH price from multi-provider aggregation
  /** Which provider supplied the ATH value */
  ath_source: string | null;
  /** Structured ATH distance context */
  ath_context: AthContext;
  /** Market capitalisation from Birdeye (primary) or DexScreener FDV (fallback) */
  market_cap_usd: number | null;
  /** Structured rug risk assessment */
  rug_risk: RugRisk;
  /** Static guidance for the current signal */
  signal_guidance: SignalGuidance;

  // 24h participant counts (Fix 6)
  txns_24h: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  makers_24h: number | null;      // unique_wallet_24h
  buyers_24h: number | null;      // not available split — null
  sellers_24h: number | null;     // not available split — null
  buy_volume_24h_usd: number | null;
  sell_volume_24h_usd: number | null;

  /** Multi-timeframe market data (Fix 2) */
  timeframes: {
    "5m": MarketTimeframe;
    "30m": MarketTimeframe;    // Birdeye has 30m not 15m
    "1h": MarketTimeframe;
    "8h": MarketTimeframe;     // Birdeye has 8h not 6h
    "24h": MarketTimeframe;
  };

  /** OHLCV candle data: last 1H candle + 24h aggregated summary */
  ohlcv: { "1h": OHLCVCandle | null; "24h": OHLCVSummary | null };
  /** Liquidity spread across DEX pools */
  liquidity_concentration: LiquidityConcentration;
  /** Token age and maturity bracket */
  token_maturity: TokenMaturity;
  /** Short-term trading velocity and bot-activity detection */
  trading_velocity: TradingVelocity;
  /** Multi-timeframe momentum alignment */
  momentum_alignment: MomentumAlignment;

  market_summary: string;
  /** Backwards-compat string confidence derived from numeric confidence */
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Structured confidence breakdown */
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  /** Structured breakdown of signal contributors */
  factors: ScoringFactor[];
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  /** Total response time in milliseconds */
  response_time_ms: number;
}

// ---------------------------------------------------------------------------
// Derived signal helpers
// ---------------------------------------------------------------------------

function derivePressure(
  buySellRatio: number | null
): { buy_pressure: "HIGH" | "MEDIUM" | "LOW"; sell_pressure: "HIGH" | "MEDIUM" | "LOW" } {
  if (buySellRatio == null) {
    return { buy_pressure: "MEDIUM", sell_pressure: "MEDIUM" };
  }
  if (buySellRatio > 0.65) return { buy_pressure: "HIGH",   sell_pressure: "LOW" };
  if (buySellRatio > 0.55) return { buy_pressure: "MEDIUM", sell_pressure: "LOW" };
  if (buySellRatio < 0.35) return { buy_pressure: "LOW",    sell_pressure: "HIGH" };
  if (buySellRatio < 0.45) return { buy_pressure: "LOW",    sell_pressure: "MEDIUM" };
  return { buy_pressure: "MEDIUM", sell_pressure: "MEDIUM" };
}

function classifyTokenHealth(data: {
  volume_24h_usd: number;
  liquidity_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
}): "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD" {
  const vol = data.volume_24h_usd;
  const liq = data.liquidity_usd;
  const ch1h = data.price_change_1h_pct;
  const ch24h = data.price_change_24h_pct;

  if (vol < 1_000 || liq < 1_000)  return "DEAD";
  if (liq < 5_000)                  return "ILLIQUID";
  if (vol < 10_000)                 return "LOW_ACTIVITY";
  if (ch1h < -5 && ch24h < -20)    return "DECLINING";
  return "ACTIVE";
}

/**
 * Weighted signal scoring algorithm — replaces computeRawSignal + deriveSignal.
 * Returns a composite score (-100 to +100) and derived signal direction.
 *
 * Components (weights sum to 1.0):
 *   price_change  0.30 — 1h price momentum clamped to [-30, +30]
 *   buy_sell      0.25 — buy/sell ratio deviation from neutral (0.5)
 *   vol_liq       0.20 — volume-to-liquidity ratio (trading intensity)
 *   large_txs     0.15 — large transaction count signal
 *   rug_risk      0.10 — rug risk penalty (negative only)
 */
function deriveSignalAndScore(data: {
  price_change_1h_pct: number;
  buy_sell_ratio: number | null;
  volume_24h_usd: number;
  liquidity_usd: number;
  large_txs_last_hour: number;
  rug_risk_score: number; // 0–13 (scaled internally to 0–100)
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  pct_from_ath: number | null;
  momentum_score?: number;   // from MomentumAlignment (-3 to +3)
  bot_activity_flag?: boolean;
}): { signal: "BULLISH" | "BEARISH" | "NEUTRAL"; signal_score: number } {
  // Health overrides — force BEARISH before scoring
  if (data.token_health === "DEAD" || data.token_health === "ILLIQUID") {
    return { signal: "BEARISH", signal_score: -80 };
  }
  if (data.token_health === "LOW_ACTIVITY" && (data.pct_from_ath === null || data.pct_from_ath < -80)) {
    return { signal: "BEARISH", signal_score: -60 };
  }

  const bsr = data.buy_sell_ratio ?? 0.5;

  // Component 1: price momentum — clamp to [-30, +30], scale to [-100, +100]
  const priceRaw = Math.max(-30, Math.min(30, data.price_change_1h_pct));
  const priceComponent = (priceRaw / 30) * 100;

  // Component 2: buy/sell pressure — deviation from 0.5, scale to [-100, +100]
  const bsComponent = ((bsr - 0.5) / 0.5) * 100;

  // Component 3: volume-to-liquidity ratio (higher = more intense trading)
  const vlRatio = data.liquidity_usd > 0 ? data.volume_24h_usd / data.liquidity_usd : 0;
  const vlComponent = Math.max(-100, Math.min(100, (vlRatio - 1) * 50));

  // Component 4: large transactions signal — guard < 3 txs (too few to weight)
  const ltxComponent = data.large_txs_last_hour < 3 ? 0 : Math.min(100, data.large_txs_last_hour * 20);

  // Component 5: rug risk — negative only, scale 0–13 → 0–100
  const rugComponent = -((data.rug_risk_score / 13) * 100);

  let raw = Math.round(
    priceComponent * 0.30 +
    bsComponent   * 0.25 +
    vlComponent   * 0.20 +
    ltxComponent  * 0.15 +
    rugComponent  * 0.10
  );

  // Momentum alignment modifiers
  const ms = data.momentum_score ?? 0;
  if (ms >= 2)       raw += 10;  // STRONG_BULL: all timeframes agree bullish
  else if (ms <= -2) raw -= 10;  // STRONG_BEAR: all timeframes agree bearish
  else if (ms === 0 && (data.momentum_score !== undefined)) raw = Math.round(raw * 0.9); // DIVERGENT

  // Bot activity penalty — wash-trading degrades signal confidence
  if (data.bot_activity_flag) raw = Math.round(raw * 0.8);

  const signal_score = Math.max(-100, Math.min(100, raw));

  let signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  if (signal_score >= 25) signal = "BULLISH";
  else if (signal_score <= -25) signal = "BEARISH";
  else signal = "NEUTRAL";

  // Health-based downgrade
  if (data.token_health === "DECLINING" && signal === "NEUTRAL") signal = "BEARISH";

  return { signal, signal_score };
}

function deriveVolatility(data: {
  price_change_5m_pct: number | null;
  price_change_15m_pct: number | null;
  price_change_1h_pct: number | null;
}): "LOW" | "MEDIUM" | "HIGH" {
  const ref = data.price_change_5m_pct ?? data.price_change_15m_pct ?? data.price_change_1h_pct ?? 0;
  const abs = Math.abs(ref);
  if (data.price_change_5m_pct !== null) {
    if (abs > 5) return "HIGH";
    if (abs > 2) return "MEDIUM";
    return "LOW";
  }
  if (data.price_change_15m_pct !== null) {
    if (abs > 10) return "HIGH";
    if (abs > 4) return "MEDIUM";
    return "LOW";
  }
  if (abs > 20) return "HIGH";
  if (abs > 8) return "MEDIUM";
  return "LOW";
}

function deriveSignalSubtype(data: {
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  volume_24h_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  pct_from_ath: number | null;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  liquidity_usd: number;
  buy_sell_ratio: number;
}): SignalSubtype {
  const ch1h  = data.price_change_1h_pct;
  const ch24h = data.price_change_24h_pct;
  const ath   = data.pct_from_ath;
  const liq   = data.liquidity_usd;

  if (data.token_health === "DEAD" || data.token_health === "ILLIQUID") {
    return (ath !== null && ath < -80) ? "POST_RUG_STAGNATION" : "NO_VOLUME_ACTIVITY";
  }
  if (data.token_health === "LOW_ACTIVITY") return "NO_VOLUME_ACTIVITY";

  // Low liquidity trap — signal present but too thin to trade safely
  if (liq < 25_000 && data.signal !== "NEUTRAL") return "LOW_LIQUIDITY_TRAP";

  // Sell pressure dominance — sustained numeric imbalance
  if (data.buy_sell_ratio < 0.3 && data.sell_pressure === "HIGH") return "SELL_PRESSURE_DOMINANCE";

  // Momentum breakdown — recent bullish run reversing with volume
  if (ch1h < -10 && ch24h > 10 && data.volume_24h_usd > 50_000) return "MOMENTUM_BREAKDOWN";

  if (ch1h > 20 && data.buy_pressure === "HIGH" && data.sell_pressure === "LOW") return "EARLY_PUMP";
  if (data.sell_pressure === "HIGH" && ch24h < -10 && data.volume_24h_usd > 10_000) return "DISTRIBUTION_PHASE";
  if (ath !== null && ath < -80 && data.volume_24h_usd < 50_000 && liq < 100_000) return "POST_RUG_STAGNATION";
  if (Math.abs(ch1h) > 30) return "HIGH_SPECULATION";
  if (data.signal === "BEARISH" && data.token_health === "ACTIVE") return "NORMAL_CORRECTION";
  if (data.signal === "BULLISH" && data.buy_pressure !== "LOW") return "ORGANIC_GROWTH";

  return "NONE";
}

/** Reconcile subtype with token_health — prevent contradictions */
function reconcileSubtype(
  subtype: SignalSubtype,
  health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD",
): SignalSubtype {
  if (health === "ACTIVE" && subtype === "POST_RUG_STAGNATION") return "NORMAL_CORRECTION";
  if (health === "ACTIVE" && subtype === "NO_VOLUME_ACTIVITY") return "NONE";
  return subtype;
}

// ---------------------------------------------------------------------------
// Rug risk heuristic (Fix 7)
// ---------------------------------------------------------------------------

export type RugRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export interface RugRisk {
  score: number;         // 0–13 (sum of 5 components, each 0–3)
  level: RugRiskLevel;
  meaning: string;
  action_guidance: string;
  components_available: string[]; // names of fields that contributed
}

const RUG_RISK_GUIDANCE: Record<RugRiskLevel, { meaning: string; action_guidance: string }> = {
  LOW:     { meaning: "No significant rug risk indicators detected.", action_guidance: "Proceed based on other signals." },
  MEDIUM:  { meaning: "Some rug risk indicators present — elevated caution warranted.", action_guidance: "Verify holder distribution and LP status before acting." },
  HIGH:    { meaning: "Multiple rug risk indicators detected — high probability of adverse outcome.", action_guidance: "Avoid or use minimal position size only." },
  UNKNOWN: { meaning: "Insufficient data to assess rug risk.", action_guidance: "Do not rely on rug risk signals. Verify independently." },
};

/**
 * Rug risk heuristic — 5 components, each scoring 0–3 points (max 13 total).
 * Thresholds: 0–1 LOW, 2–3 MEDIUM, ≥4 HIGH.
 */
function calculateRugRiskLevel(data: {
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  top_10_holder_pct: number | null;
  deployer_sold_pct_last_1h: number | null;
  liquidity_dropped_48h_pct: number | null;
}): RugRisk {
  const components_available: string[] = [];
  let score = 0;

  // Component 1: Liquidity floor (0–3)
  if (data.liquidity_usd !== null) {
    components_available.push("liquidity_usd");
    const liq = data.liquidity_usd;
    if (liq < 1_000) score += 3;
    else if (liq < 5_000) score += 2;
    else if (liq < 10_000) score += 1;
  }

  // Component 2: Liquidity-to-mcap ratio (0–3)
  if (data.market_cap_usd !== null && data.market_cap_usd > 0 && data.liquidity_usd !== null) {
    components_available.push("liq_mcap_ratio");
    const ratio = data.liquidity_usd / data.market_cap_usd;
    if (ratio < 0.01) score += 3;
    else if (ratio < 0.05) score += 2;
    else if (ratio < 0.1) score += 1;
  }

  // Component 3: Holder concentration (0–3)
  if (data.top_10_holder_pct !== null) {
    components_available.push("top_10_holder_pct");
    if (data.top_10_holder_pct > 90) score += 3;
    else if (data.top_10_holder_pct > 70) score += 2;
    else if (data.top_10_holder_pct > 50) score += 1;
  }

  // Component 4: Deployer selling (0–2)
  if (data.deployer_sold_pct_last_1h !== null) {
    components_available.push("deployer_sold_pct_last_1h");
    if (data.deployer_sold_pct_last_1h > 50) score += 2;
    else if (data.deployer_sold_pct_last_1h > 20) score += 1;
  }

  // Component 5: Liquidity drop (0–2)
  if (data.liquidity_dropped_48h_pct !== null) {
    components_available.push("liquidity_dropped_48h_pct");
    if (data.liquidity_dropped_48h_pct > 50) score += 2;
    else if (data.liquidity_dropped_48h_pct > 25) score += 1;
  }

  if (components_available.length === 0) {
    return { score: 0, level: "UNKNOWN", ...RUG_RISK_GUIDANCE.UNKNOWN, components_available };
  }

  const level: RugRiskLevel =
    score >= 4 ? "HIGH" :
    score >= 2 ? "MEDIUM" : "LOW";

  return { score, level, ...RUG_RISK_GUIDANCE[level], components_available };
}

// ---------------------------------------------------------------------------
// Signal guidance (Fix 8) — static per signal type
// ---------------------------------------------------------------------------

export interface SignalGuidance {
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  meaning: string;
  action_guidance: string;
  score_context: string;
}

const SIGNAL_GUIDANCE_LOOKUP: Record<"BULLISH" | "BEARISH" | "NEUTRAL", Omit<SignalGuidance, "signal">> = {
  BULLISH: {
    meaning: "Buying pressure exceeds selling pressure with positive price momentum.",
    action_guidance: "Conditions favor entry. Validate with structural safety (sol_quick_scan) before acting.",
    score_context: "Score > +25 indicates bullish bias; higher scores reflect stronger conviction across multiple components.",
  },
  BEARISH: {
    meaning: "Selling pressure exceeds buying pressure with negative price momentum.",
    action_guidance: "Conditions favor exit or avoidance. If holding, consider reducing position size.",
    score_context: "Score < -25 indicates bearish bias; lower scores reflect stronger conviction across multiple components.",
  },
  NEUTRAL: {
    meaning: "No clear directional bias — buying and selling pressure are balanced.",
    action_guidance: "No immediate action implied. Wait for directional confirmation before acting.",
    score_context: "Score between -25 and +25 indicates no dominant direction. May shift quickly.",
  },
};

function deriveSignalGuidance(signal: "BULLISH" | "BEARISH" | "NEUTRAL"): SignalGuidance {
  return { signal, ...SIGNAL_GUIDANCE_LOOKUP[signal] };
}

// ---------------------------------------------------------------------------
// ATH context (Fix 11) — structured distance classification
// ---------------------------------------------------------------------------

export type AthDistance = "NEAR_ATH" | "MODERATE_DECLINE" | "SIGNIFICANT_DECLINE" | "EXTREME_DECLINE" | "UNKNOWN";

export interface AthContext {
  distance: AthDistance;
  meaning: string;
  action_guidance: string;
}

const ATH_CONTEXT_LOOKUP: Record<AthDistance, { meaning: string; action_guidance: string }> = {
  NEAR_ATH: {
    meaning: "Price is within 20% of all-time high.",
    action_guidance: "Resistance near ATH is common. Consider partial profit-taking if holding.",
  },
  MODERATE_DECLINE: {
    meaning: "Price is 20–50% below all-time high.",
    action_guidance: "Normal correction range. Evaluate other signals before entry.",
  },
  SIGNIFICANT_DECLINE: {
    meaning: "Price is 50–80% below all-time high.",
    action_guidance: "Significant drawdown — verify structural safety and liquidity before considering entry.",
  },
  EXTREME_DECLINE: {
    meaning: "Price is more than 80% below all-time high — not necessarily project failure; many active tokens trade far below ATH.",
    action_guidance: "Large drawdown from peak. Cross-reference token_health and volume before drawing conclusions.",
  },
  UNKNOWN: {
    meaning: "ATH data unavailable — cannot assess distance from peak.",
    action_guidance: "Do not rely on ATH signals. Verify independently if price history matters to your decision.",
  },
};

function deriveAthContext(pct_from_ath: number | null): AthContext {
  if (pct_from_ath === null) return { distance: "UNKNOWN", ...ATH_CONTEXT_LOOKUP.UNKNOWN };
  const abs = Math.abs(pct_from_ath);
  if (abs <= 20) return { distance: "NEAR_ATH", ...ATH_CONTEXT_LOOKUP.NEAR_ATH };
  if (abs <= 50) return { distance: "MODERATE_DECLINE", ...ATH_CONTEXT_LOOKUP.MODERATE_DECLINE };
  if (abs <= 80) return { distance: "SIGNIFICANT_DECLINE", ...ATH_CONTEXT_LOOKUP.SIGNIFICANT_DECLINE };
  return { distance: "EXTREME_DECLINE", ...ATH_CONTEXT_LOOKUP.EXTREME_DECLINE };
}

// ---------------------------------------------------------------------------
// Multi-provider ATH aggregation
// ---------------------------------------------------------------------------

/**
 * Resolve ATH from multiple providers with sanity validation.
 * CoinGecko is primary (most reliable historical data), Birdeye is secondary.
 * Sanity bounds: ATH must be >= 0.5x current price AND <= 50x current price
 * (or 10000x for micro-cap tokens under $0.001).
 */
async function resolveATH(
  address: string,
  currentPriceUsd: number,
  birdeyeAth: number | null,
): Promise<{ ath_price_usd: number | null; ath_source: string | null }> {
  // Ceiling multiplier: micro-cap tokens can have extreme ATH ratios
  const maxMultiple = currentPriceUsd < 0.001 ? 10_000 : 50;
  const minMultiple = 0.5; // ATH can't be less than half current price

  function isSane(ath: number): boolean {
    if (ath <= 0 || currentPriceUsd <= 0) return false;
    const ratio = ath / currentPriceUsd;
    return ratio >= minMultiple && ratio <= maxMultiple;
  }

  // Try CoinGecko first (most reliable for established tokens)
  let cgAth: number | null = null;
  try {
    cgAth = await getCoinGeckoATH(address, currentPriceUsd, { timeout: 4000 });
  } catch {
    // swallow — fallback to Birdeye
  }

  if (cgAth !== null && isSane(cgAth)) {
    return { ath_price_usd: cgAth, ath_source: "coingecko" };
  }

  if (birdeyeAth !== null && isSane(birdeyeAth)) {
    return { ath_price_usd: birdeyeAth, ath_source: "birdeye" };
  }

  // Both failed sanity or returned null — try whichever is non-null without sanity
  // (prefer CoinGecko data even if outside bounds over nothing)
  if (cgAth !== null && cgAth > 0) {
    return { ath_price_usd: cgAth, ath_source: "coingecko" };
  }
  if (birdeyeAth !== null && birdeyeAth > 0) {
    return { ath_price_usd: birdeyeAth, ath_source: "birdeye" };
  }

  return { ath_price_usd: null, ath_source: null };
}

/**
 * Estimate number of transactions > $10k last hour.
 * DexScreener doesn't expose individual tx sizes; we approximate using
 * total h1 volume and h1 transaction count with a simple size-ratio heuristic.
 */
function estimateLargeTxs(
  volume1h: number | null,
  h1Buys: number,
  h1Sells: number
): number {
  if (volume1h == null || volume1h === 0) return 0;
  const totalTxns = h1Buys + h1Sells;
  if (totalTxns === 0) return 0;
  const avgSize = volume1h / totalTxns;
  if (avgSize >= 10000) return totalTxns;
  if (avgSize >= 1000) return Math.floor(totalTxns * avgSize / 10000);
  return 0;
}

/**
 * Build market intel factors array from signal contributors.
 * Every factor that influences the signal must appear here.
 */
function buildMarketFactors(data: {
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  signal_subtype: SignalSubtype;
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  volume_1h_usd: number;
  volume_24h_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  liquidity_usd: number;
  pct_from_ath: number | null;
  large_txs_last_hour: number;
}): ScoringFactor[] {
  const sf: ScoringFactor[] = [];

  // Token health
  const healthImpact =
    data.token_health === "DEAD" ? -40 :
    data.token_health === "ILLIQUID" ? -30 :
    data.token_health === "LOW_ACTIVITY" ? -15 :
    data.token_health === "DECLINING" ? -10 : 0;
  sf.push({
    name: "token_health",
    value: data.token_health,
    impact: healthImpact,
    interpretation: `token health: ${data.token_health.toLowerCase().replace("_", " ")}`,
  });

  // Price momentum
  const p1hImpact = data.price_change_1h_pct > 5 ? 10 : data.price_change_1h_pct < -5 ? -10 : 0;
  sf.push({
    name: "price_change_1h",
    value: data.price_change_1h_pct,
    impact: p1hImpact,
    interpretation: `${data.price_change_1h_pct >= 0 ? "+" : ""}${data.price_change_1h_pct.toFixed(1)}% 1h price change`,
  });

  const p24hImpact = data.price_change_24h_pct > 10 ? 10 : data.price_change_24h_pct < -10 ? -10 : 0;
  sf.push({
    name: "price_change_24h",
    value: data.price_change_24h_pct,
    impact: p24hImpact,
    interpretation: `${data.price_change_24h_pct >= 0 ? "+" : ""}${data.price_change_24h_pct.toFixed(1)}% 24h price change`,
  });

  // Volume
  const volImpact =
    data.volume_1h_usd > 500_000 ? 10 :
    data.volume_1h_usd > 100_000 ? 5 :
    data.volume_1h_usd < 1_000   ? -15 :
    data.volume_1h_usd < 10_000  ? -5 : 0;
  sf.push({
    name: "volume_1h_usd",
    value: data.volume_1h_usd,
    impact: volImpact,
    interpretation: `$${(data.volume_1h_usd / 1000).toFixed(0)}k 1h volume`,
  });

  // Buy pressure
  const buyImpact =
    data.buy_pressure === "HIGH" ? 10 :
    data.buy_pressure === "LOW"  ? -5 : 0;
  sf.push({
    name: "buy_pressure",
    value: data.buy_pressure,
    impact: buyImpact,
    interpretation: `${data.buy_pressure.toLowerCase()} buy pressure`,
  });

  // Sell pressure
  const sellImpact =
    data.sell_pressure === "HIGH" ? -10 :
    data.sell_pressure === "LOW"  ? 5 : 0;
  sf.push({
    name: "sell_pressure",
    value: data.sell_pressure,
    impact: sellImpact,
    interpretation: `${data.sell_pressure.toLowerCase()} sell pressure`,
  });

  // ATH distance
  if (data.pct_from_ath !== null) {
    const athImpact =
      data.pct_from_ath < -90 ? -20 :
      data.pct_from_ath < -80 ? -15 :
      data.pct_from_ath < -50 ? -5 : 0;
    sf.push({
      name: "pct_from_ath",
      value: data.pct_from_ath,
      impact: athImpact,
      interpretation: `${data.pct_from_ath.toFixed(0)}% from ATH`,
    });
  }

  // Large tx activity
  if (data.large_txs_last_hour > 0) {
    sf.push({
      name: "large_txs_last_hour",
      value: data.large_txs_last_hour,
      impact: data.large_txs_last_hour > 5 ? 10 : 5,
      interpretation: `${data.large_txs_last_hour} large txs (>$10k) last hour`,
    });
  }

  // Signal subtype context
  if (data.signal_subtype !== "NONE") {
    const subtypeImpact =
      data.signal_subtype === "EARLY_PUMP" || data.signal_subtype === "ORGANIC_GROWTH" ? 10 :
      data.signal_subtype === "POST_RUG_STAGNATION" || data.signal_subtype === "DISTRIBUTION_PHASE" ? -15 : 0;
    sf.push({
      name: "signal_subtype",
      value: data.signal_subtype,
      impact: subtypeImpact,
      interpretation: data.signal_subtype.toLowerCase().replace(/_/g, " "),
    });
  }

  return sf;
}

// ---------------------------------------------------------------------------
// Feature computation helpers (Features 1–5)
// ---------------------------------------------------------------------------

function buildOHLCVSummary(candles: OHLCVCandle[]): OHLCVSummary {
  const volume_usd = candles.reduce((s, c) => s + c.volume_usd, 0);
  const high_usd   = candles.reduce((max, c) => Math.max(max, c.high), 0);
  const low_usd    = candles.reduce((min, c) => Math.min(min, c.low), Infinity);
  const vwap_usd   = volume_usd > 0
    ? candles.reduce((s, c) => s + c.close * c.volume_usd, 0) / volume_usd
    : null;
  return {
    candles: candles.length,
    volume_usd,
    high_usd,
    low_usd: low_usd === Infinity ? 0 : low_usd,
    vwap_usd: vwap_usd !== null ? Math.round(vwap_usd * 1e9) / 1e9 : null,
  };
}

function buildLiquidityConcentration(pairs: DexScreenerPair[]): LiquidityConcentration {
  const withLiq = pairs.filter(p => (p.liquidity?.usd ?? 0) > 0);
  if (withLiq.length === 0) {
    return { total_pools: pairs.length, top_pool_share_pct: null, dominant_dex: null, risk: "UNKNOWN" };
  }
  const total = withLiq.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const sorted = [...withLiq].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const topLiq = sorted[0].liquidity?.usd ?? 0;
  const top_pool_share_pct = total > 0 ? (topLiq / total) * 100 : null;
  const dominant_dex = sorted[0].dexId ?? null;
  const risk: LiquidityConcentration["risk"] =
    top_pool_share_pct === null ? "UNKNOWN" :
    top_pool_share_pct > 90    ? "HIGH" :
    top_pool_share_pct > 60    ? "MEDIUM" : "LOW";
  return { total_pools: pairs.length, top_pool_share_pct, dominant_dex, risk };
}

function buildTokenMaturity(
  firstTradeUnixTime: number | null,
  pairs: DexScreenerPair[]
): TokenMaturity {
  // Try Birdeye firstTradeUnixTime first (Unix seconds)
  if (firstTradeUnixTime !== null) {
    const age_hours = (Date.now() / 1000 - firstTradeUnixTime) / 3600;
    const bracket: TokenMaturity["bracket"] =
      age_hours < 1    ? "NEW" :
      age_hours < 24   ? "YOUNG" :
      age_hours < 168  ? "ESTABLISHED" : "MATURE";
    return { first_trade_unix_time: firstTradeUnixTime, age_hours: Math.round(age_hours), bracket, source: "birdeye" };
  }
  // Fallback: oldest pairCreatedAt from DexScreener (milliseconds → seconds)
  const pairTimes = pairs
    .map(p => p.pairCreatedAt)
    .filter((t): t is number => typeof t === "number" && t > 0);
  if (pairTimes.length > 0) {
    const oldestMs = Math.min(...pairTimes);
    const oldestSec = oldestMs > 1e12 ? oldestMs / 1000 : oldestMs; // normalise ms vs s
    const age_hours = (Date.now() / 1000 - oldestSec) / 3600;
    const bracket: TokenMaturity["bracket"] =
      age_hours < 1    ? "NEW" :
      age_hours < 24   ? "YOUNG" :
      age_hours < 168  ? "ESTABLISHED" : "MATURE";
    return { first_trade_unix_time: Math.round(oldestSec), age_hours: Math.round(age_hours), bracket, source: "dexscreener" };
  }
  return { first_trade_unix_time: null, age_hours: null, bracket: "UNKNOWN", source: null };
}

function buildTradingVelocity(
  birdData: BirdeyeTokenOverview | null,
  candles15m: OHLCVCandle[]
): TradingVelocity {
  const txns_per_hour = birdData?.trade_1h ?? null;
  const volume_1h_usd = birdData?.volume_1h_usd ?? null;
  const usd_per_tx =
    txns_per_hour !== null && txns_per_hour > 0 && volume_1h_usd !== null
      ? volume_1h_usd / txns_per_hour
      : null;

  // Std dev of 15m candle USD volumes (need ≥ 4 candles)
  let candle_vol_std_dev: number | null = null;
  if (candles15m.length >= 4) {
    const vols = candles15m.map(c => c.volume_usd);
    const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
    const variance = vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length;
    candle_vol_std_dev = Math.round(Math.sqrt(variance) * 100) / 100;
  }

  const bot_activity_flag =
    usd_per_tx !== null && usd_per_tx < 1 &&
    txns_per_hour !== null && txns_per_hour > 500;

  return { txns_per_hour, usd_per_tx, candle_vol_std_dev, bot_activity_flag };
}

function buildMomentumAlignment(changes: {
  change_5m:  number | null;
  change_30m: number | null;
  change_1h:  number | null;
}): MomentumAlignment {
  const timeframes_used: string[] = [];
  let score = 0;

  function vote(val: number | null, label: string): void {
    if (val === null) return;
    timeframes_used.push(label);
    if (val > 1)  score += 1;
    else if (val < -1) score -= 1;
    // flat (between -1% and +1%) contributes 0
  }

  vote(changes.change_5m,  "5m");
  vote(changes.change_30m, "30m");
  vote(changes.change_1h,  "1h");

  const n = timeframes_used.length;
  const aligned = n > 0 && Math.abs(score) === n; // all agree on same direction

  const direction: MomentumAlignment["direction"] =
    n === 0             ? "UNKNOWN" :
    score >= 1          ? "BULL" :
    score <= -1         ? "BEAR" :
    /* score == 0 */      "MIXED";

  return { score, aligned, direction, timeframes_used };
}

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
}

// ---------------------------------------------------------------------------
// Timeframe helpers (Fix 2)
// ---------------------------------------------------------------------------

function deriveTimeframePressure(volume_usd: number | null): "HIGH" | "MEDIUM" | "LOW" {
  if (volume_usd === null) return "LOW";
  if (volume_usd >= 100_000) return "HIGH";
  if (volume_usd >= 10_000) return "MEDIUM";
  return "LOW";
}

function buildTimeframe(data: {
  price_change_pct: number | null;
  volume_usd: number | null;
  txns: number | null;
  buys: number | null;
  sells: number | null;
  buy_volume_usd: number | null;
  sell_volume_usd: number | null;
  unique_wallets: number | null;
}): MarketTimeframe {
  const buy_sell_ratio =
    data.buys !== null && data.sells !== null && (data.buys + data.sells) > 0
      ? data.buys / (data.buys + data.sells)
      : null;
  return {
    ...data,
    buy_sell_ratio,
    buy_sell_pressure: deriveTimeframePressure(data.buy_volume_usd),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function marketIntel(address: string): Promise<MarketIntelResult> {
  const cacheKey = `sol_market_intel:${address}`;
  return deduplicate(cacheKey, () => getOrFetch(cacheKey, () => _fetchMarketIntel(address)));
}

async function _fetchMarketIntel(address: string): Promise<MarketIntelResult> {
  const fetchStart = Date.now();

  const nowSec = Math.floor(Date.now() / 1000);

  // Parallel fetch: Birdeye overview (primary — aggregates ALL pools), DexScreener (fallback), OHLCV
  const [birdResult, dexResult, ohlcvResult, ohlcv1hResult, ohlcv15mResult] = await Promise.allSettled([
    getBirdeyeTokenOverview(address, { timeout: 4000 }),
    getDexScreenerToken(address, { timeout: 4000 }),
    getTokenOHLCV(address, { timeout: 5000 }),
    getBirdeyeOHLCV(address, "1H",  nowSec - 86_400, nowSec, { timeout: 4000 }),  // last 24h daily candles
    getBirdeyeOHLCV(address, "15m", nowSec - 7_200,  nowSec, { timeout: 4000 }),  // last 2h for std dev
  ]);

  const birdData: BirdeyeTokenOverview | null =
    birdResult.status === "fulfilled" ? birdResult.value : null;
  const dexData: DexScreenerTokenData | null =
    dexResult.status === "fulfilled" ? dexResult.value : null;
  const ohlcvData = ohlcvResult.status === "fulfilled" ? ohlcvResult.value : null;
  const candles1h: OHLCVCandle[]  = (ohlcv1hResult.status  === "fulfilled" && ohlcv1hResult.value)  ? ohlcv1hResult.value  : [];
  const candles15m: OHLCVCandle[] = (ohlcv15mResult.status === "fulfilled" && ohlcv15mResult.value) ? ohlcv15mResult.value : [];

  if (birdResult.status === "rejected") logError("birdeye",     birdResult.reason, address);
  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);

  // Merge fields — Birdeye primary (aggregates ALL pools), DexScreener fallback
  const current_price_usd    = birdData?.price_usd            ?? dexData?.price_usd            ?? 0;
  const price_change_1h_pct  = birdData?.price_change_1h_pct  ?? dexData?.price_change_1h_pct  ?? 0;
  const price_change_24h_pct = birdData?.price_change_24h_pct ?? dexData?.price_change_24h_pct ?? 0;
  const volume_1h_usd        = birdData?.volume_1h_usd        ?? dexData?.volume_1h_usd        ?? 0;
  const volume_24h_usd       = birdData?.volume_24h_usd       ?? dexData?.volume_24h_usd       ?? 0;
  const liquidity_usd        = birdData?.liquidity_usd        ?? dexData?.liquidity_usd        ?? 0;

  // Short-interval price changes — only available from Birdeye
  const price_change_5m_pct: number | null  = birdData?.price_change_5m_pct  ?? null;
  const price_change_15m_pct: number | null = birdData?.price_change_30m_pct ?? null; // 30m maps to 15m slot
  const price_change_6h_pct: number | null  = birdData?.price_change_8h_pct  ?? null; // 8h maps to 6h slot

  // Buy/sell ratio — derive from Birdeye 1h counts (primary), fallback DexScreener
  let buy_sell_ratio: number | null = null;
  let buy_pressure_window = "1h";
  if (birdData?.buy_1h != null && birdData?.sell_1h != null &&
      (birdData.buy_1h + birdData.sell_1h) > 0) {
    buy_sell_ratio = birdData.buy_1h / (birdData.buy_1h + birdData.sell_1h);
    buy_pressure_window = "1h";
  } else if (dexData?.buy_sell_ratio_1h != null) {
    buy_sell_ratio = dexData.buy_sell_ratio_1h;
    buy_pressure_window = "1h_dex";
  }

  // Market cap — Birdeye primary, DexScreener fallback
  const market_cap_usd = birdData?.market_cap_usd ?? dexData?.market_cap_usd ?? null;

  // ATH + pct_from_ath — multi-provider aggregation (CoinGecko primary, Birdeye secondary)
  const birdeyeAth = ohlcvData?.ath_price_usd ?? null;
  const { ath_price_usd, ath_source } = await resolveATH(address, current_price_usd, birdeyeAth);
  const pct_from_ath = (ath_price_usd !== null && current_price_usd > 0)
    ? ((current_price_usd - ath_price_usd) / ath_price_usd) * 100
    : null;

  // Token health classification
  const token_health = classifyTokenHealth({
    volume_24h_usd,
    liquidity_usd,
    price_change_1h_pct,
    price_change_24h_pct,
  });

  // Pressure (top-level — from merged buy_sell_ratio)
  const { buy_pressure, sell_pressure } = derivePressure(buy_sell_ratio);

  // Volatility — derived from short-term price variance
  const volatility = deriveVolatility({ price_change_5m_pct, price_change_15m_pct, price_change_1h_pct });

  // Rug risk heuristic (needed before signal scoring)
  const rug_risk = calculateRugRiskLevel({
    liquidity_usd,
    market_cap_usd,
    top_10_holder_pct: null,
    deployer_sold_pct_last_1h: null,
    liquidity_dropped_48h_pct: null,
  });

  // Large tx estimate — DexScreener h1 txns preferred; fallback to Birdeye 1h counts
  const h1Txns = dexData?.pair?.txns?.h1;
  const large_txs_last_hour = estimateLargeTxs(
    volume_1h_usd || null,
    h1Txns?.buys ?? (birdData?.buy_1h ?? 0),
    h1Txns?.sells ?? (birdData?.sell_1h ?? 0)
  );

  // Feature 2: liquidity concentration
  const liquidity_concentration = buildLiquidityConcentration(dexData?.pairs ?? []);

  // Feature 3: token maturity
  const token_maturity = buildTokenMaturity(
    birdData?.first_trade_unix_time ?? null,
    dexData?.pairs ?? []
  );

  // Feature 4: trading velocity
  const trading_velocity = buildTradingVelocity(birdData, candles15m);

  // Feature 5: momentum alignment
  const momentum_alignment = buildMomentumAlignment({
    change_5m:  birdData?.price_change_5m_pct  ?? null,
    change_30m: birdData?.price_change_30m_pct ?? null,
    change_1h:  birdData?.price_change_1h_pct  ?? null,
  });

  // Feature 1: OHLCV objects
  const ohlcv_1h_candle: OHLCVCandle | null  = candles1h.length > 0 ? candles1h[candles1h.length - 1] : null;
  const ohlcv_24h_summary: OHLCVSummary | null = candles1h.length > 0 ? buildOHLCVSummary(candles1h) : null;

  // Weighted signal scoring
  const { signal, signal_score } = deriveSignalAndScore({
    price_change_1h_pct,
    buy_sell_ratio,
    volume_24h_usd,
    liquidity_usd,
    large_txs_last_hour,
    rug_risk_score: rug_risk.score,
    token_health,
    pct_from_ath,
    momentum_score: momentum_alignment.score,
    bot_activity_flag: trading_velocity.bot_activity_flag,
  });

  // Signal subtype — deterministic rules, not LLM
  const raw_subtype = deriveSignalSubtype({
    signal,
    token_health,
    volume_24h_usd,
    price_change_1h_pct,
    price_change_24h_pct,
    pct_from_ath,
    buy_pressure,
    sell_pressure,
    liquidity_usd,
    buy_sell_ratio: buy_sell_ratio ?? 0.5,
  });
  const signal_subtype = reconcileSubtype(raw_subtype, token_health);

  // Build timeframes from Birdeye overview data (Fix 2)
  const timeframes = {
    "5m": buildTimeframe({
      price_change_pct: birdData?.price_change_5m_pct ?? null,
      volume_usd: birdData?.volume_5m_usd ?? null,
      txns: birdData?.trade_5m ?? null,
      buys: birdData?.buy_5m ?? null,
      sells: birdData?.sell_5m ?? null,
      buy_volume_usd: birdData?.buy_volume_5m_usd ?? null,
      sell_volume_usd: birdData?.sell_volume_5m_usd ?? null,
      unique_wallets: birdData?.unique_wallet_5m ?? null,
    }),
    "30m": buildTimeframe({
      price_change_pct: birdData?.price_change_30m_pct ?? null,
      volume_usd: birdData?.volume_30m_usd ?? null,
      txns: birdData?.trade_30m ?? null,
      buys: birdData?.buy_30m ?? null,
      sells: birdData?.sell_30m ?? null,
      buy_volume_usd: birdData?.buy_volume_30m_usd ?? null,
      sell_volume_usd: birdData?.sell_volume_30m_usd ?? null,
      unique_wallets: birdData?.unique_wallet_30m ?? null,
    }),
    "1h": buildTimeframe({
      price_change_pct: birdData?.price_change_1h_pct ?? null,
      volume_usd: birdData?.volume_1h_usd ?? null,
      txns: birdData?.trade_1h ?? null,
      buys: birdData?.buy_1h ?? null,
      sells: birdData?.sell_1h ?? null,
      buy_volume_usd: birdData?.buy_volume_1h_usd ?? null,
      sell_volume_usd: birdData?.sell_volume_1h_usd ?? null,
      unique_wallets: birdData?.unique_wallet_1h ?? null,
    }),
    "8h": buildTimeframe({
      price_change_pct: birdData?.price_change_8h_pct ?? null,
      volume_usd: birdData?.volume_8h_usd ?? null,
      txns: birdData?.trade_8h ?? null,
      buys: birdData?.buy_8h ?? null,
      sells: birdData?.sell_8h ?? null,
      buy_volume_usd: birdData?.buy_volume_8h_usd ?? null,
      sell_volume_usd: birdData?.sell_volume_8h_usd ?? null,
      unique_wallets: birdData?.unique_wallet_8h ?? null,
    }),
    "24h": buildTimeframe({
      price_change_pct: birdData?.price_change_24h_pct ?? null,
      volume_usd: birdData?.volume_24h_usd ?? null,
      txns: birdData?.trade_24h ?? null,
      buys: birdData?.buy_24h ?? null,
      sells: birdData?.sell_24h ?? null,
      buy_volume_usd: birdData?.buy_volume_24h_usd ?? null,
      sell_volume_usd: birdData?.sell_volume_24h_usd ?? null,
      unique_wallets: birdData?.unique_wallet_24h ?? null,
    }),
  };

  // 24h participant counts from Birdeye (Fix 6)
  const txns_24h             = birdData?.trade_24h           ?? null;
  const buys_24h             = birdData?.buy_24h             ?? null;
  const sells_24h            = birdData?.sell_24h            ?? null;
  const makers_24h           = birdData?.unique_wallet_24h   ?? null;
  const buyers_24h: number | null  = null; // not available split in Birdeye
  const sellers_24h: number | null = null; // not available split in Birdeye
  const buy_volume_24h_usd   = birdData?.buy_volume_24h_usd  ?? null;
  const sell_volume_24h_usd  = birdData?.sell_volume_24h_usd ?? null;

  // Data confidence — base from sources, then cap by health
  const sources = [
    birdData !== null ? "birdeye"      : null,
    dexData  !== null ? "dexscreener"  : null,
  ].filter((s): s is string => s !== null);

  const data_age_ms = Date.now() - fetchStart;
  const confidence = calculateConfidence({
    sources_available: sources.length,
    sources_total: 2,
    data_age_ms,
    token_health,
  });
  let data_confidence = confidenceToString(confidence.model);

  // Health-based confidence cap (backwards-compat string field)
  if (token_health === "DEAD" || token_health === "ILLIQUID") {
    data_confidence = "LOW";
  } else if (token_health === "LOW_ACTIVITY" && data_confidence === "HIGH") {
    data_confidence = "MEDIUM";
  }

  // Build structured factors
  const factors = buildMarketFactors({
    signal,
    signal_subtype,
    token_health,
    buy_pressure,
    sell_pressure,
    volume_1h_usd,
    volume_24h_usd,
    price_change_1h_pct,
    price_change_24h_pct,
    liquidity_usd,
    pct_from_ath,
    large_txs_last_hour,
  });

  // Data quality
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    sources.length === 2 ? "FULL" : sources.length === 1 ? "PARTIAL" : "LIMITED";

  const missing_fields: string[] = [];
  if (birdData  === null) missing_fields.push("price", "volume", "liquidity", "buy_sell_ratio", "timeframes");
  if (dexData   === null) missing_fields.push("dexscreener_price");
  if (ohlcvData === null) missing_fields.push("ath_price_usd", "pct_from_ath");
  if (candles1h.length  === 0) missing_fields.push("ohlcv_1h", "ohlcv_24h_summary");
  if (candles15m.length === 0) missing_fields.push("candle_vol_std_dev");

  // LLM summary — skip if SLA headroom exhausted
  const llmInput: MarketIntelData = {
    current_price_usd,
    price_change_1h_pct,
    price_change_24h_pct,
    volume_1h_usd,
    volume_24h_usd,
    buy_pressure,
    sell_pressure,
    large_txs_last_hour,
    signal,
    signal_score,
    token_health,
    pct_from_ath,
    factors,
  };

  let market_summary: string;
  const elapsed = Date.now() - fetchStart;
  if (elapsed >= 9_000) {
    console.warn(`[marketIntel] skipping LLM summary — elapsed ${elapsed}ms exceeds 9000ms`);
    market_summary = fallbackMarketIntelSummary(llmInput);
  } else {
    market_summary = await generateMarketIntelSummary(llmInput);
  }

  return {
    schema_version: "2.0" as const,
    current_price_usd,
    price_change_5m_pct,
    price_change_15m_pct,
    price_change_1h_pct,
    price_change_6h_pct,
    price_change_24h_pct,
    volume_1h_usd,
    volume_24h_usd,
    liquidity_usd,
    buy_sell_ratio: buy_sell_ratio ?? 0.5,
    buy_pressure,
    buy_pressure_window,
    sell_pressure,
    large_txs_last_hour,
    volatility,
    signal,
    signal_score,
    signal_subtype,
    token_health,
    pct_from_ath,
    ath_price_usd,
    ath_source,
    ath_context: deriveAthContext(pct_from_ath),
    market_cap_usd,
    rug_risk,
    signal_guidance: deriveSignalGuidance(signal),
    txns_24h,
    buys_24h,
    sells_24h,
    makers_24h,
    buyers_24h,
    sellers_24h,
    buy_volume_24h_usd,
    sell_volume_24h_usd,
    timeframes,
    ohlcv: { "1h": ohlcv_1h_candle, "24h": ohlcv_24h_summary },
    liquidity_concentration,
    token_maturity,
    trading_velocity,
    momentum_alignment,
    market_summary,
    data_confidence,
    confidence,
    factors,
    data_quality,
    missing_fields,
    response_time_ms: Date.now() - fetchStart,
  };
}
