import { getDexScreenerToken } from "../sources/dexscreener.js";
import { getRugCheckSummary } from "../sources/rugcheck.js";
import { getTokenInfo } from "../sources/helius.js";
import { calculateRiskGrade, scoreConfidence, type RiskFactors } from "./riskScorer.js";
import { deduplicate, getOrFetch } from "../cache.js";

export interface QuickScanResult {
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
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
  const [dexResult, rugResult, rpcResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenInfo(address, { timeout: 3000 }),
  ]);

  const dexData = dexResult.status === "fulfilled" ? dexResult.value : null;
  const rugData = rugResult.status === "fulfilled" ? rugResult.value : null;
  const rpcData = rpcResult.status === "fulfilled" ? rpcResult.value : null;

  if (dexResult.status === "rejected") logError("dexscreener", dexResult.reason, address);
  if (rugResult.status === "rejected") logError("rugcheck", rugResult.reason, address);
  if (rpcResult.status === "rejected") logError("helius_rpc", rpcResult.reason, address);

  // Source priority: RugCheck primary, Helius fallback, null if both unavailable
  const mint_authority_revoked =
    rugData?.mint_authority_revoked ?? rpcData?.mint_authority_revoked ?? null;
  const freeze_authority_revoked =
    rugData?.freeze_authority_revoked ?? rpcData?.freeze_authority_revoked ?? null;
  const top_10_holder_pct =
    rugData?.top_10_holder_pct ?? rpcData?.top_10_holder_pct ?? null;

  // liquidity: DexScreener primary (Birdeye fallback added in step 7)
  const liquidity_usd = dexData?.liquidity_usd ?? null;

  // Honeypot + rug history from RugCheck; false is the conservative default
  // (never mark safe when data is missing — but honeypot=false is safe-side default;
  // if rugcheck is down we cannot claim it's a honeypot either)
  const is_honeypot = rugData?.is_honeypot ?? false;
  const has_rug_history = rugData?.has_rug_history ?? false;

  // Token age — prefer pair creation timestamp, fall back to RPC
  let token_age_days: number | null = null;
  if (dexData?.pair_created_at_ms != null) {
    token_age_days = (Date.now() - dexData.pair_created_at_ms) / (1000 * 60 * 60 * 24);
  } else if (rpcData?.token_age_days != null) {
    token_age_days = rpcData.token_age_days;
  }

  const factors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: false, // deep dive only
    buy_sell_ratio: dexData?.buy_sell_ratio_1h ?? null,
    token_age_days,
  };

  const risk_grade = calculateRiskGrade(factors);

  // data_confidence: based on source corroboration and data freshness
  const sources = [
    dexData !== null ? "dexscreener" : null,
    rugData !== null ? "rugcheck" : null,
    rpcData !== null ? "helius" : null,
  ].filter((s): s is string => s !== null);
  const data_confidence = scoreConfidence(sources, Date.now() - fetchStart);

  const summary = buildSummary({
    is_honeypot,
    has_rug_history,
    mint_authority_revoked,
    freeze_authority_revoked,
    liquidity_usd,
    top_10_holder_pct,
    risk_grade,
    data_confidence,
  });

  return {
    is_honeypot,
    mint_authority_revoked: mint_authority_revoked ?? false,
    freeze_authority_revoked: freeze_authority_revoked ?? false,
    top_10_holder_pct,
    liquidity_usd,
    risk_grade,
    summary,
    data_confidence,
  };
}

function buildSummary(fields: {
  is_honeypot: boolean;
  has_rug_history: boolean;
  mint_authority_revoked: boolean | null;
  freeze_authority_revoked: boolean | null;
  liquidity_usd: number | null;
  top_10_holder_pct: number | null;
  risk_grade: string;
  data_confidence: string;
}): string {
  const flags: string[] = [];

  if (fields.is_honeypot) flags.push("honeypot detected");
  if (fields.has_rug_history) flags.push("rug history flagged");
  if (fields.mint_authority_revoked === false) flags.push("mint authority active");
  if (fields.freeze_authority_revoked === false) flags.push("freeze authority active");
  if (fields.top_10_holder_pct !== null && fields.top_10_holder_pct > 80)
    flags.push(`top-10 holders own ${fields.top_10_holder_pct.toFixed(1)}%`);

  const liqStr =
    fields.liquidity_usd !== null
      ? `$${fields.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} liquidity`
      : "liquidity unknown";

  const grade = `risk grade ${fields.risk_grade}`;
  const conf =
    fields.data_confidence !== "HIGH"
      ? ` (${fields.data_confidence.toLowerCase()} confidence)`
      : "";

  const flagStr = flags.length > 0 ? `${flags.join(", ")}; ` : "";
  return `${flagStr}${liqStr}; ${grade}${conf}.`;
}
