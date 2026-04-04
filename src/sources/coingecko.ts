// ---------------------------------------------------------------------------
// CoinGecko ATH provider
// Uses the contract lookup endpoint to get ATH for Solana tokens.
// Requires COINGECKO_API_KEY in environment for reliable access.
// ---------------------------------------------------------------------------

export async function getCoinGeckoATH(
  mintAddress: string,
  currentPriceUsd: number,
  options: { timeout: number }
): Promise<number | null> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    console.warn("[coingecko] COINGECKO_API_KEY not set — skipping ATH lookup");
    return null;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/solana/contract/${mintAddress}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-cg-demo-api-key": apiKey,
    };

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeout),
    });

    if (!res.ok) {
      console.warn(`[coingecko] HTTP ${res.status} for ${mintAddress}`);
      return null;
    }

    const data = await res.json() as {
      market_data?: { ath?: { usd?: number } };
    };

    const ath = data?.market_data?.ath?.usd;
    if (typeof ath !== "number" || ath <= 0) return null;

    return ath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[coingecko] ATH lookup failed: ${msg}`);
    return null;
  }
}
