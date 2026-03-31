import { deduplicate, getOrFetch } from "../cache.js";
import { getDexScreenerToken } from "../sources/dexscreener.js";
import { calculateConfidence, confidenceToString } from "./riskScorer.js";
import type { ScoringFactor } from "./types.js";
import {
  generateWalletRiskSummary,
  fallbackWalletRiskSummary,
  type WalletRiskData,
} from "../llm/narrativeEngine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WalletRiskResult {
  schema_version: "2.0";

  // ── Classification ────────────────────────────────────────────────────────
  classification: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN";

  // ── Activity profile ──────────────────────────────────────────────────────
  activity: {
    wallet_age_days: number | null;
    total_trades: number;
    active_days: number;
    last_active_hours_ago: number | null;
  };

  // ── Legacy flat fields (backwards compat) ─────────────────────────────────
  wallet_age_days: number | null;
  total_transactions: number;
  tokens_traded_30d: number;

  // ── Behavioural signals ───────────────────────────────────────────────────
  win_rate_pct: number | null;
  avg_hold_time_hours: number | null;
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  pnl_estimate_30d_usdc: number | null;
  largest_single_loss_usdc: number | null;
  is_bot: boolean;
  whale_status: boolean;
  funding_wallet_risk: "HIGH" | "MEDIUM" | "LOW";

  // ── Behavior classification ───────────────────────────────────────────────
  behavior: {
    style: "SNIPER" | "MOMENTUM" | "FLIPPER" | "HODLER" | "BOT" | "DEGEN" | "LOW_ACTIVITY" | "INCONCLUSIVE";
    consistency: "LOW" | "MEDIUM" | "HIGH";
  };

  // ── Legacy flat field (backwards compat) ─────────────────────────────────
  trading_style: "sniper" | "hodler" | "flipper" | "bot" | "degen" | "unknown";

  // ── Structured score ──────────────────────────────────────────────────────
  score: {
    overall: number;
    components: {
      history_depth: number;
      behavioral_risk: number;
      counterparty_exposure: number;
    };
  };

  // ── Legacy flat field (backwards compat) ─────────────────────────────────
  risk_score: number;

  // ── Risk signals ──────────────────────────────────────────────────────────
  risk_signals: Array<{
    name: string;
    impact: "LOW" | "MEDIUM" | "HIGH";
    reason: string;
  }>;

  // ── Historical exposure ───────────────────────────────────────────────────
  historical_exposure: {
    rug_interactions: number;
    high_risk_tokens_traded: number;
  };

  // ── MEV intelligence ──────────────────────────────────────────────────────
  mev_victim_score: number;        // 0–100
  is_mev_bot: boolean;
  mev_bot_confidence: number;      // 0.0–1.0

  // ── Pump.fun intelligence ─────────────────────────────────────────────────
  pumpfun_graduation_exit_rate_pct: number | null;
  early_entry_rate_pct: number | null;

  // ── Copy-trade opportunity ────────────────────────────────────────────────
  copy_trading: {
    worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
    confidence: number;       // 0.0–1.0; capped at 0.5 when sample_size < 50
    sample_size: number;
    key_signals: string[];
    reason: string | null;    // always populated when worthiness === "UNKNOWN"
  };

  // ── Data quality ──────────────────────────────────────────────────────────
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];

  risk_summary: string;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Structured breakdown of all scoring contributors */
  factors: ScoringFactor[];
  /** Structured confidence breakdown */
  confidence: { model: number; data_completeness: number; signal_consensus: number };
}

// ---------------------------------------------------------------------------
// Copy-trading classification (CLAUDE.md: classifyCopyTrading)
// ---------------------------------------------------------------------------

interface CopyTradingResult {
  worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  confidence: number;
  sample_size: number;
  key_signals: string[];
  reason: string | null;
}

function classifyCopyTrading(data: {
  total_trades: number;
  win_rate_pct: number | null;
  avg_hold_time_hours: number | null;
  consistency: "HIGH" | "MEDIUM" | "LOW";
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  is_bot: boolean;
}): CopyTradingResult {
  if (data.is_bot) {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet classified as bot — copy-trade signal not applicable",
    };
  }

  if (data.total_trades < 20 || data.win_rate_pct === null) {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "insufficient trading history — minimum 20 closed trades required",
    };
  }

  const signals: string[] = [];
  let score = 0;

  if (data.win_rate_pct >= 60)      { score += 30; signals.push("high_win_rate"); }
  else if (data.win_rate_pct >= 45) { score += 15; }

  if (data.consistency === "HIGH")        { score += 25; signals.push("consistent_sizing"); }
  else if (data.consistency === "MEDIUM") { score += 10; }

  if (data.avg_hold_time_hours !== null &&
      data.avg_hold_time_hours >= 1 && data.avg_hold_time_hours <= 72) {
    score += 15; signals.push("disciplined_hold_time");
  }

  if (data.sniper_score < 30) { score += 10; signals.push("non_sniper_entries"); }

  if (data.rug_exit_rate_pct !== null && data.rug_exit_rate_pct > 60) {
    score += 20; signals.push("strong_rug_exit_discipline");
  }

  const raw_confidence = Math.min(1, data.total_trades / 100);
  const confidence = data.total_trades < 50
    ? Math.min(0.5, raw_confidence)
    : raw_confidence;

  const worthiness: "HIGH" | "MEDIUM" | "LOW" =
    score >= 60 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";

  return {
    worthiness,
    confidence: Math.round(confidence * 100) / 100,
    sample_size: data.total_trades,
    key_signals: signals,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// RPC / API helpers
// ---------------------------------------------------------------------------

const PRIMARY_RPC =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? "";

// Wrapped SOL mint — used for SOL price lookup
const WSOL = "So11111111111111111111111111111111111111112";

async function rpcPost<T>(
  endpoint: string,
  body: unknown,
  timeoutMs: number
): Promise<T | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    if (json?.error) return null;
    return (json?.result ?? null) as T | null;
  } catch {
    return null;
  }
}

async function rpcWithFallback<T>(
  body: unknown,
  timeoutMs: number
): Promise<T | null> {
  const r = await rpcPost<T>(PRIMARY_RPC, body, timeoutMs);
  if (r !== null) return r;
  return rpcPost<T>(FALLBACK_RPC, body, timeoutMs);
}

// Helius Enhanced API — parsed transaction history
// Returns null when HELIUS_API_KEY is absent or the call fails.
async function fetchParsedTransactions(
  walletAddress: string,
  timeoutMs: number
): Promise<ParsedTx[] | null> {
  if (!HELIUS_API_KEY) return null;
  try {
    const url =
      `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions` +
      `?api-key=${HELIUS_API_KEY}&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data as ParsedTx[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsed transaction type (Helius Enhanced API shape)
// ---------------------------------------------------------------------------

interface ParsedTx {
  signature: string;
  timestamp: number;
  type: string;
  feePayer: string;
  fee: number;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
      userAccount: string;
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Position tracking
// ---------------------------------------------------------------------------

interface TokenPosition {
  mint: string;
  firstBuyTs: number;
  lastSellTs: number | null;
  solSpent: number;    // lamports
  solReceived: number; // lamports
  isClosed: boolean;
}

function computePositions(
  walletAddress: string,
  txs: ParsedTx[]
): Map<string, TokenPosition> {
  const positions = new Map<string, TokenPosition>();
  // Sort oldest first so firstBuyTs is set to the actual first occurrence
  const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);

  for (const tx of sorted) {
    const walletData = tx.accountData.find((a) => a.account === walletAddress);
    const nativeChange = walletData?.nativeBalanceChange ?? 0;

    for (const transfer of tx.tokenTransfers) {
      if (!transfer.mint) continue;
      const { mint } = transfer;

      if (!positions.has(mint)) {
        positions.set(mint, {
          mint,
          firstBuyTs: tx.timestamp,
          lastSellTs: null,
          solSpent: 0,
          solReceived: 0,
          isClosed: false,
        });
      }
      const pos = positions.get(mint)!;

      if (transfer.toUserAccount === walletAddress) {
        // Received token = buy event
        pos.firstBuyTs = Math.min(pos.firstBuyTs, tx.timestamp);
        if (nativeChange < 0) pos.solSpent += Math.abs(nativeChange);
      } else if (transfer.fromUserAccount === walletAddress) {
        // Sent token = sell event
        pos.lastSellTs = tx.timestamp;
        pos.isClosed = true;
        if (nativeChange > 0) pos.solReceived += nativeChange;
      }
    }
  }

  return positions;
}

function computeWinRate(positions: Map<string, TokenPosition>): number | null {
  const closed = [...positions.values()].filter(
    (p) => p.isClosed && p.solSpent > 0
  );
  if (closed.length < 5) return null;
  const wins = closed.filter((p) => p.solReceived > p.solSpent).length;
  return (wins / closed.length) * 100;
}

function computeAvgHoldTime(
  positions: Map<string, TokenPosition>
): number | null {
  const closed = [...positions.values()].filter(
    (p) => p.isClosed && p.lastSellTs !== null
  );
  if (closed.length === 0) return null;
  const totalHours = closed.reduce(
    (acc, p) => acc + (p.lastSellTs! - p.firstBuyTs) / 3600,
    0
  );
  return totalHours / closed.length;
}

function computeTokensTraded30d(
  walletAddress: string,
  txs: ParsedTx[]
): number {
  const cutoff = Date.now() / 1000 - 30 * 86400;
  const mints = new Set<string>();
  for (const tx of txs) {
    if (tx.timestamp < cutoff) continue;
    for (const t of tx.tokenTransfers) {
      if (t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress) {
        mints.add(t.mint);
      }
    }
  }
  return mints.size;
}

function detectBot(
  walletAgeDays: number | null,
  totalTx: number,
  txs: ParsedTx[],
  walletAddress: string
): boolean {
  // Criterion 1: >500 tx/day average
  if (walletAgeDays !== null && walletAgeDays > 0) {
    if (totalTx / walletAgeDays > 500) return true;
  }

  // Criterion 2: uniform trade sizing (CV < 1%) across ≥10 swaps
  if (txs.length >= 20) {
    const swaps = txs.filter((t) => t.type === "SWAP");
    if (swaps.length >= 10) {
      const amounts = swaps
        .map((tx) => {
          const d = tx.accountData.find((a) => a.account === walletAddress);
          return d ? Math.abs(d.nativeBalanceChange) : 0;
        })
        .filter((v) => v > 10_000); // filter dust (<0.00001 SOL)

      if (amounts.length >= 10) {
        const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        if (mean > 0) {
          const variance =
            amounts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
            amounts.length;
          const cv = Math.sqrt(variance) / mean;
          if (cv < 0.01) return true;
        }
      }
    }
  }

  return false;
}

function deriveTradingStyle(
  isBot: boolean,
  sniperScore: number,
  avgHoldTimeHours: number | null,
  tokensTradedLast30d: number,
  winRatePct: number | null,
  totalTx: number,
  walletAgeDays: number | null,
  closedPositionCount: number
): "sniper" | "hodler" | "flipper" | "bot" | "degen" | "unknown" {
  if (isBot) return "bot";
  if (sniperScore > 60 && avgHoldTimeHours !== null && avgHoldTimeHours < 2)
    return "sniper";
  if (
    avgHoldTimeHours !== null &&
    avgHoldTimeHours < 24 &&
    tokensTradedLast30d > 20
  )
    return "flipper";
  if (
    avgHoldTimeHours !== null &&
    avgHoldTimeHours > 168 &&
    tokensTradedLast30d < 5
  )
    return "hodler";

  // Degen: frequent trader, diverse tokens, low win rate
  const txPerDay =
    walletAgeDays !== null && walletAgeDays > 0
      ? totalTx / walletAgeDays
      : null;
  if (
    txPerDay !== null &&
    txPerDay > 10 &&
    tokensTradedLast30d > 10 &&
    winRatePct !== null &&
    winRatePct < 40
  )
    return "degen";

  if (closedPositionCount < 10) return "unknown";
  return "unknown";
}

function computeRiskScore(
  walletAgeDays: number | null,
  sniperScore: number,
  winRatePct: number | null,
  rugExitRatePct: number | null,
  fundingWalletRisk: "HIGH" | "MEDIUM" | "LOW",
  isBot: boolean,
  whaleStatus: boolean
): number {
  let score = 0;

  if (sniperScore > 70) score += 25;
  else if (sniperScore > 40) score += 15;

  if (winRatePct !== null && winRatePct > 80) score += 10; // insider-level edge
  if (rugExitRatePct !== null && rugExitRatePct > 80) score += 20;
  if (fundingWalletRisk === "HIGH") score += 20;

  if (walletAgeDays !== null && walletAgeDays < 7) score += 20;
  else if (walletAgeDays !== null && walletAgeDays < 30) score += 10;

  if (isBot) score += 15;
  if (whaleStatus && sniperScore > 40) score += 15;

  return Math.max(0, Math.min(100, score));
}

function buildWalletFactors(
  walletAgeDays: number | null,
  sniperScore: number,
  winRatePct: number | null,
  rugExitRatePct: number | null,
  fundingWalletRisk: "HIGH" | "MEDIUM" | "LOW",
  isBot: boolean,
  whaleStatus: boolean
): ScoringFactor[] {
  const sf: ScoringFactor[] = [];

  if (sniperScore > 70) {
    sf.push({ name: "sniper_score", value: sniperScore, impact: 25, interpretation: "high sniper score — likely insider" });
  } else if (sniperScore > 40) {
    sf.push({ name: "sniper_score", value: sniperScore, impact: 15, interpretation: "elevated sniper score" });
  } else {
    sf.push({ name: "sniper_score", value: sniperScore, impact: 0, interpretation: "low sniper activity" });
  }

  if (winRatePct !== null && winRatePct > 80) {
    sf.push({ name: "win_rate", value: winRatePct, impact: 10, interpretation: "suspiciously high win rate — possible insider" });
  } else {
    sf.push({ name: "win_rate", value: winRatePct, impact: 0, interpretation: winRatePct !== null ? "normal win rate" : "win rate unavailable" });
  }

  if (rugExitRatePct !== null && rugExitRatePct > 80) {
    sf.push({ name: "rug_exit_rate", value: rugExitRatePct, impact: 20, interpretation: "consistently exits before rugs" });
  } else {
    sf.push({ name: "rug_exit_rate", value: rugExitRatePct, impact: 0, interpretation: rugExitRatePct !== null ? "normal rug exit rate" : "rug exit rate unavailable" });
  }

  if (fundingWalletRisk === "HIGH") {
    sf.push({ name: "funding_wallet_risk", value: fundingWalletRisk, impact: 20, interpretation: "funded by deployer or fresh wallet chain" });
  } else {
    sf.push({ name: "funding_wallet_risk", value: fundingWalletRisk, impact: 0, interpretation: `funding wallet risk: ${fundingWalletRisk.toLowerCase()}` });
  }

  if (walletAgeDays !== null && walletAgeDays < 7) {
    sf.push({ name: "wallet_age", value: walletAgeDays, impact: 20, interpretation: "very fresh wallet — high risk" });
  } else if (walletAgeDays !== null && walletAgeDays < 30) {
    sf.push({ name: "wallet_age", value: walletAgeDays, impact: 10, interpretation: "young wallet — elevated risk" });
  } else {
    sf.push({ name: "wallet_age", value: walletAgeDays, impact: 0, interpretation: walletAgeDays !== null ? `aged wallet (${Math.round(walletAgeDays)}d)` : "wallet age unknown" });
  }

  if (isBot) {
    sf.push({ name: "is_bot", value: isBot, impact: 15, interpretation: "bot-like trading detected" });
  } else {
    sf.push({ name: "is_bot", value: isBot, impact: 0, interpretation: "no bot pattern detected" });
  }

  if (whaleStatus && sniperScore > 40) {
    sf.push({ name: "whale_sniper", value: true, impact: 15, interpretation: "whale + sniper — adversarial counterparty" });
  } else {
    sf.push({ name: "whale_sniper", value: false, impact: 0, interpretation: "no whale+sniper combination" });
  }

  return sf;
}

// ---------------------------------------------------------------------------
// Phase 2 helpers — SLA-guarded
// ---------------------------------------------------------------------------

async function computeSniperScore(
  positions: Map<string, TokenPosition>,
  slaDeadlineMs: number
): Promise<number> {
  // Take the most recently traded tokens (up to 5)
  const mints = [...positions.entries()]
    .sort((a, b) => b[1].firstBuyTs - a[1].firstBuyTs)
    .slice(0, 5)
    .map(([mint]) => mint);

  if (mints.length === 0) return 0;

  let sniped = 0;
  let checked = 0;

  for (const mint of mints) {
    if (Date.now() > slaDeadlineMs) break;
    try {
      const dex = await getDexScreenerToken(mint, { timeout: 2000 });
      if (dex?.pair_created_at_ms) {
        const pos = positions.get(mint)!;
        const pairCreatedSec = dex.pair_created_at_ms / 1000;
        // Within 2 minutes of pair creation = sniper buy
        if (pos.firstBuyTs <= pairCreatedSec + 120) sniped++;
      }
      checked++;
    } catch {
      // skip token on error
    }
  }

  return checked === 0 ? 0 : Math.round((sniped / checked) * 100);
}

async function getFundingWalletRisk(
  walletAddress: string,
  oldestSig: string | null,
  timeoutMs: number
): Promise<"HIGH" | "MEDIUM" | "LOW"> {
  if (!oldestSig) return "MEDIUM";

  try {
    const tx = await rpcWithFallback<any>(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          oldestSig,
          { encoding: "json", maxSupportedTransactionVersion: 0 },
        ],
      },
      timeoutMs
    );
    if (!tx) return "MEDIUM";

    const accountKeys: string[] = tx.transaction?.message?.accountKeys ?? [];
    const preBalances: number[] = tx.meta?.preBalances ?? [];
    const postBalances: number[] = tx.meta?.postBalances ?? [];
    const walletIdx = accountKeys.indexOf(walletAddress);
    if (walletIdx === -1) return "MEDIUM";

    // Find the account whose balance decreased (the funder)
    let funderIdx = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      if (i === walletIdx) continue;
      if ((postBalances[i] ?? 0) - (preBalances[i] ?? 0) < 0) {
        funderIdx = i;
        break;
      }
    }
    if (funderIdx === -1) return "MEDIUM";

    const funderAddress = accountKeys[funderIdx];
    const funderSigs = await rpcWithFallback<any[]>(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getSignaturesForAddress",
        params: [funderAddress, { limit: 10 }],
      },
      timeoutMs
    );

    if (!funderSigs || funderSigs.length === 0) return "HIGH"; // brand-new funder

    const oldest = funderSigs[funderSigs.length - 1];
    if (!oldest?.blockTime) return "MEDIUM";

    const funderAgeDays = (Date.now() / 1000 - oldest.blockTime) / 86400;
    if (funderAgeDays < 7) return "HIGH";
    if (funderAgeDays > 365) return "LOW";
    return "MEDIUM";
  } catch {
    return "MEDIUM";
  }
}

function estimatePnL(
  positions: Map<string, TokenPosition>,
  solPriceUsd: number
): { pnl30d: number | null; largestLoss: number | null } {
  const cutoff = Date.now() / 1000 - 30 * 86400;
  let totalLamports = 0;
  let largestLossLamports = 0;
  let hasData = false;

  for (const pos of positions.values()) {
    if (pos.solSpent === 0) continue;
    if (pos.firstBuyTs < cutoff && !pos.isClosed) continue;
    hasData = true;
    const pnl = pos.solReceived - pos.solSpent;
    totalLamports += pnl;
    if (pnl < largestLossLamports) largestLossLamports = pnl;
  }

  if (!hasData) return { pnl30d: null, largestLoss: null };

  const pnl30d = (totalLamports / 1e9) * solPriceUsd;
  const largestLoss =
    largestLossLamports < 0
      ? Math.abs((largestLossLamports / 1e9) * solPriceUsd)
      : null;

  return { pnl30d, largestLoss };
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function logError(context: string, err: unknown): void {
  const ts = new Date().toISOString();
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${ts} walletRisk context=${context} error=${msg}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function walletRisk(address: string): Promise<WalletRiskResult> {
  const cacheKey = `sol_wallet_risk:${address}`;
  return deduplicate(cacheKey, () =>
    getOrFetch(cacheKey, () => _fetchWalletRisk(address))
  );
}

async function _fetchWalletRisk(address: string): Promise<WalletRiskResult> {
  const fetchStart = Date.now();
  const SLA_ABORT_MS = fetchStart + 16_000;

  // ── Phase 1: 5 parallel calls, 8 s each ──────────────────────────────────
  const [sigsResult, accountResult, assetsResult, parsedTxResult, solPriceResult] =
    await Promise.allSettled([
      // 1. Recent signatures — wallet age + total tx count
      rpcWithFallback<any[]>(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [address, { limit: 200 }],
        },
        8000
      ),
      // 2. SOL balance
      rpcWithFallback<any>(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        },
        8000
      ),
      // 3. Token holdings via Helius DAS (Helius-specific RPC method)
      rpcPost<any>(
        PRIMARY_RPC,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "getAssetsByOwner",
          params: { ownerAddress: address, page: 1, limit: 1000 },
        },
        8000
      ),
      // 4. Helius Enhanced parsed transactions (requires API key)
      fetchParsedTransactions(address, 8000),
      // 5. SOL price — needed for PnL estimation
      getDexScreenerToken(WSOL, { timeout: 4000 }),
    ]);

  if (sigsResult.status    === "rejected") logError("getSignaturesForAddress", sigsResult.reason);
  if (accountResult.status === "rejected") logError("getAccountInfo",          accountResult.reason);
  if (assetsResult.status  === "rejected") logError("getAssetsByOwner",        assetsResult.reason);
  if (parsedTxResult.status === "rejected") logError("parsedTransactions",     parsedTxResult.reason);

  // Extract Phase 1 results
  const sigs: any[] | null =
    sigsResult.status === "fulfilled" && Array.isArray(sigsResult.value)
      ? sigsResult.value
      : null;

  const accountInfo: any | null =
    accountResult.status === "fulfilled" ? accountResult.value : null;

  const parsedTxs: ParsedTx[] | null =
    parsedTxResult.status === "fulfilled" ? parsedTxResult.value : null;

  const solPriceUsd: number =
    solPriceResult.status === "fulfilled" && solPriceResult.value?.price_usd != null
      ? solPriceResult.value.price_usd
      : 150; // fallback price

  // ── Basic signals from signatures ────────────────────────────────────────
  const totalTx = sigs?.length ?? 0;
  let walletAgeDays: number | null = null;
  let oldestSig: string | null = null;

  if (sigs && sigs.length > 0) {
    const oldest = sigs[sigs.length - 1];
    oldestSig = oldest.signature ?? null;
    if (typeof oldest.blockTime === "number") {
      walletAgeDays = (Date.now() / 1000 - oldest.blockTime) / 86400;
    }
  }

  // ── SOL balance + whale status ────────────────────────────────────────────
  const lamports: number = accountInfo?.value?.lamports ?? 0;
  const solBalance = lamports / 1e9;
  const whaleStatus = solBalance > 100;

  // ── Behavioral signals from parsed transactions ───────────────────────────
  let positions = new Map<string, TokenPosition>();
  let tokensTradedLast30d = 0;

  if (parsedTxs && parsedTxs.length > 0) {
    positions = computePositions(address, parsedTxs);
    tokensTradedLast30d = computeTokensTraded30d(address, parsedTxs);
  }

  const isBot = detectBot(walletAgeDays, totalTx, parsedTxs ?? [], address);
  const winRatePct = computeWinRate(positions);
  const avgHoldTimeHours = computeAvgHoldTime(positions);
  const closedCount = [...positions.values()].filter((p) => p.isClosed).length;

  // ── PnL estimate ──────────────────────────────────────────────────────────
  const { pnl30d, largestLoss } =
    positions.size > 0
      ? estimatePnL(positions, solPriceUsd)
      : { pnl30d: null, largestLoss: null };

  // ── Phase 2: SLA-guarded async signals ────────────────────────────────────
  let sniperScore = 0;
  let fundingWalletRisk: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";

  if (Date.now() < SLA_ABORT_MS && positions.size > 0) {
    // Sniper score + funding wallet run in parallel
    const [sniperResult, fundingResult] = await Promise.allSettled([
      computeSniperScore(positions, SLA_ABORT_MS - 2000),
      getFundingWalletRisk(address, oldestSig, Math.min(3000, Math.max(500, SLA_ABORT_MS - Date.now() - 2000))),
    ]);

    sniperScore =
      sniperResult.status === "fulfilled" ? sniperResult.value : 0;
    fundingWalletRisk =
      fundingResult.status === "fulfilled" ? fundingResult.value : "MEDIUM";
  } else if (Date.now() < SLA_ABORT_MS) {
    // No positions but still try funding wallet trace
    fundingWalletRisk = await getFundingWalletRisk(
      address,
      oldestSig,
      Math.min(3000, Math.max(500, SLA_ABORT_MS - Date.now() - 2000))
    );
  }

  // ── Derived signals ───────────────────────────────────────────────────────
  const tradingStyle = deriveTradingStyle(
    isBot,
    sniperScore,
    avgHoldTimeHours,
    tokensTradedLast30d,
    winRatePct,
    totalTx,
    walletAgeDays,
    closedCount
  );

  const riskScore = computeRiskScore(
    walletAgeDays,
    sniperScore,
    winRatePct,
    null, // rug_exit_rate_pct — skipped (too expensive within SLA)
    fundingWalletRisk,
    isBot,
    whaleStatus
  );

  // ── Data confidence ───────────────────────────────────────────────────────
  const callsOk = [
    sigs !== null,
    accountInfo !== null,
    assetsResult.status === "fulfilled" && assetsResult.value !== null,
    parsedTxs !== null,
  ].filter(Boolean).length;

  const confidence = calculateConfidence({
    sources_available: callsOk,
    sources_total: 4,
    data_age_ms: Date.now() - fetchStart,
  });
  const data_confidence = confidenceToString(confidence.model);

  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    callsOk === 4 ? "FULL" : callsOk >= 2 ? "PARTIAL" : "LIMITED";

  const missing_fields: string[] = [];
  if (sigs === null)                                                  missing_fields.push("signatures");
  if (accountInfo === null)                                           missing_fields.push("sol_balance");
  if (assetsResult.status !== "fulfilled" || assetsResult.value === null) missing_fields.push("token_holdings");
  if (parsedTxs === null)                                             missing_fields.push("parsed_transactions");
  // rug_exit_rate_pct and high_risk_tokens_traded require quickScan cross-calls — outside SLA
  missing_fields.push("rug_exit_rate_pct", "high_risk_tokens_traded");

  // ── Scoring factors ───────────────────────────────────────────────────────
  const factors = buildWalletFactors(
    walletAgeDays,
    sniperScore,
    winRatePct,
    null,
    fundingWalletRisk,
    isBot,
    whaleStatus
  );

  // ── Structured score (CLAUDE.md: calculateWalletScore) ────────────────────
  let behavioral_risk = 0;
  if (sniperScore > 70)                                                behavioral_risk += 25;
  else if (sniperScore > 40)                                           behavioral_risk += 15;
  if (winRatePct !== null && winRatePct > 80)                          behavioral_risk += 10;
  if (isBot)                                                           behavioral_risk += 15;
  behavioral_risk = Math.min(100, behavioral_risk);

  let history_depth = 0;
  if (walletAgeDays !== null && walletAgeDays < 7)                     history_depth += 20;
  else if (walletAgeDays !== null && walletAgeDays < 30)               history_depth += 10;
  history_depth = Math.min(100, history_depth);

  let counterparty_exposure = 0;
  if (fundingWalletRisk === "HIGH")                                     counterparty_exposure += 20;
  if (whaleStatus && sniperScore > 40)                                  counterparty_exposure += 15;
  counterparty_exposure = Math.min(100, counterparty_exposure);

  const score_overall = Math.min(100, Math.max(0, behavioral_risk + history_depth + counterparty_exposure));

  // ── Classification (CLAUDE.md: classifyWallet) ────────────────────────────
  const strongSignals = factors.filter(f => f.impact >= 20).length;
  const classification: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN" =
    (totalTx < 10 || (walletAgeDays !== null && walletAgeDays < 7) || walletAgeDays === null)
      ? "UNKNOWN"
      : (score_overall >= 70 && strongSignals >= 2)
        ? "HIGH_RISK"
        : score_overall < 40
          ? "LOW_RISK"
          : "UNKNOWN";

  // ── Activity profile ──────────────────────────────────────────────────────
  const activeDays = parsedTxs && parsedTxs.length > 0
    ? new Set(parsedTxs.map(tx => {
        const ts = (tx as any).timestamp ?? (tx as any).blockTime;
        return ts ? new Date(ts * 1000).toDateString() : null;
      }).filter(Boolean)).size
    : 0;

  const lastActiveSig = sigs && sigs.length > 0 ? sigs[0] : null;
  const lastActiveHoursAgo = lastActiveSig && typeof (lastActiveSig as any).blockTime === "number"
    ? (Date.now() / 1000 - (lastActiveSig as any).blockTime) / 3600
    : null;

  // ── Behavior classification ───────────────────────────────────────────────
  const behaviorStyle: "SNIPER" | "MOMENTUM" | "FLIPPER" | "HODLER" | "BOT" | "DEGEN" | "LOW_ACTIVITY" | "INCONCLUSIVE" =
    totalTx < 10
      ? "LOW_ACTIVITY"
      : tradingStyle === "bot"     ? "BOT"
      : tradingStyle === "sniper"  ? "SNIPER"
      : tradingStyle === "flipper" ? "FLIPPER"
      : tradingStyle === "hodler"  ? "HODLER"
      : tradingStyle === "degen"   ? "DEGEN"
      : "INCONCLUSIVE";

  // consistency derived from trade amount variance (approximated from closedCount vs tokens)
  const consistency: "LOW" | "MEDIUM" | "HIGH" =
    closedCount >= 10 && tokensTradedLast30d > 0
      ? closedCount / Math.max(tokensTradedLast30d, 1) > 2 ? "HIGH" : "MEDIUM"
      : "LOW";

  // ── Risk signals ──────────────────────────────────────────────────────────
  const risk_signals: Array<{ name: string; impact: "LOW" | "MEDIUM" | "HIGH"; reason: string }> = [];

  if (totalTx < 10 || walletAgeDays === null || (walletAgeDays !== null && walletAgeDays < 7)) {
    risk_signals.push({
      name: "low_history",
      impact: "MEDIUM",
      reason: `only ${totalTx} trades found — insufficient evidence for strong classification`,
    });
  }
  if (sniperScore > 70) {
    risk_signals.push({ name: "high_sniper_score", impact: "HIGH", reason: `sniper score ${sniperScore} — likely early buy coordination` });
  } else if (sniperScore > 40) {
    risk_signals.push({ name: "elevated_sniper_score", impact: "MEDIUM", reason: `sniper score ${sniperScore} — some sniping patterns present` });
  }
  if (winRatePct !== null && winRatePct > 80) {
    risk_signals.push({ name: "high_win_rate", impact: "MEDIUM", reason: `win rate ${winRatePct.toFixed(1)}% — possible information edge` });
  }
  if (fundingWalletRisk === "HIGH") {
    risk_signals.push({ name: "high_funding_risk", impact: "HIGH", reason: "funded by deployer or fresh wallet chain" });
  }
  if (isBot) {
    risk_signals.push({ name: "bot_detected", impact: "HIGH", reason: "transaction pattern consistent with automated bot activity" });
  }

  // ── Historical exposure (rug_interactions requires cross-token scan — outside SLA) ─
  const historical_exposure = {
    rug_interactions: 0,        // populated by cross-token scan — outside 20s SLA
    high_risk_tokens_traded: 0, // populated by cross-token scan — outside 20s SLA
  };

  // ── LLM summary ───────────────────────────────────────────────────────────
  const elapsed = Date.now() - fetchStart;
  const walletAgeDaysRounded = walletAgeDays !== null ? Math.round(walletAgeDays * 10) / 10 : null;

  const llmData: WalletRiskData = {
    classification,
    activity: {
      wallet_age_days: walletAgeDaysRounded,
      total_trades: totalTx,
      active_days: activeDays,
      last_active_hours_ago: lastActiveHoursAgo !== null ? Math.round(lastActiveHoursAgo * 10) / 10 : null,
    },
    wallet_age_days: walletAgeDaysRounded,
    trading_style: tradingStyle,
    win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
    sniper_score: sniperScore,
    rug_exit_rate_pct: null,
    funding_wallet_risk: fundingWalletRisk,
    risk_score: riskScore,
    is_bot: isBot,
    pnl_estimate_30d_usdc: pnl30d !== null ? Math.round(pnl30d * 100) / 100 : null,
  };

  let risk_summary: string;
  if (elapsed >= 18_000) {
    console.warn(`[walletRisk] skipping LLM summary — elapsed ${elapsed}ms exceeds 18000ms`);
    risk_summary = fallbackWalletRiskSummary(llmData);
  } else {
    risk_summary = await generateWalletRiskSummary(llmData);
  }

  return {
    schema_version: "2.0" as const,

    // ── Classification ──────────────────────────────────────────────────────
    classification,

    // ── Activity profile ────────────────────────────────────────────────────
    activity: {
      wallet_age_days: walletAgeDaysRounded,
      total_trades: totalTx,
      active_days: activeDays,
      last_active_hours_ago: lastActiveHoursAgo !== null ? Math.round(lastActiveHoursAgo * 10) / 10 : null,
    },

    // ── Legacy flat fields ──────────────────────────────────────────────────
    wallet_age_days: walletAgeDaysRounded,
    total_transactions: totalTx,
    tokens_traded_30d: tokensTradedLast30d,

    // ── Behavioural signals ─────────────────────────────────────────────────
    win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
    avg_hold_time_hours: avgHoldTimeHours !== null ? Math.round(avgHoldTimeHours * 10) / 10 : null,
    sniper_score: sniperScore,
    rug_exit_rate_pct: null,
    pnl_estimate_30d_usdc: pnl30d !== null ? Math.round(pnl30d * 100) / 100 : null,
    largest_single_loss_usdc: largestLoss !== null ? Math.round(largestLoss * 100) / 100 : null,
    is_bot: isBot,
    whale_status: whaleStatus,
    funding_wallet_risk: fundingWalletRisk,

    // ── Behavior classification ─────────────────────────────────────────────
    behavior: { style: behaviorStyle, consistency },

    // ── Legacy flat field ───────────────────────────────────────────────────
    trading_style: tradingStyle,

    // ── Structured score ────────────────────────────────────────────────────
    score: {
      overall: score_overall,
      components: { history_depth, behavioral_risk, counterparty_exposure },
    },

    // ── Legacy flat field ───────────────────────────────────────────────────
    risk_score: riskScore,

    // ── Risk signals ────────────────────────────────────────────────────────
    risk_signals,

    // ── Historical exposure ─────────────────────────────────────────────────
    historical_exposure,

    // ── MEV intelligence (defaults — Helius parsed tx MEV parsing not yet wired) ─
    mev_victim_score: 0,
    is_mev_bot: false,
    mev_bot_confidence: 0,

    // ── Pump.fun intelligence (defaults — requires Helius pump.fun event parsing) ─
    pumpfun_graduation_exit_rate_pct: null,
    early_entry_rate_pct: null,

    // ── Copy-trade opportunity ───────────────────────────────────────────────
    copy_trading: classifyCopyTrading({
      total_trades: closedCount,
      win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
      avg_hold_time_hours: avgHoldTimeHours !== null ? Math.round(avgHoldTimeHours * 10) / 10 : null,
      consistency,
      sniper_score: sniperScore,
      rug_exit_rate_pct: null,
      is_bot: isBot,
    }),

    // ── Data quality ────────────────────────────────────────────────────────
    data_quality,
    missing_fields,

    risk_summary,
    data_confidence,
    factors,
    confidence,
  };
}
