import { getDexScreenerToken } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenMintInfo, checkLPBurned } from "../sources/helius.js";
import { calculateRiskGrade, scoreConfidence, type RiskFactors } from "./riskScorer.js";
import { resolveAuthorityExempt } from "../sources/jupiterTokenList.js";
import { isLPBurnLaunchpad, PROGRAMS } from "../constants.js";
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
  lp_burned: boolean | null;
  rugcheck_risk_score: number | null;
  single_holder_danger: boolean;
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

  // ── Phase 2: LP burn check — requires LP mint from phase 1 ───────────────
  const lpMint = dexData?.lp_mint_address ?? null;
  // quickScan does not call Helius getAsset, so no creatorProgramId is available.
  // Infer the launch program from the dexId heuristic and gate on LP_BURN_LAUNCHPADS.
  // When Helius getAsset is wired up here, replace inferredProgramId with the
  // real creatorProgramId and drop the heuristic entirely.
  const inferredProgramId = dexData?.pairs.some((p) =>
    p.dexId?.toLowerCase().includes("pump")
  ) ? PROGRAMS.PUMP_FUN : null;
  const launchedFromLPBurnPad = inferredProgramId
    ? isLPBurnLaunchpad(inferredProgramId)
    : false;
  const lp_burned = launchedFromLPBurnPad
    ? true
    : (lpMint ? await checkLPBurned(lpMint, { timeout: 2000 }) : null);

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
    rugcheck_risk_score: rugData?.rugcheck_risk_score ?? null,
    single_holder_danger: rugData?.single_holder_danger ?? false,
    lp_burned,
    dev_wallet_age_days: null, // quickScan never fetches this
  };

  const { exempt: authority_exempt, reason: authority_exempt_reason } = await resolveAuthorityExempt(address);

  const risk_grade = calculateRiskGrade(factors, authority_exempt);

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
    lp_burned,
    rugcheck_risk_score: factors.rugcheck_risk_score,
    single_holder_danger: factors.single_holder_danger,
    risk_grade,
    summary,
    data_confidence,
    rugcheck_report_age_seconds,
    authority_exempt,
    authority_exempt_reason,
  };
}
