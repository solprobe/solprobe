import { getDexScreenerToken, type DexScreenerTokenData } from "../sources/dexscreener.js";
import { getBirdeyeTokenOverview, getTokenOHLCV, type BirdeyeTokenOverview } from "../sources/birdeye.js";
import { getCoinGeckoATH } from "../sources/coingecko.js";
import { calculateConfidence, confidenceToString } from "./riskScorer.js";
import { deduplicate, getOrFetch } from "../cache.js";
import {
  generateMarketIntelSummary,
  fallbackMarketIntelSummary,
  type MarketIntelData,
} from "../llm/narrativeEngine.js";
import type { ScoringFactor, SignalSubtype } from "./types.js";

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

  // Component 4: large transactions signal
  const ltxComponent = Math.min(100, data.large_txs_last_hour * 20);

  // Component 5: rug risk — negative only, scale 0–13 → 0–100
  const rugComponent = -((data.rug_risk_score / 13) * 100);

  const raw = Math.round(
    priceComponent * 0.30 +
    bsComponent   * 0.25 +
    vlComponent   * 0.20 +
    ltxComponent  * 0.15 +
    rugComponent  * 0.10
  );

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

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
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
  // Parallel fetch: DexScreener primary, Birdeye token overview + OHLCV
  const [dexResult, birdResult, ohlcvResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getBirdeyeToken(address, { timeout: 4000 }),
    getTokenOHLCV(address, { timeout: 5000 }),
  ]);

  const dexData: DexScreenerTokenData | null =
    dexResult.status === "fulfilled" ? dexResult.value : null;
  const birdData: BirdeyeTokenData | null =
    birdResult.status === "fulfilled" ? birdResult.value : null;
  const ohlcvData = ohlcvResult.status === "fulfilled" ? ohlcvResult.value : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (birdResult.status === "rejected") logError("birdeye",     birdResult.reason, address);

  // Merge fields — DexScreener primary, Birdeye fallback
  const current_price_usd    = dexData?.price_usd        ?? birdData?.price_usd        ?? 0;
  const price_change_1h_pct  = dexData?.price_change_1h_pct  ?? birdData?.price_change_1h_pct  ?? 0;
  const price_change_24h_pct = dexData?.price_change_24h_pct ?? birdData?.price_change_24h_pct ?? 0;
  const volume_1h_usd        = dexData?.volume_1h_usd    ?? birdData?.volume_1h_usd    ?? 0;
  const volume_24h_usd       = dexData?.volume_24h_usd   ?? birdData?.volume_24h_usd   ?? 0;
  const liquidity_usd        = dexData?.liquidity_usd    ?? birdData?.liquidity_usd    ?? 0;
  const buy_sell_ratio       = dexData?.buy_sell_ratio_1h ?? null;

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

  // Pressure
  const { buy_pressure, sell_pressure } = derivePressure(buy_sell_ratio);

  // Market cap from DexScreener (FDV preferred, fallback marketCap)
  const market_cap_usd = dexData?.market_cap_usd ?? null;

  // Short-interval price changes — null when Birdeye key is absent
  const price_change_5m_pct: number | null = null;
  const price_change_15m_pct: number | null = null;

  // Volatility — derived from short-term price variance
  const volatility = deriveVolatility({ price_change_5m_pct, price_change_15m_pct, price_change_1h_pct });

  // Rug risk heuristic (needed before signal scoring)
  const rug_risk = calculateRugRiskLevel({
    liquidity_usd,
    market_cap_usd,
    top_10_holder_pct: null,          // not available in market intel
    deployer_sold_pct_last_1h: null,  // not available in market intel
    liquidity_dropped_48h_pct: null,  // not available in market intel
  });

  // Large tx estimate (DexScreener h1 txns only) — needed before signal scoring
  const h1Txns = dexData?.pair?.txns?.h1;
  const large_txs_last_hour = estimateLargeTxs(
    volume_1h_usd || null,
    h1Txns?.buys ?? 0,
    h1Txns?.sells ?? 0
  );

  // Weighted signal scoring (replaces computeRawSignal + deriveSignal)
  const { signal, signal_score } = deriveSignalAndScore({
    price_change_1h_pct,
    buy_sell_ratio,
    volume_24h_usd,
    liquidity_usd,
    large_txs_last_hour,
    rug_risk_score: rug_risk.score,
    token_health,
    pct_from_ath,
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

  // Data confidence — base confidence from sources, then cap by health
  const sources = [
    dexData !== null ? "dexscreener" : null,
    birdData !== null ? "birdeye" : null,
  ].filter((s): s is string => s !== null);

  const data_age_ms = Date.now() - fetchStart;
  const rawConfidence = calculateConfidence({
    sources_available: sources.length,
    sources_total: 2,
    data_age_ms,
    token_health,
  });
  const confidence = rawConfidence;
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
  if (dexData  === null) missing_fields.push("price", "volume", "liquidity", "buy_sell_ratio");
  if (birdData === null) missing_fields.push("birdeye_price");
  if (ohlcvData === null) missing_fields.push("ath_price_usd", "pct_from_ath");

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
    price_change_24h_pct,
    volume_1h_usd,
    volume_24h_usd,
    liquidity_usd,
    buy_sell_ratio: buy_sell_ratio ?? 0.5,
    buy_pressure,
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
    market_summary,
    data_confidence,
    confidence,
    factors,
    data_quality,
    missing_fields,
    response_time_ms: Date.now() - fetchStart,
  };
}
