import { getDexScreenerToken, type DexScreenerTokenData } from "../sources/dexscreener.js";
import { getBirdeyeToken, getTokenOHLCV, type BirdeyeTokenData } from "../sources/birdeye.js";
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

export interface MarketIntelResult {
  schema_version: "2.0";
  current_price_usd: number;
  price_change_5m_pct: number | null;
  price_change_15m_pct: number | null;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  /** Numeric buy/(buy+sell) ratio e.g. 0.62 */
  buy_sell_ratio: number;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  large_txs_last_hour: number;  // txs > $10k (estimated from volume/count)
  /** Derived from short-term price variance */
  volatility: "LOW" | "MEDIUM" | "HIGH";
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  signal_subtype: SignalSubtype;
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  pct_from_ath: number | null;          // % below all-time high (negative = below ATH)
  ath_price_usd: number | null;         // ATH price from Birdeye OHLCV history
  market_summary: string;
  /** Backwards-compat string confidence derived from numeric confidence */
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Structured confidence breakdown */
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  /** Structured breakdown of signal contributors */
  factors: ScoringFactor[];
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
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

function computeRawSignal(
  buySellRatio: number | null,
  priceChange1h: number | null
): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const bsRatio = buySellRatio ?? 0.5;
  const p1h = priceChange1h ?? 0;

  if (bsRatio > 0.6 && p1h > 2)  return "BULLISH";
  if (bsRatio < 0.4 && p1h < -2) return "BEARISH";
  if (bsRatio > 0.65) return "BULLISH";
  if (bsRatio < 0.35) return "BEARISH";
  if (p1h > 5)  return "BULLISH";
  if (p1h < -5) return "BEARISH";

  return "NEUTRAL";
}

function deriveSignal(
  rawSignal: "BULLISH" | "BEARISH" | "NEUTRAL",
  health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD",
  pct_from_ath: number | null
): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (health === "DEAD" || health === "ILLIQUID") return "BEARISH";
  if (health === "LOW_ACTIVITY" && (pct_from_ath === null || pct_from_ath < -80)) {
    return "BEARISH";
  }
  if (health === "DECLINING" && rawSignal === "NEUTRAL") return "BEARISH";
  return rawSignal;
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
  if (ath !== null && ath < -80 && data.volume_24h_usd < 50_000) return "POST_RUG_STAGNATION";
  if (Math.abs(ch1h) > 30) return "HIGH_SPECULATION";
  if (data.signal === "BEARISH" && data.token_health === "ACTIVE") return "NORMAL_CORRECTION";
  if (data.signal === "BULLISH" && data.buy_pressure !== "LOW") return "ORGANIC_GROWTH";
  return "NONE";
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

  // Buy/sell pressure
  const pressureImpact =
    data.buy_pressure === "HIGH" && data.sell_pressure === "LOW" ? 15 :
    data.sell_pressure === "HIGH" && data.buy_pressure === "LOW" ? -15 :
    data.buy_pressure === "HIGH" ? 5 :
    data.sell_pressure === "HIGH" ? -5 : 0;
  sf.push({
    name: "buy_sell_pressure",
    value: `buy=${data.buy_pressure} sell=${data.sell_pressure}`,
    impact: pressureImpact,
    interpretation: `${data.buy_pressure.toLowerCase()} buy pressure, ${data.sell_pressure.toLowerCase()} sell pressure`,
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

  // ATH + pct_from_ath
  const ath_price_usd = ohlcvData?.ath_price_usd ?? null;
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

  // Pressure + signal (with health-based overrides)
  const { buy_pressure, sell_pressure } = derivePressure(buy_sell_ratio);
  const rawSignal = computeRawSignal(buy_sell_ratio, price_change_1h_pct || null);
  const signal = deriveSignal(rawSignal, token_health, pct_from_ath);

  // Short-interval price changes — null when Birdeye key is absent
  const price_change_5m_pct: number | null = null;
  const price_change_15m_pct: number | null = null;

  // Volatility — derived from short-term price variance
  const volatility = deriveVolatility({ price_change_5m_pct, price_change_15m_pct, price_change_1h_pct });

  // Signal subtype — deterministic rules, not LLM
  const signal_subtype = deriveSignalSubtype({
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

  // Large tx estimate (DexScreener h1 txns only)
  const h1Txns = dexData?.pair?.txns?.h1;
  const large_txs_last_hour = estimateLargeTxs(
    volume_1h_usd || null,
    h1Txns?.buys ?? 0,
    h1Txns?.sells ?? 0
  );

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
    signal_subtype,
    token_health,
    pct_from_ath,
    ath_price_usd,
    market_summary,
    data_confidence,
    confidence,
    factors,
    data_quality,
    missing_fields,
  };
}
