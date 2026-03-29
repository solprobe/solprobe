import { getDexScreenerToken, type DexScreenerTokenData } from "../sources/dexscreener.js";
import { getBirdeyeToken, getTokenOHLCV, type BirdeyeTokenData } from "../sources/birdeye.js";
import { scoreConfidence } from "./riskScorer.js";
import { deduplicate, getOrFetch } from "../cache.js";
import {
  generateMarketIntelSummary,
  fallbackMarketIntelSummary,
  type MarketIntelData,
} from "../llm/narrativeEngine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MarketIntelResult {
  current_price_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  large_txs_last_hour: number;  // txs > $10k (estimated from volume/count)
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  pct_from_ath: number | null;          // % below all-time high (negative = below ATH)
  ath_price_usd: number | null;         // ATH price from Birdeye OHLCV history
  market_summary: string;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
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
  if (health === "LOW_ACTIVITY" && pct_from_ath !== null && pct_from_ath < -80) {
    return "BEARISH";
  }
  if (health === "DECLINING" && rawSignal === "NEUTRAL") return "BEARISH";
  return rawSignal;
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
  let data_confidence = scoreConfidence(sources, Date.now() - fetchStart);

  // Health-based confidence cap
  if (token_health === "DEAD" || token_health === "ILLIQUID") {
    data_confidence = "LOW";
  } else if (token_health === "LOW_ACTIVITY" && data_confidence === "HIGH") {
    data_confidence = "MEDIUM";
  }

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
    current_price_usd,
    price_change_1h_pct,
    price_change_24h_pct,
    volume_1h_usd,
    volume_24h_usd,
    liquidity_usd,
    buy_pressure,
    sell_pressure,
    large_txs_last_hour,
    signal,
    token_health,
    pct_from_ath,
    ath_price_usd,
    market_summary,
    data_confidence,
  };
}
