import { deduplicate, getOrFetch } from "../cache.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WalletRiskResult {
  wallet_age_days: number;
  total_transactions: number;
  is_bot: boolean;
  rug_involvement_count: number;
  whale_status: boolean;
  risk_score: number;             // 0–100
  trading_style: "sniper" | "hodler" | "flipper" | "bot" | "unknown";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "https://api.mainnet-beta.solana.com",
] as const;

async function rpcPost(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<any> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    if (json?.error) return null;
    return json?.result ?? null;
  } catch {
    return null;
  }
}

async function rpcWithFallback(
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<any> {
  for (const endpoint of RPC_ENDPOINTS) {
    const result = await rpcPost(endpoint, method, params, timeoutMs);
    if (result !== null) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derived signal helpers
// ---------------------------------------------------------------------------

function deriveRiskScore(
  walletAgeDays: number | null,
  totalTx: number,
  isBot: boolean,
  whaleStatus: boolean
): number {
  let score = 30; // base: moderate risk

  if (isBot) score += 30;

  if (walletAgeDays != null) {
    if (walletAgeDays < 1)  score += 25;
    else if (walletAgeDays < 7)  score += 15;
    else if (walletAgeDays > 365) score -= 10;
  } else {
    score += 10; // unknown age = slight penalty
  }

  if (whaleStatus) score += 10; // whales can dump

  if (totalTx > 500) score -= 5; // established user

  return Math.max(0, Math.min(100, score));
}

function deriveTradingStyle(
  walletAgeDays: number | null,
  totalTx: number,
  isBot: boolean
): "sniper" | "hodler" | "flipper" | "bot" | "unknown" {
  if (isBot) return "bot";

  const txPerDay = walletAgeDays != null && walletAgeDays > 0
    ? totalTx / walletAgeDays
    : null;

  if (walletAgeDays != null && walletAgeDays < 7 && totalTx > 20) return "sniper";
  if (walletAgeDays != null && walletAgeDays > 180 && totalTx < 50) return "hodler";
  if (txPerDay != null && txPerDay > 5) return "flipper";

  return "unknown";
}

function logError(context: string, err: unknown): void {
  const ts = new Date().toISOString();
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${ts} walletRisk context=${context} error=${msg}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function walletRisk(address: string): Promise<WalletRiskResult> {
  const cacheKey = `wallet:${address}`;
  return deduplicate(cacheKey, () => getOrFetch(cacheKey, () => _fetchWalletRisk(address)));
}

async function _fetchWalletRisk(address: string): Promise<WalletRiskResult> {
  // Parallel fetch: balance + recent signatures
  const [balanceResult, sigsResult] = await Promise.allSettled([
    rpcWithFallback("getBalance", [address], 5000),
    rpcWithFallback(
      "getSignaturesForAddress",
      [address, { limit: 1000 }],
      8000
    ),
  ]);

  let solBalance: number | null = null;
  let signatures: any[] | null = null;

  if (balanceResult.status === "fulfilled" && balanceResult.value !== null) {
    const rawBalance = balanceResult.value?.value;
    solBalance = typeof rawBalance === "number" ? rawBalance / 1e9 : null;
  } else if (balanceResult.status === "rejected") {
    logError("getBalance", balanceResult.reason);
  }

  if (sigsResult.status === "fulfilled" && Array.isArray(sigsResult.value)) {
    signatures = sigsResult.value;
  } else if (sigsResult.status === "rejected") {
    logError("getSignaturesForAddress", sigsResult.reason);
  }

  // Derive wallet age from oldest signature's blockTime
  let walletAgeDays: number | null = null;
  let oldestBlockTime: number | null = null;

  if (signatures && signatures.length > 0) {
    const blockTimes = signatures
      .map((s: any) => s.blockTime)
      .filter((t: any): t is number => typeof t === "number");

    if (blockTimes.length > 0) {
      oldestBlockTime = Math.min(...blockTimes);
      walletAgeDays = (Date.now() / 1000 - oldestBlockTime) / 86400;
    }
  }

  const totalTx = signatures?.length ?? 0;
  const whaleStatus = solBalance != null ? solBalance > 100 : false;

  // Bot detection: > 100 tx/day for wallets with known age, or capped-out signatures on very new wallet
  let isBot = false;
  if (walletAgeDays != null && walletAgeDays > 0) {
    const txPerDay = totalTx / walletAgeDays;
    isBot = txPerDay > 100;
  } else if (totalTx >= 1000 && walletAgeDays != null && walletAgeDays < 1) {
    isBot = true;
  }

  // Data confidence
  const gotBalance  = solBalance !== null;
  const gotSigs     = signatures !== null;
  const successCount = [gotBalance, gotSigs].filter(Boolean).length;
  const data_confidence: "HIGH" | "MEDIUM" | "LOW" =
    successCount === 2 ? "HIGH" : successCount === 1 ? "MEDIUM" : "LOW";

  const risk_score = deriveRiskScore(walletAgeDays, totalTx, isBot, whaleStatus);
  const trading_style = deriveTradingStyle(walletAgeDays, totalTx, isBot);

  return {
    wallet_age_days: walletAgeDays != null ? Math.round(walletAgeDays * 10) / 10 : 0,
    total_transactions: totalTx,
    is_bot: isBot,
    rug_involvement_count: 0,   // cross-referencing against rug DB requires specialised API
    whale_status: whaleStatus,
    risk_score,
    trading_style,
    data_confidence,
  };
}
