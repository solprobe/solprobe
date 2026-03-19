import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";

const BASE_URL = "https://public-api.solscan.io/token/meta";

export interface SolscanTokenMeta {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  icon: string | null;
  website: string | null;
  twitter: string | null;
}

interface RawSolscanMeta {
  name?: string;
  symbol?: string;
  decimals?: number;
  icon?: string;
  website?: string;
  twitter?: string;
}

interface RawSolscanResponse {
  success?: boolean;
  data?: RawSolscanMeta;
  // Some versions return fields directly at top level
  name?: string;
  symbol?: string;
  decimals?: number;
}

export async function getSolscanMeta(
  address: string,
  options: { timeout?: number } = {}
): Promise<SolscanTokenMeta | null> {
  if (!isAvailable("solscan")) return null;

  const timeout = options.timeout ?? 4000;
  const url = `${BASE_URL}?tokenAddress=${encodeURIComponent(address)}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (process.env.SOLSCAN_API_KEY) {
    headers["token"] = process.env.SOLSCAN_API_KEY;
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch (err) {
    recordFailure("solscan");
    throw err;
  }

  if (res.status === 400 || res.status === 404) return null;

  if (!res.ok) {
    recordFailure("solscan");
    const err = new Error(`Solscan HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const json = (await res.json()) as RawSolscanResponse;
  recordSuccess("solscan");

  // Handle both wrapped ({ success, data }) and flat response shapes
  const d: RawSolscanMeta = json.data ?? (json as RawSolscanMeta);

  return {
    name: d.name ?? null,
    symbol: d.symbol ?? null,
    decimals: d.decimals ?? null,
    icon: d.icon ?? null,
    website: d.website ?? null,
    twitter: d.twitter ?? null,
  };
}
