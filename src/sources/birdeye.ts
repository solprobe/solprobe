import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL = "https://public-api.birdeye.so/defi/token_overview";
const OHLCV_URL = "https://public-api.birdeye.so/defi/ohlcv";

export interface BirdeyeTokenData {
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_1h_usd: number | null;
  volume_24h_usd: number | null;
  price_change_1h_pct: number | null;
  price_change_24h_pct: number | null;
}

interface RawBirdeyeData {
  price?: number | null;
  liquidity?: number | null;
  v1h?: number | null;
  v24h?: number | null;
  priceChange1hPercent?: number | null;
  priceChange24hPercent?: number | null;
}

interface RawBirdeyeResponse {
  success?: boolean;
  data?: RawBirdeyeData;
}

export async function getBirdeyeToken(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenData | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 4000;
  const url = `${BASE_URL}?address=${encodeURIComponent(address)}`;
  const start = Date.now();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-chain": "solana",
  };
  if (process.env.BIRDEYE_API_KEY) {
    headers["X-API-KEY"] = process.env.BIRDEYE_API_KEY;
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch (err) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    throw err;
  }

  if (res.status === 400 || res.status === 404) return null;

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    const err = new Error(`Birdeye HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const json = (await res.json()) as RawBirdeyeResponse;

  if (!json.success || !json.data) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    throw new Error("Birdeye returned success=false");
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");
  const d = json.data;

  return {
    price_usd: d.price ?? null,
    liquidity_usd: d.liquidity ?? null,
    volume_1h_usd: d.v1h ?? null,
    volume_24h_usd: d.v24h ?? null,
    price_change_1h_pct: d.priceChange1hPercent ?? null,
    price_change_24h_pct: d.priceChange24hPercent ?? null,
  };
}

export async function getTokenOHLCV(
  address: string,
  options: { timeout: number }
): Promise<{ ath_price_usd: number; candles: number } | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (!isAvailable("birdeye")) return null;

  const start = Date.now();
  const timeFrom = Math.floor(Date.now() / 1000) - 365 * 2 * 24 * 60 * 60; // 2 years
  const timeTo   = Math.floor(Date.now() / 1000);
  const url = `${OHLCV_URL}?address=${encodeURIComponent(address)}&type=1D&time_from=${timeFrom}&time_to=${timeTo}&chain=solana`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json", "x-chain": "solana" },
      signal: AbortSignal.timeout(options.timeout),
    });
  } catch (err) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  const data = await res.json() as { data?: { items?: Array<{ h?: number }> } };
  const items = data?.data?.items ?? [];

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");

  if (!items.length) return null;

  const ath_price_usd = Math.max(...items.map((c) => c.h ?? 0));
  return { ath_price_usd, candles: items.length };
}
