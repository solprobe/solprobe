import { getDexScreenerToken } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo } from "../sources/helius.js";
import { calculateRiskGrade, scoreConfidence, type RiskFactors } from "./riskScorer.js";
import { isAuthorityExempt, getExemptReason } from "../sources/jupiterTokenList.js";
import { deduplicate, getOrFetch } from "../cache.js";
import {
  generateQuickScanSummary,
  fallbackQuickSummary,
  type QuickScanData,
} from "../llm/narrativeEngine.js";

export interface QuickScanResult {
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Age in seconds of the RugCheck report used; null if RugCheck was unavailable. */
  rugcheck_report_age_seconds: number | null;
  /** True when this token is on the Jupiter strict list with a legitimately retained authority. */
  authority_exempt: boolean;
  /** Human-readable reason for the exemption, or null when not exempt. */
  authority_exempt_reason: string | null;
}

function logError(source: string, reason: unknown, address: string): void {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`${ts} source=${source} address=${address} error=${msg}`);
}

export async function quickScan(address: string): Promise<QuickScanResult> {
  const cacheKey = `sol_quick_scan:${address}`;
  return deduplicate(cacheKey, () => getOrFetch(cacheKey, () => _fetchQuickScan(address)));
}

async function _fetchQuickScan(address: string): Promise<QuickScanResult> {
  const fetchStart = Date.now();

  // All three sources run in parallel. getTokenMintInfo is NOT sequential.
  const [dexResult, rugResult, mintResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenMintInfo(address, { timeout: 3000 }),  // sole source for authority flags
  ]);

  const dexData  = dexResult.status  === "fulfilled" ? dexResult.value  : null;
  const rugData  = rugResult.status  === "fulfilled" ? rugResult.value  : null;
  const mintData = mintResult.status === "fulfilled" ? mintResult.value : null;

  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason,  address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason,   address);
  if (mintResult.status === "rejected") logError("helius_rpc",  mintResult.reason,  address);

  // ── Authority flags: Helius only, unconditionally ─────────────────────────
  // On null (RPC failure), default to false (conservative — treat as not revoked).
  const mint_authority_revoked   = mintData?.mint_authority_revoked   ?? false;
  const freeze_authority_revoked = mintData?.freeze_authority_revoked ?? false;

  // ── Holder concentration: from RugCheck (already filtered for protocol addrs) ─
  const top_10_holder_pct = rugData?.top_10_holder_pct ?? null;

  // ── Liquidity ─────────────────────────────────────────────────────────────
  const liquidity_usd = dexData?.liquidity_usd ?? null;

  // ── Honeypot + rug history ─────────────────────────────────────────────────
  const is_honeypot    = rugData?.is_honeypot    ?? false;
  const has_rug_history = rugData?.has_rug_history ?? false;

  // ── RugCheck report age ────────────────────────────────────────────────────
  const rugcheck_report_age_seconds = rugData?.report_age_seconds ?? null;

  // ── Token age ─────────────────────────────────────────────────────────────
  let token_age_days: number | null = null;
  if (dexData?.pair_created_at_ms != null) {
    token_age_days = (Date.now() - dexData.pair_created_at_ms) / (1000 * 60 * 60 * 24);
  }

  const factors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: rugData?.bundled_launch_detected ?? false,
    buy_sell_ratio: dexData?.buy_sell_ratio_1h ?? null,
    token_age_days,
  };

  const authority_exempt = isAuthorityExempt(address);
  const authority_exempt_reason = getExemptReason(address);

  const risk_grade = calculateRiskGrade(factors, address);

  // ── Data confidence ────────────────────────────────────────────────────────
  const sources = [
    dexData  !== null ? "dexscreener" : null,
    rugData  !== null ? "rugcheck"    : null,
    mintData !== null ? "helius"      : null,
  ].filter((s): s is string => s !== null);
  const data_confidence = scoreConfidence(sources, Date.now() - fetchStart);

  // ── LLM summary — sequential, after all parallel fetches complete ──────────
  const llmInputData: QuickScanData = {
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    risk_grade,
    data_confidence,
    has_rug_history,
    authority_exempt,
    authority_exempt_reason,
  };

  let summary: string;
  const elapsed = Date.now() - fetchStart;
  if (elapsed >= 4_200) {
    // SLA headroom exhausted — skip LLM to guarantee response time
    console.warn(`[quickScan] skipping LLM summary — elapsed ${elapsed}ms exceeds 4200ms`);
    summary = fallbackQuickSummary(llmInputData);
  } else {
    summary = await generateQuickScanSummary(llmInputData);
  }

  return {
    is_honeypot,
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    risk_grade,
    summary,
    data_confidence,
    rugcheck_report_age_seconds,
    authority_exempt,
    authority_exempt_reason,
  };
}
