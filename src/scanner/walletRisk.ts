import { deduplicate, getOrFetch } from "../cache.js";
import { getDexScreenerToken } from "../sources/dexscreener.js";
import {
  getBirdeyeWalletPortfolio,
  getBirdeyeWalletPnL,
  getBirdeyeWalletPnLDetails,
  type BirdeyeWalletPortfolioItem,
  type BirdeyeWalletPnLSummary,
  type BirdeyeWalletPnLDetails,
} from "../sources/birdeye.js";
import { calculateConfidence, confidenceToString } from "./riskScorer.js";
import type { ScoringFactor, FunderType, FundingSource } from "./types.js";
import { classifyWalletFundingSource } from "../utils/walletClassifier.js";
import {
  generateWalletRiskSummary,
  fallbackWalletRiskSummary,
  type WalletRiskData,
} from "../llm/narrativeEngine.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WinRateStatus =
  | "CALCULATED"
  | "NO_CLOSED_TRADES"
  | "INSUFFICIENT_TRADES"
  | "DATA_UNAVAILABLE"
  | "HODL_ONLY";

export type WalletActivityType =
  | "ACTIVE_TRADER"
  | "HODLER"
  | "SWING_TRADER"
  | "SNIPER"
  | "BOT"
  | "INACTIVE"
  | "NEW_WALLET"
  | "UNKNOWN";

// FunderType and FundingSource are defined in types.ts — re-exported for backwards compat
export type { FunderType, FundingSource } from "./types.js";

export interface DustingAnalysis {
  dust_transactions_detected: number;
  dust_senders: string[];
  most_recent_dust_timestamp: number | null;
  dusting_risk: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  meaning: string;
  action_guidance: string;
}

export interface StructuredPnL {
  realized_pnl_usdc: number | null;
  unrealized_pnl_usdc: number | null;
  unrealized_pnl_pct: number | null;
  total_pnl_usdc: number | null;
  positions_analysed: number;
  cost_basis_method: "SOL_LAMPORTS" | "ESTIMATED" | "BIRDEYE_API";
  method_description: string;
  calculation_note: string | null;
  spam_token_filter_applied: boolean;
  filtered_spam_count: number;
}

export interface WalletRiskResult {
  schema_version: "2.0";

  // ── Classification ────────────────────────────────────────────────────────
  classification: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN";

  // ── Activity profile ──────────────────────────────────────────────────────
  activity: {
    wallet_age_days: number | null;
    total_trades: number;
    active_days: number | null;
    last_active_hours_ago: number | null;
  };

  // ── Legacy flat fields (backwards compat) ─────────────────────────────────
  wallet_age_days: number | null;
  total_transactions: number;
  tokens_traded_30d: number | null;

  // ── Behavioural signals ───────────────────────────────────────────────────
  win_rate_pct: number | null;
  win_rate_calculation_status: WinRateStatus;
  avg_hold_time_hours: number | null;
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  pnl_estimate_30d_usdc: number | null;   // backwards compat
  pnl: StructuredPnL;
  largest_single_loss_usdc: number | null;
  is_bot: boolean;
  whale_status: boolean;
  funding_wallet_risk: "HIGH" | "MEDIUM" | "LOW";  // backwards compat
  funding_source: FundingSource;

  // ── Wallet activity type ──────────────────────────────────────────────────
  wallet_activity_type: WalletActivityType;

  // ── Behavior classification ───────────────────────────────────────────────
  behavior: {
    style:
      | "SNIPER" | "MOMENTUM" | "FLIPPER" | "HODLER" | "BOT"
      | "DEGEN" | "LOW_ACTIVITY" | "INCONCLUSIVE"
      | "PRO_TRADER" | "INSIDER" | "BUNDLER";
    consistency: "LOW" | "MEDIUM" | "HIGH";
    style_confidence: number;    // 0.0–1.0
    style_evidence: string[];
    profile_summary: string;
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
    rug_interactions: number | null;
    high_risk_tokens_traded: number | null;
  };

  // ── MEV intelligence ──────────────────────────────────────────────────────
  mev_victim_score: number;        // 0–100
  is_mev_bot: boolean;
  mev_bot_confidence: number;      // 0.0–1.0

  // ── Pump.fun intelligence ─────────────────────────────────────────────────
  pumpfun_graduation_exit_rate_pct: number | null;
  early_entry_rate_pct: number | null;

  // ── Dusting analysis ──────────────────────────────────────────────────────
  dusting_analysis: DustingAnalysis;

  // ── Copy-trade opportunity ────────────────────────────────────────────────
  copy_trading: {
    worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" | "NOT_APPLICABLE";
    confidence: number;       // 0.0–1.0; capped at 0.5 when sample_size < 50
    sample_size: number;
    key_signals: string[];
    reason: string | null;    // always populated when worthiness === "UNKNOWN"
  };

  // ── Data quality ──────────────────────────────────────────────────────────
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  warnings: string[];

  risk_summary: string;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  factors: ScoringFactor[];
  confidence: { model: number; data_completeness: number; signal_consensus: number };
}

// ---------------------------------------------------------------------------
// FIX 7: Confidence cap derived from data quality
// ---------------------------------------------------------------------------

function deriveConfidenceFromQuality(
  raw: { model: number; data_completeness: number; signal_consensus: number },
  quality: "FULL" | "PARTIAL" | "LIMITED"
): { model: number; data_completeness: number; signal_consensus: number } {
  const cap = quality === "LIMITED" ? 0.4 : quality === "PARTIAL" ? 0.7 : 1.0;
  return {
    model: Math.min(raw.model, cap),
    data_completeness: Math.min(raw.data_completeness, cap),
    signal_consensus: Math.min(raw.signal_consensus, cap),
  };
}

// ---------------------------------------------------------------------------
// FIX 1: Win rate with status
// ---------------------------------------------------------------------------

function resolveWinRate(
  positions: Map<string, TokenPosition>,
  parsedTxs: ParsedTx[] | null
): { win_rate_pct: number | null; win_rate_calculation_status: WinRateStatus } {
  if (parsedTxs === null) {
    return { win_rate_pct: null, win_rate_calculation_status: "DATA_UNAVAILABLE" };
  }

  const allPositions = [...positions.values()];
  if (allPositions.length === 0) {
    return { win_rate_pct: null, win_rate_calculation_status: "NO_CLOSED_TRADES" };
  }

  const closed = allPositions.filter((p) => p.isClosed && p.solSpent > 0);
  if (closed.length === 0) {
    const hasOpen = allPositions.some((p) => !p.isClosed && p.solSpent > 0);
    return {
      win_rate_pct: null,
      win_rate_calculation_status: hasOpen ? "HODL_ONLY" : "NO_CLOSED_TRADES",
    };
  }

  if (closed.length < 5) {
    return { win_rate_pct: null, win_rate_calculation_status: "INSUFFICIENT_TRADES" };
  }

  const wins = closed.filter((p) => p.solReceived > p.solSpent).length;
  return {
    win_rate_pct: (wins / closed.length) * 100,
    win_rate_calculation_status: "CALCULATED",
  };
}

// ---------------------------------------------------------------------------
// FIX 6: Win rate calculation status — DATA_UNAVAILABLE only on fetch failure
// ---------------------------------------------------------------------------

function resolveWinRateStatus(data: {
  has_any_sells: boolean;
  closed_trades: number;
  data_fetch_failed: boolean;
}): WinRateStatus {
  if (data.data_fetch_failed) return "DATA_UNAVAILABLE";
  if (!data.has_any_sells) return "HODL_ONLY";
  if (data.closed_trades === 0) return "NO_CLOSED_TRADES";
  if (data.closed_trades < 5) return "INSUFFICIENT_TRADES";
  return "CALCULATED";
}

// ---------------------------------------------------------------------------
// Copy-trading classification (updated to handle WinRateStatus and extended styles)
// ---------------------------------------------------------------------------

interface CopyTradingResult {
  worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" | "NOT_APPLICABLE";
  confidence: number;
  sample_size: number;
  key_signals: string[];
  reason: string | null;
}

function classifyCopyTrading(data: {
  total_trades: number;
  win_rate_pct: number | null;
  win_rate_calculation_status: WinRateStatus;
  avg_hold_time_hours: number | null;
  consistency: "HIGH" | "MEDIUM" | "LOW";
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  is_bot: boolean;
  behavior_style: string;
  wallet_activity_type: WalletActivityType;
}): CopyTradingResult {
  // FIX 6: HODLER wallets — copy-trade concept does not apply.
  // Distinct from UNKNOWN (insufficient data); here the concept itself is inapplicable.
  if (data.wallet_activity_type === "HODLER") {
    return {
      worthiness: "NOT_APPLICABLE",
      confidence: 0,
      sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet is a buy-and-hold address with no trading activity — copy-trade signal not applicable",
    };
  }

  if (data.is_bot) {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet classified as bot — copy-trade signal not applicable",
    };
  }

  // INSIDER and BUNDLER signals don't transfer to copy traders
  if (data.behavior_style === "INSIDER") {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet classified as insider — copy-trade signal unreliable",
    };
  }
  if (data.behavior_style === "BUNDLER") {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet classified as bundler — copy-trade signal unreliable",
    };
  }

  // HODL_ONLY: all holdings unrealized, no closed trade signal
  if (data.win_rate_calculation_status === "HODL_ONLY") {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "no closed positions — all holdings are unrealized; insufficient signal",
    };
  }

  // NO_CLOSED_TRADES: nothing to evaluate
  if (data.win_rate_calculation_status === "NO_CLOSED_TRADES") {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "no closed trades found — insufficient trading history",
    };
  }

  // Hard gate: minimum 20 closed trades
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

  // PRO_TRADER bonus: validated skill signal
  if (data.behavior_style === "PRO_TRADER" && data.total_trades >= 50) {
    score += 10; signals.push("pro_trader_profile");
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
        pos.firstBuyTs = Math.min(pos.firstBuyTs, tx.timestamp);
        if (nativeChange < 0) pos.solSpent += Math.abs(nativeChange);
      } else if (transfer.fromUserAccount === walletAddress) {
        pos.lastSellTs = tx.timestamp;
        pos.isClosed = true;
        if (nativeChange > 0) pos.solReceived += nativeChange;
      }
    }
  }

  return positions;
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
    if (tx.timestamp && tx.timestamp < cutoff) continue;
    for (const t of (tx.tokenTransfers ?? [])) {
      if (
        t.mint &&
        (t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress)
      ) {
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
  if (walletAgeDays !== null && walletAgeDays > 0) {
    if (totalTx / walletAgeDays > 500) return true;
  }

  if (txs.length >= 20) {
    const swaps = txs.filter((t) => t.type === "SWAP");
    if (swaps.length >= 10) {
      const amounts = swaps
        .map((tx) => {
          const d = tx.accountData.find((a) => a.account === walletAddress);
          return d ? Math.abs(d.nativeBalanceChange) : 0;
        })
        .filter((v) => v > 10_000);

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
  tokensTradedLast30d: number | null,
  winRatePct: number | null,
  totalTx: number,
  walletAgeDays: number | null,
  closedPositionCount: number
): "sniper" | "hodler" | "flipper" | "bot" | "degen" | "unknown" {
  if (isBot) return "bot";
  if (sniperScore > 60 && avgHoldTimeHours !== null && avgHoldTimeHours < 2)
    return "sniper";
  if (avgHoldTimeHours !== null && avgHoldTimeHours < 24 && tokensTradedLast30d !== null && tokensTradedLast30d > 20)
    return "flipper";
  if (avgHoldTimeHours !== null && avgHoldTimeHours > 168 && (tokensTradedLast30d === null || tokensTradedLast30d < 5))
    return "hodler";
  const txPerDay =
    walletAgeDays !== null && walletAgeDays > 0 ? totalTx / walletAgeDays : null;
  if (
    txPerDay !== null && txPerDay > 10 && tokensTradedLast30d !== null && tokensTradedLast30d > 10 &&
    winRatePct !== null && winRatePct < 40
  )
    return "degen";
  if (closedPositionCount < 10) return "unknown";
  return "unknown";
}

// ---------------------------------------------------------------------------
// FIX 2: Structured PnL
// ---------------------------------------------------------------------------

function filterSpamTokens(
  tokens: BirdeyeWalletPortfolioItem[]
): { clean: BirdeyeWalletPortfolioItem[]; spam_filtered: number } {
  const clean = tokens.filter((t) => !t.is_spam && (t.value_usd ?? 0) > 0.01);
  return { clean, spam_filtered: tokens.length - clean.length };
}

function estimateStructuredPnL(
  positions: Map<string, TokenPosition>,
  solPriceUsd: number,
  portfolio: BirdeyeWalletPortfolioItem[] | null,
  birdeyePnL: BirdeyeWalletPnLSummary | null,
  pnlDetails: BirdeyeWalletPnLDetails | null
): { pnl: StructuredPnL; largestLoss: number | null } {

  // ── PRIMARY: Birdeye PnL API ──────────────────────────────────────────────
  if (birdeyePnL !== null) {
    const spamResult = portfolio !== null
      ? filterSpamTokens(portfolio)
      : { clean: [], spam_filtered: 0 };

    // Compute unrealized_pnl_pct from per-token details when available.
    // Weight by total_invested_usd so large positions dominate the average.
    let unrealized_pnl_pct: number | null = null;
    if (pnlDetails !== null && pnlDetails.tokens.length > 0) {
      let totalInvested = 0;
      let weightedPct = 0;
      for (const t of pnlDetails.tokens) {
        const invested = t.total_invested_usd ?? 0;
        const pct = t.unrealized_percent ?? null;
        if (invested > 0 && pct !== null) {
          weightedPct += pct * invested;
          totalInvested += invested;
        }
      }
      if (totalInvested > 0) {
        unrealized_pnl_pct = Math.round((weightedPct / totalInvested) * 100) / 100;
      }
    }

    const positions_analysed = pnlDetails !== null
      ? pnlDetails.tokens.length
      : (birdeyePnL.total_trades ?? 0);

    return {
      pnl: {
        realized_pnl_usdc: birdeyePnL.total_realized_pnl_usd !== null
          ? Math.round(birdeyePnL.total_realized_pnl_usd * 100) / 100
          : null,
        unrealized_pnl_usdc: birdeyePnL.total_unrealized_pnl_usd !== null
          ? Math.round(birdeyePnL.total_unrealized_pnl_usd * 100) / 100
          : null,
        unrealized_pnl_pct,
        total_pnl_usdc: birdeyePnL.total_pnl_usd !== null
          ? Math.round(birdeyePnL.total_pnl_usd * 100) / 100
          : null,
        positions_analysed,
        cost_basis_method: "BIRDEYE_API",
        method_description: pnlDetails !== null
          ? "Realized and unrealized PnL from Birdeye wallet analytics API (per-token details)"
          : "Realized and unrealized PnL from Birdeye wallet analytics API",
        calculation_note: null,
        spam_token_filter_applied: portfolio !== null,
        filtered_spam_count: spamResult.spam_filtered,
      },
      largestLoss: null,
    };
  }

  // ── FALLBACK: SOL lamport positions + portfolio snapshot ──────────────────
  const cutoff = Date.now() / 1000 - 30 * 86400;

  let realizedLamports = 0;
  let realizedCount = 0;
  let largestLossLamports = 0;

  for (const pos of positions.values()) {
    if (pos.solSpent === 0) continue;
    if (!pos.isClosed) continue;
    if (pos.firstBuyTs < cutoff && !pos.isClosed) continue;
    const positionPnl = pos.solReceived - pos.solSpent;
    realizedLamports += positionPnl;
    realizedCount++;
    if (positionPnl < largestLossLamports) largestLossLamports = positionPnl;
  }

  const realized_pnl_usdc = realizedCount > 0
    ? Math.round((realizedLamports / 1e9) * solPriceUsd * 100) / 100
    : null;

  let unrealized_pnl_usdc: number | null = null;
  let unrealized_cost_basis_usdc = 0;
  let unrealizedCount = 0;
  let portfolioMatched = 0;
  const notes: string[] = [
    "Realized PnL unavailable — Birdeye PnL API not accessible on current tier",
  ];

  const openPositions = [...positions.values()].filter(
    (p) => !p.isClosed && p.solSpent > 0
  );

  let spamFiltered = 0;
  let spamFilterApplied = false;

  if (portfolio !== null && openPositions.length > 0) {
    const { clean, spam_filtered } = filterSpamTokens(portfolio);
    spamFiltered = spam_filtered;
    spamFilterApplied = true;

    const portfolioMap = new Map<string, BirdeyeWalletPortfolioItem>();
    for (const item of clean) portfolioMap.set(item.address, item);

    let unrealizedGross = 0;
    for (const pos of openPositions) {
      const item = portfolioMap.get(pos.mint);
      const costUsd = (pos.solSpent / 1e9) * solPriceUsd;
      unrealized_cost_basis_usdc += costUsd;
      unrealizedCount++;
      if (item?.value_usd != null) {
        unrealizedGross += item.value_usd - costUsd;
        portfolioMatched++;
      }
    }
    if (portfolioMatched > 0) {
      unrealized_pnl_usdc = Math.round(unrealizedGross * 100) / 100;
    }
    if (portfolioMatched < unrealizedCount) {
      notes.push(`${unrealizedCount - portfolioMatched} open position(s) not found in portfolio`);
    }
  } else if (openPositions.length > 0) {
    notes.push("unrealized PnL unavailable — Birdeye portfolio not fetched");
  }

  const total_pnl_usdc =
    realized_pnl_usdc !== null || unrealized_pnl_usdc !== null
      ? Math.round(((realized_pnl_usdc ?? 0) + (unrealized_pnl_usdc ?? 0)) * 100) / 100
      : null;

  const unrealized_pnl_pct =
    unrealized_pnl_usdc !== null && unrealized_cost_basis_usdc > 0
      ? Math.round((unrealized_pnl_usdc / unrealized_cost_basis_usdc) * 10000) / 100
      : null;

  const largestLoss =
    largestLossLamports < 0
      ? Math.round(Math.abs((largestLossLamports / 1e9) * solPriceUsd) * 100) / 100
      : null;

  return {
    pnl: {
      realized_pnl_usdc,
      unrealized_pnl_usdc,
      unrealized_pnl_pct,
      total_pnl_usdc,
      positions_analysed: realizedCount + unrealizedCount,
      cost_basis_method: portfolio !== null ? "SOL_LAMPORTS" : "ESTIMATED",
      method_description: portfolio !== null
        ? "Realized PnL from on-chain SOL lamport net flows; unrealized from Birdeye portfolio snapshot"
        : "Estimated PnL from on-chain SOL lamport net flows only; no portfolio snapshot available",
      calculation_note: notes.join("; "),
      spam_token_filter_applied: spamFilterApplied,
      filtered_spam_count: spamFiltered,
    },
    largestLoss,
  };
}

// ---------------------------------------------------------------------------
// FIX 3: Wallet activity type
// ---------------------------------------------------------------------------

function deriveWalletActivityType(data: {
  wallet_age_days: number | null;
  total_trades: number;
  avg_hold_time_hours: number | null;
  is_bot: boolean;
  sniper_score: number;
  has_any_sells: boolean;
  last_active_hours_ago: number | null;
  tokens_traded_30d: number | null;
  portfolio_has_holdings: boolean;
}): WalletActivityType {
  if (data.wallet_age_days !== null && data.wallet_age_days < 7) return "NEW_WALLET";
  if (data.is_bot) return "BOT";
  if (data.last_active_hours_ago !== null && data.last_active_hours_ago > 720) return "INACTIVE";

  // HODLER check before trade count gate — a wallet holding tokens with no
  // sells is a HODLER regardless of whether we have full parsed tx history
  if (!data.has_any_sells && data.portfolio_has_holdings) return "HODLER";

  // Only gate on insufficient data AFTER checking HODLER pattern
  if (data.total_trades < 3 && !data.portfolio_has_holdings) return "UNKNOWN";

  if (data.sniper_score > 60 && data.avg_hold_time_hours !== null
      && data.avg_hold_time_hours < 2) return "SNIPER";
  if (data.avg_hold_time_hours !== null && data.avg_hold_time_hours > 48
      && (data.tokens_traded_30d === null || data.tokens_traded_30d < 10)) return "SWING_TRADER";
  if (data.avg_hold_time_hours !== null && data.avg_hold_time_hours < 24
      && data.tokens_traded_30d !== null && data.tokens_traded_30d > 5) return "ACTIVE_TRADER";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// FIX 4: Structured funding source
// ---------------------------------------------------------------------------


interface FundingSourceResult extends FundingSource {
  _warnings: string[];
}

async function getFundingSource(
  walletAddress: string,
  oldestSig: string | null,
  timeoutMs: number
): Promise<FundingSourceResult> {
  const result = await classifyWalletFundingSource(walletAddress, oldestSig, timeoutMs);
  return { ...result, _warnings: [] };
}

// ---------------------------------------------------------------------------
// FEATURE 5: Dusting detection
// ---------------------------------------------------------------------------

function detectDusting(
  walletAddress: string,
  txs: ParsedTx[]
): DustingAnalysis {
  if (txs.length === 0) {
    return {
      dust_transactions_detected: 0,
      dust_senders: [],
      most_recent_dust_timestamp: null,
      dusting_risk: "NONE",
      meaning: "no transaction data available",
      action_guidance: "no action required",
    };
  }

  // Build set of all known counterparties from the wallet's history
  const knownCounterparties = new Set<string>();
  for (const tx of txs) {
    for (const transfer of tx.tokenTransfers) {
      if (transfer.fromUserAccount !== walletAddress)
        knownCounterparties.add(transfer.fromUserAccount);
      if (transfer.toUserAccount !== walletAddress)
        knownCounterparties.add(transfer.toUserAccount);
    }
  }

  // Dusting criteria:
  // 1. Incoming token transfer to this wallet
  // 2. Token amount < 1.0 (fractional — likely dust in UI units)
  // 3. Sender is not in known counterparties (first and only interaction)
  const dustTxs: ParsedTx[] = [];
  const dustSenderSet = new Set<string>();

  for (const tx of txs) {
    for (const transfer of tx.tokenTransfers) {
      if (transfer.toUserAccount !== walletAddress) continue;
      if (transfer.fromUserAccount === walletAddress) continue;
      if (transfer.tokenAmount >= 1.0) continue;  // not a dust amount

      const sender = transfer.fromUserAccount;
      if (!sender) continue;

      // Only count as dust if this sender appears nowhere else in the full history
      // (i.e., the count of txs involving this sender == 1 for incoming to wallet)
      const senderInteractionCount = txs.flatMap((t) => t.tokenTransfers).filter(
        (t) =>
          (t.fromUserAccount === sender && t.toUserAccount === walletAddress) ||
          (t.toUserAccount === sender && t.fromUserAccount === walletAddress)
      ).length;

      if (senderInteractionCount === 1) {
        dustTxs.push(tx);
        dustSenderSet.add(sender);
      }
    }
  }

  const dust_transactions_detected = dustTxs.length;
  const dust_senders = [...dustSenderSet];
  const most_recent_dust_timestamp = dustTxs.length > 0
    ? Math.max(...dustTxs.map((t) => t.timestamp))
    : null;

  let dusting_risk: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  let meaning: string;
  let action_guidance: string;

  if (dust_senders.length === 0) {
    dusting_risk = "NONE";
    meaning = "no dusting activity detected";
    action_guidance = "no action required";
  } else if (dust_senders.length >= 5) {
    dusting_risk = "HIGH";
    meaning = `${dust_senders.length} unknown senders sent micro-amounts — likely active dusting campaign`;
    action_guidance = "do not interact with dust tokens; avoid approving any contracts from these senders";
  } else if (dust_senders.length >= 2) {
    dusting_risk = "MEDIUM";
    meaning = `${dust_senders.length} unknown senders sent micro-amounts — possible dusting`;
    action_guidance = "ignore dust tokens; do not send them or approve any contracts";
  } else {
    dusting_risk = "LOW";
    meaning = "1 unknown sender sent a micro-amount — isolated incident, low concern";
    action_guidance = "ignore the dust token; no action required";
  }

  return {
    dust_transactions_detected,
    dust_senders,
    most_recent_dust_timestamp,
    dusting_risk,
    meaning,
    action_guidance,
  };
}

// ---------------------------------------------------------------------------
// FEATURE 6: Extended behavior style classification
// ---------------------------------------------------------------------------

type ExtendedBehaviorStyle =
  | "SNIPER" | "MOMENTUM" | "FLIPPER" | "HODLER" | "BOT"
  | "DEGEN" | "LOW_ACTIVITY" | "INCONCLUSIVE"
  | "PRO_TRADER" | "INSIDER" | "BUNDLER";

interface BehaviorProfile {
  style: ExtendedBehaviorStyle;
  consistency: "LOW" | "MEDIUM" | "HIGH";
  style_confidence: number;
  style_evidence: string[];
  profile_summary: string;
}

function deriveBehaviorProfile(data: {
  isBot: boolean;
  sniperScore: number;
  avgHoldTimeHours: number | null;
  tokensTradedLast30d: number | null;
  winRatePct: number | null;
  totalTx: number;
  walletAgeDays: number | null;
  closedCount: number;
  earlyEntryRatePct: number | null;
  pumpfunGraduationExitRatePct: number | null;
  isMevBot: boolean;
  fundingSourceType: FunderType;
  consistency: "LOW" | "MEDIUM" | "HIGH";
}): BehaviorProfile {
  const evidence: string[] = [];
  let style: ExtendedBehaviorStyle;
  let style_confidence: number;

  if (data.totalTx < 10) {
    return {
      style: "LOW_ACTIVITY",
      consistency: "LOW",
      style_confidence: 0.9,
      style_evidence: [`only ${data.totalTx} transactions recorded`],
      profile_summary: "insufficient activity for behavioral classification",
    };
  }

  // Priority order: BOT > BUNDLER > INSIDER > PRO_TRADER > SNIPER > FLIPPER > HODLER > DEGEN > INCONCLUSIVE

  if (data.isBot) {
    evidence.push("uniform trade sizing detected", "high tx velocity");
    return {
      style: "BOT",
      consistency: "HIGH",
      style_confidence: 0.9,
      style_evidence: evidence,
      profile_summary: "automated bot — uniform sizing and/or high-frequency pattern detected",
    };
  }

  // BUNDLER: non-MEV-bot + extreme sniper + fresh funder + very early entry
  if (
    !data.isMevBot &&
    data.sniperScore >= 80 &&
    data.fundingSourceType === "FRESH_WALLET" &&
    data.earlyEntryRatePct !== null && data.earlyEntryRatePct >= 80
  ) {
    evidence.push(
      `sniper_score=${data.sniperScore}`,
      "fresh_wallet_funder",
      `early_entry_rate=${data.earlyEntryRatePct}%`
    );
    return {
      style: "BUNDLER",
      consistency: data.consistency,
      style_confidence: 0.85,
      style_evidence: evidence,
      profile_summary: "likely bundler — extreme early entry, fresh funding chain, no MEV bot pattern",
    };
  }

  // INSIDER: very high early entry + high sniper score + strong pump.fun exit discipline
  if (
    data.earlyEntryRatePct !== null && data.earlyEntryRatePct >= 70 &&
    data.sniperScore >= 60 &&
    data.pumpfunGraduationExitRatePct !== null && data.pumpfunGraduationExitRatePct >= 60
  ) {
    evidence.push(
      `early_entry_rate=${data.earlyEntryRatePct}%`,
      `sniper_score=${data.sniperScore}`,
      `pumpfun_exit_rate=${data.pumpfunGraduationExitRatePct}%`
    );
    return {
      style: "INSIDER",
      consistency: data.consistency,
      style_confidence: 0.8,
      style_evidence: evidence,
      profile_summary: "possible insider — early entries, high sniper score, consistent pre-graduation exits",
    };
  }

  // PRO_TRADER: high win rate + large sample + disciplined hold time + non-sniper
  if (
    data.winRatePct !== null && data.winRatePct >= 60 &&
    data.closedCount >= 50 &&
    data.avgHoldTimeHours !== null &&
    data.avgHoldTimeHours >= 1 && data.avgHoldTimeHours <= 72 &&
    data.sniperScore < 40
  ) {
    evidence.push(
      `win_rate=${data.winRatePct.toFixed(1)}%`,
      `${data.closedCount} closed positions`,
      `avg_hold=${data.avgHoldTimeHours.toFixed(1)}h`,
      `sniper_score=${data.sniperScore} (low)`
    );
    return {
      style: "PRO_TRADER",
      consistency: data.consistency,
      style_confidence: Math.min(0.95, 0.6 + data.closedCount / 500),
      style_evidence: evidence,
      profile_summary: "experienced trader — high win rate, disciplined hold time, non-sniper entries",
    };
  }

  // SNIPER
  if (data.sniperScore > 60 && data.avgHoldTimeHours !== null && data.avgHoldTimeHours < 2) {
    evidence.push(`sniper_score=${data.sniperScore}`, `avg_hold=${data.avgHoldTimeHours.toFixed(1)}h`);
    style = "SNIPER";
    style_confidence = 0.75;
  }
  // FLIPPER
  else if (
    data.avgHoldTimeHours !== null &&
    data.avgHoldTimeHours < 24 &&
    data.tokensTradedLast30d !== null && data.tokensTradedLast30d > 20
  ) {
    evidence.push(`avg_hold=${data.avgHoldTimeHours.toFixed(1)}h`, `${data.tokensTradedLast30d} tokens/30d`);
    style = "FLIPPER";
    style_confidence = 0.7;
  }
  // HODLER
  else if (
    data.avgHoldTimeHours !== null &&
    data.avgHoldTimeHours > 168 &&
    (data.tokensTradedLast30d === null || data.tokensTradedLast30d < 5)
  ) {
    evidence.push(`avg_hold=${data.avgHoldTimeHours.toFixed(1)}h`, `${data.tokensTradedLast30d ?? 0} tokens/30d`);
    style = "HODLER";
    style_confidence = 0.75;
  }
  // DEGEN
  else {
    const txPerDay =
      data.walletAgeDays !== null && data.walletAgeDays > 0
        ? data.totalTx / data.walletAgeDays : null;
    if (
      txPerDay !== null && txPerDay > 10 &&
      data.tokensTradedLast30d !== null && data.tokensTradedLast30d > 10 &&
      data.winRatePct !== null && data.winRatePct < 40
    ) {
      evidence.push(
        `tx_per_day=${txPerDay.toFixed(1)}`,
        `win_rate=${data.winRatePct.toFixed(1)}%`
      );
      style = "DEGEN";
      style_confidence = 0.65;
    } else if (data.closedCount < 10) {
      style = "INCONCLUSIVE";
      style_confidence = 0.3;
    } else {
      style = "INCONCLUSIVE";
      style_confidence = 0.4;
    }
  }

  const profileSummaries: Record<ExtendedBehaviorStyle, string> = {
    SNIPER: "sniper — buys within minutes of pair creation, short holds",
    FLIPPER: "flipper — high-frequency trader with short hold times",
    HODLER: "hodler — long-term holder with infrequent trading",
    DEGEN: "degen — high-frequency trader with below-average win rate",
    INCONCLUSIVE: "inconclusive — insufficient data for clear classification",
    LOW_ACTIVITY: "low activity — too few transactions for classification",
    MOMENTUM: "momentum — trend-following with medium hold times",
    BOT: "bot — automated trading pattern",
    PRO_TRADER: "pro trader — skilled, consistent, disciplined hold time",
    INSIDER: "possible insider — coordinated early entries",
    BUNDLER: "possible bundler — fresh-funded, extreme early entry rate",
  };

  return {
    style,
    consistency: data.consistency,
    style_confidence,
    style_evidence: evidence,
    profile_summary: profileSummaries[style] ?? "unknown profile",
  };
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

  if (winRatePct !== null && winRatePct > 80) score += 10;
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
  winRateStatus: WinRateStatus,
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

  // FIX 8: HODL_ONLY wallets have no sells — Birdeye returns 0 which is misleading.
  // Treat as non-applicable rather than penalising.
  if (winRateStatus === "HODL_ONLY") {
    sf.push({ name: "win_rate", value: null, impact: 0, interpretation: "no closed trades — HODL wallet, win rate not applicable" });
  } else if (winRatePct !== null && winRatePct > 80) {
    sf.push({ name: "win_rate", value: winRatePct, impact: 10, interpretation: "suspiciously high win rate — possible insider" });
  } else if (winRatePct !== null && winRatePct === 0) {
    sf.push({ name: "win_rate", value: winRatePct, impact: -15, interpretation: "0% win rate with closed trades — poor performance" });
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
        if (pos.firstBuyTs <= pairCreatedSec + 120) sniped++;
      }
      checked++;
    } catch {
      // skip token on error
    }
  }

  return checked === 0 ? 0 : Math.round((sniped / checked) * 100);
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

  // ── Phase 1: 8 parallel calls ────────────────────────────────────────────
  const [sigsResult, accountResult, assetsResult, parsedTxResult, solPriceResult, portfolioResult, birdeyePnLResult, pnlDetailsResult] =
    await Promise.allSettled([
      // 1. Recent signatures — wallet age + total tx count
      rpcWithFallback<any[]>(
        { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit: 200 }] },
        8000
      ),
      // 2. SOL balance
      rpcWithFallback<any>(
        { jsonrpc: "2.0", id: 2, method: "getAccountInfo", params: [address, { encoding: "base64" }] },
        8000
      ),
      // 3. Token holdings via Helius DAS
      rpcPost<any>(
        PRIMARY_RPC,
        { jsonrpc: "2.0", id: 3, method: "getAssetsByOwner", params: { ownerAddress: address, page: 1, limit: 1000 } },
        8000
      ),
      // 4. Helius Enhanced parsed transactions
      fetchParsedTransactions(address, 8000),
      // 5. SOL price — needed for PnL estimation
      getDexScreenerToken(WSOL, { timeout: 4000 }),
      // 6. Birdeye wallet portfolio — needed for unrealized PnL fallback
      getBirdeyeWalletPortfolio(address, { timeout: 4000 }),
      // 7. Birdeye PnL summary — primary PnL source (win rate, totals)
      getBirdeyeWalletPnL(address, { timeout: 6000 }),
      // 8. Birdeye PnL details — per-token breakdown for unrealized_pnl_pct
      getBirdeyeWalletPnLDetails(address, { timeout: 6000 }),
    ]);

  if (sigsResult.status     === "rejected") logError("getSignaturesForAddress", sigsResult.reason);
  if (accountResult.status  === "rejected") logError("getAccountInfo",          accountResult.reason);
  if (assetsResult.status   === "rejected") logError("getAssetsByOwner",        assetsResult.reason);
  if (parsedTxResult.status === "rejected") logError("parsedTransactions",      parsedTxResult.reason);

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
      : 150;

  const portfolio: BirdeyeWalletPortfolioItem[] | null =
    portfolioResult.status === "fulfilled" ? portfolioResult.value : null;

  const birdeyePnL: BirdeyeWalletPnLSummary | null =
    birdeyePnLResult.status === "fulfilled" ? birdeyePnLResult.value : null;

  const pnlDetails: BirdeyeWalletPnLDetails | null =
    pnlDetailsResult.status === "fulfilled" ? pnlDetailsResult.value : null;

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
  let tokensTradedLast30d: number | null = null;

  if (parsedTxs && parsedTxs.length > 0) {
    positions = computePositions(address, parsedTxs);
    tokensTradedLast30d = computeTokensTraded30d(address, parsedTxs);
  }

  const isBot = detectBot(walletAgeDays, totalTx, parsedTxs ?? [], address);
  let { win_rate_pct: winRatePct, win_rate_calculation_status } = resolveWinRate(positions, parsedTxs);
  const avgHoldTimeHours = computeAvgHoldTime(positions);

  // Pre-compute closed positions count before Birdeye override — needed by FIX 1 guard.
  const closedCount = [...positions.values()].filter((p) => p.isClosed).length;
  const has_any_sells = [...positions.values()].some((p) => p.solReceived > 0);

  // ── Override with Birdeye PnL data when available ─────────────────────────
  if (birdeyePnL !== null) {
    if (birdeyePnL.tokens_traded !== null) {
      tokensTradedLast30d = birdeyePnL.tokens_traded;
    }
    // FIX 1: Do not let Birdeye's misleading win_rate=0 override when there are no
    // on-chain closed positions. Birdeye returns 0 for HODL-only wallets (no sells),
    // but that's a sentinel, not a real 0% win rate. Only accept Birdeye's 0% when
    // we can confirm closed positions exist; always accept non-zero values.
    const birdeyeWinRateValid =
      birdeyePnL.win_rate_pct !== null &&
      win_rate_calculation_status !== "HODL_ONLY" &&
      (birdeyePnL.win_rate_pct > 0 || closedCount > 0);
    if (birdeyeWinRateValid) {
      winRatePct = birdeyePnL.win_rate_pct;
      win_rate_calculation_status = "CALCULATED";
    }
  }

  // Override status using correct semantics — DATA_UNAVAILABLE only on fetch failure
  // (Birdeye PnL override above may have already set CALCULATED; don't downgrade it)
  if (win_rate_calculation_status !== "CALCULATED") {
    win_rate_calculation_status = resolveWinRateStatus({
      has_any_sells,
      closed_trades: closedCount,
      data_fetch_failed: parsedTxResult.status === "rejected",
    });
  }

  // ── Structured PnL ────────────────────────────────────────────────────────
  // Gate: call estimateStructuredPnL when we have on-chain positions OR Birdeye
  // PnL data. Without this, wallets with no parsed transactions but real Birdeye
  // PnL data (e.g. HODL-only wallets) would always return positions_analysed: 0.
  const { pnl, largestLoss } = positions.size > 0 || birdeyePnL !== null || pnlDetails !== null
    ? estimateStructuredPnL(positions, solPriceUsd, portfolio, birdeyePnL, pnlDetails)
    : {
        pnl: {
          realized_pnl_usdc: null,
          unrealized_pnl_usdc: null,
          unrealized_pnl_pct: null,
          total_pnl_usdc: null,
          positions_analysed: 0,
          cost_basis_method: "ESTIMATED" as const,
          method_description: "no positions to analyse",
          calculation_note: "no positions found",
          spam_token_filter_applied: false,
          filtered_spam_count: 0,
        },
        largestLoss: null,
      };

  // ── Dusting analysis ──────────────────────────────────────────────────────
  const dusting_analysis = detectDusting(address, parsedTxs ?? []);

  // ── Phase 2: SLA-guarded async signals ────────────────────────────────────
  let sniperScore = 0;
  let fundingSource: FundingSourceResult = {
    funder_address: null,
    funder_type: "UNKNOWN",
    funder_age_days: null,
    funder_tx_count: null,
    shared_funder_wallets: [],
    cluster_size: 1,
    risk: "MEDIUM",
    risk_reason: "funder details unavailable",
    action_guidance: "verify funding source manually before high-value trades",
    _warnings: [],
  };

  if (Date.now() < SLA_ABORT_MS && positions.size > 0) {
    const [sniperResult, fundingResult] = await Promise.allSettled([
      computeSniperScore(positions, SLA_ABORT_MS - 2000),
      getFundingSource(address, oldestSig, Math.min(3000, Math.max(500, SLA_ABORT_MS - Date.now() - 2000))),
    ]);

    sniperScore =
      sniperResult.status === "fulfilled" ? sniperResult.value : 0;
    fundingSource =
      fundingResult.status === "fulfilled" ? fundingResult.value : fundingSource;
  } else if (Date.now() < SLA_ABORT_MS) {
    fundingSource = await getFundingSource(
      address,
      oldestSig,
      Math.min(3000, Math.max(500, SLA_ABORT_MS - Date.now() - 2000))
    );
  }

  // FIX 4: Collect funding source warnings; strip _warnings from the public shape.
  const topLevelWarnings: string[] = [...fundingSource._warnings];

  const fundingWalletRisk = fundingSource.risk;  // backwards compat

  // wallet_activity_type is derived later, after lastActiveHoursAgo is available

  // ── Legacy trading style (flat backwards compat) ──────────────────────────
  const tradingStyle = deriveTradingStyle(
    isBot, sniperScore, avgHoldTimeHours, tokensTradedLast30d,
    winRatePct, totalTx, walletAgeDays, closedCount
  );

  const riskScore = computeRiskScore(
    walletAgeDays, sniperScore, winRatePct, null,
    fundingWalletRisk, isBot, whaleStatus
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

  // Losing parsed_transactions alone disables PnL, active_days, tokens_traded_30d,
  // and win_rate simultaneously — always LIMITED even if other calls succeeded.
  const data_quality: "FULL" | "PARTIAL" | "LIMITED" =
    callsOk === 4 ? "FULL"
    : parsedTxs === null ? "LIMITED"
    : callsOk >= 2 ? "PARTIAL"
    : "LIMITED";

  const cappedConfidence = deriveConfidenceFromQuality(confidence, data_quality);
  const data_confidence = confidenceToString(cappedConfidence.model);

  // FIX 7: Build missing_fields from final computed values, not intermediate fetch failures.
  // tokens_traded_30d is sourced from Birdeye PnL when parsedTxs is null — only mark
  // missing if the final value is still null.
  const missing_fields: string[] = [];
  if (sigs === null)                                                       missing_fields.push("signatures");
  if (accountInfo === null)                                                missing_fields.push("sol_balance");
  if (assetsResult.status !== "fulfilled" || assetsResult.value === null)  missing_fields.push("token_holdings");
  if (parsedTxs === null)                                                  missing_fields.push("parsed_transactions");
  if (tokensTradedLast30d === null)                                        missing_fields.push("tokens_traded_30d");
  if (portfolio === null)                                                  missing_fields.push("birdeye_portfolio");
  // FIX 5: rug_exit_rate_pct and historical_exposure are not computed within the SLA window.
  // Promote them to warnings so callers know the gap exists and why.
  missing_fields.push("rug_exit_rate_pct", "historical_exposure");
  topLevelWarnings.push(
    "rug_exit_rate_pct not computed within SLA window — cross-token rug scan requires extended analysis",
    "historical_exposure not computed within SLA window — requires full transaction history scan"
  );

  // ── Scoring factors ───────────────────────────────────────────────────────
  // FIX 8: Pass win_rate_calculation_status so the factor uses correct semantics.
  const factors = buildWalletFactors(
    walletAgeDays, sniperScore, winRatePct, win_rate_calculation_status, null,
    fundingWalletRisk, isBot, whaleStatus
  );

  // ── Structured score ──────────────────────────────────────────────────────
  let behavioral_risk = 0;
  if (sniperScore > 70)                                 behavioral_risk += 25;
  else if (sniperScore > 40)                            behavioral_risk += 15;
  if (winRatePct !== null && winRatePct > 80)           behavioral_risk += 10;
  if (isBot)                                            behavioral_risk += 15;
  behavioral_risk = Math.min(100, behavioral_risk);

  let history_depth = 0;
  if (walletAgeDays !== null && walletAgeDays < 7)      history_depth += 20;
  else if (walletAgeDays !== null && walletAgeDays < 30) history_depth += 10;
  history_depth = Math.min(100, history_depth);

  let counterparty_exposure = 0;
  if (fundingWalletRisk === "HIGH")                     counterparty_exposure += 20;
  if (whaleStatus && sniperScore > 40)                  counterparty_exposure += 15;
  counterparty_exposure = Math.min(100, counterparty_exposure);

  const score_overall = Math.min(100, Math.max(0, behavioral_risk + history_depth + counterparty_exposure));

  // ── Classification ────────────────────────────────────────────────────────
  const strongSignals = factors.filter((f) => f.impact >= 20).length;
  const classification: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN" =
    (totalTx < 10 || (walletAgeDays !== null && walletAgeDays < 7) || walletAgeDays === null)
      ? "UNKNOWN"
      : (score_overall >= 70 && strongSignals >= 2)
        ? "HIGH_RISK"
        : score_overall < 40
          ? "LOW_RISK"
          : "UNKNOWN";

  // ── Activity profile ──────────────────────────────────────────────────────
  function calculateActiveDays(transactions: ParsedTx[]): number {
    if (!transactions.length) return 0;
    const uniqueDays = new Set(
      transactions
        .filter((tx) => tx.timestamp != null)
        .map((tx) => {
          const d = new Date(tx.timestamp * 1000);
          return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        })
    );
    return uniqueDays.size;
  }

  // FIX 2: resolveActiveDays — Helius txs primary, Birdeye PnL token timestamps secondary.
  // Returns null only when neither source has timestamp data.
  function resolveActiveDays(
    transactions: ParsedTx[] | null,
    tokenPnLDetails: BirdeyeWalletPnLDetails | null
  ): number | null {
    // Non-null means Helius responded (even with 0 txs) — use it as authoritative.
    if (transactions !== null) {
      return calculateActiveDays(transactions);
    }
    // Secondary: derive unique active days from Birdeye per-token last_trade timestamps
    if (tokenPnLDetails !== null && tokenPnLDetails.tokens.length > 0) {
      const uniqueDays = new Set<string>();
      for (const t of tokenPnLDetails.tokens) {
        if (t.last_trade_unix_time !== null) {
          const d = new Date(t.last_trade_unix_time * 1000);
          uniqueDays.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
        }
      }
      // Only return a count if we have at least one timestamp; otherwise stay null.
      if (uniqueDays.size > 0) return uniqueDays.size;
    }
    return null;
  }

  const activeDays: number | null = resolveActiveDays(parsedTxs, pnlDetails);

  const lastActiveSig = sigs && sigs.length > 0 ? sigs[0] : null;
  const lastActiveHoursAgo =
    lastActiveSig && typeof (lastActiveSig as any).blockTime === "number"
      ? (Date.now() / 1000 - (lastActiveSig as any).blockTime) / 3600
      : null;

  // ── Wallet activity type ──────────────────────────────────────────────────
  // has_any_sells already computed above (Fix 6)
  const portfolio_has_holdings = (portfolio?.length ?? 0) > 0;

  const wallet_activity_type = deriveWalletActivityType({
    wallet_age_days: walletAgeDays,
    total_trades: birdeyePnL?.total_trades ?? totalTx,
    avg_hold_time_hours: avgHoldTimeHours,
    is_bot: isBot,
    sniper_score: sniperScore,
    has_any_sells,
    last_active_hours_ago: lastActiveHoursAgo,
    tokens_traded_30d: tokensTradedLast30d,
    portfolio_has_holdings,
  });

  // ── HODLER win-rate correction ────────────────────────────────────────────
  // wallet_activity_type is now known. If the wallet is HODLER but win_rate was
  // computed as CALCULATED (possible when tokens were transferred out without
  // receiving SOL — isClosed=true but solReceived=0, so has_any_sells=false),
  // the 0% win rate is a data artefact, not a real signal. Force HODL_ONLY and
  // patch the factors[] entry that was built before this determination was available.
  if (wallet_activity_type === "HODLER" && win_rate_calculation_status !== "HODL_ONLY") {
    winRatePct = null;
    win_rate_calculation_status = "HODL_ONLY";
    const wrIdx = factors.findIndex((f) => f.name === "win_rate");
    if (wrIdx >= 0) {
      factors[wrIdx] = {
        name: "win_rate",
        value: null,
        impact: 0,
        interpretation: "no closed trades — HODL wallet, win rate not applicable",
      };
    }
  }

  // ── Consistency (approximated from closed count vs tokens traded) ─────────
  const consistency: "LOW" | "MEDIUM" | "HIGH" =
    closedCount >= 10 && tokensTradedLast30d !== null && tokensTradedLast30d > 0
      ? closedCount / Math.max(tokensTradedLast30d, 1) > 2 ? "HIGH" : "MEDIUM"
      : "LOW";

  // ── FEATURE 6: Extended behavior profile ──────────────────────────────────
  const rawBehaviorProfile = deriveBehaviorProfile({
    isBot,
    sniperScore,
    avgHoldTimeHours,
    tokensTradedLast30d,
    winRatePct,
    totalTx,
    walletAgeDays,
    closedCount,
    earlyEntryRatePct: null,      // not yet wired from Helius
    pumpfunGraduationExitRatePct: null, // not yet wired from Helius
    isMevBot: false,              // not yet wired from Helius
    fundingSourceType: fundingSource.funder_type,
    consistency,
  });

  // FIX 3: syncBehaviorStyle — ensure behavior.style matches wallet_activity_type
  // when the activity type is definitively HODLER. deriveBehaviorProfile may return
  // INCONCLUSIVE for HODL wallets because avgHoldTimeHours is null (no sells to measure).
  // BOT/INSIDER/BUNDLER take precedence over the activity-type override.
  const behaviorProfile: BehaviorProfile = (() => {
    if (
      wallet_activity_type === "HODLER" &&
      rawBehaviorProfile.style !== "BOT" &&
      rawBehaviorProfile.style !== "INSIDER" &&
      rawBehaviorProfile.style !== "BUNDLER"
    ) {
      return {
        ...rawBehaviorProfile,
        style: "HODLER" as const,
        consistency: "HIGH" as const,
        style_confidence: 0.9,
        style_evidence: [...rawBehaviorProfile.style_evidence, "wallet_activity_type=HODLER"],
        profile_summary: "hodler — long-term holder with infrequent trading",
      };
    }
    return rawBehaviorProfile;
  })();

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
    risk_signals.push({ name: "high_funding_risk", impact: "HIGH", reason: fundingSource.risk_reason });
  }
  if (isBot) {
    risk_signals.push({ name: "bot_detected", impact: "HIGH", reason: "transaction pattern consistent with automated bot activity" });
  }
  if (dusting_analysis.dusting_risk === "HIGH") {
    risk_signals.push({ name: "active_dusting", impact: "MEDIUM", reason: dusting_analysis.meaning });
  }

  // ── Historical exposure (cross-token scan — outside 20s SLA) ─────────────
  // Not computed within the SLA window; null signals "not yet scanned"
  const historical_exposure = {
    rug_interactions: null as number | null,
    high_risk_tokens_traded: null as number | null,
  };

  // ── Copy-trade classification ─────────────────────────────────────────────
  const copy_trading = classifyCopyTrading({
    total_trades: closedCount,
    win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
    win_rate_calculation_status,
    avg_hold_time_hours: avgHoldTimeHours !== null ? Math.round(avgHoldTimeHours * 10) / 10 : null,
    consistency,
    sniper_score: sniperScore,
    rug_exit_rate_pct: null,
    is_bot: isBot,
    behavior_style: behaviorProfile.style,
    wallet_activity_type,
  });

  // ── LLM summary ───────────────────────────────────────────────────────────
  const walletAgeDaysRounded =
    walletAgeDays !== null ? Math.round(walletAgeDays * 10) / 10 : null;

  const llmData: WalletRiskData = {
    classification,
    activity: {
      wallet_age_days: walletAgeDaysRounded,
      total_trades: birdeyePnL?.total_trades ?? totalTx,
      active_days: activeDays,
      last_active_hours_ago:
        lastActiveHoursAgo !== null ? Math.round(lastActiveHoursAgo * 10) / 10 : null,
    },
    wallet_age_days: walletAgeDaysRounded,
    trading_style: tradingStyle,
    win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
    sniper_score: sniperScore,
    rug_exit_rate_pct: null,
    funding_wallet_risk: fundingWalletRisk,
    risk_score: riskScore,
    is_bot: isBot,
    pnl_estimate_30d_usdc: pnl.realized_pnl_usdc,
  };

  const elapsed = Date.now() - fetchStart;
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
      total_trades: birdeyePnL?.total_trades ?? totalTx,
      active_days: activeDays,
      last_active_hours_ago:
        lastActiveHoursAgo !== null ? Math.round(lastActiveHoursAgo * 10) / 10 : null,
    },

    // ── Legacy flat fields ──────────────────────────────────────────────────
    wallet_age_days: walletAgeDaysRounded,
    total_transactions: totalTx,
    tokens_traded_30d: tokensTradedLast30d,

    // ── Behavioural signals ─────────────────────────────────────────────────
    win_rate_pct: winRatePct !== null ? Math.round(winRatePct * 10) / 10 : null,
    win_rate_calculation_status,
    avg_hold_time_hours:
      avgHoldTimeHours !== null ? Math.round(avgHoldTimeHours * 10) / 10 : null,
    sniper_score: sniperScore,
    rug_exit_rate_pct: null,
    pnl_estimate_30d_usdc: pnl.realized_pnl_usdc,   // backwards compat
    pnl,
    largest_single_loss_usdc: largestLoss,
    is_bot: isBot,
    whale_status: whaleStatus,
    funding_wallet_risk: fundingWalletRisk,           // backwards compat
    // FIX 4: Strip internal _warnings field before returning.
    funding_source: (({ _warnings: _w, ...rest }) => rest)(fundingSource),

    // ── Wallet activity type ────────────────────────────────────────────────
    wallet_activity_type,

    // ── Behavior classification ─────────────────────────────────────────────
    behavior: behaviorProfile,

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

    // ── MEV intelligence (defaults — Helius MEV parsing not yet wired) ──────
    mev_victim_score: 0,
    is_mev_bot: false,
    mev_bot_confidence: 0,

    // ── Pump.fun intelligence (defaults — requires Helius pump.fun parsing) ─
    pumpfun_graduation_exit_rate_pct: null,
    early_entry_rate_pct: null,

    // ── Dusting analysis ────────────────────────────────────────────────────
    dusting_analysis,

    // ── Copy-trade opportunity ───────────────────────────────────────────────
    copy_trading,

    // ── Data quality ────────────────────────────────────────────────────────
    data_quality,
    missing_fields,
    warnings: topLevelWarnings,

    risk_summary,
    data_confidence,
    factors,
    confidence: cappedConfidence,
  };
}
