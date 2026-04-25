import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { tryAcquire } from "../cache.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL = "https://api.dexscreener.com/latest/dex/tokens";

// ---------------------------------------------------------------------------
// LP model classification
// ---------------------------------------------------------------------------

/** Whether the DEX uses a traditional fungible LP token (burnable) or a
 *  concentrated/dynamic liquidity model (no LP mint to burn). */
export type LPModel = "TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN";

/** Interpreted LP burn state, accounting for whether the DEX model even has
 *  an LP token to burn. */
export type LPStatus = "BURNED" | "UNBURNED" | "CUSTODIAL" | "UNKNOWN" | "NOT_APPLICABLE";

/** DexScreener dexId values known to use traditional fungible LP tokens. */
const TRADITIONAL_AMM_DEXES = new Set([
  "raydium",    // Raydium AMM v4
  "pumpfun",    // pump.fun (alternate dexId)
  "pump",       // pump.fun
  "fluxbeam",   // FluxBeam
  "saber",      // Saber
  "aldrin",     // Aldrin
  "crema",      // Crema
]);

/** DexScreener dexId values that use concentrated or dynamic liquidity —
 *  no fungible LP mint exists, so LP burn checks are not applicable. */
const CLMM_DLMM_DEXES = new Set([
  "raydiumclmm",  // Raydium CLMM
  "meteora",      // Meteora DLMM
  "meteoradlmm",  // Meteora DLMM (alternate dexId)
  "orca",         // Orca Whirlpool (all Orca pools are Whirlpool/CLMM)
  "whirlpool",    // Orca Whirlpool (alternate dexId)
  "orcawhirlpool", // Orca Whirlpool (alternate dexId)
]);

/**
 * Classify a DexScreener dexId into an LP model category.
 * Unknown dexIds return "UNKNOWN" — callers apply a mild penalty rather
 * than treating them as confirmed TRADITIONAL_AMM.
 */
export function classifyLPModel(dexId: string | null | undefined): LPModel {
  if (!dexId) return "UNKNOWN";
  const id = dexId.toLowerCase();
  if (TRADITIONAL_AMM_DEXES.has(id) || id.includes("pump")) return "TRADITIONAL_AMM";
  if (CLMM_DLMM_DEXES.has(id) || id.startsWith("meteora") || id.startsWith("orca"))
    return "CLMM_DLMM";
  return "UNKNOWN";
}

/**
 * Derive the semantic LP status from a raw burn check result and the
 * DEX model classification.
 *
 * CLMM/DLMM pools have no LP mint — always NOT_APPLICABLE regardless of
 * what the burn check returned.
 */
export function deriveLPStatus(
  lp_burned: boolean | null,
  lp_model: LPModel,
): LPStatus {
  if (lp_model === "CLMM_DLMM") return "NOT_APPLICABLE";
  if (lp_burned === true)  return "BURNED";
  if (lp_burned === false) return "UNBURNED";
  return "UNKNOWN"; // null — burn check was skipped or failed
}

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
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    liquidityToken?: { address: string } | null;
  } | null;
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
  /** LP token mint address from the best pair; null if unavailable */
  lp_mint_address: string | null;
  /** DEX model of the best pair — determines whether LP burn is meaningful */
  lp_model: LPModel;
  /** dexId of the best pair; null when no pair found */
  dex_id: string | null;
  /** Market cap (FDV preferred, fallback to marketCap); null if unavailable */
  market_cap_usd: number | null;
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
      lp_mint_address: null,
      lp_model: "UNKNOWN",
      dex_id: null,
      market_cap_usd: null,
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

  const dex_id = best.dexId ?? null;

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
    lp_mint_address: best.info?.liquidityToken?.address ?? null,
    lp_model: classifyLPModel(dex_id),
    dex_id,
    market_cap_usd: best.fdv ?? best.marketCap ?? null,
  };
}
