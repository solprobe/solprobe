import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";

const BASE_URL = "https://public-api.birdeye.so/defi/token_overview";

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
    recordFailure("birdeye");
    throw err;
  }

  if (res.status === 400 || res.status === 404) return null;

  if (!res.ok) {
    recordFailure("birdeye");
    const err = new Error(`Birdeye HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const json = (await res.json()) as RawBirdeyeResponse;

  if (!json.success || !json.data) {
    recordFailure("birdeye");
    throw new Error("Birdeye returned success=false");
  }

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
