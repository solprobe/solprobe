import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { tryAcquire } from "../cache.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL = "https://api.dexscreener.com/latest/dex/tokens";

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string | null;
  priceChange: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  volume: {
    h1?: number;
    h6?: number;
    h24?: number;
  };
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  txns?: {
    h1?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  pairCreatedAt?: number;
}

export interface DexScreenerTokenData {
  /** Best (highest liquidity) Solana pair for this token */
  pair: DexScreenerPair | null;
  /** All Solana pairs found */
  pairs: DexScreenerPair[];
  /** Derived fields */
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_1h_usd: number | null;
  volume_24h_usd: number | null;
  price_change_1h_pct: number | null;
  price_change_24h_pct: number | null;
  /** h1 buys / (buys + sells) from best pair; null if no txn data */
  buy_sell_ratio_1h: number | null;
  /** Unix ms timestamp of pair creation (proxy for token age) */
  pair_created_at_ms: number | null;
}

/**
 * Fetch token data from DexScreener.
 *
 * Respects the circuit breaker (caller must check isAvailable before calling).
 * Uses AbortSignal.timeout() for per-call timeout enforcement.
 *
 * @param address  Solana mint address (already validated by caller)
 * @param options  timeout — ms budget for this call (default 4000)
 */
export async function getDexScreenerToken(
  address: string,
  options: { timeout?: number } = {}
): Promise<DexScreenerTokenData> {
  if (!isAvailable("dexscreener")) {
    throw new Error("DexScreener circuit breaker OPEN");
  }
  if (!tryAcquire("dexscreener")) {
    throw new Error("DexScreener rate limit exceeded");
  }

  const timeout = options.timeout ?? 4000;
  const url = `${BASE_URL}/${address}`;
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    recordSourceResult("dexscreener", false, Date.now() - start);
    recordFailure("dexscreener");
    throw err;
  }

  if (!res.ok) {
    recordSourceResult("dexscreener", false, Date.now() - start);
    recordFailure("dexscreener");
    const err = new Error(`DexScreener HTTP ${res.status}`) as any;
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    throw err;
  }

  const json = (await res.json()) as { pairs: DexScreenerPair[] | null };
  recordSourceResult("dexscreener", true, Date.now() - start);
  recordSuccess("dexscreener");
  const rawPairs: DexScreenerPair[] = json.pairs ?? [];

  // Filter to Solana pairs only
  const solanaPairs = rawPairs.filter((p) => p.chainId === "solana");

  // Pick the pair with the highest USD liquidity as the "best" pair
  const best = solanaPairs.reduce<DexScreenerPair | null>((acc, p) => {
    const liq = p.liquidity?.usd ?? 0;
    const accLiq = acc?.liquidity?.usd ?? 0;
    return liq > accLiq ? p : acc;
  }, null);

  if (!best) {
    return {
      pair: null,
      pairs: solanaPairs,
      price_usd: null,
      liquidity_usd: null,
      volume_1h_usd: null,
      volume_24h_usd: null,
      price_change_1h_pct: null,
      price_change_24h_pct: null,
      buy_sell_ratio_1h: null,
      pair_created_at_ms: null,
    };
  }

  const price_usd = best.priceUsd != null ? parseFloat(best.priceUsd) : null;
  const liquidity_usd = best.liquidity?.usd ?? null;
  const volume_1h_usd = best.volume?.h1 ?? null;
  const volume_24h_usd = best.volume?.h24 ?? null;
  const price_change_1h_pct = best.priceChange?.h1 ?? null;
  const price_change_24h_pct = best.priceChange?.h24 ?? null;

  let buy_sell_ratio_1h: number | null = null;
  const txns1h = best.txns?.h1;
  if (txns1h != null) {
    const total = txns1h.buys + txns1h.sells;
    buy_sell_ratio_1h = total > 0 ? txns1h.buys / total : null;
  }

  return {
    pair: best,
    pairs: solanaPairs,
    price_usd,
    liquidity_usd,
    volume_1h_usd,
    volume_24h_usd,
    price_change_1h_pct,
    price_change_24h_pct,
    buy_sell_ratio_1h,
    pair_created_at_ms: best.pairCreatedAt ?? null,
  };
}
